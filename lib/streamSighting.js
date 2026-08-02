/**
 * Stream sightings: bridging "what we offered" to "what is playing".
 *
 * Stremio never tells an addon which stream the viewer clicked, and subtitle
 * requests do not carry the playback URL. The only workable inference is to
 * remember the rows we just returned, then match the subtitle request's
 * `videoHash` / `filename` / `videoSize` extras back to one of them.
 *
 * Sightings are short-lived and best-effort: writing them must never delay a
 * stream response, and a miss simply means auto-sync cannot target that file.
 */
import crypto from 'node:crypto';
import { selectRows, insertRows, canWrite, canRead, writeWithBudget } from './supabaseServer.js';
import { MODEL_VERSION } from './versions.js';
import { parseTorrentIdentityFromUrl, normalizeInfoHash } from './playbackLocator.js';

const TABLE = 'personal_stream_sightings';

/** Playable links (especially debrid) expire; two hours is generous but bounded. */
export const SIGHTING_TTL_MS = 2 * 60 * 60 * 1000;

// No longer racing the response (writes run inside waitUntil()), so allow a
// realistic cross-region round trip instead of a budget tuned for the old
// inline race.
const WRITE_BUDGET_MS = 1000;
const READ_TIMEOUT_MS = 500;
const MAX_SIGHTINGS_PER_REQUEST = 15;

/** Match strength, strongest first. Weak matches are reported, never guessed past. */
export const MATCH_STRENGTH = {
  VIDEO_HASH: 'video_hash',
  FILENAME_SIZE: 'filename_size',
  FILENAME: 'filename',
  VIDEO_SIZE: 'video_size',
  VIDEO_KEY: 'video_key',
  NONE: 'none',
};

function normalizeFilename(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ') || null;
}

function normalizeHash(hash) {
  const clean = String(hash || '').trim().toLowerCase();
  return /^[0-9a-f]{8,40}$/.test(clean) ? clean : null;
}

/**
 * Stable key for the file a viewer is watching.
 * Prefers the OpenSubtitles hash; falls back to filename+size, which is the only
 * other identity Stremio reliably provides.
 */
export function buildVideoKey({ videoHash, filename, videoSize, contentId }) {
  const hash = normalizeHash(videoHash);
  if (hash) return `vh:${hash}`;
  const name = normalizeFilename(filename);
  if (name && videoSize) return `fs:${crypto.createHash('sha256').update(`${name}|${videoSize}`).digest('hex').slice(0, 24)}`;
  if (name) return `fn:${crypto.createHash('sha256').update(name).digest('hex').slice(0, 24)}`;
  if (contentId && videoSize) return `cs:${contentId}:${videoSize}`;
  return null;
}

/**
 * Parse Stremio subtitle extras from both the path segment form
 * (`/subtitles/movie/tt123/videoHash=..&filename=...json`) and the query form.
 * Different clients use different shapes; we accept both.
 */
export function parseVideoIdentityFromUrl(rawUrl) {
  const identity = { videoHash: null, videoSize: null, filename: null };
  const value = String(rawUrl || '');
  if (!value) return identity;

  const [pathPart, queryPart] = value.split('?');
  const candidates = [];

  const segments = decodeSafe(pathPart).split('/').filter(Boolean);
  for (const segment of segments) {
    if (segment.includes('=')) candidates.push(segment.replace(/\.json$/i, ''));
  }
  if (queryPart) {
    const params = new URLSearchParams(queryPart);
    const extra = params.get('extra');
    if (extra) candidates.push(decodeSafe(extra));
    for (const key of ['videoHash', 'videoSize', 'filename']) {
      const direct = params.get(key);
      if (direct) candidates.push(`${key}=${direct}`);
    }
  }

  for (const candidate of candidates) {
    for (const pair of candidate.split('&')) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const key = pair.slice(0, eq).trim();
      const val = decodeSafe(pair.slice(eq + 1).trim());
      if (!val) continue;
      if (/^videohash$/i.test(key)) identity.videoHash = normalizeHash(val);
      else if (/^videosize$/i.test(key)) {
        const size = Number(val);
        if (Number.isFinite(size) && size > 0) identity.videoSize = Math.round(size);
      } else if (/^filename$/i.test(key)) identity.filename = normalizeFilename(val);
    }
  }
  return identity;
}

