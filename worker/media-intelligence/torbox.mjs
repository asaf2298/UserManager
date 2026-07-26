/**
 * TorBox API client (v1).
 *
 * Used for:
 *   - Audits (`checkcached` / `mylist`) — never as click telemetry
 *   - Subtitle sync probe: issue a CDN download locator so the droplet can
 *     ffprobe without hitting Cloudflare-blocked Torrentio resolve URLs
 *
 * Endpoints used:
 *   GET  /v1/api/torrents/checkcached
 *   GET  /v1/api/torrents/mylist
 *   GET  /v1/api/torrents/requestdl
 *   POST /v1/api/torrents/createtorrent
 */
import fetch from 'node-fetch';
import { TORBOX_API_BASE, TORBOX_API_VERSION, TORBOX_API_TOKEN, LIMITS, log } from './config.mjs';
import { normalizeInfoHash } from '../../lib/playbackLocator.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const CREATE_TIMEOUT_MS = 30_000;
const PROBE_READY_ATTEMPTS = 6;
const PROBE_READY_WAIT_MS = 2_500;

async function torboxGet(path, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const url = new URL(`${TORBOX_API_BASE}/${TORBOX_API_VERSION}/api/${path}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${TORBOX_API_TOKEN}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      return { ok: false, status: response.status, error: payload?.error || text.slice(0, 200), data: null };
    }
    // TorBox always returns { success, error, detail, data }.
    return { ok: payload?.success !== false, status: response.status, error: payload?.error || null, data: payload?.data ?? null };
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.name || err), data: null };
  } finally {
    clearTimeout(timer);
  }
}

async function torboxPostForm(path, fields, timeoutMs = CREATE_TIMEOUT_MS) {
  const url = `${TORBOX_API_BASE}/${TORBOX_API_VERSION}/api/${path}`;
  const form = new FormData();
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null || value === '') continue;
    form.append(key, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TORBOX_API_TOKEN}`,
        Accept: 'application/json',
      },
      body: form,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      return { ok: false, status: response.status, error: payload?.error || text.slice(0, 200), data: null };
    }
    return { ok: payload?.success !== false, status: response.status, error: payload?.error || null, data: payload?.data ?? null };
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.name || err), data: null };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check whether torrent hashes are cached on TorBox.
 *
 * A hash present in the response is cache-positive evidence; a hash absent from a
 * successful response is cache-negative evidence for that moment. A failed request
 * yields no evidence at all — silence is never treated as a failure.
 *
 * @param {string[]} hashes up to LIMITS.auditBatchSize hashes
 * @returns {Promise<{ ok:boolean, cached:Map<string, object>, error:string|null }>}
 */
export async function checkCached(hashes) {
  const list = [...new Set((hashes || []).map(h => String(h || '').toLowerCase()).filter(Boolean))]
    .slice(0, LIMITS.auditBatchSize);
  if (!list.length) return { ok: true, cached: new Map(), error: null };

  const result = await torboxGet('torrents/checkcached', {
    hash: list.join(','),
    format: 'object',
    list_files: 'true',
  });

  if (!result.ok) {
    log('torbox', `checkcached failed: ${result.error}`, { status: result.status, hashes: list.length });
    return { ok: false, cached: new Map(), error: result.error };
  }

  // `format=object` returns a hash-keyed map; be tolerant of a list shape too.
  const cached = new Map();
  const data = result.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const [key, value] of Object.entries(data)) {
      if (value) cached.set(String(key).toLowerCase(), value);
    }
  } else if (Array.isArray(data)) {
    for (const entry of data) {
      const hash = String(entry?.hash || '').toLowerCase();
      if (hash) cached.set(hash, entry);
    }
  }

  return { ok: true, cached, error: null };
}

/**
 * Account download list. Confirms hash/file/state for items TorBox already holds;
 * it is not evidence about a viewer's behavior.
 */
export async function getMyList({ limit = 1000, offset = 0, bypassCache = false } = {}) {
  const result = await torboxGet('torrents/mylist', {
    limit, offset, bypass_cache: bypassCache ? 'true' : 'false',
  }, 20_000);
  if (!result.ok) return { ok: false, items: [], error: result.error };
  const items = Array.isArray(result.data) ? result.data : (result.data ? [result.data] : []);
  return { ok: true, items, error: null };
}

/**
 * Request a download locator for a known torrent/file.
 * Success proves TorBox can issue a usable link — nothing about playback.
 */
export async function requestDownloadLink({ torrentId, fileId, userIp }) {
  const result = await torboxGet('torrents/requestdl', {
    token: TORBOX_API_TOKEN,
    torrent_id: torrentId,
    file_id: fileId,
    user_ip: userIp,
  });
  if (!result.ok) return { ok: false, url: null, error: result.error };
  // data may be a bare URL string or { url } depending on API version.
  const url = typeof result.data === 'string'
    ? result.data
    : (result.data?.url || result.data?.download || null);
  return { ok: !!url, url, error: url ? null : (result.error || 'no_url_in_response') };
}

/** Find a torrent already on the account by infoHash. */
export async function findTorrentByHash(infoHash) {
  const hash = normalizeInfoHash(infoHash);
  if (!hash) return { ok: false, torrent: null, error: 'bad_hash' };
  const list = await getMyList({ limit: 1000, bypassCache: true });
  if (!list.ok) return { ok: false, torrent: null, error: list.error };
  const torrent = list.items.find(item => normalizeInfoHash(item.hash || item.Hash) === hash) || null;
  return { ok: true, torrent, error: null };
}

