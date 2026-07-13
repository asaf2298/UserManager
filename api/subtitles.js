import fetch from 'node-fetch';

// --- הגדרות שפות נתמכות (נרמול) ---
const ALLOWED_LANGS = new Set([
    'he', 'heb', 'hebrew', 'iw', 'he-il', 'עברית',
    'en', 'eng', 'english', 'en-us', 'en-gb',
    'ru', 'rus', 'russian',
    'submaker', 'forced', 'hi'
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
        if (subIdx < 1 || subIdx + 2 >= urlParts.length) {
            return res.status(400).json({ subtitles: [] });
        }

        const type = urlParts[subIdx + 1];
        // חותכים את ה- .json מהמזהה המקורי כדי שלא יווצר כפל
        const id = urlParts[subIdx + 2].replace('.json', '');
        
        const subtitleUrls = (process.env.SUBTITLE_URLS || '').split('|||').map(u => u.trim()).filter(Boolean);
        if (subtitleUrls.length === 0) return res.status(200).json({ subtitles: [] });

        // פונקציית שליפה מבודדת ומנוטרת לכתוביות
        const fetchSubtitleAddon = async (baseUrl) => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 4650); // 4 שניות גג לכתוביות

            // הניקוי הקריטי - מסיר manifest.json כדי למנוע 404
            const cleanBaseUrl = baseUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
            // הרכבה נכונה ותקנית של הלינק עם .json בסוף
            const targetUrl = `${cleanBaseUrl}/subtitles/${type}/${id}.json`;

            const headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8'
            };

            const startTime = performance.now();

            try {
                const response = await fetch(targetUrl, { signal: controller.signal, headers });
                const durationMs = (performance.now() - startTime).toFixed(0);

                if (!response.ok) {
                    console.error(`[Vecret Subtitles] ❌ ${baseUrl.substring(0, 45)}... returned status ${response.status} after ${durationMs}ms`);
                    return { subtitles: [] };
                }
                
                const data = await response.json();
                const subCount = (data && Array.isArray(data.subtitles)) ? data.subtitles.length : 0;
                console.log(`[Vecret Subtitles] ⏱️  ${baseUrl.substring(0, 45)}... responded in ${durationMs}ms (Found ${subCount} subs)`);
                
                return data;
            } catch (err) {
                const durationMs = (performance.now() - startTime).toFixed(0);
                if (err.name === 'AbortError') {
                    console.warn(`[Vecret Subtitles] ⏱️  ${baseUrl.substring(0, 45)}... TIMEOUT hit after ${durationMs}ms!`);
                } else {
                    console.error(`[Vecret Subtitles] ❌ ${baseUrl.substring(0, 45)}... FAILED after ${durationMs}ms. Error: ${err.message}`);
                }
                return { subtitles: [] };
            } finally {
                clearTimeout(timeoutId);
            }
        };

        const requests = subtitleUrls.map(url => fetchSubtitleAddon(url));
        const results = await Promise.allSettled(requests);
        
        // --- איסוף כל הכתוביות למערך אחד ---
        let allSubs = [];
        for (const r of results) {
            if (r.status === 'fulfilled' && r.value && Array.isArray(r.value.subtitles)) {
                allSubs = allSubs.concat(r.value.subtitles);
            }
        }

        // --- ניקוי, סינון ומיון חכם ---
        
        // 1. סינון שפות לפי הפונקציה החכמה שלנו (תופס עברית, אנגלית, רוסית, ו-submaker)
        allSubs = allSubs.filter(sub => isAllowedLang(sub.lang, sub.title));

        // 2. הסרת כפילויות (Deduplication)
        const uniqueSubsMap = new Map();
        for (const sub of allSubs) {
            const lang = (sub.lang || '').toLowerCase();
            const key = `${sub.id}_${lang}`; // מזהה ייחודי לפי ID ושפה
            if (!uniqueSubsMap.has(key)) {
                uniqueSubsMap.set(key, sub);
            }
        }
        let uniqueSubs = Array.from(uniqueSubsMap.values());

        // 3. מיון: עברית תמיד למעלה
        uniqueSubs.sort((a, b) => {
            const langA = (a.lang || '').toLowerCase();
            const langB = (b.lang || '').toLowerCase();
            const isHebA = ['he', 'heb', 'hebrew', 'iw', 'עברית'].includes(langA);
            const isHebB = ['he', 'heb', 'hebrew', 'iw', 'עברית'].includes(langB);
            
            if (isHebA && !isHebB) return -1; // עברית קודמת לכל השאר
            if (!isHebA && isHebB) return 1;
            return 0;
        });

        // החזרה לסטרימיו
        return res.status(200).json({ subtitles: uniqueSubs });

    } catch (error) {
        console.error('Subtitle Proxy Error:', error);
        return res.status(500).json({ subtitles: [] });
    }
}
