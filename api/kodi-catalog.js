// api/kodi-catalog.js
// Adapter רזה לקודי: מתרגם קטלוגים מ-AIOMetadata (פורמט Stremio) לפורמט JSON פשוט
import fetch from 'node-fetch';

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getAvailableCatalogs(baseUrl) {
  const cleanBase = baseUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
  const res = await fetchWithTimeout(`${cleanBase}/manifest.json`, { headers: { 'Accept': 'application/json' } }, 7000);
  if (!res.ok) return [];
  const manifest = await res.json();
  return (manifest.catalogs || []).map(c => ({
    id: c.id,
    type: c.type,
    name: c.name
  }));
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

function mapMetaToKodiItem(meta) {
  const imdbId = meta.imdb_id || (meta.id && meta.id.startsWith('tt') ? meta.id.split(':')[0] : null);
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
    const { userKey, type, catalogId, skip, search, list } = req.query;

    const configs = JSON.parse(process.env.USER_CONFIGS || '{}');
    const userConfig = configs[userKey] || {};
    const metadataBaseUrl = userConfig.metadataBase || process.env.AIOMETADATA_URL || '';

    if (!metadataBaseUrl) {
      return res.status(404).json({ error: 'AIOMETADATA_URL not configured' });
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
