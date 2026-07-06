import fetch from 'node-fetch';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const urlParts = req.url.split('?')[0].split('/');
        const user = urlParts[1] || 'default';
        const configs = JSON.parse(process.env.USER_CONFIGS || '{}');
        const userConfig = configs[user] || { catalogBase: '', profile: 'friends_light' };

        let externalCatalogs = [];
        
        // משיכת הקטלוגים של המשתמש מ-AIOMetaData במקור
        if (userConfig.catalogBase) {
            try {
                const manifestUrl = `${userConfig.catalogBase.replace(/\/$/, '')}/manifest.json`;
                const catRes = await fetch(manifestUrl);
                if (catRes.ok) {
                    const catManifest = await catRes.json();
                    if (catManifest.catalogs) {
                        externalCatalogs = catManifest.catalogs;
                    }
                }
            } catch (e) {
                console.error(`Failed to fetch external catalogs for user ${user}:`, e);
            }
        }

        const manifest = {
            id: `com.vecret.${user}`,
            version: "1.0.0",
            name: `Vecret - ${user}`,
            description: `Private Serverless Proxy`,
            types: ["movie", "series", "anime"],
            catalogs: externalCatalogs,
            resources: [
                "stream",
                "subtitles",
                ...(externalCatalogs.length > 0 ? ["catalog"] : [])
            ],
            idPrefixes: ["tt"]
        };

        return res.status(200).json(manifest);
    } catch (error) {
        console.error('Manifest Error:', error);
        return res.status(500).json({ error: "Internal Server Error" });
    }
}
