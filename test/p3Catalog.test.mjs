/**
 * P3 · WP-16 (manifest discovery budget) and WP-17 (racy cross-request search
 * dedup, deleted) (#59). No existing test in this suite exercises
 * api/catalog.js's handler directly (it requires real network fan-out to
 * addon manifests with no mock seam), so most of this relies on source-text
 * assertions -- the same convention already used for other handler-internal
 * checks in this suite -- plus direct unit tests for the two functions now
 * exported for that purpose.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeMetas, searchQueryKey } from '../api/catalog.js';
import { resolveAlternateQueries } from '../lib/search.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('WP-16: manifest cache TTL matches getTvCatalogIds\' 1h class, not the old 60s', () => {
  const source = fs.readFileSync(path.join(__dirname, '../api/catalog.js'), 'utf8');
  assert.match(source, /MANIFEST_TTL_MS\s*=\s*30 \* 60 \* 1000/);
  assert.match(source, /Date\.now\(\)\s*-\s*cached\.ts\s*<\s*MANIFEST_TTL_MS/);
});

test('WP-16: discovery is bounded to a fraction of the search budget, not the full manifest timeout', () => {
  const source = fs.readFileSync(path.join(__dirname, '../api/catalog.js'), 'utf8');
  assert.match(source, /const discoveryMs = Math\.min\(1200, Math\.floor\(hardBudgetMs \/ 3\)\)/);
  assert.match(source, /getAllSearchCatalogs\(\s*\n\s*tvAddonUrl, addonUrls, reqType, proxyHeaders,\s*\n\s*\{[^}]*discoveryMs/s);
});

test('WP-17: the racy cross-request fast-search cache is gone', () => {
  const source = fs.readFileSync(path.join(__dirname, '../api/catalog.js'), 'utf8');
  for (const name of ['_fastSearchIdCache', 'rememberFastSearchIds', 'collectFastSearchIds', 'FAST_SEARCH_CACHE_TTL_MS']) {
    assert.equal(source.includes(name), false, `${name} must be fully removed, not just unused`);
  }
});

test('WP-17: mergeMetas no longer accepts excludeIds', () => {
  const metas = [
    { id: 'tt1', name: 'A' },
    { id: 'tt2', name: 'B' },
    { id: 'tt1', name: 'A dup' },
  ];
  // Even if a caller still passed excludeIds, mergeMetas must ignore it --
  // proves the plumbing, not just the call site, is gone.
  const { combinedMetas } = mergeMetas([{ metas }], { excludeIds: new Set(['tt1']) });
  assert.deepEqual(combinedMetas.map(m => m.id), ['tt1', 'tt2'], 'dedup by id must still work; excludeIds must have no effect');
});

test('searchQueryKey extracts and normalizes the search term', () => {
  assert.equal(searchQueryKey('search=Breaking%20Bad/genre=action'), 'breaking bad');
  assert.equal(searchQueryKey('search=Dune'), 'dune');
  assert.equal(searchQueryKey('genre=action'), null);
  assert.equal(searchQueryKey(''), null);
});

// #63 -- the catalog searchbar forwarded the raw query to every addon verbatim
// with no multi-language fallback, unlike the stream/subtitle paths.
test('resolveAlternateQueries: fails safe (no network) when TMDB is not configured', async () => {
  const prevKey = process.env.TMDB_API_KEY;
  delete process.env.TMDB_API_KEY;
  try {
    assert.deepEqual(await resolveAlternateQueries('שובר שורות'), []);
    assert.deepEqual(await resolveAlternateQueries(''), []);
    assert.deepEqual(await resolveAlternateQueries(null), []);
  } finally {
    if (prevKey !== undefined) process.env.TMDB_API_KEY = prevKey;
  }
});

test('WP-19: the alternate-query wave is gated by thinness and remaining budget, and only fires for MIXED_SEARCH', () => {
  const source = fs.readFileSync(path.join(__dirname, '../api/catalog.js'), 'utf8');
  assert.match(source, /ALT_QUERY_THIN_THRESHOLD = 5/);
  assert.match(source, /ALT_QUERY_MIN_BUDGET_MS = 900/);

  const gateIdx = source.indexOf('combinedMetas.length < ALT_QUERY_THIN_THRESHOLD');
  assert.ok(gateIdx > -1, 'the thinness+budget gate must exist');

  // The whole alternate-query block must live inside the MIXED_SEARCH_PREFIX
  // branch (Live TV is filtered out of getSearchCatalogs entirely, so this
  // inherits that exclusion rather than needing its own).
  const mixedSearchIdx = source.indexOf('cleanCatalogId.startsWith(MIXED_SEARCH_PREFIX)');
  assert.ok(mixedSearchIdx > -1 && mixedSearchIdx < gateIdx, 'alternate-query gate must be inside the mixed-search branch');
});

test('WP-19: resolveAlternateQueries is only called with a real budget check ahead of it', () => {
  const source = fs.readFileSync(path.join(__dirname, '../api/catalog.js'), 'utf8');
  const idx = source.indexOf('const remainingMs = hardBudgetMs');
  assert.ok(idx > -1);
  const block = source.slice(idx, idx + 400);
  assert.match(block, /remainingMs > ALT_QUERY_MIN_BUDGET_MS/);
  assert.match(block, /resolveAlternateQueries\(queryKey\)/);
});
