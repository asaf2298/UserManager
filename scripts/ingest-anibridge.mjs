#!/usr/bin/env node
/**
 * Ingest AniBridge v3 mappings → personal_episode_map (Phase 3).
 *
 * Expands tvdb/tmdb/imdb season → mal episode rows, then mirrors kitsu via Fribb mal→kitsu.
 *
 * Usage:
 *   node --env-file=.env.local scripts/ingest-anibridge.mjs
 *
 * Requires:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
import fetch from 'node-fetch';
import {
  expandSimpleRule,
  parseDescriptor,
  seasonFromScope,
} from '../lib/episodeRanges.js';

const MAPPINGS_URL =
  'https://github.com/anibridge/anibridge-mappings/releases/download/v3/mappings.min.json';
const FRIBB_URL =
  'https://raw.githubusercontent.com/Fribb/anime-lists/refs/heads/master/anime-list-full.json';
const BATCH_SIZE = 500;
const SOURCE = 'anibridge';
const TARGET_PROVIDERS = new Set(['mal']);

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

function firstScalar(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return firstScalar(value[0]);
  return value;
}

async function downloadJson(url, label) {
  console.log(`[ingest-anibridge] downloading ${label}`);
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Personal-ingest/1.0' },
  });
  if (!res.ok) throw new Error(`${label} download failed: ${res.status}`);
  return res.json();
}

async function fetchPersonalTitles(supabaseUrl, key) {
  const rows = [];
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const params = new URLSearchParams({
      select: 'imdb_id,tvdb_id,tmdb_id,mal_id,kitsu_id,category',
      limit: String(pageSize),
      offset: String(offset),
    });
    const res = await fetch(`${supabaseUrl}/rest/v1/personal_titles?${params}`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) throw new Error(`personal_titles fetch ${res.status}: ${await res.text()}`);
    const batch = await res.json();
    if (!Array.isArray(batch) || !batch.length) break;
    rows.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

function buildMalToKitsuMap(fribbList) {
  const map = new Map();
  for (const entry of fribbList) {
    const mal = firstScalar(entry.mal_id);
    const kitsu = firstScalar(entry.kitsu_id);
    if (mal && kitsu && !map.has(mal)) map.set(mal, kitsu);
  }
  return map;
}

function collectSourceDescriptors(title) {
  const out = [];
  const { imdb_id: imdb, tvdb_id: tvdb, tmdb_id: tmdb } = title;
  if (tvdb) {
    for (let s = 0; s <= 30; s++) out.push(`tvdb_show:${tvdb}:s${s}`);
  }
  if (tmdb) {
    for (let s = 0; s <= 30; s++) out.push(`tmdb_show:${tmdb}:s${s}`);
  }
  if (imdb) {
    for (let s = 0; s <= 30; s++) out.push(`imdb_show:${imdb}:s${s}`);
  }
  return out;
}

function episodeRowsFromMappings(mappings, titles, malToKitsu) {
  /** @type {Map<string, object>} */
  const byKey = new Map();

  const put = (row) => {
    const key = `${row.imdb_id}|${row.from_s}|${row.from_e}|${row.scheme_to}`;
    if (!byKey.has(key)) byKey.set(key, row);
  };

  for (const title of titles) {
    const imdb = title.imdb_id;
    if (!imdb) continue;

    for (const srcDesc of collectSourceDescriptors(title)) {
      const targets = mappings[srcDesc];
      if (!targets || typeof targets !== 'object') continue;

      const { scope } = parseDescriptor(srcDesc);
      const fromS = seasonFromScope(scope);
      if (fromS === null) continue;

      for (const [tgtDesc, rules] of Object.entries(targets)) {
        const tgt = parseDescriptor(tgtDesc);
        if (!TARGET_PROVIDERS.has(tgt.provider)) continue;
        if (!rules || typeof rules !== 'object') continue;

        for (const [srcRange, tgtRange] of Object.entries(rules)) {
          const pairs = expandSimpleRule(srcRange, tgtRange);
          for (const { from_e, to_e } of pairs) {
            const malId = Number(tgt.id);
            if (!Number.isFinite(malId)) continue;

            put({
              imdb_id: imdb,
              scheme_from: 'stremio_sxe',
              scheme_to: 'mal',
              from_s: fromS,
              from_e,
              to_s: null,
              to_e,
              to_provider_id: malId,
              absolute: null,
              range_note: `${srcDesc} → ${tgtDesc} ${srcRange}→${tgtRange}`.slice(0, 240),
              source: SOURCE,
            });

            const kitsuId = malToKitsu.get(malId);
            if (kitsuId) {
              put({
                imdb_id: imdb,
                scheme_from: 'stremio_sxe',
                scheme_to: 'kitsu',
                from_s: fromS,
                from_e,
                to_s: null,
                to_e,
                to_provider_id: kitsuId,
                absolute: null,
                range_note: `fribb mal:${malId}→kitsu:${kitsuId} (${srcDesc})`.slice(0, 240),
                source: SOURCE,
              });
            }
          }
        }
      }
    }
  }

  return [...byKey.values()];
}

