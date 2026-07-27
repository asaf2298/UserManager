import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ANIME_CATALOGS,
    ESAY_ANIME_MOVIE_ID,
    ESAY_ANIME_SERIES_ID,
    DBZ_MOVIE_GENRE,
    DBZ_SERIES_GENRES,
    buildAnimeGenreOptions,
    buildEsayAnimeCatalogs,
    findAnimeilBaseUrl,
    isEsayAnimeCatalog,
    parseGenreFromExtra,
    resolveAnimeCatalogUrl,
} from '../lib/animeCatalog.js';

const TV = 'https://kan-box-addon.vercel.app';
const ANIMEIL = 'https://addon.animeil.qzz.io';
const ADDONS = ['https://torrentio.strem.fun', `${ANIMEIL}/manifest.json`];

test('isEsayAnimeCatalog matches the routing table', () => {
    assert.equal(isEsayAnimeCatalog(ESAY_ANIME_SERIES_ID), true);
    assert.equal(isEsayAnimeCatalog(ESAY_ANIME_MOVIE_ID), true);
    assert.equal(isEsayAnimeCatalog('dbz_series_catalog'), false);
    assert.deepEqual(Object.keys(ANIME_CATALOGS).sort(), [ESAY_ANIME_MOVIE_ID, ESAY_ANIME_SERIES_ID].sort());
});

test('buildAnimeGenreOptions merges DBZ ahead of AnimeIL without duplicates', () => {
    const opts = buildAnimeGenreOptions(DBZ_SERIES_GENRES, ['Action', DBZ_SERIES_GENRES[0], 'Comedy']);
    assert.equal(opts.filter(g => g === DBZ_SERIES_GENRES[0]).length, 1);
    assert.ok(opts.indexOf(DBZ_SERIES_GENRES[0]) < opts.indexOf('Action'));
});

test('findAnimeilBaseUrl uses providerCapabilities family match', () => {
    assert.equal(findAnimeilBaseUrl(ADDONS), ANIMEIL);
    assert.equal(findAnimeilBaseUrl(['https://torrentio.strem.fun']), null);
});

test('parseGenreFromExtra decodes genre param', () => {
    assert.equal(parseGenreFromExtra('genre=Action/skip=0'), 'Action');
    assert.equal(parseGenreFromExtra('genre=' + encodeURIComponent(DBZ_MOVIE_GENRE)), DBZ_MOVIE_GENRE);
    assert.equal(parseGenreFromExtra('skip=0'), null);
});

test('resolveAnimeCatalogUrl: DBZ movie drops genre (whole catalog)', () => {
    const url = resolveAnimeCatalogUrl({
        catalogId: ESAY_ANIME_MOVIE_ID,
        extraPart: `genre=${encodeURIComponent(DBZ_MOVIE_GENRE)}`,
        tvAddonUrl: TV,
        addonUrls: ADDONS,
    });
    assert.equal(url, `${TV}/catalog/movie/dbz_movies_catalog.json`);
});

test('resolveAnimeCatalogUrl: DBZ series forwards genre and keeps other extras', () => {
    const genre = DBZ_SERIES_GENRES[1];
    const url = resolveAnimeCatalogUrl({
        catalogId: ESAY_ANIME_SERIES_ID,
        extraPart: `genre=${encodeURIComponent(genre)}/skip=20`,
        tvAddonUrl: TV,
        addonUrls: ADDONS,
    });
    assert.equal(
        url,
        `${TV}/catalog/series/dbz_series_catalog.json/genre=${encodeURIComponent(genre)}/skip=20`,
    );
});

test('resolveAnimeCatalogUrl: AnimeIL passthrough of extraPart', () => {
    const url = resolveAnimeCatalogUrl({
        catalogId: ESAY_ANIME_SERIES_ID,
        extraPart: 'genre=Action/skip=0',
        tvAddonUrl: TV,
        addonUrls: ADDONS,
    });
    assert.equal(
        url,
        `${ANIMEIL}/catalog/series/${encodeURIComponent('AnimeIL-TV Series')}.json/genre=Action/skip=0`,
    );
});

test('resolveAnimeCatalogUrl: missing genre or addon → null', () => {
    assert.equal(resolveAnimeCatalogUrl({
        catalogId: ESAY_ANIME_SERIES_ID,
        extraPart: 'skip=0',
        tvAddonUrl: TV,
        addonUrls: ADDONS,
    }), null);
    assert.equal(resolveAnimeCatalogUrl({
        catalogId: ESAY_ANIME_MOVIE_ID,
        extraPart: `genre=${encodeURIComponent(DBZ_MOVIE_GENRE)}`,
        tvAddonUrl: '',
        addonUrls: ADDONS,
    }), null);
    assert.equal(resolveAnimeCatalogUrl({
        catalogId: ESAY_ANIME_SERIES_ID,
        extraPart: 'genre=Action',
        tvAddonUrl: TV,
        addonUrls: ['https://torrentio.strem.fun'],
    }), null);
});

test('buildEsayAnimeCatalogs builds both rows with merged genres', async () => {
    const rows = await buildEsayAnimeCatalogs(ADDONS, async () => ({
        catalogs: [
            {
                type: 'series',
                id: 'AnimeIL-TV Series',
                extra: [{ name: 'genre', options: ['Action', 'Comedy'] }],
            },
            {
                type: 'movie',
                id: 'AnimeIL-TV Movies',
                extra: [{ name: 'genre', options: ['Action'] }],
            },
        ],
    }));
    assert.equal(rows.length, 2);
    const series = rows.find(r => r.id === ESAY_ANIME_SERIES_ID);
    const movie = rows.find(r => r.id === ESAY_ANIME_MOVIE_ID);
    assert.equal(series.type, 'series');
    assert.equal(movie.type, 'movie');
    assert.equal(series.extra[0].isRequired, true);
    assert.ok(series.extra[0].options.includes('Action'));
    assert.ok(series.extra[0].options.includes(DBZ_SERIES_GENRES[0]));
    assert.ok(movie.extra[0].options.includes(DBZ_MOVIE_GENRE));
});
