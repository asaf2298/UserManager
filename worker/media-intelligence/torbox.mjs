/**
 * TorBox API client (v1).
 *
 * Scope is deliberately narrow. TorBox can tell us whether a hash is cached and
 * what an account already holds; it cannot tell us that a viewer clicked a stream
 * or that playback succeeded. So this module is used for *audits* — checking
 * whether a provider's cache claim was true — and never as click telemetry.
 *
 * Endpoints used:
 *   GET /v1/api/torrents/checkcached  — up to ~100 hashes per call, ~1s, hourly cached
 *   GET /v1/api/torrents/mylist       — account download state (updated every ~600s)
 *   GET /v1/api/torrents/requestdl    — proves a locator can be issued, not that it played
 */
import fetch from 'node-fetch';
import { TORBOX_API_BASE, TORBOX_API_VERSION, TORBOX_API_TOKEN, LIMITS, log } from './config.mjs';

const DEFAULT_TIMEOUT_MS = 15_000;

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
  return { ok: true, url: typeof result.data === 'string' ? result.data : null, error: null };
}
