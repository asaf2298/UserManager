/**
 * Yastream Asian-provider helpers (kisskh / idrama / onetouchtv).
 * Yastream itself stays in ADDON_URLS for normal tt fan-out; these helpers
 * only handle its custom catalog IDs that Cinemeta cannot resolve.
 */

export const YASTREAM_ID_PREFIXES = ['kisskh:', 'idrama:', 'onetouchtv:'];

/** Manifest idPrefixes (Stremio matches on prefix without requiring the colon). */
export const YASTREAM_MANIFEST_PREFIXES = ['kisskh', 'idrama', 'onetouchtv'];

const IMDB_IN_URL_RE = /(?:^|\/)(?:imdb\/(?:poster[^/]*\/)?|title\/)?(tt\d{5,})/i;
const IMDB_FIELD_RE = /\b(tt\d{5,})\b/i;

export function isYastreamProviderId(id) {
  const s = String(id || '').toLowerCase();
  return YASTREAM_ID_PREFIXES.some(p => s.startsWith(p));
}

/** Strip episode/season suffixes: kisskh:6158:1:1 → kisskh:6158 */
export function yastreamBaseId(id) {
  const s = String(id || '');
  const m = s.match(/^(kisskh|idrama|onetouchtv):([^:]+)/i);
  return m ? `${m[1].toLowerCase()}:${m[2]}` : s;
}

/**
 * Find the Yastream base URL from ADDON_URLS (or optional dedicated env).
 * Matches common hosts: yastream.*, tamthai.de, etc.
 */
export function findYastreamBaseUrl(addonUrls = [], explicitUrl = '') {
  const candidates = [
    explicitUrl,
    ...addonUrls
  ]
    .map(u => String(u || '').trim())
    .filter(Boolean)
    .map(u => u.replace(/\/manifest\.json$/i, '').replace(/\/$/, ''));

  const hit = candidates.find(u => /yastream|tamthai\.de/i.test(u));
  return hit || null;
}

/**
 * Extract an IMDb id from Yastream meta/poster fields when the provider
 * linked one (common in ratingposterdb /imdb/.../tt….jpg URLs).
 */
export function extractImdbIdFromMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  for (const key of ['imdb_id', 'imdbId', 'imdb']) {
    const v = meta[key];
    if (typeof v === 'string') {
      const m = v.match(IMDB_FIELD_RE);
      if (m) return m[1];
    }
  }
  for (const key of ['poster', 'background', 'logo', 'thumbnail']) {
    const v = meta[key];
    if (typeof v === 'string') {
      const m = v.match(IMDB_IN_URL_RE);
      if (m) return m[1];
    }
  }
  // videos[0] artwork
  const vid = Array.isArray(meta.videos) ? meta.videos[0] : null;
  if (vid) {
    for (const key of ['thumbnail', 'background']) {
      const v = vid[key];
      if (typeof v === 'string') {
        const m = v.match(IMDB_IN_URL_RE);
        if (m) return m[1];
      }
    }
  }
  return null;
}

/**
 * If meta exposes an IMDb id, rewrite to tt… (preserving :season:episode when present)
 * so Stremio uses Cinemeta + the normal ADDON_URLS fan-out (including Yastream on tt).
 * Provider-only titles (no IMDb) are left unchanged for Yastream meta/stream proxying.
 */
export function rewriteMetaToImdbIfKnown(meta) {
  if (!meta || !meta.id || !isYastreamProviderId(meta.id)) return meta;
  const tt = extractImdbIdFromMeta(meta);
  if (!tt) return meta;

  const parts = String(meta.id).split(':');
  // kisskh:6158 | kisskh:6158:1:1 | onetouchtv:slug:1:2
  let newId = tt;
  if (parts.length >= 4) {
    // provider:id:season:episode — keep season/episode
    newId = `${tt}:${parts[parts.length - 2]}:${parts[parts.length - 1]}`;
  } else if (parts.length === 3 && /^\d+$/.test(parts[1]) === false) {
    // onetouchtv:slug-only with no ep — just tt
    newId = tt;
  }

  return { ...meta, id: newId, imdb_id: tt };
}
