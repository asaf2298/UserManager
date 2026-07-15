import fetch from 'node-fetch';
import https from 'https';
import { getCleanMovieName } from './search.js'; 

// הוספת סוכן שמתעלם משגיאות של תעודות אבטחה חינמיות (כמו של sub.scary.network)
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, agent: httpsAgent, signal: controller.signal });
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
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    console.log(`\n======================================================`);
    console.log(`[ESAY SUBTITLES] 📝 בקשת כתוביות חדשה התקבלה!`);

    try {
        const urlParts = req.url.split('?')[0].split('/');
        const subIdx = urlParts.indexOf('subtitles');
        if (subIdx < 1 || subIdx + 2 >= urlParts.length) return res.status(400).json({ subtitles: [] });

        const type = urlParts[subIdx + 1];
        const id = urlParts[subIdx + 2].replace('.json', '');
        
        const subtitleUrls = (process.env.SUBTITLE_URLS || '').split('|||').map(u => u.trim()).filter(Boolean);
        if (subtitleUrls.length === 0) return res.status(200).json({ subtitles: [] });

        const fetchSubtitleAddon = async (baseUrl, customQuery, isSearch) => {
            const startTime = Date.now();
            const cleanBaseUrl = baseUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
            const targetUrl = `${cleanBaseUrl}/subtitles/${type}/${customQuery}.json`;

            const headers = {
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'application/json, text/plain, */*'
            };

            const reqTypeStr = isSearch ? '(Text Search)' : '(IMDb ID)';

            try {
                const response = await fetchWithTimeout(targetUrl, { headers }, 4650);
                const elapsed = Date.now() - startTime;

                if (!response.ok) {
                    console.log(`[ESAY SUBTITLES] ⚠️ סטטוס ${response.status} מ-${cleanBaseUrl} ${reqTypeStr}`);
                    return { subtitles: [], isSearch };
                }
                const data = await response.json();
                
                const subCount = data.subtitles ? data.subtitles.length : 0;
                console.log(`[ESAY SUBTITLES] ⏱️ תוסף ${cleanBaseUrl} ${reqTypeStr} סיים ב-${elapsed}ms (הביא ${subCount} כתוביות)`);
                
                return { subtitles: data.subtitles || [], isSearch };
            } catch (err) {
                const elapsed = Date.now() - startTime;
                if (err.name === 'AbortError' || err.type === 'aborted') {
                    console.warn(`[ESAY SUBTITLES] ⏳ TIMEOUT: נחתך בכוח ${cleanBaseUrl} ${reqTypeStr} (${elapsed}ms)`);
                } else {
                    console.error(`[ESAY SUBTITLES] ❌ קריסה ב-${cleanBaseUrl} ${reqTypeStr}: ${err.message}`);
                }
                return { subtitles: [], isSearch };
            }
        };

        let promises = subtitleUrls.map(url => fetchSubtitleAddon(url, id, false));

        if (id.startsWith('tt')) {
            const movieName = await getCleanMovieName(type, id);
            if (movieName) {
                console.log(`[ESAY SUBTITLES] 🔎 מריץ חיפוש כתוביות טקסטואלי מקביל עבור: "${movieName}"`);
                const textPromises = subtitleUrls.map(url => fetchSubtitleAddon(url, `search=${encodeURIComponent(movieName)}`, true));
                promises = promises.concat(textPromises);
            }
        }

        const results = await Promise.allSettled(promises);
        
        let allSubs = [];
        for (const r of results) {
            if (r.status === 'fulfilled' && r.value && Array.isArray(r.value.subtitles)) {
                r.value.subtitles.forEach(sub => {
                    sub._isTextSearch = r.value.isSearch;
                    allSubs.push(sub);
                });
            }
        }

        allSubs = allSubs.filter(sub => isAllowedLang(sub.lang, sub.title));

        console.log(`[ESAY SUBTITLES] 📥 נאספו סה"כ ${allSubs.length} כתוביות חוקיות מכל המקורות.`);

        const uniqueSubsMap = new Map();
        for (const sub of allSubs) {
            const lang = (sub.lang || '').toLowerCase();
            const key = sub.url ? sub.url : `${sub.id}_${lang}`; 
            
            if (!uniqueSubsMap.has(key)) {
                uniqueSubsMap.set(key, sub);
            } else {
                const existingSub = uniqueSubsMap.get(key);
                if (existingSub._isTextSearch === true && sub._isTextSearch === false) {
                    uniqueSubsMap.set(key, sub);
                }
            }
        }
        
        let uniqueSubs = Array.from(uniqueSubsMap.values());
        console.log(`[ESAY SUBTITLES] 🔄 אחרי Deduplication: נותרו ${uniqueSubs.length} כתוביות יחודיות.`);

        uniqueSubs.sort((a, b) => {
            const langA = (a.lang || '').toLowerCase();
            const langB = (b.lang || '').toLowerCase();
            const isHebA = ['he', 'heb', 'hebrew', 'iw', 'עברית'].includes(langA);
            const isHebB = ['he', 'heb', 'hebrew', 'iw', 'עברית'].includes(langB);
            
            if (isHebA && !isHebB) return -1; 
            if (!isHebA && isHebB) return 1;

            if (a._isTextSearch !== b._isTextSearch) {
                return a._isTextSearch ? 1 : -1; 
            }

            return 0;
        });

        uniqueSubs = uniqueSubs.map(sub => {
            delete sub._isTextSearch;
            return sub;
        });

        console.log(`[ESAY SUBTITLES] 🏁 הליך הסתיים. נשלחו ${uniqueSubs.length} כתוביות מסודרות ללקוח.`);
        console.log(`======================================================\n`);
        return res.status(200).json({ subtitles: uniqueSubs });

    } catch (error) {
        console.error('[ESAY SUBTITLES] 💥 שגיאה כללית בפרוקסי:', error);
        return res.status(500).json({ subtitles: [] });
    }
}
