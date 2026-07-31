// api/kodi-catalog.js
// Adapter רזה לקודי: Cinemeta לקטלוגי VOD, Kan-Box לערוצי Live TV
import fetch from 'node-fetch';
import { LIVE_TV_CATALOG_ID } from '../lib/catalogIds.js';

const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';

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

export { isLiveChannel, mapMetaToKodiItem };

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
    const { type, catalogId, skip, search, list } = req.query;
    const metadataBaseUrl = CINEMETA_BASE;
    const tvAddonUrl = process.env.TV_ADDON_URL || '';

    // מצב חדש: ערוצי Live TV מ-Kan-Box בלבד
    if (list === 'live_channels') {
      if (!tvAddonUrl) return res.status(404).json({ error: 'TV_ADDON_URL not configured' });
      const metas = await getLiveChannels(tvAddonUrl);
      const items = metas.map(mapMetaToKodiItem);
      return res.status(200).json({ items });
    }

    if (list === 'catalogs') {
      const catalogs = await getAvailableCatalogs(metadataBaseUrl);
      return res.status(200).json({ catalogs });
    }

    if (!type || !catalogId) {
      return res.status(400).json({ error: 'type and catalogId are required' });
    }

    const metas = await getCatalogItems(metadataBaseUrl, type, catalogId, { skip, search });
    const items = metas.map(mapMetaToKodiItem).filter(item => item.imdb_id);

    return res.status(200).json({ items });
  } catch (error) {
    console.error('KODI CATALOG ENDPOINT ERROR:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
