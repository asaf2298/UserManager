// api/kodi.js
//
// Thin-client stream API for the Kodi plugin. Uses the same retrieval, feature,
// dedup, and ranking pipeline as the Stremio path with the Kodi presentation
// profile: capable device compatibility, a long flat list, and light diversity
// penalties. The response shape is unchanged for existing plugin versions.
import { retrieveRankAndSelect } from '../lib/streamEngine.js';
import { resolveProfile } from '../lib/streamRanker.js';
import { RESOLUTION } from '../lib/releaseParser.js';
import { upsertStreamSightings } from '../lib/streamSighting.js';
import { recordRankingAudits } from '../lib/rankingTelemetry.js';

/** Kodi expects these exact quality labels. */
const QUALITY_LABELS = {
  [RESOLUTION.R2160]: '4K',
  [RESOLUTION.R1440]: '1080p',
  [RESOLUTION.R1080]: '1080p',
  [RESOLUTION.R720]: '720p',
  [RESOLUTION.SD]: 'SD',
  [RESOLUTION.R360]: 'SD',
  [RESOLUTION.UNKNOWN]: 'SD',
};

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

    const profile = resolveProfile('kodi');
    const result = await retrieveRankAndSelect(type, idWithExt, {
      profile,
      profileName: 'kodi',
      addons: (process.env.ADDON_URLS || '').split('|||').map(u => u.trim()).filter(Boolean),
      clientUA: 'Kodi-ThinClient/1.0',
      clientIp: req.headers['x-forwarded-for']?.split(',')[0] || '',
    });

    // Kodi plays direct URLs only; magnet-only rows are dropped after ranking so
    // they still participate in dedup and never resurface as duplicates.
    const playable = result.selected.filter(candidate => candidate.stream.url);
    const results = formatKodiResults(playable);

    console.log(
      `[PERSONAL KODI] 🎛️ ${imdb_id} → ranked=${result.diagnostics.eligibleCount}` +
      ` clusters=${result.diagnostics.dedup.clusters} selected=${result.selected.length}` +
      ` playable=${results.length}`
    );

    const contentId = idWithExt.replace(/\.json$/i, '');
    upsertStreamSightings({ contentType: type, contentId, candidates: playable }).catch(() => {});
    recordRankingAudits(result.selected, { contentId }).catch(() => {});

    return res.status(200).json({ results });
  } catch (error) {
    console.error('KODI ENDPOINT ERROR:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

/** Shape selected candidates into the stable Kodi plugin JSON contract. */
export function formatKodiResults(playable) {
  return playable.map(candidate => {
    const features = candidate.features;
    const bytes = features.release.size.bytes;
    return {
      title: String(candidate.stream.title || candidate.stream.name || 'Unknown').replace(/\n/g, ' ').trim(),
      url: candidate.stream.url,
      quality: QUALITY_LABELS[features.release.resolution.value] ?? 'SD',
      sizeGB: Number.isFinite(bytes) && bytes > 0 ? Number((bytes / 1024 ** 3).toFixed(2)) : null,
    };
  });
}
