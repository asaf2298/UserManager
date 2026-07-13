import fetch from 'node-fetch';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const urlParts = req.url.split('?')[0].split('/');
        const metaIdx = urlParts.indexOf('meta');
        if (metaIdx < 0 || metaIdx + 2 >= urlParts.length) {
            return res.status(404).json({ meta: null });
        }

        const type = urlParts[metaIdx + 1];
        const idWithExt = urlParts[metaIdx + 2];
        const id = idWithExt.replace('.json', '');

        // מעקף ל-IMDb: מחזירים 404 כדי לאלץ את סטרימיו להשתמש ב-Cinemeta!
        if (id.startsWith('tt')) {
            return res.status(404).json({ meta: null });
        }

        const tvAddonUrl = process.env.TV_ADDON_URL;
        if (!tvAddonUrl) return res.status(404).json({ meta: null });

        const cleanTvUrl = tvAddonUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
        
        // תיקון נתיב חובה ל-Kanbox: אם type=tv, פונים ל-series
        const forwardType = type === 'tv' ? 'series' : type;
        const targetUrl = `${cleanTvUrl}/meta/${forwardType}/${idWithExt}`;

        const headers = {
            'User-Agent': req.headers['user-agent'] || 'Stremio/4.4.156',
            'Accept': 'application/json, text/plain, */*',
            'X-Forwarded-For': req.headers['x-forwarded-for'] || req.socket.remoteAddress,
            'Accept-Encoding': 'gzip'
        };

        const response = await fetch(targetUrl, { headers, timeout: 5000 });
        if (response.ok) {
            const data = await response.json();
            return res.status(200).json(data);
        }

        return res.status(404).json({ meta: null });

    } catch (error) {
        console.error('Meta Proxy Error:', error);
        return res.status(404).json({ meta: null });
    }
}
