// Single source of truth for the unified-search catalog ids. manifest.js
// advertises these in the Stremio manifest; catalog.js matches incoming
// requests against the same ids. Keeping one shared constant means the two
// can never drift out of sync the way hand-duplicated string literals can.
export const MIXED_SEARCH_CATALOG_IDS = {
  movie: 'personal_mixed_search_movie',
  series: 'personal_mixed_search_series',
  complete: 'personal_mixed_search_complete',
  full: 'personal_mixed_search_full',
};

/** Shared id prefix used for the startsWith() check in catalog.js. */
export const MIXED_SEARCH_PREFIX = 'personal_mixed_search';
