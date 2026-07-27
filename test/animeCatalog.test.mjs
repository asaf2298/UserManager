import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildAnimeGenreOptions,
    findAnimeilBaseUrl,
    isDbzGenre,
    isEsayAnimeCatalog,
    parseGenreFromExtra,
    DBZ_MOVIE_GENRE,
    DBZ_SERIES_GENRES,
} from '../lib/animeCatalog.js';

test('isEsayAnimeCatalog recognizes unified anime catalog ids', () => {
    assert.equal(isEsayAnimeCatalog('esay_anime_series'), true);
    assert.equal(isEsayAnimeCatalog('esay_anime_movie'), true);
    assert.equal(isEsayAnimeCatalog('dbz_series_catalog'), false);
});

test('isDbzGenre routes Dragon Ball vs AnimeIL genres', () => {
    assert.equal(isDbzGenre(DBZ_MOVIE_GENRE, true), true);
    assert.equal(isDbzGenre('Action', true), false);
    assert.equal(isDbzGenre(DBZ_SERIES_GENRES[0], false), true);
    assert.equal(isDbzGenre('Comedy', false), false);
});

test('buildAnimeGenreOptions merges DBZ and AnimeIL without duplicates', () => {
    const opts = buildAnimeGenreOptions(false, ['Action', DBZ_SERIES_GENRES[0], 'Comedy']);
    assert.ok(opts.includes(DBZ_SERIES_GENRES[0]));
    assert.ok(opts.includes('Action'));
    assert.equal(opts.filter(g => g === DBZ_SERIES_GENRES[0]).length, 1);
    assert.ok(opts.indexOf(DBZ_SERIES_GENRES[0]) < opts.indexOf('Action'));
});

test('findAnimeilBaseUrl picks AnimeIL from addon list', () => {
    const url = findAnimeilBaseUrl([
        'https://torrentio.strem.fun',
        'https://addon.animeil.qzz.io/manifest.json',
    ]);
    assert.equal(url, 'https://addon.animeil.qzz.io');
});

test('parseGenreFromExtra decodes genre param', () => {
    assert.equal(parseGenreFromExtra('genre=Action/skip=0'), 'Action');
    assert.equal(parseGenreFromExtra('genre=' + encodeURIComponent('דרגון בול')), 'דרגון בול');
    assert.equal(parseGenreFromExtra('skip=0'), null);
});