function decodeSafe(value) {
  try {
    return decodeURIComponent(String(value));
  } catch {
    return String(value);
  }
}

/** Pull the sighting-relevant identity out of a selected candidate. */
export function extractStreamIdentity(candidate) {
  const stream = candidate.stream || candidate;
  const features = candidate.features || null;
  const hints = stream.behaviorHints || {};
  const playableUrl = stream.url || stream.externalUrl || null;
  const fromUrl = parseTorrentIdentityFromUrl(playableUrl);
  const infoHash = normalizeInfoHash(stream.infoHash) || fromUrl.infoHash;
  const fileIdx = Number.isFinite(Number(stream.fileIdx))
    ? Number(stream.fileIdx)
    : fromUrl.fileIdx;
  return {
    playableUrl,
    infoHash,
    fileIdx: Number.isFinite(fileIdx) ? fileIdx : null,
    videoHash: normalizeHash(hints.videoHash),
    filename: normalizeFilename(hints.filename),
    videoSize: Number.isFinite(Number(hints.videoSize)) ? Math.round(Number(hints.videoSize)) : null,
    providerId: features?.providerId || null,
    // Carried so a later subtitle-sync probe result can be attributed back to the
    // right provider/stratum for the (currently unfed) `integrity` trust metric.
    providerFamily: features?.providerFamily || null,
    stratum: features?.stratum || null,
    releaseCluster: features?.release?.fileFingerprint || null,
  };
}

/**
 * Persist the identities we just offered. Fire-and-forget by design.
 * Called before response formatting strips internal fields.
 */
