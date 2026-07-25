#!/usr/bin/env node
/**
 * Build Manami synonym rows for personal_akas and write JSON batches for RPC ingest.
 *
 * Matches Manami entries to personal_titles via MAL id. Only imdb-linked titles get aliases
 * (stream resolver is tt-keyed).
 *
 * Usage:
 *   node --env-file=.env.local scripts/generate-manami-batches.mjs [--out-dir /tmp/manami-batches]
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import fetch from 'node-fetch';

const MANAMI_URL =
  'https://github.com/manami-project/anime-offline-database/releases/download/2026-27/anime-offline-database-minified.json';
const BATCH_SIZE = 2000;
const SOURCE = 'manami';
const MAX_SYNONYMS_PER_TITLE = 8;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function supabaseKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || null;
}

function malFromSources(sources) {
  if (!Array.isArray(sources)) return null;
  for (const url of sources) {
    const m = String(url).match(/myanimelist\.net\/anime\/(\d+)/i);
    if (m) return Number(m[1]);
  }
  return null;
}

function normalizeTitle(title) {
  return String(title || '').trim().toLowerCase();
}

function isUsefulAlias(title) {
  const t = String(title || '').trim();
  if (t.length < 2 || t.length > 120) return false;
  if (/^https?:\/\//i.test(t)) return false;
  return true;
}

async function downloadJson(url, label) {
  console.log(`[generate-manami] downloading ${label}`);
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Personal-ingest/1.0' },
  });
  if (!res.ok) throw new Error(`${label} download failed: ${res.status}`);
  return res.json();
}

async function fetchMalToImdb(supabaseUrl, key) {
  const map = new Map();
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const params = new URLSearchParams({
      select: 'imdb_id,mal_id,primary_title',
      imdb_id: 'not.is.null',
      mal_id: 'not.is.null',
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
    for (const row of batch) {
      if (row.mal_id && row.imdb_id) {
        map.set(row.mal_id, {
          imdb_id: row.imdb_id,
          primary_title: row.primary_title || null,
        });
      }
    }
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return map;
}

function buildAkaRows(manamiData, malToImdb) {
  const rows = [];
  const seen = new Set();
  let matched = 0;
  let skippedNoImdb = 0;

  for (const entry of manamiData) {
    const mal = malFromSources(entry.sources);
    if (!mal) continue;
    const link = malToImdb.get(mal);
    if (!link) {
      skippedNoImdb++;
      continue;
    }
    matched++;

    const candidates = [];
    if (isUsefulAlias(entry.title)) {
      candidates.push({ title: entry.title.trim(), kind: 'display', weight: 20 });
    }
    for (const syn of entry.synonyms || []) {
      if (!isUsefulAlias(syn)) continue;
      candidates.push({ title: syn.trim(), kind: 'synonym', weight: 10 });
    }

    const used = new Set();
    if (link.primary_title) used.add(normalizeTitle(link.primary_title));

    let added = 0;
    for (const c of candidates) {
      const key = `${link.imdb_id}|${normalizeTitle(c.title)}|${c.kind}`;
      if (seen.has(key) || used.has(normalizeTitle(c.title))) continue;
      seen.add(key);
      used.add(normalizeTitle(c.title));
      rows.push({
        imdb_id: link.imdb_id,
        title: c.title,
        kind: c.kind,
        weight: c.weight,
        language: null,
        region: null,
        source: SOURCE,
      });
      added++;
      if (added >= MAX_SYNONYMS_PER_TITLE) break;
    }
  }

  return { rows, matched, skippedNoImdb };
}

async function main() {
  const outDir = process.argv.includes('--out-dir')
    ? process.argv[process.argv.indexOf('--out-dir') + 1]
    : '/tmp/manami-batches';

  const supabaseUrl = requireEnv('SUPABASE_URL').replace(/\/$/, '');
  const key = supabaseKey();
  if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY');

  const [manamiJson, malToImdb] = await Promise.all([
    downloadJson(MANAMI_URL, 'manami'),
    fetchMalToImdb(supabaseUrl, key),
  ]);

  const manamiData = manamiJson.data || manamiJson;
  if (!Array.isArray(manamiData)) throw new Error('Manami JSON has no data array');

  const { rows, matched, skippedNoImdb } = buildAkaRows(manamiData, malToImdb);
  console.log(
    `[generate-manami] ${manamiData.length} manami entries | mal→imdb map=${malToImdb.size}` +
      ` | matched=${matched} skippedNoImdb=${skippedNoImdb} | aka rows=${rows.length}`
  );

  mkdirSync(outDir, { recursive: true });
  const batches = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const name = `batch-${String(Math.floor(i / BATCH_SIZE)).padStart(4, '0')}.json`;
    writeFileSync(join(outDir, name), JSON.stringify(batch));
    batches.push({ file: name, count: batch.length });
  }

  const manifest = {
    source: SOURCE,
    generatedAt: new Date().toISOString(),
    totalRows: rows.length,
    batchSize: BATCH_SIZE,
    batches,
    rpc: 'personal_ingest_aka_rows',
  };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`[generate-manami] wrote ${batches.length} batches to ${outDir}`);
}

main().catch((err) => {
  console.error('[generate-manami] fatal:', err.message);
  process.exit(1);
});
