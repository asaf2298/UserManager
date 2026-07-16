import fetch from 'node-fetch';
import http from 'http';
import https from 'https';
import { getCleanMovieName } from './search.js';

const httpAgent = new http.Agent();
const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const dynamicAgent = (_parsedURL) => _parsedURL.protocol === 'http:' ? httpAgent : httpsAgent;

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}

// מערכת זיהוי שפות הרמטית (מונעת באג שבו "en" מאשר "french")
function isAllowedLang(rawLang) {
    if (!rawLang) return false;
    const l = rawLang.toLowerCase().trim();
    
    // התאמה מדויקת בלבד (Exact Match)
    const exactMatches = [
        'he', 'heb', 'hebrew', 'iw', 'he-il', 'עברית',
        'ru', 'rus', 'russian',
        'en', 'eng', 'english', 'en-us', 'en-gb',
        'submaker', 'make hebrew', 'forced'
    ];
    
    if (exactMatches.includes(l)) return true;
    
    // התאמות חלקיות בטוחות בלבד
    if (l.includes('heb') || l.includes('עברית')) return true;
    if (l.includes('rus')) return true;
    if (l.startsWith('en ') || l.startsWith('eng ')) return true;
    
    return false;
}

export default async function handler(req, res) {
    console.log(`[ESAY SUBTITLES] 🟢 NEW REQUEST DETECTED: ${req.url}`); // לוג ברזל
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const urlParts = req.url.split('?')[0].split('/');
        const subIdx = urlParts.indexOf('subtitles');
        if (subIdx < 1 || subIdx + 2 >= urlParts.length) return res.status(400).json({ subtitles: [] });

        const type = urlParts[subIdx + 1];
        let rawIdWithExt = urlParts[subIdx + 2];
        if (rawIdWithExt.includes('%')) rawIdWithExt = decodeURIComponent(rawIdWithExt);
        const idWithExt = rawIdWithExt;
        const id = idWithExt.replace('.json', '');

        const addonUrlsStr = process.env.SUBTITLE_URLS || '';
        const addons = addonUrlsStr.split('|||').map(u => u.trim()).filter(Boolean);

        if (addons.length === 0) return res.status(200).json({ subtitles: [] });

        const fetchSubtitleAddon = async (baseUrl, customQuery, isSearch) => {
            const startTime = Date.now();
            const cleanBaseUrl = baseUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
            
            const cleanQuery = customQuery.replace(/\.json$/, '');
            const targetUrl = `${cleanBaseUrl}/subtitles/${type}/${cleanQuery}.json`;

            let calculatedProvider = 'Esay Sub';
            const match = cleanBaseUrl.match(/https?:\/\/([^\/]+)/);
            if (match && match[1]) {
                calculatedProvider = match[1]
                    .replace('.strem.io', '')
                    .replace('.elfhosted.com', '')
                    .replace('.onrender.com', '')
                    .replace('-stremio', '')
                    .replace('.club', '');
            }

            const headers = {
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'application/json, text/plain, */*'
            };
            
            const fetchOptions = { headers };
            
            if (cleanBaseUrl.includes('sub.scary.network')) {
                fetchOptions.agent = dynamicAgent;
            }

            const reqTypeStr = isSearch ? '(Text Search)' : '(IMDb ID)';

            try {
                const response = await fetchWithTimeout(targetUrl, fetchOptions, 9000);
                const elapsed = Date.now() - startTime;

                if (!response.ok) {
                    console.log(`[ESAY SUBTITLES] ⚠️ סטטוס ${response.status} מ-${cleanBaseUrl} ${reqTypeStr}`);
                    return { subtitles: [], isSearch, calculatedProvider };
                }
                const data = await response.json();
                
                const subCount = data.subtitles ? data.subtitles.length : 0;
                console.log(`[ESAY SUBTITLES] ⏱️ תוסף ${cleanBaseUrl} ${reqTypeStr} סיים ב-${elapsed}ms (הביא ${subCount} כתוביות במקור)`);
                
                return { subtitles: data.subtitles || [], isSearch, calculatedProvider };
            } catch (err) {
                const elapsed = Date.now() - startTime;
                if (err.name === 'AbortError' || err.type === 'aborted') {
                    console.warn(`[ESAY SUBTITLES] ⏳ TIMEOUT: נחתך בכוח ${cleanBaseUrl} ${reqTypeStr} אחרי (${elapsed}ms)`);
                } else {
                    console.error(`[ESAY SUBTITLES] ❌ קריסה ב-${cleanBaseUrl} ${reqTypeStr}: ${err.message}`);
                }
                return { subtitles: [], isSearch, calculatedProvider };
            }
        };

        let promises = addons.map(url => fetchSubtitleAddon(url, idWithExt, false));

        if (id.startsWith('tt') || id.startsWith('tmdb:')) {
            console.log(`[ESAY SUBTITLES] 🔍 מנסה לבצע גיבוי חיפוש טקסט עבור ID: ${id}`);
            const cleanName = await getCleanMovieName(type, id);
            
            if (cleanName) {
                console.log(`[ESAY SUBTITLES] 🔤 TMDB זיהה את השם: "${cleanName}". מריץ גל חיפושים שני...`);
                const searchPromises = addons.map(url => fetchSubtitleAddon(url, `search=${encodeURIComponent(cleanName)}`, true));
                promises = promises.concat(searchPromises);
            } else {
                console.log(`[ESAY SUBTITLES] ⚠️ פונקציית העזר לא מצאה שם תקין ב-TMDB. חיפוש הטקסט מבוטל.`);
            }
        }

        const results = await Promise.allSettled(promises);
        
        const seenUrls = new Set();
        let uniqueSubs = [];
        
        // משתני אבחון (Diagnostics) להדפסה
        const droppedLangs = {};
        const keptLangs = {};

        for (const res of results) {
            if (res.status === 'fulfilled' && res.value.subtitles.length > 0) {
                const { subtitles, isSearch, calculatedProvider } = res.value;
                
                for (let i = 0; i < subtitles.length; i++) {
                    const sub = subtitles[i];
                    
                    if (sub.url && seenUrls.has(sub.url)) continue;
                    
                    const langStr = (sub.lang || 'unknown').toLowerCase().trim();
                    
                    // בדיקת שפה נוקשה
                    if (isAllowedLang(langStr)) {
                        if (sub.url) seenUrls.add(sub.url);
                        keptLangs[langStr] = (keptLangs[langStr] || 0) + 1;
                        
                        sub._isTextSearch = isSearch;
                        sub._providerName = (sub.id && sub.id.includes('opensubtitles')) ? 'OpenSubtitles' : calculatedProvider;
                        
                        uniqueSubs.push(sub);
                    } else {
                        // מעקב אחרי שפות שסוננו
                        droppedLangs[langStr] = (droppedLangs[langStr] || 0) + 1;
                    }
                }
            }
        }

        // הדפסת לוגים מפורטים (Diagnostics)
        console.log(`\n[ESAY DIAGNOSTIC] 📊 דו"ח סינון שפות:`);
        console.log(`✅ שפות שאושרו ונשמרו:`, keptLangs);
        console.log(`🚫 שפות שנחסמו ונמחקו:`, droppedLangs);

        // מערכת דירוג מדויקת: עברית (3) > רוסית (2) > אנגלית (1)
        uniqueSubs.sort((a, b) => {
            const langA = (a.lang || '').toLowerCase();
            const langB = (b.lang || '').toLowerCase();

            const getScore = (l) => {
                if (l.includes('heb') || l.includes('עברית') || l === 'he') return 3;
                if (l.includes('rus') || l === 'ru') return 2;
                if (l.includes('en') || l.includes('eng')) return 1;
                return 0;
            };

            const scoreA = getScore(langA);
            const scoreB = getScore(langB);

            // מיון לפי ניקוד השפה הגבוה ביותר
            if (scoreA !== scoreB) {
                return scoreB - scoreA;
            }

            // שובר שוויון: כתוביות שנמצאו לפי ID רשמי עדיפות על חיפוש טקסט
            if (a._isTextSearch !== b._isTextSearch) {
                return a._isTextSearch ? 1 : -1;
            }

            return 0;
        });

        // עיצוב התצוגה הסופית
        // מערכת דירוג מדויקת: עברית (3) > רוסית (2) > אנגלית (1)
        uniqueSubs.sort((a, b) => {
            const langA = (a.lang || '').toLowerCase();
            const langB = (b.lang || '').toLowerCase();

            const getScore = (l) => {
                if (l.includes('heb') || l.includes('עברית') || l === 'he' || l === 'make hebrew'|| l === 'submaker') return 3;
                if (l.includes('rus') || l === 'ru') return 1;
                if (l.includes('en') || l.includes('eng')) return 2;
                return 0;
            };

            const scoreA = getScore(langA);
            const scoreB = getScore(langB);

            if (scoreA !== scoreB) {
                return scoreB - scoreA;
            }

            if (a._isTextSearch !== b._isTextSearch) {
                return a._isTextSearch ? 1 : -1;
            }

            return 0;
        });

        // עיצוב התצוגה הסופית ופתרון קריסות ה-Frontend של סטרימיו
        uniqueSubs = uniqueSubs.map((sub, index) => {
            const provider = sub._providerName || 'Esay Sub';
            const originalTitle = sub.title ? sub.title.trim() : '';
            
            // 1. פתרון קריסת React: הבטחת ID ייחודי לחלוטין לכל כתובית
            const safeId = (sub.id || '').replace(/[^a-zA-Z0-9]/g, '').substring(0, 15);
            sub.id = `esay_${index}_${safeId}`;

            // 2. פתרון תקן השפות: "דחיפת" שפות לא מוכרות לקטגוריות שסטרימיו מבין
            let displayType = '';
            const lowerLang = (sub.lang || '').toLowerCase();
            if (lowerLang === 'make hebrew') {
                sub.lang = 'heb'; // קיבוץ מול סטרימיו
                displayType = ' [Auto-Translated]'; // סימון למשתמש
            } else if (lowerLang === 'עברית') {
                sub.lang = 'heb';
            }

            // בניית כותרת אינפורמטיבית
            if (originalTitle) {
                sub.title = `${originalTitle}${displayType} [${provider}]`;
            } else {
                sub.title = `מקור: ${provider}${displayType}`;
            }
            
            delete sub._isTextSearch;
            delete sub._providerName;
            delete sub._sourceBaseUrl; 
            return sub;
        });

        console.log(`[ESAY SUBTITLES] 🏁 הליך הסתיים. נשלחו ${uniqueSubs.length} כתוביות מסודרות ללקוח.\n`);
        return res.status(200).json({ subtitles: uniqueSubs });

    } catch (error) {
        console.error('[ESAY SUBTITLES] 💥 Global Proxy Error:', error);
        return res.status(200).json({ subtitles: [] });
    }
}
