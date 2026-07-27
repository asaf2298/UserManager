/**
 * AnimeIL catalogs in the Personal manifest: Discover-only (genre required), no search.
 * Mixed-search (חיפוש משולב) still fans out to AnimeIL via ADDON_URLS.
 */

import { resolveProvider } from './providerCapabilities.js';

export const ANIMEIL_CATALOG_IDS = new Set([
  'AnimeIL-TV Movies',
  'AnimeIL-TV Series',
]);

export const ANIMEIL_FALLBACK_BASE = 'https://addon.animeil.qzz.io';

export function findAnimeilBaseUrl(addonUrls) {
  for (const raw of addonUrls || []) {
    const u = String(raw).replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
    if (!u) continue;
    if (resolveProvider(u, { configured: true }).family === 'animeil') return u;
  }
  return ANIMEIL_FALLBACK_BASE;
}

export function isAnimeilCatalog(id) {
  return ANIMEIL_CATALOG_IDS.has(String(id || ''));
}

/**
 * Strip search; require genre so Stremio lists the catalog in Discover, not Board.
 */
export function prepareAnimeilCatalog(cat) {
  const extras = (cat.extra || []).filter(e => e.name !== 'search');
  const genreExtra = extras.find(e => e.name === 'genre');
  const genreOptions = genreExtra?.options || cat.genres || [];

  return {
    ...cat,
    extra: [
      ...extras.filter(e => e.name !== 'genre'),
      {
        name: 'genre',
        isRequired: true,
        options: genreOptions.length ? genreOptions : ['🔤 A-Z'],
      },
    ],
  };
}

/**
 * @param {string[]} addonUrls
 * @param {(baseUrl: string) => Promise<object|null>} [fetchManifest]
 */
export async function buildAnimeilCatalogs(addonUrls, fetchManifest) {
  const baseUrl = findAnimeilBaseUrl(addonUrls);
  let manifest = null;
  if (typeof fetchManifest === 'function') {
    try {
      manifest = await fetchManifest(baseUrl);
    } catch {
      manifest = null;
    }
  }

  return (manifest?.catalogs || [])
    .filter(c => ANIMEIL_CATALOG_IDS.has(String(c.id || '')))
    .map(prepareAnimeilCatalog);
}

/**
 * @returns {string|null}
 */
export function resolveAnimeilCatalogUrl({
  catalogId,
  reqType,
  extraPart,
  addonUrls = [],
} = {}) {
  if (!isAnimeilCatalog(catalogId)) return null;

  const base = findAnimeilBaseUrl(addonUrls).replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
  const idSeg = encodeURIComponent(catalogId);
  const cleanExtras = String(extraPart || '').replace(/\.json$/i, '');
  const suffix = cleanExtras ? `/${cleanExtras}` : '';
  return `${base}/catalog/${reqType}/${idSeg}.json${suffix}`;
}
