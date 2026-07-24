import fetch from 'node-fetch';

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const clientUA = req.headers['user-agent'] || 'Stremio/4.4.156';
    const forwardedIps = req.headers['x-forwarded-for'] || '';
    const clientIp = forwardedIps ? forwardedIps.split(',')[0].trim() : (req.socket?.remoteAddress || '');
    
    // ניהול מוקפד של Headers
    const kanboxHeaders = { 'User-Agent': clientUA, 'X-Forwarded-For': clientIp };
    const standardHeaders = { 'User-Agent': clientUA };

    try {
        const urlParts = req.url.split('?')[0].split('/');
        const userKey = urlParts[1] || 'default';
        const configs = JSON.parse(process.env.USER_CONFIGS || '{}');
        const userConfig = configs[userKey] || { name: 'Unknown', catalogBase: '' };

        let firstKanboxCatalog = null;
        let aioCatalogs = [];
        let restKanboxCatalogs = [];

        const tvAddonUrl = process.env.TV_ADDON_URL;
        if (tvAddonUrl) {
            try {
                const cleanTvUrl = tvAddonUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
                const tvRes = await fetchWithTimeout(`${cleanTvUrl}/manifest.json`, { headers: kanboxHeaders }, 7500);
                if (tvRes.ok) {
                    const tvManifest = await tvRes.json();
                    const catalogs = tvManifest?.catalogs || [];
                    
                    if (catalogs.length > 0) {
                        // שומרים את הקטלוג הראשון שיופיע בראש הרשימה
                        firstKanboxCatalog = catalogs[0];
                        
                        // לוקחים את שאר הקטלוגים
                        const remainingCatalogs = catalogs.slice(1);
                        
                        restKanboxCatalogs = remainingCatalogs
                            // Task 2: Hide Dragon Ball catalogs from the aggregator Board.
                            // They're still reachable via the Kan-Box addon's own discovery page.
                            .filter(cat => !String(cat.id || '').startsWith('dbz'))
                            .map(cat => ({
                                ...cat,
                                name: cat.name.includes('Israeli') ? cat.name : `IL - ${cat.name}`,
                                // Strip the 'search' extra so Stremio doesn't search these catalogs
                                // directly — our "חיפוש משולב" unified searches handle Kan-Box search.
                                // Catalogs that are ONLY a search interface (isRequired:true) are
                                // dropped entirely; browsable ones keep their other extras.
                                extra: cat.extra
                                    ? cat.extra.filter(e => e.name !== 'search').length > 0
                                        ? cat.extra.filter(e => e.name !== 'search')
                                        : undefined
                                    : undefined
                            }))
                            // Drop catalogs whose only purpose was search (now undefined extra means search-only)
                            .filter(cat => cat.extra !== undefined);
                    }
                }
            } catch (e) { 
                console.error('TV Addon fetch error:', e.message); 
            }
        }
        
        if (userConfig.catalogBase) {
            try {
                const cleanCatalogBase = userConfig.catalogBase.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
                
                // === שינוי 1: שימוש ב-kanboxHeaders כדי למנוע חסימת AIO ===
                const catRes = await fetchWithTimeout(`${cleanCatalogBase}/manifest.json`, { headers: kanboxHeaders }, 7500);
                
                if (catRes.ok) {
                    const catManifest = await catRes.json();
                    if (catManifest?.catalogs) {
                        aioCatalogs = catManifest.catalogs;
                    }
                }
            } catch (e) { 
                console.error('AIO fetch error:', e.message); 
            }
        }

        const unifiedSearchCatalogs = [
            { id: "esay_mixed_search_movie", type: "movie", name: " חיפוש משולב", extra: [{ name: "search", isRequired: true }] },
            { id: "esay_mixed_search_series", type: "series", name: " חיפוש משולב", extra: [{ name: "search", isRequired: true }] },
            // "complete" = VIP (Kan-Box/AnimeIL) + anime + tv/channel. Movie/series mixed
            // searches intentionally exclude those so they stay in this catch-all only.
            { id: "esay_mixed_search_complete", type: "anime", name: " חיפוש משולב - complete", extra: [{ name: "search", isRequired: true }] }
        ];

        return res.status(200).json({
            id: `com.esay.${userKey}`,
            version: "2.8.0",
            name: `Esay - ${userConfig.name || userKey}`,
            description: "Esay Aggregator with Unified Search & LiveTV Israel",
            // tt/tmdb: סטנדרט | il_/dbz: ישראלי | mal/kitsu/anilist/anidb: אנימה
            // tvdb: סדרות | http/https: סטרימינג ישיר (Yuki ודומים)
            idPrefixes: ["tt", "tmdb", "il_", "mal", "kitsu", "anilist", "anidb", "tvdb", "http", "https", "dbz:"],
            resources: [
                "stream",
                "catalog",
                "meta",
                {
                    name: "subtitles",
                    types: ["movie", "series", "anime"],
                    idPrefixes: ["tt", "tmdb:", "kitsu:", "mal:", "anilist:", "anidb:", "tvdb", "http", "https", "dbz:"]
                }
            ],
            types: ["movie", "series", "anime", "tv", "channel"],
            catalogs: [
                ...(firstKanboxCatalog ? [firstKanboxCatalog] : []), // ה-First ממוקם ראשון לחלוטין
                ...unifiedSearchCatalogs,
                ...aioCatalogs,
                ...restKanboxCatalogs
            ]
        });
    } catch (error) {
        console.error('Manifest Proxy Error:', error);
        return res.status(500).json({ error: "Internal Server Error" });
    }
}
