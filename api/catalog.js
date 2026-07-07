import fetch from 'node-fetch';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const urlParts = req.url.split('?')[0].split('/');
        const catIdx = urlParts.indexOf('catalog');
        if (catIdx < 1) return res.status(400).json({ metas: [] });

        const user = urlParts[catIdx - 1];
        const type = urlParts[catIdx + 1];
        // לוקח את כל שאר הנתיב (כמו tmdb.json או tmdb/genre=Action.json)
        const catalogPathEnd = urlParts.slice(catIdx + 2).join('/');
        
        const configs = JSON.parse(process.env.USER_CONFIGS || '{}');
        const userConfig = configs[user];

        if (!userConfig || !userConfig.catalogBase) {
            return res.status(404).json({ metas: [] });
        }

        const targetUrl = `${userConfig.catalogBase.replace(/\/$/, '')}/catalog/${type}/${catalogPathEnd}`;
        
        const fetchRes = await fetch(targetUrl);
        if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}`);
        
        const data = await fetchRes.json();
        return res.status(200).json(data);

    } catch (error) {
        console.error('Catalog Proxy Error:', error);
        return res.status(500).json({ metas: [] });
    }
}