/**
 * Ensure the hash exists on the TorBox account.
 * Prefer an existing mylist entry; otherwise create with add_only_if_cached so we
 * never start a multi-hour remux download just to sync subtitles.
 */
export async function ensureTorrentForHash(infoHash) {
  const hash = normalizeInfoHash(infoHash);
  if (!hash) return { ok: false, torrentId: null, torrent: null, error: 'bad_hash' };

  const existing = await findTorrentByHash(hash);
  if (existing.ok && existing.torrent) {
    const id = existing.torrent.id ?? existing.torrent.torrent_id;
    return { ok: true, torrentId: id, torrent: existing.torrent, error: null, created: false };
  }

  const created = await torboxPostForm('torrents/createtorrent', {
    magnet: `magnet:?xt=urn:btih:${hash}`,
    add_only_if_cached: 'true',
    seed: '3',
  });
  if (!created.ok) {
    return { ok: false, torrentId: null, torrent: null, error: created.error || 'create_failed', created: false };
  }

  const torrentId = created.data?.torrent_id ?? created.data?.id ?? null;
  // Fresh creates often need a short settle before files appear on mylist.
  for (let attempt = 0; attempt < PROBE_READY_ATTEMPTS; attempt++) {
    const again = await findTorrentByHash(hash);
    if (again.ok && again.torrent) {
      const id = again.torrent.id ?? again.torrent.torrent_id ?? torrentId;
      return { ok: true, torrentId: id, torrent: again.torrent, error: null, created: true };
    }
    await sleep(PROBE_READY_WAIT_MS);
  }

  if (torrentId != null) {
    return { ok: true, torrentId, torrent: created.data, error: null, created: true };
  }
  return { ok: false, torrentId: null, torrent: null, error: 'torrent_not_ready', created: true };
}

/**
 * Pick the TorBox file id for the stream we offered.
 * Prefer explicit file index, then filename match, then largest video-ish file.
 */
export function pickTorboxFileId(torrent, { fileIdx = null, filename = null } = {}) {
  const files = Array.isArray(torrent?.files) ? torrent.files : [];
  if (!files.length) return null;

  if (Number.isFinite(fileIdx)) {
    const byIndex = files.find(f => Number(f.id) === Number(fileIdx) || Number(f.file_id) === Number(fileIdx));
    if (byIndex) return Number(byIndex.id ?? byIndex.file_id);
    // Some providers use 0-based index into the files array.
    if (fileIdx >= 0 && fileIdx < files.length) {
      return Number(files[fileIdx].id ?? files[fileIdx].file_id);
    }
  }

  if (filename) {
    const want = String(filename).toLowerCase().replace(/\s+/g, ' ').trim();
    const byName = files.find(f => String(f.name || f.filename || '').toLowerCase().replace(/\s+/g, ' ').includes(want)
      || want.includes(String(f.name || f.filename || '').toLowerCase().replace(/\s+/g, ' ')));
    if (byName) return Number(byName.id ?? byName.file_id);
  }

  const sorted = [...files].sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0));
  const best = sorted[0];
  return best ? Number(best.id ?? best.file_id) : null;
}

/**
 * Resolve a droplet-reachable CDN URL for subtitle probing/extraction.
 *
 * @returns {Promise<{ ok:boolean, url:string|null, source:string, error:string|null, torrentId:*, fileId:* }>}
 */
export async function resolveProbeDownloadUrl({ infoHash, fileIdx = null, filename = null }) {
  if (!TORBOX_API_TOKEN) {
    return { ok: false, url: null, source: 'none', error: 'no_torbox_token', torrentId: null, fileId: null };
  }
  const ensured = await ensureTorrentForHash(infoHash);
  if (!ensured.ok) {
    log('torbox', `ensure torrent failed: ${ensured.error}`, { hash: infoHash });
    return { ok: false, url: null, source: 'torbox', error: ensured.error, torrentId: null, fileId: null };
  }

  let torrent = ensured.torrent;
  // mylist entries sometimes omit files until a second fetch.
  if (!Array.isArray(torrent?.files) || !torrent.files.length) {
    const refreshed = await findTorrentByHash(infoHash);
    if (refreshed.ok && refreshed.torrent) torrent = refreshed.torrent;
  }

  const fileId = pickTorboxFileId(torrent, { fileIdx, filename });
  if (fileId == null || !Number.isFinite(fileId)) {
    return {
      ok: false, url: null, source: 'torbox', error: 'no_file_id',
      torrentId: ensured.torrentId, fileId: null,
    };
  }

  const link = await requestDownloadLink({ torrentId: ensured.torrentId, fileId });
  if (!link.ok || !link.url) {
    log('torbox', `requestdl failed: ${link.error}`, { torrentId: ensured.torrentId, fileId });
    return {
      ok: false, url: null, source: 'torbox', error: link.error || 'requestdl_failed',
      torrentId: ensured.torrentId, fileId,
    };
  }

  log('torbox', 'issued CDN probe URL', { torrentId: ensured.torrentId, fileId, created: !!ensured.created });
  return {
    ok: true, url: link.url, source: 'torbox_cdn', error: null,
    torrentId: ensured.torrentId, fileId,
  };
}
