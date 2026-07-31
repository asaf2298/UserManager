/**
 * Dailymotion source (port of the Kodi plugin.video.dailymotion_com prototype).
 *
 * Fully self-contained: calls api.dailymotion.com directly (no separately
 * deployed service to proxy to, unlike Yastream). Own catalog, own search box
 * -- deliberately NOT merged into the unified "חיפוש משולב" search, since a
 * plain-text query against Dailymotion's open public catalog returns mostly
 * unrelated clips that would bury real movie/series results.
 *
 * Not registered in lib/providerCapabilities.js: that registry only feeds
 * lib/streamEngine.js's retrieveRankAndSelect(), which never sees `dm:` ids --
 * each Dailymotion item has exactly one source and one stream, so there is no
 * competing claim to rank. Isolation in its own catalog is the trust boundary
 * here, not a numeric prior.
 */
import fetch from 'node-fetch';

export const DAILYMOTION_ID_PREFIX = 'dm:';
/** Manifest idPrefixes (Stremio matches on prefix without requiring the colon). */
export const DAILYMOTION_MANIFEST_PREFIX = 'dm';
export const DAILYMOTION_CATALOG_ID = 'dailymotion_videos';
export const DAILYMOTION_CATALOG_TYPE = 'channel';

const API_BASE = 'https://api.dailymotion.com';
const PAGE_SIZE = 20;

/** Category dropdown -> Dailymotion channel slug. */
const GENRE_MAP = {
  News: 'news',
  Sport: 'sport',
  Music: 'music',
  Tech: 'tech',
  Gaming: 'videogames',
  Fun: 'fun',
  TV: 'tv',
};

/** Catalog entry spliced into manifest.js's catalogs array. */
export const DAILYMOTION_CATALOG_MANIFEST_ENTRY = {
  type: DAILYMOTION_CATALOG_TYPE,
  id: DAILYMOTION_CATALOG_ID,
  name: 'Dailymotion',
  genres: Object.keys(GENRE_MAP),
  extra: [
    { name: 'search', isRequired: false },
    { name: 'genre', isRequired: false },
    { name: 'skip', isRequired: false },
  ],
};

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

export function isDailymotionId(id) {
  return String(id || '').startsWith(DAILYMOTION_ID_PREFIX);
}

/** Parses Stremio's raw extra path segment ("genre=News&skip=20") into a dict. */
function parseExtra(extraPart) {
  const params = {};
  for (const pair of String(extraPart || '').split('&')) {
    if (!pair.includes('=')) continue;
    const [k, v] = pair.split('=');
    try {
      params[decodeURIComponent(k)] = decodeURIComponent(v);
    } catch {
      params[k] = v;
    }
  }
  return params;
}

/** Catalog: default/featured, genre browse, search, and skip->page pagination. */
export async function getDailymotionCatalog(extraPart) {
  const { search, genre, skip } = parseExtra(extraPart);
  const page = Math.floor((Number(skip) || 0) / PAGE_SIZE) + 1;

  const apiParams = new URLSearchParams({
    fields: 'id,title,thumbnail_360_url,description',
    limit: String(PAGE_SIZE),
    page: String(page),
  });

  if (search) {
    apiParams.set('search', search);
  } else if (genre && GENRE_MAP[genre]) {
    apiParams.set('channel', GENRE_MAP[genre]);
  } else {
    apiParams.set('flags', 'featured');
  }

  try {
    const res = await fetchWithTimeout(`${API_BASE}/videos?${apiParams}`, {}, 8000);
    if (!res.ok) return { metas: [] };
    const data = await res.json();
    const metas = (data.list || []).map(item => ({
      id: `${DAILYMOTION_ID_PREFIX}${item.id}`,
      type: DAILYMOTION_CATALOG_TYPE,
      name: item.title || 'Untitled',
      poster: item.thumbnail_360_url,
      description: item.description || '',
    }));
    return { metas };
  } catch {
    return { metas: [] };
  }
}

/** Meta: single video's full detail. */
export async function getDailymotionMeta(id) {
  const videoId = String(id).slice(DAILYMOTION_ID_PREFIX.length);
  const apiParams = new URLSearchParams({
    fields: 'id,title,thumbnail_720_url,description,owner.screenname',
  });

  try {
    const res = await fetchWithTimeout(`${API_BASE}/video/${videoId}?${apiParams}`, {}, 8000);
    if (!res.ok) return { meta: null };
    const item = await res.json();
    return {
      meta: {
        id,
        type: DAILYMOTION_CATALOG_TYPE,
        name: item.title || 'Untitled',
        poster: item.thumbnail_720_url,
        description: item.description || '',
        genres: [item['owner.screenname'] || 'Dailymotion'],
      },
    };
  } catch {
    return { meta: null };
  }
}

/** Stream: Dailymotion's own HLS CDN manifest for the video. */
export async function getDailymotionStream(id) {
  const videoId = String(id).slice(DAILYMOTION_ID_PREFIX.length);
  return {
    streams: [{
      title: 'Dailymotion HLS',
      url: `https://www.dailymotion.com/cdn/manifest/video/${videoId}.m3u8`,
    }],
  };
}
