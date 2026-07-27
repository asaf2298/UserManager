/** Unified Personal anime catalogs (AnimeIL + Kan-Box Dragon Ball). */

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

export const DBZ_CATALOG_IDS = new Set(['dbz_movies_catalog', 'dbz_series_catalog']);

export function isEsayAnimeCatalog(id) {
    return id === ESAY_ANIME_SERIES_ID || id === ESAY_ANIME_MOVIE_ID;
}

export function isDbzGenre(genre, isMovie) {
    if (!genre) return false;
    if (isMovie) return genre === DBZ_MOVIE_GENRE;
    return DBZ_SERIES_GENRES.includes(genre);
}

export function findAnimeilBaseUrl(addonUrls) {
    for (const raw of addonUrls) {
        const u = String(raw).replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
        if (!u) continue;
        try {
            if (new URL(u).hostname.toLowerCase().includes('animeil')) return u;
        } catch { /* skip invalid */ }
    }
    return null;
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

/** Genre options for manifest `extra` (DBZ slice + AnimeIL upstream genres). */
export function buildAnimeGenreOptions(isMovie, animeilGenres = []) {
    const dbz = isMovie ? [DBZ_MOVIE_GENRE] : [...DBZ_SERIES_GENRES];
    const seen = new Set(dbz);
    const merged = [...dbz];
    for (const g of animeilGenres) {
        if (!g || seen.has(g)) continue;
        seen.add(g);
        merged.push(g);
    }
    return merged;
}
