import fetch from 'node-fetch';
import https from 'https';

const keepAliveAgent = new https.Agent({ keepAlive: true });
const metaCache = new Map();
const MAX_CACHE_SIZE = 500;

/**
 * A cold-cache TMDB timeout used to cache an all-null meta permanently for
 * that warm instance (#59) -- every later request for the title then got no
 * titles and a null runtime, pinning the match-confidence Z feature and
 * disabling the subtitle duration match. Good lookups still cache for hours;
 * failed/empty ones expire quickly so a transient timeout self-heals.
 */
const META_TTL_OK_MS = 6 * 60 * 60 * 1000;
const META_TTL_FAIL_MS = 45 * 1000;

const DUBBED_HE_RE = /דיבוב|מדובב|מדובבת|מדובבים/;

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { agent: keepAliveAgent, ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function emptyMeta() {
  return {
    en: null, he: null, ru: null, original: null, year: null, runtimeMin: null,
    // ISO-639-1 code of the production language. Drives the embedded-subtitle
    // reference priority for auto-sync and language relevance for ranking.
    originalLanguage: null,
  };
}

/**
 * Pull multi-language titles + year + runtime from TMDB via IMDb id.
 * Uses language=en|he|ru so regional addons (Yuki, Israeli trackers, etc.) can match.
 */
async function getMetaFromTMDB(imdbId, type) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    console.log(`[META HELPER] ⚠️ TMDB_API_KEY לא מוגדר בסביבה (Env).`);
    return null;
  }

  try {
    const findUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${apiKey}&external_source=imdb_id`;
    // Tightened from 3500ms (#59): metadata is now raced against META_BUDGET_MS
    // upstream, so a slow TMDB find must not eat most of that budget alone.
    const findRes = await fetchWithTimeout(findUrl, { headers: { 'Accept': 'application/json' } }, 2000);
    if (!findRes.ok) return null;
    const findData = await findRes.json();

    const movie = findData.movie_results?.[0];
    const tvShow = findData.tv_results?.[0];
    const isMovie = !!movie;
    const tmdbId = movie?.id || tvShow?.id;
    if (!tmdbId) return null;

    const mediaPath = isMovie ? 'movie' : 'tv';
    const meta = emptyMeta();
    meta.en = movie?.title || tvShow?.name || null;
    meta.original = movie?.original_title || tvShow?.original_name || null;
    meta.originalLanguage = normalizeLanguageCode(movie?.original_language || tvShow?.original_language);
    meta.year = parseYear(movie?.release_date || tvShow?.first_air_date);

    // Parallel language lookups for he/ru + full details for runtime
    const [heRes, ruRes, detailRes] = await Promise.all([
      fetchWithTimeout(
        `https://api.themoviedb.org/3/${mediaPath}/${tmdbId}?api_key=${apiKey}&language=he`,
        { headers: { 'Accept': 'application/json' } },
        1500
      ).catch(() => null),
      fetchWithTimeout(
        `https://api.themoviedb.org/3/${mediaPath}/${tmdbId}?api_key=${apiKey}&language=ru`,
        { headers: { 'Accept': 'application/json' } },
        1500
      ).catch(() => null),
      fetchWithTimeout(
        `https://api.themoviedb.org/3/${mediaPath}/${tmdbId}?api_key=${apiKey}&language=en`,
        { headers: { 'Accept': 'application/json' } },
        1500
      ).catch(() => null)
    ]);

    if (heRes?.ok) {
      const heData = await heRes.json();
      meta.he = heData.title || heData.name || null;
    }
    if (ruRes?.ok) {
      const ruData = await ruRes.json();
      meta.ru = ruData.title || ruData.name || null;
    }
    if (detailRes?.ok) {
      const detail = await detailRes.json();
      if (!meta.en) meta.en = detail.title || detail.name || null;
      if (!meta.original) meta.original = detail.original_title || detail.original_name || null;
      if (!meta.originalLanguage) meta.originalLanguage = normalizeLanguageCode(detail.original_language);
      if (!meta.year) meta.year = parseYear(detail.release_date || detail.first_air_date);
      if (isMovie && detail.runtime) {
        meta.runtimeMin = Number(detail.runtime) || null;
      } else if (!isMovie && Array.isArray(detail.episode_run_time) && detail.episode_run_time.length) {
        meta.runtimeMin = Number(detail.episode_run_time[0]) || null;
      }
    }

    console.log(
      `[META HELPER] 🎬 TMDB ${isMovie ? 'movie' : 'tv'} id=${tmdbId}` +
      ` en="${meta.en}" he="${meta.he}" ru="${meta.ru}" orig="${meta.original}"` +
      ` origLang=${meta.originalLanguage ?? 'unknown'}` +
      ` year=${meta.year} runtime=${meta.runtimeMin}m`
    );
    return meta;
  } catch (e) {
    console.error(`[META HELPER] 💥 שגיאה בפנייה ל-TMDB:`, e.message);
    return null;
  }
}

function parseYear(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const y = parseInt(dateStr.slice(0, 4), 10);
  return Number.isFinite(y) && y > 1880 ? y : null;
}

/** TMDB returns ISO-639-1; keep only well-formed two-letter codes. */
function normalizeLanguageCode(code) {
  const clean = String(code || '').trim().toLowerCase().slice(0, 2);
  return /^[a-z]{2}$/.test(clean) ? clean : null;
}

