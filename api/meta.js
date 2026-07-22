import fetch from 'node-fetch';
import { debugLog } from '../lib/debugLog.js';

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}

async function fetchMetaJson(targetUrl, headers, timeoutMs) {
    const response = await fetchWithTimeout(targetUrl, { headers }, timeoutMs);
    if (!response.ok) return { ok: false, status: response.status, data: null };
    const data = await response.json();
    if (data && data.meta) return { ok: true, status: response.status, data };
    return { ok: false, status: response.status, data: null };
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

        // טעינת משתני סביבה כדי להכיר את שרת ה-AIO והשרת הישראלי
        const configs = JSON.parse(process.env.USER_CONFIGS || '{}');
        const userConfig = configs[userKey] || {};
        const catalogBaseUrl = (userConfig.catalogBase || '').replace(/\/manifest\.json$/i, '').replace(/\/$/, '');

        const tvAddonUrl = process.env.TV_ADDON_URL;
        const cleanTvUrl = tvAddonUrl ? tvAddonUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '') : '';

        // הלוגיקה שלך לניתוב ערוצים (נשמר!)
        const forwardType = (type === 'tv' || type === 'channel') ? 'series' : type;

        // חילוץ IP להדרים כדי למנוע חסימה (נשמר!)
        const forwardedIps = req.headers['x-forwarded-for'] || '';
        const clientIp = forwardedIps ? forwardedIps.split(',')[0].trim() : (req.socket?.remoteAddress || '');

        const headers = {
            'User-Agent': req.headers['user-agent'] || 'Stremio/4.4.156',
            'Accept': 'application/json, text/plain, */*',
            'X-Forwarded-For': clientIp
        };

        // 🟢 ניתוב חכם: מה ששלנו הולך לישראלי, הכל השאר (AIO) הולך ל-catalogBaseUrl
        let targetUrl = '';
        let branch = 'aio';
        if (id.startsWith('dbz:') || id.startsWith('il_') || type === 'tv' || type === 'channel') {
            if (!cleanTvUrl) return res.status(404).json({ meta: null });
            targetUrl = `${cleanTvUrl}/meta/${forwardType}/${idWithExt}`;
            branch = 'tv';
        } else {
            if (!catalogBaseUrl) {
                // No AIO configured — fall through to Cinemeta for tt ids
                targetUrl = '';
                branch = 'none';
            } else {
                targetUrl = `${catalogBaseUrl}/meta/${type}/${idWithExt}`;
            }
        }

        // #region agent log
        debugLog('H3', 'api/meta.js:start', 'meta request', {
            userKey, type, id: id.slice(0, 40), branch,
            targetHost: targetUrl ? targetUrl.split('/').slice(0, 3).join('/') : null,
            hasXff: !!clientIp
        });
        // #endregion

        let result = targetUrl ? await fetchMetaJson(targetUrl, headers, 5000) : { ok: false, status: 0, data: null };

        // H3: If AIO/catalogBase fails for IMDb ids, fall back to public Cinemeta so Board posters still load
        if (!result.ok && id.startsWith('tt') && branch !== 'tv') {
            const cineUrl = `https://v3-cinemeta.strem.io/meta/${type}/${idWithExt}`;
            console.log(`[ESAY META] 🔄 AIO miss for ${id} — falling back to Cinemeta`);
            result = await fetchMetaJson(cineUrl, headers, 4000);
            // #region agent log
            debugLog('H3', 'api/meta.js:cinemetaFallback', 'cinemeta fallback', {
                id: id.slice(0, 40),
                ok: result.ok,
                status: result.status,
                name: result.data?.meta?.name || null
            });
            // #endregion
        }

        if (result.ok && result.data?.meta) {
            const data = result.data;
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
        
        // #region agent log
        debugLog('H3', 'api/meta.js:miss', 'meta not found', { id: id.slice(0, 40), branch, status: result.status });
        // #endregion
        return res.status(404).json({ meta: null });

    } catch (error) {
        // #region agent log
        debugLog('H3', 'api/meta.js:error', 'meta error', { err: String(error && error.message || error) });
        // #endregion
        return res.status(404).json({ meta: null });
    }
}
