/**
 * Subtitle auto-sync state machine (embedded-reference only).
 *
 * Product contract, chosen deliberately over a background "next play" model:
 *   - Up to four `סנכרון כתוביות` tracks appear in the *first* subtitle list.
 *   - Selecting one starts the work. Nothing heavy runs on a list request.
 *   - While a job is pending the same URL serves a one-cue "wait and reselect"
 *     subtitle, so the player shows status instead of an error.
 *   - When the job finishes, that same URL serves the aligned SRT.
 *
 * Timing comes from the movie's own embedded text subtitles aligned with alass.
 * There is no audio path: if a file has no extractable text track, sync fails
 * honestly rather than guessing.
 */
import { buildOneCueSrt, computeSubFingerprint } from './subtitleUtils.js';
import { selectRows, insertRows, updateRows, canRead, canWrite } from './supabaseServer.js';
import { MODEL_VERSION } from './versions.js';
import { resolveTorrentIdentity } from './playbackLocator.js';

export const JOBS_TABLE = 'personal_subtitle_sync_jobs';
export const CACHE_TABLE = 'personal_subtitle_sync';

/** Reference slots offered per Hebrew base subtitle. */
export const REFERENCE_SLOT = { OFFICIAL: 'official', ENGLISH: 'english' };
export const REFERENCE_SLOTS = [REFERENCE_SLOT.OFFICIAL, REFERENCE_SLOT.ENGLISH];

/** Max Hebrew base subtitles used as sync sources (2 bases x 2 slots = 4 tracks). */
export const MAX_SYNC_BASES = 2;

export const JOB_STATUS = { QUEUED: 'queued', RUNNING: 'running', DONE: 'done', FAILED: 'failed' };

export const FAIL_REASON = {
  NO_EMBEDS: 'no_embeds',
  NO_URL: 'no_url',
  ALIGN_FAILED: 'align_failed',
  PROBE_FAILED: 'probe_failed',
  TIMEOUT: 'timeout',
  BUSY_ABORTED: 'busy_aborted',
};

/** Exact viewer-facing copy. Terminal states must be unambiguous. */
export const SYNC_MESSAGES = {
  PENDING: 'please wait one minute and reselect to sync',
  NO_EMBEDS: 'no available embedded subtitles',
  FAILED: 'sorry couldnt sync',
};

/** How the sync endpoint responded, for logging and tests. */
export const SYNC_STATE = { READY: 'ready', PENDING: 'pending', NO_EMBEDS: 'no_embeds', FAILED: 'failed' };

const READ_TIMEOUT_MS = 600;
const WRITE_TIMEOUT_MS = 600;

/**
 * Language name shown as its own Stremio picker group (Submaker-style: custom
 * text in `lang`, not ISO `heb`). Real Hebrew subs stay `lang: 'heb'`.
 */
export const SYNC_TRACK_LABEL = 'סנכרון כתוביות';

/**
 * Prefer durable hosts as sync bases. Ktuvit often 502s through the sub-proxy
 * from the worker, which fails the job after a successful probe. Relative rank
 * order is preserved within each priority bucket.
 */
function syncBasePriority(sub) {
  const url = String(sub.sourceUrl || sub.url || '').toLowerCase();
  const provider = String(sub._providerName || sub.calculatedProvider || '').toLowerCase();
  if (provider.includes('opensubtitles') || url.includes('opensubtitles')) return 2;
  if (provider.includes('ktuvit') || url.includes('ktuvit')) return 0;
  return 1;
}

/**
 * Pick the Hebrew base subtitles to offer sync for.
 *
 * Machine-translated tracks are excluded as *bases* (aligning a bad translation
 * only produces well-timed nonsense) while remaining visible as normal options.
 */
export function pickHebrewSyncBases(rankedSubs, max = MAX_SYNC_BASES) {
  const eligible = [];
  for (const sub of rankedSubs || []) {
    if (sub._classifiedLang !== 'heb' && sub.lang !== 'heb') continue;
    if (sub._isAuto) continue;
    if (!sub.sourceUrl && !sub.url) continue;
    eligible.push(sub);
  }
  return eligible
    .map((sub, index) => ({ sub, index, priority: syncBasePriority(sub) }))
    .sort((a, b) => (b.priority - a.priority) || (a.index - b.index))
    .map(entry => entry.sub)
    .slice(0, max);
}

/**
 * Build the sync track descriptors injected at the top of the subtitle list.
 * Tracks are advertised before any probing happens, which is what makes them
 * available on the very first list.
 */
