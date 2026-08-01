// api/kodi-catalog.js
// Adapter רזה לקודי: Cinemeta לקטלוגי VOD, Kan-Box לערוצי Live TV, AnimeIL לאנימה
import fetch from 'node-fetch';
import { LIVE_TV_CATALOG_ID } from '../lib/catalogIds.js';

const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';
const ANIMEIL_BASE = 'https://addon.animeil.qzz.io';
const ANIMEIL_CATALOGS = { movie: 'AnimeIL-TV Movies', series: 'AnimeIL-TV Series' };

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Same identity check api/manifest.js and api/catalog.js already use to find
 * Kan-Box's live catalog. The previous version of this file re-derived its
 * own hardcoded per-channel id list and a `baseId.includes("live")` check
 * that could never match the real catalog id ("Live_TV_Channels" -- capital
 * L, so the lowercase substring check silently failed), and needed manual
 * updates every time Kan-Box added a channel. One shared source of truth
 * instead.
 */
function isLiveChannel(catalogId) {
  return String(catalogId || '') === LIVE_TV_CATALOG_ID;
}

/**
 * Look up the display name for a userKey, same USER_CONFIGS lookup and
 * fallback api/manifest.js already uses. userKey is optional and identical
 * across all list modes -- there is no per-user channel/catalog entitlement
 * system anywhere in this codebase, so this is labeling only (diagnostics),
 * not a filter.
 */
function resolveUserLabel(userKey) {
  const configs = JSON.parse(process.env.USER_CONFIGS || '{}');
  return configs[userKey]?.name || (userKey ? 'Unknown' : 'anonymous');
}

export { isLiveChannel, mapMetaToKodiItem, resolveUserLabel };

/**
 * AnimeIL's real catalog only accepts one genre per request (no comma-
 * combining server-side), so a "combined" anime row is built here by fanning
 * out one request per genre x per type (movie/series) and merging by id.
 * AnimeIL's whole catalog is anime -- genre only narrows which kind (action
 * anime, romance anime, ...), it never mixes in non-anime content, so this
 * stays pure-anime the way Cinemeta's genre=Animation never could.
 */
async function getAnimeIlByGenres(genresParam) {
  const genres = String(genresParam || '').split(',').map(g => g.trim()).filter(Boolean);
  if (!genres.length) return [];

  const seen = new Set();
  const items = [];
  for (const type of Object.keys(ANIMEIL_CATALOGS)) {
    const catalogId = ANIMEIL_CATALOGS[type];
    for (const genre of genres) {
      const targetUrl = `${ANIMEIL_BASE}/catalog/${type}/${encodeURIComponent(catalogId)}/genre=${encodeURIComponent(genre)}.json`;
      try {
        const res = await fetchWithTimeout(targetUrl, { headers: { Accept: 'application/json' } }, 8000);
        if (!res.ok) continue;
        const data = await res.json();
        for (const meta of Array.isArray(data.metas) ? data.metas : []) {
          if (!meta || !meta.id || seen.has(meta.id)) continue;
          seen.add(meta.id);
          items.push(meta);
        }
      } catch {
        // One genre/type failing must not drop the rest of the combined row.
      }
    }
  }
  return items;
}

async function getAvailableCatalogs(baseUrl) {
  const cleanBase = baseUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
  const res = await fetchWithTimeout(`${cleanBase}/manifest.json`, { headers: { 'Accept': 'application/json' } }, 7000);
  if (!res.ok) return [];
  const manifest = await res.json();
  return (manifest.catalogs || []).map(c => ({ id: c.id, type: c.type, name: c.name }));
}

async function getCatalogItems(baseUrl, type, catalogId, { skip, search }) {
  const cleanBase = baseUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
  let extra = '';
  if (search) extra = `/search=${encodeURIComponent(search)}.json`;
  else if (skip) extra = `/skip=${skip}.json`;
  else extra = '.json';
  const targetUrl = `${cleanBase}/catalog/${type}/${catalogId}${extra}`;
  const res = await fetchWithTimeout(targetUrl, { headers: { 'Accept': 'application/json' } }, 8000);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.metas) ? data.metas : [];
}

