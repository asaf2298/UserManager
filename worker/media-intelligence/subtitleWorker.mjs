/**
 * Embedded-reference subtitle alignment.
 *
 * The movie's own embedded subtitles are the timing reference: they are already
 * aligned to this exact cut, which makes them a far better anchor than audio
 * analysis and vastly cheaper on a 1 GB box. There is no audio path at all — a
 * file with no extractable text track fails honestly with `no_embeds`.
 *
 * Pipeline: ffprobe → rank text tracks → extract reference → fetch Hebrew base →
 * alass → store the rewritten SRT.
 *
 * Every external process is spawned with an explicit timeout and a known PID so a
 * Telegram lease can terminate exactly this job's child and nothing else.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fetch from 'node-fetch';
import { selectRows, updateRows, insertRows } from '../../lib/supabaseServer.js';
import {
  rankEmbeddedTracks, slotReferencePool, REFERENCE_SLOT, JOB_STATUS, FAIL_REASON,
} from '../../lib/subtitleSync.js';
import { countSubtitleCues, decodeSubtitleBuffer } from '../../lib/subtitleUtils.js';
import { BITMAP_SUBTITLE_CODECS } from '../../lib/releaseParser.js';
import { getContentMeta } from '../../lib/search.js';
import { MODEL_VERSION } from '../../lib/versions.js';
import { auditInclusionProbability, currentSnapshot } from '../../lib/providerTrust.js';
import {
  looksCloudflareProxiedPlayback,
  parseFilenameFromPlaybackUrl,
  resolveTorrentIdentity,
} from '../../lib/playbackLocator.js';
import { LIMITS, WORKER_ID, log, torboxConfigured } from './config.mjs';
import { resolveProbeDownloadUrl } from './torbox.mjs';

const JOBS_TABLE = 'personal_subtitle_sync_jobs';
const CACHE_TABLE = 'personal_subtitle_sync';
const OBSERVATIONS_TABLE = 'personal_provider_observations';

/** Raised when the Telegram lease activates mid-job. Not a real failure. */
export class BusyAbortError extends Error {
  constructor() {
    super('aborted: host busy');
    this.name = 'BusyAbortError';
  }
}

/**
 * Spawn a child process with a hard timeout, exposing its PID so the caller can
 * terminate precisely this process rather than pattern-killing by name.
 */
function run(command, args, { timeoutMs, onSpawn }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000);
    }, timeoutMs);

    if (onSpawn) onSpawn(child);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      if (code !== 0) return reject(new Error(`${command} exited ${code}: ${stderr.slice(0, 300)}`));
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Probe subtitle streams.
 *
 * Nothing textual is discarded: forced, SDH, commentary, and signs tracks all stay
 * eligible and are merely ranked lower. Bitmap formats (PGS/VobSub) are the single
 * hard exclusion because alass needs text, not images.
 */
export async function probeSubtitleTracks(sourceUrl, { onSpawn } = {}) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 's',
    '-show_entries', 'stream=index,codec_name,disposition:stream_tags=language,title,handler_name',
    '-of', 'json',
    sourceUrl,
  ], { timeoutMs: LIMITS.ffprobeTimeoutMs, onSpawn });

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('ffprobe returned unparseable JSON');
  }

  return (parsed.streams || []).map((stream, order) => {
    const tags = stream.tags || {};
    const disposition = stream.disposition || {};
    const descriptor = `${tags.title || ''} ${tags.handler_name || ''}`.toLowerCase();
    const codec = String(stream.codec_name || '').toLowerCase();

    return {
      index: Number.isFinite(stream.index) ? stream.index : order,
      order,
      codec,
      isText: !BITMAP_SUBTITLE_CODECS.has(codec),
      language: (tags.language || '').toLowerCase().slice(0, 3) || null,
      title: tags.title || null,
      isForced: !!disposition.forced || /\bforced\b/.test(descriptor),
      isSdh: /\bsdh\b/.test(descriptor),
      isHearingImpaired: !!disposition.hearing_impaired || /\bhi\b|hearing/.test(descriptor),
      isCommentary: !!disposition.comment || /commentar/.test(descriptor),
      isSigns: /\bsigns?\b|\bsongs?\b/.test(descriptor),
      isSongs: /\bsongs?\b|\blyrics?\b/.test(descriptor),
      isDescription: /descript|narration|audio\s*desc/.test(descriptor),
      cueCount: null,
    };
  });
}

