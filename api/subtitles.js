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

function isAllowedLang(rawLang) {
    if (!rawLang) return false;
    const l = rawLang.toLowerCase().trim();
    
    const exactMatches = [
        'he', 'heb', 'hebrew', 'iw', 'he-il', 'עברית',
        'ru', 'rus', 'russian',
        'en', 'eng', 'english', 'en-us', 'en-gb',
        'submaker', 'make hebrew', 'forced'
    ];
    
    if (exactMatches.includes(l)) return true;
    if (l.includes('heb') || l.includes('עברית')) return true;
    if (l.includes('rus')) return true;
    if (l.startsWith('en ') || l.startsWith('eng ')) return true;
    
    return false;
}

export default async function handler(req, res) {
    console.log(`[ESAY SUBTITLES] 🟢 NEW REQUEST DETECTED: ${req.url}`); 
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
        console.log(`[ESAY SUBTITLES] 🔎 חולץ מזהה: ${id} | סוג תוכן: ${type}`);
        
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

            const headers = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json, text/plain, */*' };
            const fetchOptions = { headers };
            if (cleanBaseUrl.includes('sub.scary.network')) fetchOptions.agent = dynamicAgent;
            const reqTypeStr = isSearch ? '(Text Search)' : '(IMDb ID)';

            try {
                // נשאר על 9 שניות כי יש לנו Pre-warming שעושה את העבודה הכבדה מראש
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
            }
        }

        const results = await Promise.allSettled(promises);
        const seenUrls = new Set();
        let uniqueSubs = [];
        const droppedLangs = {};
        const keptLangs = {};

        for (const res of results) {
            if (res.status === 'fulfilled' && res.value.subtitles.length > 0) {
                const { subtitles, isSearch, calculatedProvider } = res.value;
                for (let i = 0; i < subtitles.length; i++) {
                    const sub = subtitles[i];
                    if (sub.url && seenUrls.has(sub.url)) continue;
                    
                    const langStr = (sub.lang || 'unknown').toLowerCase().trim();
                    if (isAllowedLang(langStr)) {
                        if (sub.url) seenUrls.add(sub.url);
                        keptLangs[langStr] = (keptLangs[langStr] || 0) + 1;
                        sub._isTextSearch = isSearch;
                        sub._providerName = (sub.id && sub.id.includes('opensubtitles')) ? 'OpenSubtitles' : calculatedProvider;
                        uniqueSubs.push(sub);
                    } else {
                        droppedLangs[langStr] = (droppedLangs[langStr] || 0) + 1;
                    }
                }
            }
        }

        console.log(`\n[ESAY DIAGNOSTIC] 📊 דו"ח סינון שפות:`);
        console.log(`✅ שפות שאושרו ונשמרו:`, keptLangs);
        console.log(`🚫 שפות שנחסמו ונמחקו:`, droppedLangs);

        // ניקוי, סינון שפות והמרה סופית
        const cleanedSubs = [];
        const seenSubs = new Set();

        uniqueSubs.forEach((sub, index) => {
            // 1. השמדת כתוביות ללא לינק (קריטי ליציבות סטרימיו)
            if (!sub.url) return;

            // 2. המרת שפות לתקן אחיד (heb, eng, rus)
            const l = (sub.lang || '').toLowerCase().trim();
            let lang = 'heb';
            let displayType = ''; 

            if (['ru', 'rus', 'russian'].some(s => l.includes(s))) {
                lang = 'rus';
            } else if (['en', 'eng', 'english', 'en-us', 'en-gb'].some(s => l.includes(s))) {
                lang = 'eng';
            } else {
                lang = 'heb';
                if (l.includes('make') || l.includes('submaker')) {
                    displayType = ' [Auto-Translated]';
                }
            }
            sub.lang = lang;

            // 3. מניעת כפילויות (אותו לינק + אותה שפה)
            const subKey = `${sub.url}|${sub.lang}`;
            if (seenSubs.has(subKey)) return;
            seenSubs.add(subKey);

            // 4. עיצוב סופי לממשק
            const provider = sub._providerName || 'Esay Sub';
            const safeId = (sub.id || '').replace(/[^a-zA-Z0-9]/g, '').substring(0, 10);
            sub.id = `esay_${index}_${safeId}`;
            
            let warning = (sub.behaviorHints?.notWebReady) ? ' ⚠️ נגן חיצוני' : '';
            sub.title = `${sub.title || 'כתובית'}${displayType} [${provider}]${warning}`;

            delete sub._isTextSearch;
            delete sub._providerName;
            delete sub._sourceBaseUrl;
            
            cleanedSubs.push(sub);
        });

        // 5. סידור חכם: עברית ראשונה > אנגלית > רוסית. ותעדוף מזהה אמיתי על חיפוש מילולי.
        cleanedSubs.sort((a, b) => {
            const getScore = (l) => l === 'heb' ? 3 : (l === 'eng' ? 2 : (l === 'rus' ? 1 : 0));
            const scoreA = getScore(a.lang);
            const scoreB = getScore(b.lang);
            
            if (scoreA !== scoreB) return scoreB - scoreA;
            if (a._isTextSearch !== b._isTextSearch) return a._isTextSearch ? 1 : -1;
            return 0;
        });

        console.log(`[ESAY SUBTITLES] 🏁 הליך הסתיים. נשלחו ${cleanedSubs.length} כתוביות מסודרות ללקוח.\n`);
        return res.status(200).json({ subtitles: cleanedSubs });

    } catch (error) {
        console.error('[ESAY SUBTITLES] 💥 Global Proxy Error:', error);
        return res.status(200).json({ subtitles: [] });
    }
}