export function buildSyncTrackDescriptors({
  bases, videoKey, contentType, contentId, publicBaseUrl,
  filename = null, videoSize = null,
}) {
  const tracks = [];
  if (!videoKey || !bases?.length) return tracks;

  bases.forEach((base, baseIndex) => {
    const sourceUrl = base.sourceUrl || base.url;
    const fingerprint = computeSubFingerprint(sourceUrl);
    if (!fingerprint) return;

    for (const slot of REFERENCE_SLOTS) {
      const params = new URLSearchParams({
        videoKey,
        sub: fingerprint,
        slot,
        url: sourceUrl,
        type: contentType || '',
        id: contentId || '',
      });
      // Filename/size let sub-sync match sightings when videoHash alone is missing.
      if (filename) params.set('filename', filename);
      if (videoSize != null && videoSize !== '') params.set('videoSize', String(videoSize));
      // Custom lang string (like Submaker's "make hebrew") so the client shows a
      // separate language row instead of burying sync under identical "Hebrew".
      const title = `${SYNC_TRACK_LABEL} · ${baseIndex + 1}/${slot === REFERENCE_SLOT.OFFICIAL ? 'מקור' : 'EN'}`;
      tracks.push({
        id: `esay_sync_${baseIndex}_${slot}`,
        url: `${publicBaseUrl}/api/sub-sync?${params.toString()}`,
        lang: SYNC_TRACK_LABEL,
        title,
        _syncTrack: true,
        _syncSlot: slot,
        _syncFingerprint: fingerprint,
      });
    }
  });

  return tracks;
}

/** Cache identity of one aligned result. */
export function syncCacheKey({ videoKey, subFingerprint, slot }) {
  return `${videoKey}|${subFingerprint}|${slot}`;
}

/** Look up a finished alignment. */
export async function lookupSyncCache({ videoKey, subFingerprint, slot }) {
  if (!canRead()) return null;
  const params = new URLSearchParams({
    select: 'synced_srt,method,ref_lang,created_at',
    video_key: `eq.${videoKey}`,
    sub_fingerprint: `eq.${subFingerprint}`,
    reference_slot: `eq.${slot}`,
    limit: '1',
  });
  const rows = await selectRows(CACHE_TABLE, params, READ_TIMEOUT_MS);
  if (!Array.isArray(rows) || !rows.length) return null;
  const row = rows[0];
  return row.synced_srt ? row : null;
}

