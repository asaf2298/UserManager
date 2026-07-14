import fetch from 'node-fetch';

// שילוב פונקציית העזר לאחידות בכל הפרויקט
async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}

const ALLOWED_LANGS = new Set([
    'he', 'heb', 'hebrew', 'iw', 'he-il', 'עברית',
    'en', 'eng', 'english', 'en-us', 'en-gb',
    'ru', 'rus', 'russian',
    'submaker', 'make hebrew', 'forced', 'hi'
]);

function isAllowedLang(lang, title) {
    if (!lang && !title) return false;
    const normalizedLang = (lang || '').toLowerCase().trim();
    const normalizedTitle = (title || '').toLowerCase().trim();
    return ALLOWED_LANGS.has(normalizedLang) || ALLOWED_LANGS.has(normalizedTitle);
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const urlParts = req.url.split('?')[0].split('/');
        const subIdx = urlParts.indexOf('subtitles');
        if (subIdx < 1 || subIdx + 2 >= urlParts.length) return res.status(400).json({ subtitles: [] });

        const type = urlParts[subIdx + 1];
        const id = urlParts[subIdx + 2].replace('.json', '');
        
        const subtitleUrls = (process.env.SUBTITLE_URLS || '').split('|||').map(u => u.trim()).filter(Boolean);
        if (subtitleUrls.length === 0) return res.status(200).json({ subtitles: [] });

        const fetchSubtitleAddon = async (baseUrl) => {
            const cleanBaseUrl = baseUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
            const targetUrl = `${cleanBaseUrl}/subtitles/${type}/${id}.json`;

            const headers = {
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'application/json, text/plain, */*'
            };

            try {
                // שימוש במעטפת התיקנית למניעת תקיעות ודליפות
                const response = await fetchWithTimeout(targetUrl, { headers }, 4650);
                if (!response.ok) return { subtitles: [] };
                return await response.json();
            } catch (err) {
                return { subtitles: [] };
            }
        };

        const requests = subtitleUrls.map(url => fetchSubtitleAddon(url));
        const results = await Promise.allSettled(requests);
        
        let allSubs = [];
        for (const r of results) {
            if (r.status === 'fulfilled' && r.value && Array.isArray(r.value.subtitles)) {
                allSubs = allSubs.concat(r.value.subtitles);
            }
        }

        allSubs = allSubs.filter(sub => isAllowedLang(sub.lang, sub.title));

        const uniqueSubsMap = new Map();
        for (const sub of allSubs) {
            const lang = (sub.lang || '').toLowerCase();
            const key = sub.url ? sub.url : `${sub.id}_${lang}`; 
            if (!uniqueSubsMap.has(key)) {
                uniqueSubsMap.set(key, sub);
            }
        }
        let uniqueSubs = Array.from(uniqueSubsMap.values());

        uniqueSubs.sort((a, b) => {
            const langA = (a.lang || '').toLowerCase();
            const langB = (b.lang || '').toLowerCase();
            const isHebA = ['he', 'heb', 'hebrew', 'iw', 'עברית'].includes(langA);
            const isHebB = ['he', 'heb', 'hebrew', 'iw', 'עברית'].includes(langB);
            
            if (isHebA && !isHebB) return -1; 
            if (!isHebA && isHebB) return 1;
            return 0;
        });

        return res.status(200).json({ subtitles: uniqueSubs });

    } catch (error) {
        console.error('Subtitle Proxy Error:', error);
        return res.status(500).json({ subtitles: [] });
    }
}