async function deleteAnibridgeRows(supabaseUrl, key) {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/personal_episode_map?source=eq.${SOURCE}`,
    {
      method: 'DELETE',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'return=minimal',
      },
    }
  );
  if (!res.ok && res.status !== 404) {
    const body = await res.text();
    throw new Error(`Delete anibridge rows failed ${res.status}: ${body.slice(0, 300)}`);
  }
}

async function insertBatch(supabaseUrl, key, rows) {
  const res = await fetch(`${supabaseUrl}/rest/v1/personal_episode_map`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Upsert failed ${res.status}: ${body.slice(0, 500)}`);
  }
}

async function recordIngestMeta(supabaseUrl, key, rowCount) {
  const payload = {
    source: SOURCE,
    etag: null,
    row_count: rowCount,
    last_success_at: new Date().toISOString(),
    last_error: null,
  };
  await fetch(`${supabaseUrl}/rest/v1/personal_ingest_meta?on_conflict=source`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(payload),
  });
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const supabaseUrl = requireEnv('SUPABASE_URL').replace(/\/$/, '');
  const key = dryRun ? null : requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  const [mappings, fribbList, titles] = await Promise.all([
    downloadJson(MAPPINGS_URL, 'anibridge mappings'),
    downloadJson(FRIBB_URL, 'fribb'),
    dryRun
      ? Promise.resolve([]) // dry-run loads titles from Supabase only if key present
      : fetchPersonalTitles(supabaseUrl, key),
  ]);

  let titleRows = titles;
  if (dryRun && process.env.SUPABASE_ANON_KEY) {
    titleRows = await fetchPersonalTitles(supabaseUrl, process.env.SUPABASE_ANON_KEY);
  }

  const malToKitsu = buildMalToKitsuMap(fribbList);
  const rows = episodeRowsFromMappings(mappings, titleRows, malToKitsu);

  const rezero = rows.filter(r => r.imdb_id === 'tt5607616' && r.from_s === 2 && r.from_e === 1);
  console.log(
    `[ingest-anibridge] ${titleRows.length} titles → ${rows.length} episode rows` +
      ` | mal→kitsu pairs ${malToKitsu.size}` +
      ` | Re:Zero S2E1 sample: ${JSON.stringify(rezero)}`
  );

  if (dryRun) {
    console.log('[ingest-anibridge] dry-run — no database writes');
    return;
  }

  console.log('[ingest-anibridge] clearing previous anibridge rows…');
  await deleteAnibridgeRows(supabaseUrl, key);

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await insertBatch(supabaseUrl, key, batch);
    console.log(`[ingest-anibridge] upserted ${Math.min(i + BATCH_SIZE, rows.length)} / ${rows.length}`);
  }

  await recordIngestMeta(supabaseUrl, key, rows.length);
  console.log('[ingest-anibridge] done');
}

main().catch((err) => {
  console.error('[ingest-anibridge] fatal:', err.message);
  process.exit(1);
});
