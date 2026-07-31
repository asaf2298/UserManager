// api/kodi.js
//
// Thin-client stream API for the Kodi plugin. Uses the same retrieval, feature,
// dedup, and ranking pipeline as the Stremio path. `userKey` (optional) selects
// a named USER_CONFIGS profile exactly like the Stremio path does via the URL
// path segment -- e.g. a "friends_light" Kodi user gets that profile's target
// count, diversity penalties, and eligibility floor, not the flat/wide "kodi"
// default. `clientClass: 'capable'` is always applied on top (matching
// isCapableClient's own "kodi" check in api/stream.js -- this endpoint IS
// Kodi, no user-agent sniffing needed), with a widened timeout/collection
// window. Callers without a recognized userKey keep the previous behavior:
// the fixed "kodi" profile. The response shape is unchanged for existing
// plugin versions.
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

/**
 * Resolve a Kodi request's profile from its (optional) userKey, exactly like
 * the Stremio path resolves a profile from the URL path segment. Falls back
 * to the fixed "kodi" profile when userKey is missing or unrecognized.
 * `clientClass: 'capable'` and the widened timeout/collection window are
 * always applied on top, since this endpoint IS Kodi -- no user-agent
 * sniffing needed the way api/stream.js's isCapableClient() has to do it.
 */
export function resolveKodiProfile(userKey) {
  const configs = JSON.parse(process.env.USER_CONFIGS || '{}');
  const profileName = configs[userKey]?.profile || 'kodi';
  const baseProfile = resolveProfile(profileName);
  const profile = {
    ...baseProfile,
    clientClass: 'capable',
    timeoutMs: Math.max(baseProfile.timeoutMs, 9500),
    collectionCutoffMs: Math.max(baseProfile.collectionCutoffMs, 7000),
  };
  return { profileName, profile };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { imdb_id, season, episode, type, userKey } = req.query;
    if (!imdb_id || !type) return res.status(400).json({ error: 'imdb_id and type are required' });

    const idWithExt = (type === 'series' && season && episode)
      ? `${imdb_id}:${season}:${episode}.json`
      : `${imdb_id}.json`;

    const { profileName, profile } = resolveKodiProfile(userKey);
    const result = await retrieveRankAndSelect(type, idWithExt, {
      profile,
      profileName,
      addons: (process.env.ADDON_URLS || '').split('|||').map(u => u.trim()).filter(Boolean),
      clientUA: 'Kodi-ThinClient/1.0',
      clientIp: req.headers['x-forwarded-for']?.split(',')[0] || '',
    });

    // Kodi plays direct URLs only; magnet-only rows are dropped after ranking so
    // they still participate in dedup and never resurface as duplicates.
    const playable = result.selected.filter(candidate => candidate.stream.url);
    const results = formatKodiResults(playable);

    console.log(
      `[PERSONAL KODI] 🎛️ ${imdb_id} profile=${profileName} → ranked=${result.diagnostics.eligibleCount}` +
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
