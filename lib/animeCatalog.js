/**
 * AnimeIL Discover-only catalogs: resolve base from ADDON_URLS, match catalog ids.
 * Manifest prepare + catalog proxy stay in the handlers (same path shape as Kan-Box).
 */

import { resolveProvider } from './providerCapabilities.js';

export const ANIMEIL_CATALOG_IDS = new Set([
  'AnimeIL-TV Movies',
  'AnimeIL-TV Series',
]);

/** Strip catalog search so Stremio uses חיפוש משולב. */
export function stripSearchExtra(extra) {
  return (extra || []).filter(e => e.name !== 'search');
}

/**
 * Force a required genre extra (Board skips required extras; Discover still lists).
 * @param {object[]} extra
 * @param {string[]} options
 */
export function requireGenreExtra(extra, options) {
  return [
    ...(extra || []).filter(e => e.name !== 'genre'),
    { name: 'genre', isRequired: true, options },
  ];
}

/**
 * @param {string[]} addonUrls
 * @returns {string|null} AnimeIL base when present in ADDON_URLS; otherwise null
 */
export function findAnimeilBaseUrl(addonUrls) {
  for (const raw of addonUrls || []) {
    const u = String(raw).replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
    if (!u) continue;
    if (resolveProvider(u, { configured: true }).family === 'animeil') return u;
  }
  return null;
}

export function isAnimeilCatalog(id) {
  const raw = String(id || '');
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    /* keep raw */
  }
  return ANIMEIL_CATALOG_IDS.has(decoded) || ANIMEIL_CATALOG_IDS.has(raw);
}
