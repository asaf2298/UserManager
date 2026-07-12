import fetch from 'node-fetch';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const urlParts = req.url.split('?')[0].split('/');
        const userKey = urlParts[1] || 'default';
        const configs = JSON.parse(process.env.USER_CONFIGS || '{}');
        const userConfig = configs[userKey] || { name: 'Unknown', catalogBase: '' };

        let firstKanboxCatalog = null;  // הקטלוג הראשון מ-KANBOX
        let aioCatalogs = [];           // כל הקטלוגים מ-AIOMETADATA
        let restKanboxCatalogs = [];    // שאר הקטלוגים מ-KANBOX

        // 1. טיפול ב-Kan-Box (פיצול לראשון + שאר)
        const tvAddonUrl = process.env.TV_ADDON_URL;
        if (tvAddonUrl) {
            try {
                const cleanTvUrl = tvAddonUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
                const tvRes = await fetch(`${cleanTvUrl}/manifest.json`, { timeout: 4000 });
                if (tvRes.ok) {
                    const tvManifest = await tvRes.json();
                    
                    if (tvManifest.catalogs && tvManifest.catalogs.length > 0) {
                        // הקטלוג הראשון נשמר בנפרד
                        firstKanboxCatalog = tvManifest.catalogs[0];
                        // שאר הקטלוגים
                        restKanboxCatalogs = tvManifest.catalogs.slice(1);
                    }
                }
            } catch (e) { console.error('Kan-Box fetch error:', e.message); }
        }
        
        // 2. משיכת AIOMetaData
        if (userConfig.catalogBase) {
            try {
                const cleanCatalogBase = userConfig.catalogBase.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
                const catRes = await fetch(`${cleanCatalogBase}/manifest.json`, { timeout: 4000 });
                if (catRes.ok) {
                    const catManifest = await catRes.json();
                    if (catManifest.catalogs) aioCatalogs.push(...catManifest.catalogs);
                }
            } catch (e) { console.error('AIO fetch error:', e.message); }
        }

        // 3. הרכבת הסדר הסופי: קטלוג ראשון של KANBOX -> AIO -> שאר KANBOX
        const finalCatalogs = [
            ...(firstKanboxCatalog ? [firstKanboxCatalog] : []),
            ...aioCatalogs,
            ...restKanboxCatalogs
        ];

        return res.status(200).json({
            id: `com.vecret.${userKey}`,
            version: "2.2.0",
            name: `Vecret - ${userConfig.name || userKey}`,
            resources: ["stream", "subtitles", "catalog"],
            types: ["movie", "series", "anime", "tv", "channel"],
            catalogs: finalCatalogs
            // אין idPrefixes = catchall לכל התכנים
        });
    } catch (error) {
        return res.status(500).json({ error: "Internal Server Error" });
    }
}
