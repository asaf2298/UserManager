import fetch from 'node-fetch';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const urlParts = req.url.split('?')[0].split('/');
        const userKey = urlParts[1] || 'default'; // כעת זה קוד ה-Trakt
        const configs = JSON.parse(process.env.USER_CONFIGS || '{}');
        
        const userConfig = configs[userKey] || { name: 'Unknown', catalogBase: '', profile: 'friends_light' };
        const displayName = userConfig.name || userKey;

        let finalCatalogs = [];

        // 1. משיכת קטלוג הטלוויזיה ודחיפתו למקום הראשון
        const tvAddonUrl = process.env.TV_ADDON_URL;
        if (tvAddonUrl) {
            try {
                const tvManifestUrl = `${tvAddonUrl.replace(/\/$/, '')}/manifest.json`;
                const tvRes = await fetch(tvManifestUrl);
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
                console.error('Failed to fetch TV catalogs:', e);
            }
        }
        
        // 2. משיכת הקטלוגים של המשתמש מ-AIOMetaData (יופיעו אחרי הטלוויזיה)
        if (userConfig.catalogBase) {
            try {
                const manifestUrl = `${userConfig.catalogBase.replace(/\/$/, '')}/manifest.json`;
                const catRes = await fetch(manifestUrl);
                if (catRes.ok) {
                    const catManifest = await catRes.json();
                    if (catManifest.catalogs) {
                        finalCatalogs.push(...catManifest.catalogs);
                    }
                }
            } catch (e) {
                console.error(`Failed to fetch external catalogs for user ${userKey}:`, e);
            }
        }

        const manifest = {
            id: `com.vecret.${userKey}`,
            version: "1.0.0",
            name: `Vecret - ${displayName}`,
            description: `Private Serverless Proxy`,
            types: ["movie", "series", "anime", "tv", "channel"],
            catalogs: finalCatalogs,
            resources: [
                "stream",
                "subtitles",
                ...(finalCatalogs.length > 0 ? ["catalog"] : [])
            ],
            idPrefixes: ["tt"]
        };

        return res.status(200).json(manifest);
    } catch (error) {
        console.error('Manifest Error:', error);
        return res.status(500).json({ error: "Internal Server Error" });
    }
}