/**
 * Grade an ffprobe attempt as `integrity` evidence: does this provider's claimed
 * file really open as real, playable video?
 *
 * Only counted when the source was the TorBox-resolved CDN locator
 * (`sourceKind === 'torbox_cdn'`) — a raw offered URL can fail for reasons
 * (Cloudflare block, geo-restriction) that look identical to a genuinely
 * fake/corrupt file, so those yield no evidence rather than a false accusation.
 * Whatever happens *after* a successful probe (no text tracks, extraction or
 * alass failure) is irrelevant here: ffprobe already proved the container is
 * real, matching content.
 */
export function gradeIntegrityProbe({ probeSucceeded, sourceKind }) {
  if (probeSucceeded) return { outcome: true, metric: 'integrity' };
  if (sourceKind === 'torbox_cdn') return { outcome: false, metric: 'integrity' };
  return { outcome: null, metric: 'integrity' };
}

/** Current effective weight for a provider/stratum's integrity cell, if a snapshot is loaded. */
function currentIntegrityWeight(providerId, stratum) {
  const snapshot = currentSnapshot();
  const entry = snapshot?.byKey?.get(`${providerId}||${stratum}||integrity`);
  return entry?.effectiveWeight || 0;
}

/**
 * Record one integrity observation from a subtitle-sync probe.
 *
 * Best-effort and non-blocking: a write failure here must never fail the sync
 * job itself. Sampling is demand-driven (whatever the viewer happens to be
 * watching), unlike the uniform sampling `personal_ranking_audit_queue` uses for
 * cache-claim audits -- IPW weighting corrects the magnitude of that but not the
 * underlying selection bias, which is an accepted approximation here.
 */
async function recordIntegrityObservation(job, { probeSucceeded, sourceKind }) {
  if (!job.provider_id) return; // pre-migration job row or unattributed sighting
  const { outcome, metric } = gradeIntegrityProbe({ probeSucceeded, sourceKind });
  if (outcome === null) return;

  const stratum = job.stratum || 'unknown|movie';
  const probability = auditInclusionProbability(currentIntegrityWeight(job.provider_id, stratum));
  await insertRows(OBSERVATIONS_TABLE, [{
    provider_id: job.provider_id,
    provider_family: job.provider_family || String(job.provider_id).split(':')[0],
    stratum,
    metric,
    outcome,
    inclusion_probability: probability,
    source: 'controlled_probe',
    candidate_key: `${job.info_hash || job.id}|${job.file_idx ?? ''}`,
    model_version: MODEL_VERSION,
    observed_at: new Date().toISOString(),
  }], {
    onConflict: 'provider_id,metric,candidate_key,source',
    ignoreDuplicates: true,
    timeoutMs: 3000,
  }).catch(err => log('integrity', `observation write failed: ${err.message}`));
}

/** Extract one embedded subtitle stream to SRT text. */
async function extractTrack(sourceUrl, trackIndex, workDir, { onSpawn }) {
  const output = path.join(workDir, `ref_${trackIndex}.srt`);
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    // Only the opening window is needed to establish offset/drift, which keeps the
    // download far below the temp-disk budget on large remuxes.
    '-t', String(LIMITS.probeWindowSeconds),
    '-i', sourceUrl,
    '-map', `0:${trackIndex}`,
    '-c:s', 'srt',
    output,
  ], { timeoutMs: LIMITS.extractTimeoutMs, onSpawn });

  const info = await stat(output).catch(() => null);
  if (!info || info.size === 0) throw new Error(`track ${trackIndex} produced no text`);
  return { file: output, text: await readFile(output, 'utf8') };
}

/**
 * Choose the reference track for a slot.
 *
 * Cue counts come from actually extracting candidates, because ffprobe cannot tell
 * a 40-cue forced track from a full dialogue track. Extraction is capped to the
 * few most promising candidates to bound cost.
 */
/**
 * @returns {Promise<{ ok:true, reference:object }|{ ok:false, reason:string }>}
 */
