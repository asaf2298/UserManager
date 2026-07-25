#!/usr/bin/env node
/**
 * Build Manami synonym rows for personal_akas and write JSON batches for RPC ingest.
 *
 * Matches Manami entries to personal_titles via MAL id. Only imdb-linked titles get aliases
 * (stream resolver is tt-keyed). Prefers origin-language synonyms (JP→ja + romaji for anime).
 *
 * Usage:
 *   node --env-file=.env.local scripts/generate-manami-batches.mjs [--out-dir /tmp/manami-batches]
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import fetch from 'node-fetch';
import {
  detectTitleLanguage,
  aliasIngestWeight,
  shouldKeepAnimeAlias,
} from '../lib/titleLanguage.js';

const MANAMI_URL =
  'https://github.com/manami-project/anime-offline-database/releases/download/2026-27/anime-offline-database-minified.json';
const BATCH_SIZE = 2000;
const SOURCE = 'manami';
const MAX_SYNONYMS_PER_TITLE = 10;

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
      select: 'imdb_id,mal_id,primary_title,category,origin_countries',
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
          category: row.category || 'anime',
          origin_countries: row.origin_countries || [],
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
  let droppedForeign = 0;
  const langCounts = {};

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
      const language = detectTitleLanguage(entry.title) || 'latin';
      candidates.push({
        title: entry.title.trim(),
        kind: 'display',
        language,
        weight: aliasIngestWeight('display', language),
      });
    }
    for (const syn of entry.synonyms || []) {
      if (!isUsefulAlias(syn)) continue;
      const title = syn.trim();
      const language = detectTitleLanguage(title) || 'other';
      // Anime / JP pool: keep native + romaji, drop random translations
      if (link.category === 'anime' || (link.origin_countries || []).includes('JP')) {
        if (!shouldKeepAnimeAlias('synonym', language, title)) {
          droppedForeign++;
          continue;
        }
      }
      candidates.push({
        title,
        kind: 'synonym',
        language,
        weight: aliasIngestWeight('synonym', language),
      });
    }

    // Prefer ja/native first, then display, then romaji
    candidates.sort((a, b) => b.weight - a.weight || a.title.localeCompare(b.title));

    const used = new Set();
    if (link.primary_title) used.add(normalizeTitle(link.primary_title));

    let added = 0;
    let addedJa = 0;
    let addedLatin = 0;
    for (const c of candidates) {
      const key = `${link.imdb_id}|${normalizeTitle(c.title)}|${c.kind}`;
      if (seen.has(key) || used.has(normalizeTitle(c.title))) continue;
      // Cap latin synonyms tighter so ja titles always fit
      if (c.language === 'latin' && c.kind === 'synonym' && addedLatin >= 3) continue;
      if (c.language === 'ja' && addedJa >= 4) continue;

      seen.add(key);
      used.add(normalizeTitle(c.title));
      rows.push({
        imdb_id: link.imdb_id,
        title: c.title,
        kind: c.kind,
        weight: c.weight,
        language: c.language,
        region: c.language === 'ja' ? 'JP' : null,
        source: SOURCE,
      });
      langCounts[c.language] = (langCounts[c.language] || 0) + 1;
      if (c.language === 'ja') addedJa++;
      if (c.language === 'latin') addedLatin++;
      added++;
      if (added >= MAX_SYNONYMS_PER_TITLE) break;
    }
  }

  return { rows, matched, skippedNoImdb, droppedForeign, langCounts };
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

  const { rows, matched, skippedNoImdb, droppedForeign, langCounts } = buildAkaRows(manamiData, malToImdb);
  console.log(
    `[generate-manami] ${manamiData.length} manami entries | mal→imdb map=${malToImdb.size}` +
      ` | matched=${matched} skippedNoImdb=${skippedNoImdb} droppedForeign=${droppedForeign}` +
      ` | aka rows=${rows.length} langs=${JSON.stringify(langCounts)}`
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
    langCounts,
    droppedForeign,
  };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`[generate-manami] wrote ${batches.length} batches to ${outDir}`);
}

main().catch((err) => {
  console.error('[generate-manami] fatal:', err.message);
  process.exit(1);
});
