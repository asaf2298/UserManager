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

const ALLOWED_LANGS = [
    'he', 'heb', 'hebrew', 'iw', 'he-il', 'עברית',
    'en', 'eng', 'english', 'en-us', 'en-gb',
    'ru', 'rus', 'russian',
    'submaker', 'make hebrew', 'forced', 'hi'
];

export default async function handler(req, res) {
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
            
            // תיקון ה-404 החשוב: מניעת כפילות של .json
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
                console.log(`[ESAY SUBTITLES] ⏱️ תוסף ${cleanBaseUrl} ${reqTypeStr} סיים ב-${elapsed}ms (הביא ${subCount} כתוביות)`);
                
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

        for (const res of results) {
            if (res.status === 'fulfilled' && res.value.subtitles.length > 0) {
                const { subtitles, isSearch, calculatedProvider } = res.value;
                
                for (let i = 0; i < subtitles.length; i++) {
                    const sub = subtitles[i];
                    
                    if (sub.url && seenUrls.has(sub.url)) continue;
                    
                    const lang = (sub.lang || '').toLowerCase();
                    const isAllowed = ALLOWED_LANGS.some(allowed => lang.includes(allowed));
                    
                    if (isAllowed) {
                        if (sub.url) seenUrls.add(sub.url);
                        
                        sub._isTextSearch = isSearch;
                        sub._providerName = (sub.id && sub.id.includes('opensubtitles')) ? 'OpenSubtitles' : calculatedProvider;
                        
                        uniqueSubs.push(sub);
                    }
                }
            }
        }

        uniqueSubs.sort((a, b) => {
            const langA = (a.lang || '').toLowerCase();
            const langB = (b.lang || '').toLowerCase();

            const isHebA = langA.includes('heb') || langA.includes('עברית');
            const isHebB = langB.includes('heb') || langB.includes('עברית');

            if (isHebA && !isHebB) return -1;
            if (!isHebA && isHebB) return 1;

            if (a._isTextSearch !== b._isTextSearch) {
                return a._isTextSearch ? 1 : -1;
            }

            return 0;
        });

        uniqueSubs = uniqueSubs.map(sub => {
            const provider = sub._providerName || 'Esay Sub';
            const originalTitle = sub.title ? sub.title.trim() : '';
            
            if (originalTitle) {
                sub.title = `${originalTitle} [${provider}]`;
            } else {
                sub.title = `מקור: ${provider}`;
            }
            
            delete sub._isTextSearch;
            delete sub._providerName;
            delete sub._sourceBaseUrl; 
            return sub;
        });

        console.log(`[ESAY SUBTITLES] 🏁 הליך הסתיים. נשלחו ${uniqueSubs.length} כתוביות מסודרות ללקוח.`);
        return res.status(200).json({ subtitles: uniqueSubs });

    } catch (error) {
        console.error('[ESAY SUBTITLES] 💥 Global Proxy Error:', error);
        return res.status(200).json({ subtitles: [] });
    }
}
