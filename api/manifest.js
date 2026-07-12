import fetch from 'node-fetch';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const urlParts = req.url.split('?')[0].split('/');
        const userKey = urlParts[1] || 'default';
        const configs = JSON.parse(process.env.USER_CONFIGS || '{}');
        
        const userConfig = configs[userKey] || { name: 'Unknown', catalogBase: '', profile: 'friends_light' };
        const displayName = userConfig.name || userKey;

        let finalCatalogs = [];

        // 1. משיכת קטלוג הטלוויזיה ודחיפתו למקום הראשון (כולל ניקוי manifest.json מההגדרות)
        const tvAddonUrl = process.env.TV_ADDON_URL;
        if (tvAddonUrl) {
            try {
                const cleanTvUrl = tvAddonUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
                const tvManifestUrl = `${cleanTvUrl}/manifest.json`;
                
                const tvRes = await fetch(tvManifestUrl, { timeout: 5000 });
                if (tvRes.ok) {
                    const tvManifest = await tvRes.json();
                    if (tvManifest.catalogs) {
                        const tvCatalogs = tvManifest.catalogs.map(cat => ({
                            ...cat,
                            showInHome: true // מכריח הופעה במסך הבית
                        }));
                        finalCatalogs.push(...tvCatalogs);
                    }
                }
            } catch (e) {
                console.error('Failed to fetch TV catalogs:', e.message);
            }
        }
        
        // 2. משיכת הקטלוגים של המשתמש מ-AIOMetaData (יופיעו אחרי הטלוויזיה, כולל ניקוי)
        if (userConfig.catalogBase) {
            try {
                const cleanCatalogBase = userConfig.catalogBase.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
                const manifestUrl = `${cleanCatalogBase}/manifest.json`;
                
                const catRes = await fetch(manifestUrl, { timeout: 5000 });
                if (catRes.ok) {
                    const catManifest = await catRes.json();
                    if (catManifest.catalogs) {
                        finalCatalogs.push(...catManifest.catalogs);
                    }
                }
            } catch (e) {
                console.error(`Failed to fetch external catalogs for user ${userKey}:`, e.message);
            }
        }

        const manifest = {
            id: `com.vecret.${userKey}`,
            version: "1.0.5",
            name: `Vecret - ${displayName}`,
            description: `Private Serverless Proxy`,
            types: ["movie", "series", "anime", "tv", "channel"],
            catalogs: finalCatalogs,
            resources: [
                "stream",
                "subtitles",
                ...(finalCatalogs.length > 0 ? ["catalog"] : [])
            ],
            idPrefixes: ["tt", "kitsu", "animeil"] // הוספתי תמיכה באנימה כדי שחיפושים יעבדו טוב יותר
        };

        return res.status(200).json(manifest);
    } catch (error) {
        console.error('Manifest Error:', error);
        return res.status(500).json({ error: "Internal Server Error" });
    }
}