// שולף את כל הערוצים החיים מ-Kan-Box, לפי מזהה הקטלוג היחיד (LIVE_TV_CATALOG_ID)
async function getLiveChannels(tvAddonUrl) {
  const cleanBase = tvAddonUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
  const manifestRes = await fetchWithTimeout(`${cleanBase}/manifest.json`, { headers: { 'Accept': 'application/json' } }, 7000).catch(() => null);
  const manifest = manifestRes && manifestRes.ok ? await manifestRes.json().catch(() => null) : null;
  if (!manifest || !Array.isArray(manifest.catalogs)) return [];

  const liveCatalogs = manifest.catalogs.filter(c => isLiveChannel(c.id));
  const allItems = [];
  for (const cat of liveCatalogs) {
    const res = await fetchWithTimeout(`${cleanBase}/catalog/${cat.type}/${cat.id}.json`, { headers: { 'Accept': 'application/json' } }, 7000);
    if (!res.ok) continue;
    const data = await res.json();
    if (Array.isArray(data.metas)) allItems.push(...data.metas);
  }
  return allItems;
}

function mapMetaToKodiItem(meta) {
  const imdbId = meta.imdb_id || (meta.id && meta.id.startsWith('tt') ? meta.id.split(':')[0] : meta.id);
  return {
    imdb_id: imdbId,
    title: meta.name || meta.title || 'Unknown',
    year: meta.releaseInfo || meta.year || '',
    poster: meta.poster || '',
    fanart: meta.background || meta.fanart || '',
    plot: meta.description || '',
    type: meta.type || 'movie',
    genres: Array.isArray(meta.genres) ? meta.genres.join(', ') : '',
    imdbRating: meta.imdbRating || null
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { type, catalogId, skip, search, list, genres, userKey } = req.query;
    const metadataBaseUrl = CINEMETA_BASE;
    const tvAddonUrl = process.env.TV_ADDON_URL || '';
    const userLabel = resolveUserLabel(userKey);

    // מצב חדש: ערוצי Live TV מ-Kan-Box בלבד
    if (list === 'live_channels') {
      if (!tvAddonUrl) return res.status(404).json({ error: 'TV_ADDON_URL not configured' });
      const metas = await getLiveChannels(tvAddonUrl);
      const items = metas.map(mapMetaToKodiItem);
      console.log(`[PERSONAL KODI CATALOG] 📺 ${userLabel} live_channels → ${items.length} items`);
      return res.status(200).json({ items });
    }

    if (list === 'catalogs') {
      const catalogs = await getAvailableCatalogs(metadataBaseUrl);
      console.log(`[PERSONAL KODI CATALOG] 📚 ${userLabel} catalogs → ${catalogs.length} available`);
      return res.status(200).json({ catalogs });
    }

    // אנימה טהורה מ-AnimeIL, לפי שילוב ז'אנרים (שורה אחת = כמה ז'אנרים ממוזגים)
    if (list === 'anime_genres') {
      const metas = await getAnimeIlByGenres(genres);
      const items = metas.map(mapMetaToKodiItem).filter(item => item.imdb_id);
      console.log(`[PERSONAL KODI CATALOG] 🎌 ${userLabel} anime_genres=${genres} → ${items.length} items`);
      return res.status(200).json({ items });
    }

    if (!type || !catalogId) {
      return res.status(400).json({ error: 'type and catalogId are required' });
    }

    const metas = await getCatalogItems(metadataBaseUrl, type, catalogId, { skip, search });
    const items = metas.map(mapMetaToKodiItem).filter(item => item.imdb_id);

    console.log(`[PERSONAL KODI CATALOG] 🎬 ${userLabel} ${type}/${catalogId} → ${items.length} items`);
    return res.status(200).json({ items });
  } catch (error) {
    console.error('KODI CATALOG ENDPOINT ERROR:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
