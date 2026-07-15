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
    // מניעת שגיאת קאש של תוכן לייב בצד Vercel
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
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
        
        const forwardType = (type === 'tv' || type === 'channel') ? 'series' : type;
        const targetUrl = `${cleanTvUrl}/meta/${forwardType}/${idWithExt}`;

        const forwardedIps = req.headers['x-forwarded-for'] || '';
        const clientIp = forwardedIps ? forwardedIps.split(',')[0].trim() : (req.socket?.remoteAddress || '');

        const headers = {
            'User-Agent': req.headers['user-agent'] || 'Stremio/4.4.156',
            'Accept': 'application/json, text/plain, */*',
            'X-Forwarded-For': clientIp
        };

        const response = await fetchWithTimeout(targetUrl, { headers }, 5000);

        if (response.ok) {
            const data = await response.json();
            if (data && data.meta) {
                data.meta.type = type; 
                data.meta.id = id;

                if ((type === 'tv' || type === 'channel')) {
                    const channelName = data.meta.name || id.replace(/_/g, ' ');
                    if (!data.meta.description || data.meta.description.trim() === '') {
                        data.meta.description = `שידור חי - ${channelName}`;
                    }
                }
                return res.status(200).json(data);
            }
        }
        
        return res.status(404).json({ meta: null });

    } catch (error) {
        return res.status(404).json({ meta: null });
    }
}
