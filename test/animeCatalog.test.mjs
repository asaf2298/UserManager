import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnimeilCatalogs,
  findAnimeilBaseUrl,
  isAnimeilCatalog,
  prepareAnimeilCatalog,
  resolveAnimeilCatalogUrl,
} from '../lib/animeCatalog.js';

const ANIMEIL = 'https://addon.animeil.qzz.io';
const ADDONS = ['https://torrentio.strem.fun', `${ANIMEIL}/manifest.json`];

test('isAnimeilCatalog matches AnimeIL movie + series ids only', () => {
  assert.equal(isAnimeilCatalog('AnimeIL-TV Movies'), true);
  assert.equal(isAnimeilCatalog('AnimeIL-TV Series'), true);
  assert.equal(isAnimeilCatalog('dbz_movies_catalog'), false);
});

test('findAnimeilBaseUrl prefers ADDON_URLS animeil host, else fallback', () => {
  assert.equal(findAnimeilBaseUrl(ADDONS), ANIMEIL);
  assert.equal(findAnimeilBaseUrl(['https://torrentio.strem.fun']), ANIMEIL);
});

test('prepareAnimeilCatalog strips search and requires genre', () => {
  const prepared = prepareAnimeilCatalog({
    type: 'series',
    id: 'AnimeIL-TV Series',
    name: 'AnimeIL-TV',
    extra: [
      { name: 'genre', options: ['Action', 'Comedy'] },
      { name: 'search' },
      { name: 'skip' },
    ],
  });
  assert.equal(prepared.extra.some(e => e.name === 'search'), false);
  const genre = prepared.extra.find(e => e.name === 'genre');
  assert.equal(genre.isRequired, true);
  assert.deepEqual(genre.options, ['Action', 'Comedy']);
});

test('buildAnimeilCatalogs returns both upstream catalogs prepared', async () => {
  const rows = await buildAnimeilCatalogs(ADDONS, async () => ({
    catalogs: [
      { type: 'series', id: 'AnimeIL-TV Series', extra: [{ name: 'genre', options: ['Action'] }, { name: 'search' }] },
      { type: 'movie', id: 'AnimeIL-TV Movies', extra: [{ name: 'genre', options: ['Comedy'] }, { name: 'search' }] },
      { type: 'movie', id: 'other', extra: [] },
    ],
  }));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.extra.find(e => e.name === 'genre').isRequired, true);
    assert.equal(row.extra.some(e => e.name === 'search'), false);
  }
});

test('resolveAnimeilCatalogUrl encodes catalog id and forwards extras', () => {
  const url = resolveAnimeilCatalogUrl({
    catalogId: 'AnimeIL-TV Series',
    reqType: 'series',
    extraPart: 'genre=Action/skip=0',
    addonUrls: ADDONS,
  });
  assert.equal(
    url,
    `${ANIMEIL}/catalog/series/${encodeURIComponent('AnimeIL-TV Series')}.json/genre=Action/skip=0`,
  );
});
