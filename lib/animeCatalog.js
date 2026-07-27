/**
 * Unified Personal anime catalogs (AnimeIL + Kan-Box Dragon Ball).
 *
 * One table owns catalog ids, upstream targets, and DBZ genre routing.
 * Handlers resolve a URL (or null) and proxy — no nested genre/type branches.
 */

import { resolveProvider } from './providerCapabilities.js';

export const ESAY_ANIME_SERIES_ID = 'esay_anime_series';
export const ESAY_ANIME_MOVIE_ID = 'esay_anime_movie';

export const DBZ_MOVIE_GENRE = 'דרגון בול';

/** Kan-Box `dbz_series_catalog` franchise genres. */
export const DBZ_SERIES_GENRES = [
    'דרגון בול GT',
    'דרגון בול סופר',
    'דרגון בול זי',
    'דרגון בול',
    'דרגון בול דאימה',
];

/** Kan-Box catalog ids absorbed into the unified anime catalogs (strip from manifest). */
export const DBZ_CATALOG_IDS = new Set(['dbz_movies_catalog', 'dbz_series_catalog']);

/**
 * catalogId → upstream routing.
 * `forwardDbzGenre`: series Kan-Box expects genre=; movies return the whole catalog.
 */
export const ANIME_CATALOGS = {
    [ESAY_ANIME_SERIES_ID]: {
        type: 'series',
        name: 'אנימה',
        animeilId: 'AnimeIL-TV Series',
        dbzId: 'dbz_series_catalog',
        dbzGenres: DBZ_SERIES_GENRES,
        forwardDbzGenre: true,
    },
    [ESAY_ANIME_MOVIE_ID]: {
        type: 'movie',
        name: 'אנימה',
        animeilId: 'AnimeIL-TV Movies',
        dbzId: 'dbz_movies_catalog',
        dbzGenres: [DBZ_MOVIE_GENRE],
        forwardDbzGenre: false,
    },
};

export function isEsayAnimeCatalog(id) {
    return Object.prototype.hasOwnProperty.call(ANIME_CATALOGS, id);
}

export function parseGenreFromExtra(extraPart) {
    const m = String(extraPart || '').match(/genre=([^/]+)/);
    if (!m) return null;
    try {
        return decodeURIComponent(m[1]);
    } catch {
        return m[1];
    }
}

/** Remaining extras after dropping genre= (path segments). */
export function extraWithoutGenre(extraPart) {
    return String(extraPart || '')
        .split('/')
        .filter(Boolean)
        .filter(p => !p.startsWith('genre='))
        .join('/');
}

/** Genre options for manifest `extra` (DBZ slice + AnimeIL upstream genres). */
export function buildAnimeGenreOptions(dbzGenres, animeilGenres = []) {
    const seen = new Set(dbzGenres);
    const merged = [...dbzGenres];
    for (const g of animeilGenres) {
        if (!g || seen.has(g)) continue;
        seen.add(g);
        merged.push(g);
    }
    return merged;
}

/**
 * First configured addon whose provider family is AnimeIL.
 * Authority is the capability registry (same as VIP / stream fan-out).
 */
export function findAnimeilBaseUrl(addonUrls) {
    for (const raw of addonUrls || []) {
        const u = String(raw).replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
        if (!u) continue;
        if (resolveProvider(u, { configured: true }).family === 'animeil') return u;
    }
    return null;
}

function animeilCatalogGenres(manifest, type) {
    const cat = manifest?.catalogs?.find(c => c.type === type);
    const genreExtra = cat?.extra?.find(e => e.name === 'genre');
    return genreExtra?.options || cat?.genres || [];
}

/**
 * Manifest rows for the unified anime catalogs.
 * `fetchManifest(baseUrl)` should return a parsed Stremio manifest or null.
 */
export async function buildEsayAnimeCatalogs(addonUrls, fetchManifest) {
    const animeilUrl = findAnimeilBaseUrl(addonUrls);
    let animeilManifest = null;
    if (animeilUrl && typeof fetchManifest === 'function') {
        try {
            animeilManifest = await fetchManifest(animeilUrl);
        } catch {
            animeilManifest = null;
        }
    }

    return Object.entries(ANIME_CATALOGS).map(([id, spec]) => {
        const animeilGenres = animeilCatalogGenres(animeilManifest, spec.type);
        return {
            id,
            type: spec.type,
            name: spec.name,
            extra: [{
                name: 'genre',
                isRequired: true,
                options: buildAnimeGenreOptions(spec.dbzGenres, animeilGenres),
            }],
        };
    });
}

function catalogPath(baseUrl, type, catalogId, extras = '') {
    const idSeg = encodeURIComponent(catalogId);
    const suffix = extras ? `/${extras}` : '';
    return `${baseUrl}/catalog/${type}/${idSeg}.json${suffix}`;
}

/**
 * Resolve the upstream catalog URL for a unified anime catalog request.
 * @returns {string|null} target URL, or null when the request cannot be served
 */
export function resolveAnimeCatalogUrl({
    catalogId,
    extraPart,
    tvAddonUrl = '',
    addonUrls = [],
} = {}) {
    const spec = ANIME_CATALOGS[catalogId];
    if (!spec) return null;

    const genre = parseGenreFromExtra(extraPart);
    if (!genre) return null;

    if (spec.dbzGenres.includes(genre)) {
        const base = String(tvAddonUrl || '').replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
        if (!base) return null;
        if (!spec.forwardDbzGenre) {
            return catalogPath(base, spec.type, spec.dbzId);
        }
        const genreParam = `genre=${encodeURIComponent(genre)}`;
        const rest = extraWithoutGenre(extraPart);
        return catalogPath(base, spec.type, spec.dbzId, rest ? `${genreParam}/${rest}` : genreParam);
    }

    const animeilUrl = findAnimeilBaseUrl(addonUrls);
    if (!animeilUrl) return null;
    return catalogPath(animeilUrl, spec.type, spec.animeilId, extraPart || '');
}
