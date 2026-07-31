import { YASTREAM_MANIFEST_PREFIXES } from '../lib/yastream.js';
import { MIXED_SEARCH_CATALOG_IDS } from '../lib/catalogIds.js';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const urlParts = req.url.split('?')[0].split('/');
        const userKey = urlParts[1] || 'default';
        const configs = JSON.parse(process.env.USER_CONFIGS || '{}');
        const userConfig = configs[userKey] || { name: 'Unknown' };

        const unifiedSearchCatalogs = [
            { id: MIXED_SEARCH_CATALOG_IDS.movie, type: "movie", name: " חיפוש משולב", extra: [{ name: "search", isRequired: true }] },
            { id: MIXED_SEARCH_CATALOG_IDS.series, type: "series", name: " חיפוש משולב", extra: [{ name: "search", isRequired: true }] },
            { id: MIXED_SEARCH_CATALOG_IDS.complete, type: "anime", name: " חיפוש משולב - complete", extra: [{ name: "search", isRequired: true }] },
            { id: MIXED_SEARCH_CATALOG_IDS.full, type: "anime", name: " חיפוש משולב - full", extra: [{ name: "search", isRequired: true }] }
        ];

        return res.status(200).json({
            id: `com.personal.${userKey}`,
            version: "2.11.0",
            name: `Personal - ${userConfig.name || userKey}`,
            description: "Personal Aggregator with Unified Search",
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
            catalogs: [...unifiedSearchCatalogs]
        });
    } catch (error) {
        console.error('Manifest Proxy Error:', error);
        return res.status(500).json({ error: "Internal Server Error" });
    }
}