async function selectReference(sourceUrl, tracks, { slot, officialLanguage, runtimeMinutes, workDir, onSpawn }) {
  const pool = slotReferencePool(tracks, { slot, officialLanguage });
  if (pool.tryOther) {
    return { ok: false, reason: FAIL_REASON.TRY_OTHER_SYNC };
  }
  if (!pool.tracks.length) return { ok: false, reason: FAIL_REASON.NO_EMBEDS };

  const provisional = rankEmbeddedTracks(pool.tracks, { slot, officialLanguage, runtimeMinutes });
  const shortlist = provisional.slice(0, 3);

  const extracted = [];
  for (const track of shortlist) {
    try {
      const result = await extractTrack(sourceUrl, track.index, workDir, { onSpawn });
      extracted.push({ ...track, cueCount: countSubtitleCues(result.text), file: result.file, text: result.text });
    } catch (err) {
      if (err instanceof BusyAbortError) throw err;
      log('subtitle', `track ${track.index} extraction failed: ${err.message}`);
    }
  }
  if (!extracted.length) return { ok: false, reason: FAIL_REASON.PROBE_FAILED };

  const reranked = rankEmbeddedTracks(extracted, { slot, officialLanguage, runtimeMinutes });
  const best = reranked[0];
  const reference = extracted.find(t => t.index === best.index) || extracted[0];
  return { ok: true, reference };
}

