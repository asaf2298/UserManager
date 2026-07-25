#!/usr/bin/env node
/**
 * Build compact AniBridge range rows and write JSON batches for Supabase RPC ingest.
 * Used when SERVICE_ROLE_KEY is unavailable — batches are loaded via personal_ingest_episode_rows().
 *
 * Usage:
 *   node scripts/generate-anibridge-batches.mjs [--out-dir /tmp/anibridge-batches]
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import fetch from 'node-fetch';
import {
  isSimpleTargetRange,
  parseDescriptor,
  seasonFromScope,
} from '../lib/episodeRanges.js';

const MAPPINGS_URL =
  'https://github.com/anibridge/anibridge-mappings/releases/download/v3/mappings.min.json';
const FRIBB_URL =
  'https://raw.githubusercontent.com/Fribb/anime-lists/refs/heads/master/anime-list-full.json';
const BATCH_SIZE = 4000;
const SOURCE = 'anibridge';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function firstScalar(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return firstScalar(value[0]);
  return value;
}

async function downloadJson(url, label) {
  console.log(`[generate-anibridge] downloading ${label}`);
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
      select: 'imdb_id,tvdb_id,tmdb_id',
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
    if (!res.ok) throw new Error(`personal_titles fetch ${res.status}`);
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

function parseClosedRange(range) {
  const m = String(range || '').trim().match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] !== undefined ? Number(m[2]) : start;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { start, end };
}

function collectSourceDescriptors(title) {
  const out = [];
  const { imdb_id: imdb, tvdb_id: tvdb, tmdb_id: tmdb } = title;
  if (tvdb) for (let s = 0; s <= 30; s++) out.push(`tvdb_show:${tvdb}:s${s}`);
  if (tmdb) for (let s = 0; s <= 30; s++) out.push(`tmdb_show:${tmdb}:s${s}`);
  if (imdb) for (let s = 0; s <= 30; s++) out.push(`imdb_show:${imdb}:s${s}`);
  return out;
}

function buildRangeRows(mappings, titles, malToKitsu) {
  const byKey = new Map();

  const put = (row) => {
    const key = `${row.imdb_id}|${row.from_s}|${row.from_e}|${row.to_s}|${row.scheme_to}|${row.to_provider_id}`;
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
        if (tgt.provider !== 'mal') continue;
        if (!rules || typeof rules !== 'object') continue;

        for (const [srcRange, tgtRange] of Object.entries(rules)) {
          if (!isSimpleTargetRange(tgtRange)) continue;
          const src = parseClosedRange(srcRange);
          const trg = parseClosedRange(String(tgtRange).trim());
          if (!src || !trg) continue;
          if (src.end - src.start !== trg.end - trg.start) continue;

          const malId = Number(tgt.id);
          if (!Number.isFinite(malId)) continue;

          put({
            imdb_id: imdb,
            scheme_from: 'stremio_sxe',
            scheme_to: 'mal',
            from_s: fromS,
            from_e: src.start,
            to_s: src.end,
            to_e: trg.start,
            to_provider_id: malId,
            source: SOURCE,
          });

          const kitsuId = malToKitsu.get(malId);
          if (kitsuId) {
            put({
              imdb_id: imdb,
              scheme_from: 'stremio_sxe',
              scheme_to: 'kitsu',
              from_s: fromS,
              from_e: src.start,
              to_s: src.end,
              to_e: trg.start,
              to_provider_id: kitsuId,
              source: SOURCE,
            });
          }
        }
      }
    }
  }

  return [...byKey.values()];
}

async function main() {
  const outDir = process.argv.includes('--out-dir')
    ? process.argv[process.argv.indexOf('--out-dir') + 1]
    : '/tmp/anibridge-batches';

  const supabaseUrl = requireEnv('SUPABASE_URL').replace(/\/$/, '');
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Need SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY');

  const [mappings, fribbList, titles] = await Promise.all([
    downloadJson(MAPPINGS_URL, 'anibridge mappings'),
    downloadJson(FRIBB_URL, 'fribb'),
    fetchPersonalTitles(supabaseUrl, key),
  ]);

  const malToKitsu = buildMalToKitsuMap(fribbList);
  const rows = buildRangeRows(mappings, titles, malToKitsu);

  mkdirSync(outDir, { recursive: true });
  const manifest = { total: rows.length, batchSize: BATCH_SIZE, batches: [] };

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const name = `batch-${String(Math.floor(i / BATCH_SIZE)).padStart(3, '0')}.json`;
    writeFileSync(join(outDir, name), JSON.stringify(batch));
    manifest.batches.push(name);
  }

  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const rezero = rows.filter(r => r.imdb_id === 'tt5607616' && r.from_s === 2);
  console.log(
    `[generate-anibridge] ${rows.length} compact range rows → ${manifest.batches.length} batches in ${outDir}` +
      ` | Re:Zero S2 rules: ${JSON.stringify(rezero.slice(0, 4))}`
  );
}

main().catch((err) => {
  console.error('[generate-anibridge] fatal:', err.message);
  process.exit(1);
});
