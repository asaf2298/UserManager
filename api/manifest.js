import fetch from 'node-fetch';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const urlParts = req.url.split('?')[0].split('/');
        const userKey = urlParts[1] || 'default';
        const configs = JSON.parse(process.env.USER_CONFIGS || '{}');
        const userConfig = configs[userKey] || { name: 'Unknown', catalogBase: '' };

        let firstKanboxCatalog = null;  // הקטלוג הראשון (Live TV)
        let aioCatalogs = [];           // כל הקטלוגים מ-AIO
        let restKanboxCatalogs = [];    // שאר הקטלוגים מהספק הישראלי (VOD)

        // 1. טיפול בספק המקומי בבטחה
        const tvAddonUrl = process.env.TV_ADDON_URL;
        if (tvAddonUrl) {
            try {
                const cleanTvUrl = tvAddonUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
                const tvRes = await fetch(`${cleanTvUrl}/manifest.json`, { timeout: 4600 });
                
                if (tvRes.ok) {
                    const tvManifest = await tvRes.json();
                    const catalogs = tvManifest?.catalogs || [];
                    
                    if (catalogs.length > 0) {
                        firstKanboxCatalog = catalogs[0];
                        
                        restKanboxCatalogs = catalogs.slice(1).map(cat => ({
                            ...cat,
                            name: cat.name.includes('Israeli') ? cat.name : `Israeli - ${cat.name}`
                        }));
                    }
                }
            } catch (e) { 
                console.error('TV Addon fetch error:', e.message); 
            }
        }
        
        // 2. משיכת AIOMetaData בבטחה
        if (userConfig.catalogBase) {
            try {
                const cleanCatalogBase = userConfig.catalogBase.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
                const catRes = await fetch(`${cleanCatalogBase}/manifest.json`, { timeout: 4600 });
                
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

        // 3. יצירת קטלוגי החיפוש המאוחד של Esay
        const unifiedSearchCatalogs = [
            {
                id: "esay_mixed_search_movie",
                type: "movie",
                name: "Esay - חיפוש משולב",
                extra: [{ name: "search", isRequired: true }]
            },
            {
                id: "esay_mixed_search_series",
                type: "series",
                name: "Esay - חיפוש משולב",
                extra: [{ name: "search", isRequired: true }]
            }
        ];

        // 4. הרכבת הסדר הסופי
        const finalCatalogs = [
            ...(firstKanboxCatalog ? [firstKanboxCatalog] : []),
            ...unifiedSearchCatalogs,
            ...aioCatalogs,
            ...restKanboxCatalogs
        ];

        return res.status(200).json({
            id: `com.esay.${userKey}`,
            version: "2.4.0", // הקפצת גרסה חיונית בגלל שינוי ה-ID והשמות
            name: `Esay - ${userConfig.name || userKey}`,
            description: "Esay Aggregator with Unified Search & Israeli HTTP support",
            resources: ["stream", "subtitles", "catalog"],
            types: ["movie", "series", "anime", "tv", "channel"],
            catalogs: finalCatalogs
        });
        
    } catch (error) {
        console.error('Manifest Proxy Error:', error);
        return res.status(500).json({ error: "Internal Server Error" });
    }
}
