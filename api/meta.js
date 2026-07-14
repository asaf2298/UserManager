import fetch from 'node-fetch';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const urlParts = req.url.split('?')[0].split('/');
        const metaIdx = urlParts.indexOf('meta');
        if (metaIdx < 0 || metaIdx + 2 >= urlParts.length) return res.status(404).json({ meta: null });

        const type = urlParts[metaIdx + 1];
        let rawIdWithExt = urlParts[metaIdx + 2];
        if (rawIdWithExt.includes('%')) rawIdWithExt = decodeURIComponent(rawIdWithExt);

        const idWithExt = rawIdWithExt;
        const id = idWithExt.replace('.json', '');

        if (id.startsWith('tt')) return res.status(404).json({ meta: null });

        const tvAddonUrl = process.env.TV_ADDON_URL;
        if (!tvAddonUrl) return res.status(404).json({ meta: null });

        const cleanTvUrl = tvAddonUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
        
        // --- התיקון: ממיר ל-series מול Kan-Box כדי שיענה ---
        const forwardType = (type === 'tv' || type === 'channel') ? 'series' : type;
        const targetUrl = `${cleanTvUrl}/meta/${forwardType}/${idWithExt}`;

        const forwardedIps = req.headers['x-forwarded-for'] || '';
        const clientIp = forwardedIps ? forwardedIps.split(',')[0].trim() : (req.socket?.remoteAddress || '');

        const headers = {
            'User-Agent': req.headers['user-agent'] || 'Stremio/4.4.156',
            'Accept': 'application/json, text/plain, */*',
            'X-Forwarded-For': clientIp
        };

        const response = await fetch(targetUrl, { headers, timeout: 5000 });

        if (response.ok) {
            const data = await response.json();
            if (data && data.meta) {
                // --- התיקון: מבטיח שסטרימיו יקבל את ה-type המקורי שביקש כדי למנוע No Metadata ---
                data.meta.type = type; 
                return res.status(200).json(data);
            }
        }
        
        return res.status(404).json({ meta: null });

    } catch (error) {
        return res.status(404).json({ meta: null });
    }
}
