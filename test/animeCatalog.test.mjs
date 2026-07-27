import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findAnimeilBaseUrl,
  isAnimeilCatalog,
  requireGenreExtra,
  stripSearchExtra,
} from '../lib/animeCatalog.js';

const ANIMEIL = 'https://addon.animeil.qzz.io';
const ADDONS = ['https://torrentio.strem.fun', `${ANIMEIL}/manifest.json`];

test('isAnimeilCatalog matches decoded and percent-encoded ids', () => {
  assert.equal(isAnimeilCatalog('AnimeIL-TV Movies'), true);
  assert.equal(isAnimeilCatalog('AnimeIL-TV Series'), true);
  assert.equal(isAnimeilCatalog('AnimeIL-TV%20Series'), true);
  assert.equal(isAnimeilCatalog('dbz_movies_catalog'), false);
});

test('findAnimeilBaseUrl returns configured host or null', () => {
  assert.equal(findAnimeilBaseUrl(ADDONS), ANIMEIL);
  assert.equal(findAnimeilBaseUrl(['https://torrentio.strem.fun']), null);
});

test('stripSearchExtra removes search only', () => {
  assert.deepEqual(
    stripSearchExtra([{ name: 'genre' }, { name: 'search' }, { name: 'skip' }]),
    [{ name: 'genre' }, { name: 'skip' }],
  );
});

test('requireGenreExtra forces isRequired and replaces prior genre', () => {
  const out = requireGenreExtra(
    [{ name: 'genre', options: ['Old'] }, { name: 'skip' }],
    ['הכל'],
  );
  assert.deepEqual(out, [
    { name: 'skip' },
    { name: 'genre', isRequired: true, options: ['הכל'] },
  ]);
});