export function upsertStreamSightings({ contentType, contentId, candidates }) {
  if (!canWrite() || !contentId || !Array.isArray(candidates) || !candidates.length) {
    return Promise.resolve(false);
  }

  const expiresAt = new Date(Date.now() + SIGHTING_TTL_MS).toISOString();
  const rows = [];
  for (const candidate of candidates.slice(0, MAX_SIGHTINGS_PER_REQUEST)) {
    const identity = extractStreamIdentity(candidate);
    // Only an HTTP locator is useful to the worker; a magnet cannot be probed.
    if (!identity.playableUrl || !/^https?:\/\//i.test(identity.playableUrl)) continue;
    rows.push({
      content_type: contentType || null,
      content_id: contentId,
      provider_id: identity.providerId,
      provider_family: identity.providerFamily,
      stratum: identity.stratum,
      release_cluster: identity.releaseCluster,
      info_hash: identity.infoHash,
      file_idx: identity.fileIdx,
      video_hash: identity.videoHash,
      filename: identity.filename,
      video_size: identity.videoSize,
      playable_url: identity.playableUrl,
      model_version: MODEL_VERSION,
      expires_at: expiresAt,
    });
  }
  if (!rows.length) return Promise.resolve(false);

  return writeWithBudget(
    () => insertRows(TABLE, rows, {
      onConflict: 'content_id,playable_url',
      merge: true,
      timeoutMs: WRITE_BUDGET_MS,
    }),
    WRITE_BUDGET_MS,
    TABLE,
  );
}

/**
 * True when a stored sighting row satisfies the given stable videoKey.
 * Matches by key flavor (vh / fs / fn / cs) rather than rebuild-preferred key,
 * so an `fs:` sync URL still finds a row that also has a videoHash.
 */
export function sightingMatchesVideoKey(row, videoKey, contentId = null) {
  const want = String(videoKey || '').trim();
  if (!want || !row) return false;
  if (want.startsWith('vh:')) {
    return !!normalizeHash(row.video_hash) && `vh:${normalizeHash(row.video_hash)}` === want;
  }
  if (want.startsWith('fs:')) {
    const name = normalizeFilename(row.filename);
    const size = Number(row.video_size);
    if (!name || !Number.isFinite(size) || size <= 0) return false;
    return buildVideoKey({ filename: name, videoSize: size }) === want;
  }
  if (want.startsWith('fn:')) {
    const name = normalizeFilename(row.filename);
    if (!name) return false;
    return buildVideoKey({ filename: name }) === want;
  }
  if (want.startsWith('cs:')) {
    return buildVideoKey({ contentId, videoSize: row.video_size }) === want;
  }
  return false;
}

/**
 * Resolve a playable URL for the file a subtitle request refers to.
 *
 * Match order is strongest-evidence-first. An ambiguous weak match returns a
 * miss rather than an arbitrary pick: syncing the wrong file is worse than not
 * offering sync at all.
 */
export async function resolvePlayableSighting({ contentId, identity, videoKey = null }) {
  if (!canRead() || !contentId) return { found: false, strength: MATCH_STRENGTH.NONE, reason: 'unavailable' };

  const params = new URLSearchParams({
    select: 'playable_url,video_hash,filename,video_size,info_hash,file_idx,provider_id,provider_family,stratum,seen_at',
    content_id: `eq.${contentId}`,
    expires_at: `gt.${new Date().toISOString()}`,
    order: 'seen_at.desc',
    limit: '60',
  });
  const rows = await selectRows(TABLE, params, READ_TIMEOUT_MS);
  if (!Array.isArray(rows) || !rows.length) {
    return { found: false, strength: MATCH_STRENGTH.NONE, reason: 'no_sightings' };
  }

  const hash = normalizeHash(identity?.videoHash)
    || (String(videoKey || '').startsWith('vh:') ? normalizeHash(String(videoKey).slice(3)) : null);
  const filename = normalizeFilename(identity?.filename);
  const size = Number.isFinite(Number(identity?.videoSize)) ? Math.round(Number(identity.videoSize)) : null;

  if (hash) {
    const matches = rows.filter(row => normalizeHash(row.video_hash) === hash);
    if (matches.length) return ok(matches[0], MATCH_STRENGTH.VIDEO_HASH);
  }
  if (filename && size) {
    const matches = rows.filter(row => normalizeFilename(row.filename) === filename && Number(row.video_size) === size);
    if (matches.length) return ok(matches[0], MATCH_STRENGTH.FILENAME_SIZE);
  }
  if (filename) {
    const matches = rows.filter(row => normalizeFilename(row.filename) === filename);
    if (matches.length === 1) return ok(matches[0], MATCH_STRENGTH.FILENAME);
    if (matches.length > 1) return { found: false, strength: MATCH_STRENGTH.NONE, reason: 'ambiguous_filename' };
  }
  if (size) {
    const matches = rows.filter(row => Number(row.video_size) === size);
    if (matches.length === 1) return ok(matches[0], MATCH_STRENGTH.VIDEO_SIZE);
    if (matches.length > 1) return { found: false, strength: MATCH_STRENGTH.NONE, reason: 'ambiguous_size' };
  }

  // Last resort: recreate each row's videoKey and compare. Covers fn:/fs: sync
  // URLs that never carried filename/videoSize query params.
  if (videoKey) {
    const matches = rows.filter(row => sightingMatchesVideoKey(row, videoKey, contentId));
    if (matches.length === 1) return ok(matches[0], MATCH_STRENGTH.VIDEO_KEY);
    if (matches.length > 1) return { found: false, strength: MATCH_STRENGTH.NONE, reason: 'ambiguous_video_key' };
  }

  return { found: false, strength: MATCH_STRENGTH.NONE, reason: 'no_match' };
}

function ok(row, strength) {
  const fromUrl = parseTorrentIdentityFromUrl(row.playable_url);
  const infoHash = normalizeInfoHash(row.info_hash) || fromUrl.infoHash;
  const fileIdx = Number.isFinite(Number(row.file_idx))
    ? Number(row.file_idx)
    : fromUrl.fileIdx;
  return {
    found: true,
    strength,
    playableUrl: row.playable_url,
    infoHash,
    fileIdx: Number.isFinite(fileIdx) ? fileIdx : null,
    providerId: row.provider_id || null,
    providerFamily: row.provider_family || null,
    stratum: row.stratum || null,
    filename: row.filename || null,
    videoSize: Number(row.video_size) || null,
  };
}

export { TABLE as SIGHTINGS_TABLE, normalizeFilename, normalizeHash };