/** Current job state for this exact (video, base subtitle, slot) triple. */
export async function lookupSyncJob({ videoKey, subFingerprint, slot }) {
  if (!canRead()) return null;
  const params = new URLSearchParams({
    select: 'id,status,fail_reason,attempts,created_at,updated_at,playable_url,info_hash,file_idx',
    video_key: `eq.${videoKey}`,
    sub_fingerprint: `eq.${subFingerprint}`,
    reference_slot: `eq.${slot}`,
    order: 'created_at.desc',
    limit: '1',
  });
  const rows = await selectRows(JOBS_TABLE, params, READ_TIMEOUT_MS);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/**
 * Enqueue an alignment job. A partial unique index keeps one active job per
 * triple, so repeated reselects while pending cannot pile up work.
 */
export async function enqueueSyncJob({
  videoKey, subFingerprint, slot, baseSubUrl, contentType, contentId, playableUrl, infoHash, fileIdx,
}) {
  if (!canWrite()) return { ok: false, error: 'no_service_role_key' };
  const identity = resolveTorrentIdentity({ infoHash, fileIdx, playableUrl });
  const row = {
    video_key: videoKey,
    sub_fingerprint: subFingerprint,
    reference_slot: slot,
    base_sub_url: baseSubUrl,
    content_type: contentType || null,
    content_id: contentId || null,
    playable_url: playableUrl || null,
    info_hash: identity.infoHash,
    file_idx: Number.isFinite(identity.fileIdx) ? identity.fileIdx : null,
    status: JOB_STATUS.QUEUED,
    attempts: 0,
    model_version: MODEL_VERSION,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
  return insertRows(JOBS_TABLE, [row], {
    onConflict: 'video_key,sub_fingerprint,reference_slot',
    ignoreDuplicates: true,
    timeoutMs: WRITE_TIMEOUT_MS,
  });
}

/** Re-queue a soft failure so a later select (after TorBox/CDN fixes) can retry. */
async function requeueFailedJob(job, { playableUrl, infoHash, fileIdx } = {}) {
  if (!canWrite() || !job?.id) return false;
  const identity = resolveTorrentIdentity({
    infoHash: infoHash || job.info_hash,
    fileIdx: fileIdx ?? job.file_idx,
    playableUrl: playableUrl || job.playable_url,
  });
  const patch = {
    status: JOB_STATUS.QUEUED,
    fail_reason: null,
    locked_at: null,
    locked_by: null,
    updated_at: new Date().toISOString(),
    playable_url: playableUrl || job.playable_url || null,
    info_hash: identity.infoHash,
    file_idx: Number.isFinite(identity.fileIdx) ? identity.fileIdx : null,
  };
  const result = await updateRows(
    JOBS_TABLE,
    new URLSearchParams({ id: `eq.${job.id}` }),
    patch,
    WRITE_TIMEOUT_MS,
  );
  return !!result.ok;
}

/**
 * Resolve what the sync URL should return right now.
 *
 * Ready wins over everything. A terminal `no_embeds` is reported as such because
 * retrying it would waste worker time on a file that structurally cannot be
 * aligned. Soft failures (probe) are re-queued on select so a TorBox CDN path
 * can be retried. Anything else pending returns the wait cue.
 */
export async function resolveSyncResponse({
  videoKey, subFingerprint, slot, baseSubUrl, contentType, contentId, sighting,
}) {
  const cached = await lookupSyncCache({ videoKey, subFingerprint, slot });
  if (cached) {
    return { state: SYNC_STATE.READY, body: cached.synced_srt, refLang: cached.ref_lang || null };
  }

  const job = await lookupSyncJob({ videoKey, subFingerprint, slot });

  if (job?.status === JOB_STATUS.FAILED) {
    if (job.fail_reason === FAIL_REASON.NO_EMBEDS) {
      return { state: SYNC_STATE.NO_EMBEDS, body: buildOneCueSrt(SYNC_MESSAGES.NO_EMBEDS) };
    }
    const exhausted = Number(job.attempts) >= 3;
    if (exhausted) {
      return { state: SYNC_STATE.FAILED, body: buildOneCueSrt(SYNC_MESSAGES.FAILED) };
    }
    // Soft failure (probe/timeout/align): requeue when the viewer reselects so the
    // worker can try TorBox CDN again instead of sitting forever on a dead row.
    await requeueFailedJob(job, {
      playableUrl: sighting?.found ? sighting.playableUrl : job.playable_url,
      infoHash: sighting?.found ? sighting.infoHash : job.info_hash,
      fileIdx: sighting?.found ? sighting.fileIdx : job.file_idx,
    });
    return { state: SYNC_STATE.PENDING, body: buildOneCueSrt(SYNC_MESSAGES.PENDING) };
  }

  if (!job) {
    if (!sighting?.found) {
      // We cannot identify which file is playing, so there is nothing to align
      // against. Reported as a plain failure rather than a misleading wait.
      return { state: SYNC_STATE.FAILED, body: buildOneCueSrt(SYNC_MESSAGES.FAILED), reason: sighting?.reason };
    }
    const identity = resolveTorrentIdentity({
      infoHash: sighting.infoHash,
      fileIdx: sighting.fileIdx,
      playableUrl: sighting.playableUrl,
    });
    await enqueueSyncJob({
      videoKey, subFingerprint, slot, baseSubUrl, contentType, contentId,
      playableUrl: sighting.playableUrl,
      infoHash: identity.infoHash,
      fileIdx: identity.fileIdx,
    });
  }

  return { state: SYNC_STATE.PENDING, body: buildOneCueSrt(SYNC_MESSAGES.PENDING) };
}

/**
 * Rank embedded text tracks for a reference slot.
 *
 * No text track is ever discarded — forced, SDH, and commentary tracks are
 * merely ranked lower, because a forced track is still usable timing evidence
 * when it is the only match for the target language. Bitmap subtitles are the
 * one hard exclusion: alass needs text.
 */
export function rankEmbeddedTracks(tracks, { slot, officialLanguage, runtimeMinutes }) {
  const targetLanguage = slot === REFERENCE_SLOT.ENGLISH ? 'en' : (officialLanguage || 'en');
  const expectedCues = Math.max(1, (Number(runtimeMinutes) || 100) * 8);

  return (tracks || [])
    .filter(track => track.isText)
    .map((track) => {
      const languageMatch = track.language && track.language.slice(0, 2) === targetLanguage ? 1 : 0;
      const cueCoverage = Math.max(0, Math.min(1, (Number(track.cueCount) || 0) / expectedCues));
      const normality = trackNormality(track);
      const score = 0.65 * languageMatch + 0.25 * cueCoverage + 0.10 * normality;
      return { ...track, languageMatch, cueCoverage, normality, score };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.cueCount !== a.cueCount) return (b.cueCount || 0) - (a.cueCount || 0);
      return (a.index || 0) - (b.index || 0);
    });
}

/** Weaker anchors rank later but stay eligible. */
export function trackNormality(track) {
  if (track.isCommentary || track.isSigns || track.isSongs || track.isDescription) return 0.60;
  if (track.isSdh || track.isHearingImpaired) return 0.75;
  if (track.isForced) return 0.80;
  return 1.00;
}

export { computeSubFingerprint, buildOneCueSrt };
