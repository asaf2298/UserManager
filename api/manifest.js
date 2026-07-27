import fetch from 'node-fetch';
import {
    DBZ_CATALOG_IDS,
    buildEsayAnimeCatalogs,
} from '../lib/animeCatalog.js';
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

/**
 * Prepare a Kan-Box catalog for Personal Board/Discovery.
 * Live TV keeps a short Hebrew name; others get an IL - prefix.
 * Search extras are stripped so Stremio uses חיפוש משולב.
 */
function prepareKanboxCatalog(cat, { isLive = false } = {}) {
    let name = cat.name || cat.id;
    if (isLive) {
        // User-facing label for Live_TV_Channels
        name = 'ערוצים חיים';
    } else if (!name.includes('Israeli') && !name.startsWith('IL - ')) {
        name = `IL - ${name}`;
    }

    const nonSearchExtra = cat.extra
        ? cat.extra.filter(e => e.name !== 'search')
        : [];

    return {
        ...cat,
        name,
        // Browsable catalogs need a defined extra array even if only search was stripped
        extra: nonSearchExtra.length > 0 ? nonSearchExtra : []
    };
}

async function fetchAddonManifest(baseUrl, headers) {
    const res = await fetchWithTimeout(`${baseUrl}/manifest.json`, { headers }, 7500);
    if (!res.ok) return null;
    return await res.json();
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const clientUA = req.headers['user-agent'] || 'Stremio/4.4.156';
    const forwardedIps = req.headers['x-forwarded-for'] || '';
    const clientIp = forwardedIps ? forwardedIps.split(',')[0].trim() : (req.socket?.remoteAddress || '');

    const proxyHeaders = { 'User-Agent': clientUA, 'X-Forwarded-For': clientIp };

    try {
        const urlParts = req.url.split('?')[0].split('/');
        const userKey = urlParts[1] || 'default';
        const configs = JSON.parse(process.env.USER_CONFIGS || '{}');
        const userConfig = configs[userKey] || { name: 'Unknown' };
        const addonUrls = (process.env.ADDON_URLS || '').split('|||').map(u => u.trim()).filter(Boolean);

        const tvAddonUrl = (process.env.TV_ADDON_URL || '').replace(/\/manifest\.json$/i, '').replace(/\/$/, '');

        const fetchKanbox = tvAddonUrl
            ? fetchAddonManifest(tvAddonUrl, proxyHeaders).catch((e) => {
                console.error('TV Addon fetch error:', e.message);
                return null;
            })
            : Promise.resolve(null);

        const fetchAnime = buildEsayAnimeCatalogs(addonUrls, async (baseUrl) => {
            try {
                return await fetchAddonManifest(baseUrl, proxyHeaders);
            } catch (e) {
                console.error('AnimeIL manifest fetch error:', e.message);
                return null;
            }
        });

        const [tvManifest, animeCatalogs] = await Promise.all([fetchKanbox, fetchAnime]);

        let firstKanboxCatalog = null;
        let restKanboxCatalogs = [];
        const catalogs = tvManifest?.catalogs || [];
        if (catalogs.length > 0) {
            // Prefer Live_TV_Channels as the promoted first row; fall back to catalogs[0]
            const liveIdx = catalogs.findIndex(c => String(c.id || '') === 'Live_TV_Channels');
            const liveCat = liveIdx >= 0 ? catalogs[liveIdx] : catalogs[0];
            firstKanboxCatalog = prepareKanboxCatalog(liveCat, { isLive: true });

            restKanboxCatalogs = catalogs
                .filter(cat => cat !== liveCat && !DBZ_CATALOG_IDS.has(String(cat.id || '')))
                .map(cat => prepareKanboxCatalog(cat));
        }

        const unifiedSearchCatalogs = [
            { id: "esay_mixed_search_movie", type: "movie", name: " חיפוש משולב", extra: [{ name: "search", isRequired: true }] },
            { id: "esay_mixed_search_series", type: "series", name: " חיפוש משולב", extra: [{ name: "search", isRequired: true }] },
            { id: "esay_mixed_search_complete", type: "anime", name: " חיפוש משולב - complete", extra: [{ name: "search", isRequired: true }] },
            { id: "esay_mixed_search_full", type: "anime", name: " חיפוש משולב - full", extra: [{ name: "search", isRequired: true }] }
        ];

        return res.status(200).json({
            id: `com.esay.${userKey}`,
            version: "2.12.0",
            name: `Personal - ${userConfig.name || userKey}`,
            description: "Personal Aggregator with Unified Search & LiveTV Israel",
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
                ...(firstKanboxCatalog ? [firstKanboxCatalog] : []),
                ...unifiedSearchCatalogs,
                ...animeCatalogs,
                ...restKanboxCatalogs
            ]
        });
    } catch (error) {
        console.error('Manifest Proxy Error:', error);
        return res.status(500).json({ error: "Internal Server Error" });
    }
}