async function getMetaFromCinemeta(type, id) {
  try {
    const response = await fetchWithTimeout(
      `https://v3-cinemeta.strem.io/meta/${type}/${id}.json`,
      { headers: { 'Accept': 'application/json' } },
      1500
    );
    if (!response.ok) return null;
    const data = await response.json();
    const m = data.meta;
    if (!m) return null;
    const meta = emptyMeta();
    meta.en = m.name || null;
    meta.original = m.name || null;
    meta.year = m.year ? parseInt(String(m.year).slice(0, 4), 10) : parseYear(m.released || m.releaseInfo);
    if (m.runtime) {
      const match = String(m.runtime).match(/(\d+)/);
      if (match) meta.runtimeMin = parseInt(match[1], 10);
    }
    return meta;
  } catch (e) {
    return null;
  }
}

function cacheSet(key, value, ttlMs) {
  if (metaCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = metaCache.keys().next().value;
    metaCache.delete(oldestKey);
  }
  metaCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/**
 * Full metadata bundle for scoring + multi-lang text search.
 * @returns {{ en, he, ru, original, year, runtimeMin }}
 */
export async function getContentMeta(type, id) {
  const baseId = String(id).split(':')[0];
  const cached = metaCache.get(baseId);
  if (cached && cached.expiresAt > Date.now()) {
    console.log(`[META HELPER] ⚡ מטא-דאטה מהזיכרון עבור ${baseId}`);
    return cached.value;
  }

  let meta = null;
  if (baseId.startsWith('tt')) {
    meta = await getMetaFromTMDB(baseId, type);
  }
  if (!meta || (!meta.en && !meta.original)) {
    console.log(`[META HELPER] 🔄 פונה ל-Cinemeta כפולבק עבור: ${baseId}`);
    const cine = await getMetaFromCinemeta(type, baseId);
    if (cine) {
      meta = meta ? { ...cine, ...Object.fromEntries(Object.entries(meta).filter(([, v]) => v != null)) } : cine;
      // Prefer non-null from TMDB over Cinemeta when both exist
      if (meta) {
        for (const k of Object.keys(cine)) {
          if (meta[k] == null && cine[k] != null) meta[k] = cine[k];
        }
      }
    }
  }

  meta = meta || emptyMeta();
  const usable = !!(meta.en || meta.original || meta.he);
  cacheSet(baseId, meta, usable ? META_TTL_OK_MS : META_TTL_FAIL_MS);
  return meta;
}

/**
 * Ordered list of distinct search titles.
 * When query hints dubbed Hebrew content (דיבוב / מדובב), Hebrew titles go first.
 */
export function buildSearchTitles(meta, queryHint = '') {
  if (!meta) return [];
  const preferHebrew = DUBBED_HE_RE.test(queryHint || '');
  const ordered = preferHebrew
    ? [meta.he, meta.en, meta.original, meta.ru]
    : [meta.en, meta.original, meta.he, meta.ru];

  const seen = new Set();
  const out = [];
  for (const t of ordered) {
    const clean = (t || '').trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  if (preferHebrew) {
    console.log(`[META HELPER] 🇮🇱 זוהה דיבוב בבקשה — מעדיף כותרות בעברית לחיפוש טקסט`);
  }
  return out;
}

/**
 * Backward-compatible single English (or best) title helper.
 */
export async function getCleanMovieName(type, id) {
  const meta = await getContentMeta(type, id);
  return meta.en || meta.original || meta.he || meta.ru || null;
}

export function isDubbedQuery(text) {
  return DUBBED_HE_RE.test(text || '');
}

/**
 * Alternate-language titles for a raw catalog searchbar query (#63).
 *
 * The searchbar has no resolved content id yet -- unlike the stream/subtitle
 * paths, which already have an IMDb/TMDB id and can pull `personal_akas` by
 * id. Resolving akas for free-typed text would need a text-search endpoint
 * against that table that doesn't exist yet, so this uses the one live
 * signal available for raw text: TMDB's own `search/multi`, one bounded call.
 * Distinct from WP-15 (Hebrew/Russian fallback for a *known* title) -- this
 * is for when the fallback title set was never reachable at all because
 * `buildSearchTitles` is never called on the catalog search path.
 *
 * @returns {Promise<string[]>} up to 2 titles distinct from the query
 */
export async function resolveAlternateQueries(queryText) {
  const apiKey = process.env.TMDB_API_KEY;
  const q = String(queryText || '').trim();
  if (!apiKey || !q) return [];
  try {
    const url = `https://api.themoviedb.org/3/search/multi?api_key=${apiKey}&query=${encodeURIComponent(q)}`;
    const res = await fetchWithTimeout(url, { headers: { 'Accept': 'application/json' } }, 1200);
    if (!res.ok) return [];
    const data = await res.json();
    const hit = (data.results || []).find(r => r.media_type === 'movie' || r.media_type === 'tv');
    if (!hit) return [];

    const qLower = q.toLowerCase();
    const primary = hit.title || hit.name || null;
    const original = hit.original_title || hit.original_name || null;
    const alternates = [];
    if (primary && primary.toLowerCase() !== qLower) alternates.push(primary);
    if (original && original.toLowerCase() !== qLower && original !== primary) alternates.push(original);
    return alternates.slice(0, 2);
  } catch {
    return [];
  }
}
