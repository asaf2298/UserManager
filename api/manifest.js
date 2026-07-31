import fetch from 'node-fetch';
import { YASTREAM_MANIFEST_PREFIXES } from '../lib/yastream.js';
import { MIXED_SEARCH_CATALOG_IDS, LIVE_TV_CATALOG_ID } from '../lib/catalogIds.js';

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Kan-Box VOD catalogs kept in Discovery but hidden from Board by marking a
 * required extra (Stremio Board only loads catalogs with no required extras).
 */
const BOARD_HIDDEN_KANBOX_IDS = new Set([
    'dbz_movies_catalog',
    'dbz_series_catalog',
]);

/**
 * Prepare a Kan-Box VOD catalog for Personal Board/Discovery.
 * Search extras are stripped so Stremio search goes through unified search instead.
 */
function prepareKanboxCatalog(cat) {
    let name = cat.name || cat.id;
    if (!name.includes('Israeli') && !name.startsWith('IL - ')) {
        name = `IL - ${name}`;
    }

    const nonSearchExtra = cat.extra
        ? cat.extra.filter(e => e.name !== 'search')
        : [];

    const prepared = {
        ...cat,
        name,
        // Browsable catalogs need a defined extra array even if only search was stripped
        extra: nonSearchExtra.length > 0 ? nonSearchExtra : []
    };

    // Board-hide: require genre so Board skips it; Discover still lists it.
    // Use a single "הכל" option for both DBZ movies and series (series upstream
    // otherwise exposes franchise genres that clutter Discover).
    if (BOARD_HIDDEN_KANBOX_IDS.has(String(cat.id || ''))) {
        prepared.extra = [
            ...prepared.extra.filter(e => e.name !== 'genre'),
            { name: 'genre', isRequired: true, options: ['הכל'] }
        ];
    }

    return prepared;
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const clientUA = req.headers['user-agent'] || 'Stremio/4.4.156';
    const forwardedIps = req.headers['x-forwarded-for'] || '';
    const clientIp = forwardedIps ? forwardedIps.split(',')[0].trim() : (req.socket?.remoteAddress || '');

    const kanboxHeaders = { 'User-Agent': clientUA, 'X-Forwarded-For': clientIp };

    try {
        const urlParts = req.url.split('?')[0].split('/');
        const userKey = urlParts[1] || 'default';
        const configs = JSON.parse(process.env.USER_CONFIGS || '{}');
        const userConfig = configs[userKey] || { name: 'Unknown' };

        // LiveTV (Live_TV_Channels) is intentionally excluded: Kan-Box's own
        // addon already advertises it directly. Only Kan-Box VOD catalogs are
        // merged in here.
        let kanboxVodCatalogs = [];

        const tvAddonUrl = process.env.TV_ADDON_URL;
        if (tvAddonUrl) {
            try {
                const cleanTvUrl = tvAddonUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
                const tvRes = await fetchWithTimeout(`${cleanTvUrl}/manifest.json`, { headers: kanboxHeaders }, 7500);
                if (tvRes.ok) {
                    const tvManifest = await tvRes.json();
                    const catalogs = tvManifest?.catalogs || [];

                    kanboxVodCatalogs = catalogs
                        .filter(cat => String(cat.id || '') !== LIVE_TV_CATALOG_ID)
                        .map(cat => prepareKanboxCatalog(cat));
                }
            } catch (e) {
                console.error('TV Addon fetch error:', e.message);
            }
        }

        const unifiedSearchCatalogs = [
            { id: MIXED_SEARCH_CATALOG_IDS.movie, type: "movie", name: " חיפוש משולב", extra: [{ name: "search", isRequired: true }] },
            { id: MIXED_SEARCH_CATALOG_IDS.series, type: "series", name: " חיפוש משולב", extra: [{ name: "search", isRequired: true }] },
            { id: MIXED_SEARCH_CATALOG_IDS.complete, type: "anime", name: " חיפוש משולב - complete", extra: [{ name: "search", isRequired: true }] },
            { id: MIXED_SEARCH_CATALOG_IDS.full, type: "anime", name: " חיפוש משולב - full", extra: [{ name: "search", isRequired: true }] }
        ];

        return res.status(200).json({
            id: `com.personal.${userKey}`,
            version: "2.12.0",
            name: `Personal - ${userConfig.name || userKey}`,
            description: "Personal Aggregator with Unified Search & IL VOD",
            idPrefixes: [
                "tt", "tmdb", "mal", "kitsu", "anilist", "anidb", "tvdb",
                "http", "https", "dbz:",
                ...YASTREAM_MANIFEST_PREFIXES
            ],
            resources: [
                "stream",
                "catalog",
                "meta",
                {
                    name: "subtitles",
                    types: ["movie", "series", "anime"],
                    idPrefixes: [
                        "tt", "tmdb:", "kitsu:", "mal:", "anilist:", "anidb:", "tvdb",
                        "http", "https", "dbz:",
                        ...YASTREAM_MANIFEST_PREFIXES
                    ]
                }
            ],
            types: ["movie", "series", "anime", "tv", "channel"],
            catalogs: [...unifiedSearchCatalogs, ...kanboxVodCatalogs]
        });
    } catch (error) {
        console.error('Manifest Proxy Error:', error);
        return res.status(500).json({ error: "Internal Server Error" });
    }
}
