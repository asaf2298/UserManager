#!/usr/bin/env node
/**
 * Ingest Fribb anime-list-full.json into personal_titles (Phase 1).
 *
 * Usage:
 *   node --env-file=.env.local scripts/ingest-fribb.mjs
 *
 * Requires:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
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

function mapTmdbId(entry) {
  const tmdb = entry.themoviedb_id;
  if (!tmdb || typeof tmdb !== 'object') return null;
  return tmdb.tv ?? tmdb.movie ?? null;
}

function rowFromFribb(entry) {
  const imdbId = firstImdbId(entry);
  if (!imdbId) return null;

  const mal = entry.mal_id ?? null;
  const kitsu = entry.kitsu_id ?? null;
  const anilist = entry.anilist_id ?? null;
  const anidb = entry.anidb_id ?? null;
  const isAnime = Boolean(mal || kitsu || anilist || anidb);

  const hints = {};
  if (entry.season && typeof entry.season === 'object') {
    hints.fribbSeason = entry.season;
  }

  return {
    imdb_id: imdbId,
    tmdb_id: mapTmdbId(entry),
    tvdb_id: entry.tvdb_id ?? null,
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

async function downloadFribb() {
  console.log(`[ingest-fribb] downloading ${FRIBB_URL}`);
  const res = await fetch(FRIBB_URL, {
    headers: { Accept: 'application/json', 'User-Agent': 'Personal-ingest/1.0' },
  });
  if (!res.ok) throw new Error(`Fribb download failed: ${res.status}`);
  return res.json();
}

async function upsertBatch(supabaseUrl, key, rows) {
  const res = await fetch(`${supabaseUrl}/rest/v1/personal_titles?on_conflict=imdb_id`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Upsert failed ${res.status}: ${body.slice(0, 500)}`);
  }
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
  const supabaseUrl = requireEnv('SUPABASE_URL').replace(/\/$/, '');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  const list = await downloadFribb();
  if (!Array.isArray(list)) throw new Error('Fribb JSON is not an array');

  const byImdb = new Map();
  let skippedNoImdb = 0;
  for (const entry of list) {
    const row = rowFromFribb(entry);
    if (!row) {
      skippedNoImdb++;
      continue;
    }
    const existing = byImdb.get(row.imdb_id);
    if (!existing) {
      byImdb.set(row.imdb_id, row);
      continue;
    }
    // Merge sibling Fribb cour rows onto one imdb show key (keep richest ids).
    for (const field of ['tmdb_id', 'tvdb_id', 'mal_id', 'kitsu_id', 'anilist_id', 'anidb_id']) {
      if (!existing[field] && row[field]) existing[field] = row[field];
    }
    if (!existing.sources.includes(SOURCE)) existing.sources.push(SOURCE);
    if (existing.category === 'unknown' && row.category === 'anime') existing.category = 'anime';
  }

  const rows = [...byImdb.values()];
  console.log(
    `[ingest-fribb] ${list.length} fribb entries → ${rows.length} imdb rows (skipped ${skippedNoImdb} without imdb)`
  );

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await upsertBatch(supabaseUrl, key, batch);
    console.log(`[ingest-fribb] upserted ${Math.min(i + BATCH_SIZE, rows.length)} / ${rows.length}`);
  }

  await recordIngestMeta(supabaseUrl, key, rows.length, null);
  console.log('[ingest-fribb] done');
}

main().catch((err) => {
  console.error('[ingest-fribb] fatal:', err.message);
  process.exit(1);
});
