// api/kodi.js
import { fetchAndSortStreams } from '../lib/streamEngine.js';

function extractQuality(resWeight) {
  if (resWeight === 4) return '4K';
  if (resWeight === 3) return '1080p';
  if (resWeight === 2) return '720p';
  return 'SD';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { imdb_id, season, episode, type } = req.query;
    if (!imdb_id || !type) return res.status(400).json({ error: 'imdb_id and type are required' });

    const idWithExt = (type === 'series' && season && episode)
      ? `${imdb_id}:${season}:${episode}.json`
      : `${imdb_id}.json`;

    const engineContext = {
      timeoutMs: 9500,
      maxSizeGB: Infinity,
      minSeedersUncached: 1,
      maxResults: 100,
      addons: (process.env.ADDON_URLS || '').split('|||').map(u => u.trim()).filter(Boolean),
      clientUA: 'Kodi-ThinClient/1.0',
      clientIp: req.headers['x-forwarded-for']?.split(',')[0] || ''
    };

    const allValidStreams = await fetchAndSortStreams(type, idWithExt, engineContext);
    const top = allValidStreams.slice(0, 100).filter(s => s.url);

    const results = top.map(s => ({
      title: (s.title || s.name || 'Unknown').replace(/\n/g, ' ').trim(),
      url: s.url,
      quality: extractQuality(s._resWeight),
      sizeGB: s._sizeGB ? Number(s._sizeGB.toFixed(2)) : null
    }));

    return res.status(200).json({ results });
  } catch (error) {
    console.error('KODI ENDPOINT ERROR:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
