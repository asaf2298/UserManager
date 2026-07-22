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
    // מניעת שגיאת קאש של תוכן לייב בצד Vercel (נשמר!)
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const urlParts = req.url.split('?')[0].split('/');
        const metaIdx = urlParts.indexOf('meta');
        
        // שינוי קטן כדי לאפשר שליפת קונפיגורציה של AIO מהנתיב (משיכת ה-userKey)
        if (metaIdx < 1 || metaIdx + 2 >= urlParts.length) return res.status(404).json({ meta: null });

        const userKey = urlParts[metaIdx - 1]; 
        const type = urlParts[metaIdx + 1];
        let rawIdWithExt = urlParts[metaIdx + 2];
        
        // פענוח וטיפול במזהים (נשמר!)
        if (rawIdWithExt.includes('%')) rawIdWithExt = decodeURIComponent(rawIdWithExt);
        const idWithExt = rawIdWithExt;
        const id = idWithExt.replace('.json', '');

        // 🔴 השורה הזו הוסרה כדי לאפשר לסרטים/סדרות מ-IMDb לקבל מידע!
        // if (id.startsWith('tt')) return res.status(404).json({ meta: null });

        // טעינת משתני סביבה כדי להכיר את שרת ה-AIO והשרת הישראלי
        const configs = JSON.parse(process.env.USER_CONFIGS || '{}');
        const userConfig = configs[userKey] || {};
        const catalogBaseUrl = (userConfig.catalogBase || '').replace(/\/manifest\.json$/i, '').replace(/\/$/, '');

        const tvAddonUrl = process.env.TV_ADDON_URL;
        const cleanTvUrl = tvAddonUrl ? tvAddonUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '') : '';

        // הלוגיקה שלך לניתוב ערוצים (נשמר!)
        const forwardType = (type === 'tv' || type === 'channel') ? 'series' : type;

        // 🟢 ניתוב חכם: מה ששלנו הולך לישראלי, הכל השאר (AIO) הולך ל-catalogBaseUrl
        let targetUrl = '';
        if (id.startsWith('dbz:') || id.startsWith('il_') || type === 'tv' || type === 'channel') {
            if (!cleanTvUrl) return res.status(404).json({ meta: null });
            targetUrl = `${cleanTvUrl}/meta/${forwardType}/${idWithExt}`;
        } else {
            if (!catalogBaseUrl) return res.status(404).json({ meta: null });
            targetUrl = `${catalogBaseUrl}/meta/${type}/${idWithExt}`;
        }

        // חילוץ IP להדרים כדי למנוע חסימה (נשמר!)
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
                // דריסת מזהים (נשמר!)
                data.meta.type = type; 
                data.meta.id = id;

                // יצירת תיאור לערוצים בלייב (נשמר הלוגיקה שלך אחד לאחד!)
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