/** Fetch the Hebrew base subtitle and normalize it to UTF-8. */
async function fetchBaseSubtitle(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/plain,*/*' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`base subtitle HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = decodeSubtitleBuffer(buffer);
    if (!text || countSubtitleCues(text) === 0) throw new Error('base subtitle has no cues');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Align the base subtitle to the reference with alass.
 * alass handles non-linear drift, so the stored output is a rewritten SRT rather
 * than a single global offset.
 */
async function alignWithAlass(referenceFile, baseFile, workDir, { onSpawn }) {
  const output = path.join(workDir, 'synced.srt');
  await run('alass', [referenceFile, baseFile, output], {
    timeoutMs: LIMITS.alassTimeoutMs,
    onSpawn,
  });
  const text = await readFile(output, 'utf8');
  if (!text || countSubtitleCues(text) === 0) throw new Error('alass produced no cues');
  return text;
}

/** Claim the oldest runnable job. */
export async function claimSubtitleJob() {
  const nowIso = new Date().toISOString();
  const params = new URLSearchParams({
    select: 'id,video_key,content_type,content_id,sub_fingerprint,base_sub_url,reference_slot,playable_url,info_hash,file_idx,attempts,provider_id,provider_family,stratum',
    status: 'eq.queued',
    expires_at: `gt.${nowIso}`,
    order: 'created_at.asc',
    limit: '1',
  });
  const rows = await selectRows(JOBS_TABLE, params, 1500);
  if (!Array.isArray(rows) || !rows.length) return null;

  const job = rows[0];
  const claim = await updateRows(
    JOBS_TABLE,
    new URLSearchParams({ id: `eq.${job.id}`, status: 'eq.queued' }),
    { status: JOB_STATUS.RUNNING, locked_at: nowIso, locked_by: WORKER_ID, updated_at: nowIso },
    2000,
  );
  // Empty representation means another worker won the race.
  if (!claim.ok || (Array.isArray(claim.data) && claim.data.length === 0)) return null;
  return job;
}

/**
 * Choose a URL the droplet can actually open for ffprobe/ffmpeg.
 * Torrentio/Comet resolve links are Cloudflare-blocked from DO; TorBox CDN is not.
 */
async function resolveWorkingSourceUrl(job) {
  const offered = job.playable_url;
  const identity = resolveTorrentIdentity({
    infoHash: job.info_hash,
    fileIdx: job.file_idx,
    playableUrl: offered,
  });
  const filenameHint = parseFilenameFromPlaybackUrl(offered);

  if (torboxConfigured() && identity.infoHash) {
    const resolved = await resolveProbeDownloadUrl({
      infoHash: identity.infoHash,
      fileIdx: identity.fileIdx,
      filename: filenameHint,
    });
    if (resolved.ok && resolved.url) {
      // Backfill hash/index on the job row so later retries skip URL re-parsing.
      if (!job.info_hash || job.info_hash !== identity.infoHash
          || (identity.fileIdx != null && job.file_idx !== identity.fileIdx)) {
        await updateRows(
          JOBS_TABLE,
          new URLSearchParams({ id: `eq.${job.id}` }),
          {
            info_hash: identity.infoHash,
            file_idx: Number.isFinite(identity.fileIdx) ? identity.fileIdx : job.file_idx,
            updated_at: new Date().toISOString(),
          },
          1500,
        ).catch(() => null);
      }
      return { url: resolved.url, source: resolved.source, infoHash: identity.infoHash, fileIdx: identity.fileIdx };
    }
    log('subtitle', `TorBox CDN resolve failed (${resolved.error}); falling back to offered URL`, {
      hash: identity.infoHash,
      fileIdx: identity.fileIdx,
    });
  }

  if (looksCloudflareProxiedPlayback(offered)) {
    return {
      url: null,
      source: 'blocked',
      error: torboxConfigured()
        ? (identity.infoHash ? 'torbox_cdn_unavailable' : 'missing_info_hash_for_torbox')
        : 'cloudflare_blocked_playback_url',
      infoHash: identity.infoHash,
      fileIdx: identity.fileIdx,
    };
  }

  return { url: offered, source: 'offered', infoHash: identity.infoHash, fileIdx: identity.fileIdx };
}

async function finishJob(jobId, patch) {
  await updateRows(
    JOBS_TABLE,
    new URLSearchParams({ id: `eq.${jobId}` }),
    { ...patch, updated_at: new Date().toISOString() },
    2000,
  );
}

/** Requeue without consuming an attempt — a yield is not a failure. */
export async function requeueJob(jobId) {
  await finishJob(jobId, {
    status: JOB_STATUS.QUEUED,
    locked_at: null,
    locked_by: null,
    fail_reason: FAIL_REASON.BUSY_ABORTED,
  });
}

/**
 * Process one alignment job.
 *
 * @param {object} job claimed job row
 * @param {{ isAborted:()=>boolean, registerChild:(child)=>void }} control
 */
export async function processSubtitleJob(job, control) {
  const workDir = await mkdtemp(path.join(tmpdir(), 'subsync-'));
  const startedAt = Date.now();
  const onSpawn = (child) => {
    control.registerChild(child);
    if (control.isAborted()) child.kill('SIGTERM');
  };
  const checkAbort = () => {
    if (control.isAborted()) throw new BusyAbortError();
  };

  try {
    if (!job.playable_url && !job.info_hash) {
      await finishJob(job.id, { status: JOB_STATUS.FAILED, fail_reason: FAIL_REASON.NO_URL, attempts: (job.attempts || 0) + 1 });
      return { ok: false, reason: FAIL_REASON.NO_URL };
    }

    checkAbort();
    const source = await resolveWorkingSourceUrl(job);
    if (!source.url) {
      log('subtitle', `no reachable probe URL for job ${job.id}`, { error: source.error, hash: source.infoHash });
      await finishJob(job.id, {
        status: JOB_STATUS.FAILED, fail_reason: FAIL_REASON.PROBE_FAILED, attempts: (job.attempts || 0) + 1,
      });
      return { ok: false, reason: FAIL_REASON.PROBE_FAILED, error: source.error || 'no_probe_url' };
    }
    log('subtitle', `probing job ${job.id} via ${source.source}`, { hash: source.infoHash, fileIdx: source.fileIdx });

    checkAbort();
    const meta = job.content_id ? await getContentMeta(job.content_type || 'movie', job.content_id).catch(() => null) : null;
    const officialLanguage = meta?.originalLanguage || 'en';
    const runtimeMinutes = meta?.runtimeMin || null;

    checkAbort();
    let tracks;
    try {
      tracks = await probeSubtitleTracks(source.url, { onSpawn });
    } catch (err) {
      if (err instanceof BusyAbortError) throw err;
      log('subtitle', `ffprobe failed for job ${job.id}: ${err.message}`, { source: source.source });
      await recordIntegrityObservation(job, { probeSucceeded: false, sourceKind: source.source });
      await finishJob(job.id, {
        status: JOB_STATUS.FAILED, fail_reason: FAIL_REASON.PROBE_FAILED, attempts: (job.attempts || 0) + 1,
      });
      return { ok: false, reason: FAIL_REASON.PROBE_FAILED, error: err.message };
    }
    await recordIntegrityObservation(job, { probeSucceeded: true, sourceKind: source.source });

    const textTracks = tracks.filter(t => t.isText);
    if (!textTracks.length) {
      // File-level terminal: no retry will conjure a text track into this file.
      // This is the only path that may hide סנכרון כתוביות on later lists.
      await finishJob(job.id, {
        status: JOB_STATUS.FAILED, fail_reason: FAIL_REASON.NO_EMBEDS, attempts: LIMITS.maxAttempts,
      });
      return { ok: false, reason: FAIL_REASON.NO_EMBEDS };
    }

    checkAbort();
    const selected = await selectReference(source.url, tracks, {
      slot: job.reference_slot || REFERENCE_SLOT.OFFICIAL,
      officialLanguage,
      runtimeMinutes,
      workDir,
      onSpawn,
    });
    if (!selected.ok) {
      if (selected.reason === FAIL_REASON.TRY_OTHER_SYNC) {
        // Embeds exist for another language/slot — tell the viewer to switch track.
        await finishJob(job.id, {
          status: JOB_STATUS.FAILED, fail_reason: FAIL_REASON.TRY_OTHER_SYNC, attempts: LIMITS.maxAttempts,
        });
        return { ok: false, reason: FAIL_REASON.TRY_OTHER_SYNC };
      }
      if (selected.reason === FAIL_REASON.NO_EMBEDS) {
        await finishJob(job.id, {
          status: JOB_STATUS.FAILED, fail_reason: FAIL_REASON.NO_EMBEDS, attempts: LIMITS.maxAttempts,
        });
        return { ok: false, reason: FAIL_REASON.NO_EMBEDS };
      }
      // Text embeds present but extraction failed (CDN/ffmpeg) — soft, retriable.
      log('subtitle', `text embeds present but extraction failed for job ${job.id}`, {
        textTracks: textTracks.length,
        slot: job.reference_slot,
      });
      await finishJob(job.id, {
        status: JOB_STATUS.FAILED, fail_reason: FAIL_REASON.PROBE_FAILED, attempts: (job.attempts || 0) + 1,
      });
      return { ok: false, reason: FAIL_REASON.PROBE_FAILED, error: 'extract_failed' };
    }
    const reference = selected.reference;

    checkAbort();
    const baseText = await fetchBaseSubtitle(job.base_sub_url);
    const baseFile = path.join(workDir, 'base.srt');
    await writeFile(baseFile, baseText, 'utf8');

    checkAbort();
    const syncedText = await alignWithAlass(reference.file, baseFile, workDir, { onSpawn });

    await insertRows(CACHE_TABLE, [{
      video_key: job.video_key,
      sub_fingerprint: job.sub_fingerprint,
      reference_slot: job.reference_slot,
      ref_fingerprint: `track:${reference.index}`,
      synced_srt: syncedText,
      method: 'embedded_alass',
      ref_lang: reference.language,
      ref_track_index: reference.index,
      cue_count: countSubtitleCues(syncedText),
      model_version: MODEL_VERSION,
    }], {
      onConflict: 'video_key,sub_fingerprint,reference_slot',
      merge: true,
      timeoutMs: 8000,
    });

    await finishJob(job.id, { status: JOB_STATUS.DONE, fail_reason: null });
    log('subtitle', `aligned job ${job.id} in ${Date.now() - startedAt}ms`, {
      slot: job.reference_slot,
      refTrack: reference.index,
      refLang: reference.language,
      cues: countSubtitleCues(syncedText),
    });
    return { ok: true, refTrack: reference.index };
  } catch (err) {
    if (err instanceof BusyAbortError) {
      await requeueJob(job.id);
      log('subtitle', `job ${job.id} yielded to Telegram playback and was requeued`);
      return { ok: false, reason: FAIL_REASON.BUSY_ABORTED };
    }
    const attempts = (job.attempts || 0) + 1;
    const timedOut = /timed out/i.test(err.message);
    await finishJob(job.id, {
      status: attempts >= LIMITS.maxAttempts ? JOB_STATUS.FAILED : JOB_STATUS.QUEUED,
      fail_reason: timedOut ? FAIL_REASON.TIMEOUT : FAIL_REASON.ALIGN_FAILED,
      attempts,
      locked_at: null,
      locked_by: null,
    });
    log('subtitle', `job ${job.id} failed (attempt ${attempts}): ${err.message}`);
    return { ok: false, reason: FAIL_REASON.ALIGN_FAILED, error: err.message };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
