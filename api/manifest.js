import fetch from 'node-fetch';
import { YASTREAM_MANIFEST_PREFIXES } from '../lib/yastream.js';

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}

/** Board-only Kan-Box catalogs (browsable). Search still hits Kan-Box via complete/full. */
const KANBOX_BOARD_CATALOG_IDS = new Set(['MakoVOD', 'kanDigital']);

function prepareKanboxBoardCatalog(cat) {
    return {
        ...cat,
        name: cat.name.includes('Israeli') || cat.name.startsWith('IL - ')
            ? cat.name
            : `IL - ${cat.name}`,
        // Strip search so Stremio uses חיפוש משולב instead of per-catalog search
        extra: cat.extra
            ? cat.extra.filter(e => e.name !== 'search').length > 0
                ? cat.extra.filter(e => e.name !== 'search')
                : undefined
            : undefined
    };
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

        let kanboxBoardCatalogs = [];

        const tvAddonUrl = process.env.TV_ADDON_URL;
        if (tvAddonUrl) {
            try {
                const cleanTvUrl = tvAddonUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
                const tvRes = await fetchWithTimeout(`${cleanTvUrl}/manifest.json`, { headers: kanboxHeaders }, 7500);
                if (tvRes.ok) {
                    const tvManifest = await tvRes.json();
                    const catalogs = tvManifest?.catalogs || [];
                    // Board: only Channel 12 VOD + Kan 11 Digital (ids MakoVOD / kanDigital)
                    kanboxBoardCatalogs = catalogs
                        .filter(cat => KANBOX_BOARD_CATALOG_IDS.has(String(cat.id || '')))
                        .map(cat => {
                            const prepared = prepareKanboxBoardCatalog(cat);
                            // Browsable catalogs need a defined extra array for Stremio even if
                            // the only original extras were search (stripped above).
                            if (prepared.extra === undefined) prepared.extra = [];
                            return prepared;
                        });
                }
            } catch (e) {
                console.error('TV Addon fetch error:', e.message);
            }
        }

        const unifiedSearchCatalogs = [
            { id: "esay_mixed_search_movie", type: "movie", name: " חיפוש משולב", extra: [{ name: "search", isRequired: true }] },
            { id: "esay_mixed_search_series", type: "series", name: " חיפוש משולב", extra: [{ name: "search", isRequired: true }] },
            // complete = VIP (Kan-Box/AnimeIL) + anime + tv/channel (excludes movie/series types)
            { id: "esay_mixed_search_complete", type: "anime", name: " חיפוש משולב - complete", extra: [{ name: "search", isRequired: true }] },
            // full = all types + VIP, longer soft deadline; excludes ids already returned by the fast 3
            { id: "esay_mixed_search_full", type: "anime", name: " חיפוש משולב - full", extra: [{ name: "search", isRequired: true }] }
        ];

        return res.status(200).json({
            id: `com.esay.${userKey}`,
            version: "2.10.0",
            name: `Esay - ${userConfig.name || userKey}`,
            description: "Esay Aggregator with Unified Search & LiveTV Israel",
            // tt/tmdb: standard | il_/dbz: Israeli | anime ids | http(s) | Yastream Asian providers
            idPrefixes: [
                "tt", "tmdb", "il_", "mal", "kitsu", "anilist", "anidb", "tvdb",
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
            catalogs: [
                ...unifiedSearchCatalogs,
                ...kanboxBoardCatalogs
            ]
        });
    } catch (error) {
        console.error('Manifest Proxy Error:', error);
        return res.status(500).json({ error: "Internal Server Error" });
    }
}
