#!/usr/bin/env node
/**
 * Ingest Fribb anime-list-full.json into personal_titles (Phase 1 + Phase 4 pool).
 *
 * Usage:
 *   node --env-file=.env.local scripts/ingest-fribb.mjs [--imdb-only] [--mal-only]
 *
 * Default: ingest both imdb-keyed rows and MAL-only rows (~28k total).
 *
 * Requires:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY (RPC personal_ingest_title_rows)
 */
import fetch from 'node-fetch';

const FRIBB_URL =
  'https://raw.githubusercontent.com/Fribb/anime-lists/refs/heads/master/anime-list-full.json';
const BATCH_SIZE = 200;
const SOURCE = 'fribb';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function supabaseKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || null;
}

function firstImdbId(entry) {
  const raw = entry.imdb_id;
  if (!raw) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  for (const id of list) {
    if (typeof id === 'string' && /^tt\d+$/i.test(id)) return id.toLowerCase();
  }
  return null;
}

function mapMediaType(entry) {
  const t = String(entry.type || '').toUpperCase();
  if (t === 'MOVIE') return 'movie';
  return 'series';
}

function firstScalar(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return firstScalar(value[0]);
  return value;
}

function mapTmdbId(entry) {
  const tmdb = entry.themoviedb_id;
  if (!tmdb || typeof tmdb !== 'object') return null;
  return firstScalar(tmdb.tv ?? tmdb.movie ?? null);
}

function baseRowFromFribb(entry) {
  const mal = firstScalar(entry.mal_id);
  const kitsu = firstScalar(entry.kitsu_id);
  const anilist = firstScalar(entry.anilist_id);
  const anidb = firstScalar(entry.anidb_id);
  const isAnime = Boolean(mal || kitsu || anilist || anidb);

  const hints = {};
  if (entry.season && typeof entry.season === 'object') {
    hints.fribbSeason = entry.season;
  }

  return {
    tmdb_id: mapTmdbId(entry),
    tvdb_id: firstScalar(entry.tvdb_id),
    mal_id: mal,
    kitsu_id: kitsu,
    anilist_id: anilist,
    anidb_id: anidb,
    media_type: mapMediaType(entry),
    category: isAnime ? 'anime' : 'unknown',
    primary_title: null,
    titles: { synonyms: [] },
    hints,
    sources: [SOURCE],
    updated_at: new Date().toISOString(),
  };
}

function rowFromFribbImdb(entry) {
  const imdbId = firstImdbId(entry);
  if (!imdbId) return null;
  return { imdb_id: imdbId, ...baseRowFromFribb(entry) };
}

function rowFromFribbMalOnly(entry) {
  if (firstImdbId(entry)) return null;
  const mal = firstScalar(entry.mal_id);
  if (!mal) return null;
  return { imdb_id: null, ...baseRowFromFribb(entry) };
}

function mergeTitleRow(existing, row) {
  for (const field of ['tmdb_id', 'tvdb_id', 'mal_id', 'kitsu_id', 'anilist_id', 'anidb_id']) {
    if (!existing[field] && row[field]) existing[field] = row[field];
  }
  if (!existing.sources.includes(SOURCE)) existing.sources.push(SOURCE);
  if (existing.category === 'unknown' && row.category === 'anime') existing.category = 'anime';
  existing.hints = { ...existing.hints, ...row.hints };
}

async function downloadFribb() {
  console.log(`[ingest-fribb] downloading ${FRIBB_URL}`);
  const res = await fetch(FRIBB_URL, {
    headers: { Accept: 'application/json', 'User-Agent': 'Personal-ingest/1.0' },
  });
  if (!res.ok) throw new Error(`Fribb download failed: ${res.status}`);
  return res.json();
}

async function ingestBatchRpc(supabaseUrl, key, rows) {
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/personal_ingest_title_rows`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ rows }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`RPC personal_ingest_title_rows failed ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

async function upsertBatchRest(supabaseUrl, key, rows) {
  const res = await fetch(`${supabaseUrl}/rest/v1/personal_titles?on_conflict=imdb_id`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows.filter(r => r.imdb_id)),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Upsert failed ${res.status}: ${body.slice(0, 500)}`);
  }
}

async function ingestBatch(supabaseUrl, key, rows, useRpc) {
  if (useRpc) {
    return ingestBatchRpc(supabaseUrl, key, rows);
  }
  await upsertBatchRest(supabaseUrl, key, rows);
  return rows.length;
}

async function recordIngestMeta(supabaseUrl, key, rowCount, etag) {
  const payload = {
    source: SOURCE,
    etag: etag || null,
    row_count: rowCount,
    last_success_at: new Date().toISOString(),
    last_error: null,
  };
  const res = await fetch(`${supabaseUrl}/rest/v1/personal_ingest_meta?on_conflict=source`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    console.warn(`[ingest-fribb] ingest_meta update failed: ${res.status} ${body.slice(0, 200)}`);
  }
}

async function main() {
  const imdbOnly = process.argv.includes('--imdb-only');
  const malOnly = process.argv.includes('--mal-only');
  const includeImdb = malOnly ? false : true;
  const includeMal = imdbOnly ? false : true;

  const supabaseUrl = requireEnv('SUPABASE_URL').replace(/\/$/, '');
  const key = supabaseKey();
  if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY');

  const list = await downloadFribb();
  if (!Array.isArray(list)) throw new Error('Fribb JSON is not an array');

  const byImdb = new Map();
  const byMalOnly = new Map();
  let skippedNoIds = 0;

  for (const entry of list) {
    if (includeImdb) {
      const imdbRow = rowFromFribbImdb(entry);
      if (imdbRow) {
        const existing = byImdb.get(imdbRow.imdb_id);
        if (!existing) byImdb.set(imdbRow.imdb_id, imdbRow);
        else mergeTitleRow(existing, imdbRow);
      }
    }

    if (includeMal) {
      const malRow = rowFromFribbMalOnly(entry);
      if (malRow?.mal_id) {
        const existing = byMalOnly.get(malRow.mal_id);
        if (!existing) byMalOnly.set(malRow.mal_id, malRow);
        else mergeTitleRow(existing, malRow);
      }
    }

    if (!firstImdbId(entry) && !firstScalar(entry.mal_id)) skippedNoIds++;
  }

  const rows = [...byImdb.values(), ...byMalOnly.values()];
  const useRpc = includeMal || Boolean(process.env.SUPABASE_ANON_KEY);

  console.log(
    `[ingest-fribb] ${list.length} fribb entries → ${byImdb.size} imdb + ${byMalOnly.size} mal-only` +
      ` = ${rows.length} rows (skipped ${skippedNoIds} without ids)` +
      ` | rpc=${useRpc}`
  );

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const result = await ingestBatch(supabaseUrl, key, batch, useRpc);
    console.log(
      `[ingest-fribb] upserted ${Math.min(i + BATCH_SIZE, rows.length)} / ${rows.length}` +
        (useRpc ? ` (rpc processed ${result})` : '')
    );
  }

  await recordIngestMeta(supabaseUrl, key, rows.length, null);
  console.log('[ingest-fribb] done');
}

main().catch((err) => {
  console.error('[ingest-fribb] fatal:', err.message);
  process.exit(1);
});
