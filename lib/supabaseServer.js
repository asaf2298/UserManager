/**
 * Shared server-side Supabase REST transport.
 *
 * Used by Vercel handlers (telemetry, sightings, subtitle sync state) and by the
 * media worker. Every call is timeout-bounded and failure-tolerant: this data is
 * always auxiliary, so a Supabase outage must degrade features, never break a
 * stream or subtitle response.
 *
 * Writes require a service-role key. Reads fall back to the anon key so the
 * existing ID-resolver behavior is preserved when only that key is configured.
 */
import fetch from 'node-fetch';

const DEFAULT_TIMEOUT_MS = 800;

function baseUrl() {
  return (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
}

function serviceKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}

function readKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
}

/** True when reads are possible (service role or anon). */
export function canRead() {
  return !!(baseUrl() && readKey());
}

/** True when writes are possible. Anon keys must never write worker tables. */
export function canWrite() {
  return !!(baseUrl() && serviceKey());
}

async function request(path, { method = 'GET', key, body, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const url = baseUrl();
  if (!url || !key) return { ok: false, status: 0, data: null, error: 'supabase_not_configured' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!response.ok) {
      return { ok: false, status: response.status, data, error: text.slice(0, 300) };
    }
    return { ok: true, status: response.status, data, error: null };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: String(err?.name || err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * SELECT rows. Returns an array (possibly empty) or null when unavailable.
 * @param {string} table
 * @param {URLSearchParams|string} params PostgREST query string
 */
export async function selectRows(table, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const query = params ? `?${params.toString ? params.toString() : params}` : '';
  const result = await request(`${table}${query}`, { key: readKey(), timeoutMs });
  if (!result.ok) return null;
  return Array.isArray(result.data) ? result.data : [];
}

/**
 * INSERT rows. `onConflict` + `ignoreDuplicates` make append-only tables safe to
 * retry without creating duplicate observations.
 */
export async function insertRows(table, rows, opts = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return { ok: true, inserted: 0 };
  if (!canWrite()) return { ok: false, inserted: 0, error: 'no_service_role_key' };

  const { onConflict, ignoreDuplicates = false, merge = false, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const query = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
  const resolution = merge ? 'merge-duplicates' : 'ignore-duplicates';
  const prefer = [`return=minimal`];
  if (onConflict || ignoreDuplicates || merge) prefer.push(`resolution=${resolution}`);

  const result = await request(`${table}${query}`, {
    method: 'POST',
    key: serviceKey(),
    body: rows,
    headers: { Prefer: prefer.join(',') },
    timeoutMs,
  });
  return { ok: result.ok, inserted: result.ok ? rows.length : 0, error: result.error };
}

/** UPSERT rows on a conflict target, merging values. */
export async function upsertRows(table, rows, onConflict, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return insertRows(table, rows, { onConflict, merge: true, timeoutMs });
}

/** PATCH rows matching a filter. */
export async function updateRows(table, params, patch, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!canWrite()) return { ok: false, error: 'no_service_role_key' };
  const query = params ? `?${params.toString ? params.toString() : params}` : '';
  const result = await request(`${table}${query}`, {
    method: 'PATCH',
    key: serviceKey(),
    body: patch,
    headers: { Prefer: 'return=representation' },
    timeoutMs,
  });
  return { ok: result.ok, data: result.data, error: result.error };
}

/** DELETE rows matching a filter (used for TTL cleanup by the worker). */
export async function deleteRows(table, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!canWrite()) return { ok: false, error: 'no_service_role_key' };
  const query = params ? `?${params.toString ? params.toString() : params}` : '';
  const result = await request(`${table}${query}`, {
    method: 'DELETE',
    key: serviceKey(),
    headers: { Prefer: 'return=minimal' },
    timeoutMs,
  });
  return { ok: result.ok, error: result.error };
}

/** Call a Postgres function. */
export async function callRpc(fn, args, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const result = await request(`rpc/${fn}`, {
    method: 'POST',
    key: serviceKey() || readKey(),
    body: args || {},
    timeoutMs,
  });
  return { ok: result.ok, data: result.data, error: result.error };
}

/**
 * Fire-and-forget write with a hard budget. Resolves to false on any failure and
 * never rejects, so callers can safely skip `await` on a request hot path.
 *
 * `logTag` identifies the call site in logs on failure only -- this path is
 * otherwise silent by design, which previously made a misconfigured or
 * rejected write indistinguishable from "nothing to write" in production.
 */
export function writeWithBudget(promiseFactory, budgetMs, logTag = null) {
  const timeout = new Promise(resolve => setTimeout(() => resolve(false), budgetMs));
  return Promise.race([
    Promise.resolve()
      .then(promiseFactory)
      .then(result => {
        if (result?.ok === false && logTag) {
          console.error(`[SUPABASE WRITE] ${logTag} failed: ${result.error}`);
        }
        return result?.ok !== false;
      })
      .catch(err => {
        if (logTag) console.error(`[SUPABASE WRITE] ${logTag} threw: ${err?.message || err}`);
        return false;
      }),
    timeout,
  ]);
}
