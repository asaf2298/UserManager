import fetch from 'node-fetch';

const PROFILES = {
    everything: { maxResults: 25, maxSizeGB: Infinity, minSeedersUncached: 1, hasHDR: true, hasHDAudio: true, timeoutMs: 18000 },
    family: { maxResults: 7, maxSizeGB: 30, minSeedersUncached: 5, hasHDR: false, hasHDAudio: false, timeoutMs: 10000 },
    friends_light: { maxResults: 7, maxSizeGB: 30, minSeedersUncached: 5, hasHDR: false, hasHDAudio: false, timeoutMs: 10000 },
    friends_heavy: { maxResults: 25, maxSizeGB: Infinity, minSeedersUncached: 5, hasHDR: true, hasHDAudio: true, timeoutMs: 18000 }
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const urlParts = req.url.split('?')[0].split('/');
        const streamIdx = urlParts.indexOf('stream');
        const user = urlParts[streamIdx - 1];
        const configs = JSON.parse(process.env.USER_CONFIGS || '{}');
        const profile = PROFILES[configs[user]?.profile] || PROFILES.friends_light;
        
        const type = urlParts[streamIdx + 1];
        const idWithExt = urlParts[streamIdx + 2];
        const addons = (process.env.ADDON_URLS || '').split(',').map(u => u.trim());

        const requests = addons.map(baseUrl => {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), profile.timeoutMs);
            return fetch(`${baseUrl.replace(/\/$/, '')}/stream/${type}/${idWithExt}`, { signal: controller.signal })
                .then(r => r.json()).then(d => { clearTimeout(id); return d; }).catch(() => { clearTimeout(id); return { streams: [] }; });
        });

        const results = await Promise.all(requests);
        let allStreams = results.flatMap(r => r.streams || []);
        
        // כאן מגיע הסינון והמיון (כפי שכתבנו בשלב 1)
        // ... (הלוגיקה נשארת כפי שהגדרנו) ...
        
        return res.status(200).json({ streams: allStreams.slice(0, profile.maxResults) });
    } catch (e) {
        return res.status(500).json({ streams: [] });
    }
}
