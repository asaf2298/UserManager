#!/usr/bin/env node
/**
 * Build Manami synonym rows for personal_akas (+ origin_countries updates).
 *
 * Matches Manami → personal_titles via MAL id. Prefers origin-language synonyms:
 *   JP → ja + romaji, KR → ko + romanization, CN/TW → zh + pinyin
 *
 * Usage:
 *   node scripts/generate-manami-batches.mjs [--out-dir /tmp/manami-batches]
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import fetch from 'node-fetch';
import {
  detectTitleLanguage,
  inferOriginCountriesFromManamiTags,
  preferredAliasLanguages,
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

function regionForLang(language, origins) {
  if (language === 'ja') return 'JP';
  if (language === 'ko') return 'KR';
  if (language === 'zh') {
    if (origins.includes('TW')) return 'TW';
    if (origins.includes('HK')) return 'HK';
    return 'CN';
  }
  return origins[0] || null;
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
  const originUpdates = [];
  const seen = new Set();
  let matched = 0;
  let skippedNoImdb = 0;
  let droppedForeign = 0;
  const langCounts = {};
  const originCounts = { JP: 0, KR: 0, CN: 0, TW: 0, other: 0 };

  for (const entry of manamiData) {
    const mal = malFromSources(entry.sources);
    if (!mal) continue;
    const link = malToImdb.get(mal);
    if (!link) {
      skippedNoImdb++;
      continue;
    }
    matched++;

    const inferred = inferOriginCountriesFromManamiTags(entry.tags);
    // Prefer Manami production tags; fall back to existing row / JP for anime
    const origins = inferred.length
      ? inferred
      : (link.origin_countries?.length ? link.origin_countries : (link.category === 'anime' ? ['JP'] : []));
    const preferredLangs = preferredAliasLanguages({
      category: link.category,
      origin_countries: origins,
    });

    if (origins.includes('KR')) originCounts.KR++;
    else if (origins.includes('TW')) originCounts.TW++;
    else if (origins.includes('CN')) originCounts.CN++;
    else if (origins.includes('JP')) originCounts.JP++;
    else originCounts.other++;

    if (inferred.length) {
      originUpdates.push({ imdb_id: link.imdb_id, origin_countries: inferred });
    }

    const candidates = [];
    if (isUsefulAlias(entry.title)) {
      const language = detectTitleLanguage(entry.title) || 'latin';
      candidates.push({
        title: entry.title.trim(),
        kind: 'display',
        language,
        weight: aliasIngestWeight('display', language, preferredLangs),
      });
    }
    for (const syn of entry.synonyms || []) {
      if (!isUsefulAlias(syn)) continue;
      const title = syn.trim();
      const language = detectTitleLanguage(title) || 'other';
      if (!shouldKeepAnimeAlias('synonym', language, title, preferredLangs)) {
        droppedForeign++;
        continue;
      }
      candidates.push({
        title,
        kind: 'synonym',
        language,
        weight: aliasIngestWeight('synonym', language, preferredLangs),
      });
    }

    candidates.sort((a, b) => b.weight - a.weight || a.title.localeCompare(b.title));

    const used = new Set();
    if (link.primary_title) used.add(normalizeTitle(link.primary_title));

    let added = 0;
    let addedNative = 0;
    let addedLatin = 0;
    const nativeLangs = new Set(preferredLangs.filter(l => l !== 'latin'));

    for (const c of candidates) {
      const key = `${link.imdb_id}|${normalizeTitle(c.title)}|${c.kind}`;
      if (seen.has(key) || used.has(normalizeTitle(c.title))) continue;
      if (c.language === 'latin' && c.kind === 'synonym' && addedLatin >= 3) continue;
      if (nativeLangs.has(c.language) && addedNative >= 4) continue;

      seen.add(key);
      used.add(normalizeTitle(c.title));
      rows.push({
        imdb_id: link.imdb_id,
        title: c.title,
        kind: c.kind,
        weight: c.weight,
        language: c.language,
        region: regionForLang(c.language, origins),
        source: SOURCE,
      });
      langCounts[c.language] = (langCounts[c.language] || 0) + 1;
      if (nativeLangs.has(c.language)) addedNative++;
      if (c.language === 'latin') addedLatin++;
      added++;
      if (added >= MAX_SYNONYMS_PER_TITLE) break;
    }
  }

  return { rows, originUpdates, matched, skippedNoImdb, droppedForeign, langCounts, originCounts };
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

  const {
    rows, originUpdates, matched, skippedNoImdb, droppedForeign, langCounts, originCounts,
  } = buildAkaRows(manamiData, malToImdb);

  console.log(
    `[generate-manami] ${manamiData.length} manami entries | mal→imdb map=${malToImdb.size}` +
      ` | matched=${matched} skippedNoImdb=${skippedNoImdb} droppedForeign=${droppedForeign}` +
      ` | aka rows=${rows.length} langs=${JSON.stringify(langCounts)}` +
      ` | origins=${JSON.stringify(originCounts)} originUpdates=${originUpdates.length}`
  );

  mkdirSync(outDir, { recursive: true });
  const batches = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const name = `batch-${String(Math.floor(i / BATCH_SIZE)).padStart(4, '0')}.json`;
    writeFileSync(join(outDir, name), JSON.stringify(batch));
    batches.push({ file: name, count: batch.length });
  }

  // Origin country updates (dedupe by imdb_id — last write wins)
  const byImdb = new Map();
  for (const u of originUpdates) byImdb.set(u.imdb_id, u);
  const originRows = [...byImdb.values()];
  writeFileSync(join(outDir, 'origin-updates.json'), JSON.stringify(originRows));

  const manifest = {
    source: SOURCE,
    generatedAt: new Date().toISOString(),
    totalRows: rows.length,
    batchSize: BATCH_SIZE,
    batches,
    originUpdates: originRows.length,
    rpc: 'personal_ingest_aka_rows',
    originRpc: 'personal_set_origin_countries',
    langCounts,
    originCounts,
    droppedForeign,
  };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`[generate-manami] wrote ${batches.length} batches + ${originRows.length} origin updates to ${outDir}`);
}

main().catch((err) => {
  console.error('[generate-manami] fatal:', err.message);
  process.exit(1);
});
