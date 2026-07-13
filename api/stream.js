import fetch from 'node-fetch';

const PROFILES = {
    everything: { maxResults: 30, maxSizeGB: Infinity, minSeedersUncached: 1, hasHDR: true, hasHDAudio: true, timeoutMs: 9500 },
    family: { maxResults: 10, maxSizeGB: 30, minSeedersUncached: 5, hasHDR: true, hasHDAudio: true, timeoutMs: 9150 },
    friends_light: { maxResults: 10, maxSizeGB: 30, minSeedersUncached: 5, hasHDR: true, hasHDAudio: true, timeoutMs: 9150 },
    friends_heavy: { maxResults: 30, maxSizeGB: Infinity, minSeedersUncached: 5, hasHDR: true, hasHDAudio: true, timeoutMs: 9150 }
};

const REGEX_HDR = /(hdr10|dolby\s?vision|dovi|dv\b|hdr)/i;
const REGEX_HDR_FALLBACK = /(fallback|hdr10\+?(\s|-)compatible|hybrid)/i;
const REGEX_HD_AUDIO = /(dts(-hd|:x|x|ma)?|truehd|atmos)/i;
const REGEX_SIZE = /(\d+(?:\.\d+)?)\s*(GB|MB)/i;
const REGEX_SEEDERS = /(?:👤|seeders?:?)\s*(\d+)/i;
const REGEX_CACHED_TAGS = /\[?(torbox\+|rd\+|ad\+|pm\+|cached|real-?debrid|all-?debrid|premiumize)\]?/gi;

function getTextForAnalysis(stream) {
    return ((stream.name || '') + ' ' + (stream.title || '') + ' ' + (stream.description || '')).toLowerCase();
}
function isCached(stream) {
    const text = getTextForAnalysis(stream);
    // בודק אם יש לינק ישיר שמתחיל ב-http או ב-acestream
    const isDirectStream = stream.url && (stream.url.startsWith('http') || stream.url.startsWith('acestream'));
    return text.includes('torbox+') || text.includes('cached') || text.includes('rd+') || isDirectStream;
}
function isUsenet(stream) {
    return getTextForAnalysis(stream).includes('usenet') || getTextForAnalysis(stream).includes('nzb');
}
function isVIPSource(stream) {
    const sourceUrl = (stream._sourceBaseUrl || '').toLowerCase();
    const text = getTextForAnalysis(stream);
    return sourceUrl.includes('kan-box') || sourceUrl.includes('animeil') || text.includes('animeil');
}
function getSeeders(stream) {
    const match = getTextForAnalysis(stream).match(REGEX_SEEDERS);
    return match ? parseInt(match[1], 10) : null; // null אומר שאין מידע בכלל
}
function getSizeGB(stream) {
    if (stream.size) return stream.size / (1024 ** 3);
    const match = getTextForAnalysis(stream).match(REGEX_SIZE);
    if (!match) return 0;
    const val = parseFloat(match[1]);
    return match[2].toUpperCase() === 'MB' ? val / 1024 : val;
}
function getQualityWeight(text) {
    if (text.includes('remux')) return 4;
    if (text.includes('bluray') || text.includes('bdrip') || text.includes('brrip')) return 3;
    if (text.includes('web-dl') || text.includes('webrip') || text.includes('web')) return 2;
    if (text.includes('hdtv') || text.includes('tvrip')) return 1;
    return 0;
}
function getResWeight(text) {
    if (text.includes('4k') || text.includes('2160p')) return 4;
    if (text.includes('1080p') || text.includes('fhd')) return 3;
    if (text.includes('720p') || text.includes('hd')) return 2;
    return 1;
}
async function getMetaName(type, id) {
    try {
        const response = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${id}.json`);
        const data = await response.json();
        return data.meta?.name || null;
    } catch (e) {
        return null;
    }
}
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const urlParts = req.url.split('?')[0].split('/');
        const streamIdx = urlParts.indexOf('stream');
        if (streamIdx < 1 || streamIdx + 2 >= urlParts.length) {
            return res.status(400).json({ streams: [] });
        }

        const userKey = urlParts[streamIdx - 1];
        const type = urlParts[streamIdx + 1];
        const idWithExt = urlParts[streamIdx + 2];

        if (type === 'tv' || type === 'channel') {
            const tvAddonUrl = process.env.TV_ADDON_URL;
            if (!tvAddonUrl) return res.status(200).json({ streams: [] });
            try {
                const cleanTvUrl = tvAddonUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
                const targetUrl = `${cleanTvUrl}/stream/${type}/${idWithExt}`;
                const tvRes = await fetch(targetUrl);
                if (tvRes.ok) {
                    const tvData = await tvRes.json();
                    return res.status(200).json(tvData);
                }
            } catch (e) {
                console.error('TV Stream Error:', e);
            }
            return res.status(200).json({ streams: [] });
        }

        const configs = JSON.parse(process.env.USER_CONFIGS || '{}');
        const profileConfig = configs[userKey]?.profile || 'friends_light';
        const profile = PROFILES[profileConfig] || PROFILES.friends_light;
        
        const addons = (process.env.ADDON_URLS || '').split('|||').map(u => u.trim()).filter(Boolean);
        if (addons.length === 0) return res.status(200).json({ streams: [] });
        
        const fetchFromAddon = async (baseUrl) => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), profile.timeoutMs); 

            // הסרת המילה manifest.json מהקישור הבסיסי (במידה והוזנה) לפני הרכבת הנתיב
            const cleanBaseUrl = baseUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
            const targetUrl = `${cleanBaseUrl}/stream/${type}/${idWithExt}`;
            
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
                    console.error(`[Vecret Timer] ❌ ${baseUrl.substring(0, 45)}... returned status ${response.status} after ${durationMs}ms`);
                    return [];
                }
                
                const data = await response.json();
                const streamCount = (data && Array.isArray(data.streams)) ? data.streams.length : 0;
                console.log(`[Vecret Timer] ⏱️  ${baseUrl.substring(0, 45)}... responded in ${durationMs}ms (Found ${streamCount} streams)`);

                if (data && Array.isArray(data.streams)) {
                    data.streams.forEach(s => s._sourceBaseUrl = baseUrl);
                    return data.streams;
                }
                return [];
            } catch (err) {
                const durationMs = (performance.now() - startTime).toFixed(0);
                if (err.name === 'AbortError') {
                    console.warn(`[Vecret Timer] ⏱️  ${baseUrl.substring(0, 45)}... TIMEOUT hit after ${durationMs}ms!`);
                } else {
                    console.error(`[Vecret Timer] ❌ ${baseUrl.substring(0, 45)}... FAILED after ${durationMs}ms. Error: ${err.message}`);
                }
                return [];
            } finally {
                clearTimeout(timeoutId);
            }
        };

                let promises = addonUrls.map(url => fetchFromAddon(url));

        // --- מנגנון תרגום IMDB לשם לחיפוש בספקי HTTP ---
        if (id.startsWith('tt')) {
            const movieName = await getMetaName(type, id);
            if (movieName) {
                console.log(`[Vecret Search] Translating ${id} to "${movieName}" for HTTP providers...`);
                
                // יוצרים בקשות חיפוש טקסטואליות לכל הלינקים שמתחילים ב-http
                // אנחנו מריצים אותן במקביל לסטרימים הרגילים
                const textSearchPromises = addonUrls.map(baseUrl => {
                    // הופכים את הבקשה לחיפוש טקסטואלי (פרוטוקול חיפוש סטנדרטי בסטרימיו)
                    const cleanBaseUrl = baseUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
                    const searchUrl = `${cleanBaseUrl}/stream/${type}/search=${encodeURIComponent(movieName)}.json`;
                    
                    return fetchFromAddon(searchUrl); // משתמשים באותה פונקציה שכבר כתבת
                });
                
                promises = promises.concat(textSearchPromises);
            }
        }
        // --- מערכת ניהול זמנים דינמית חכמה (מותאמת למגבלת Vercel) ---
        let allStreams = [];
        let pendingCount = promises.length;

        // רצים על ההבטחות ויוצרים מנגנון מעקב בזמן אמת
        const trackPromises = promises.map(p => {
            return p.then(val => {
                if (Array.isArray(val)) {
                    allStreams = allStreams.concat(val);
                }
                pendingCount--; // מסמנים שהתוסף סיים
                return val;
            }).catch(e => {
                pendingCount--;
            });
        });

        // שלב 1: מחכים עד שכולם יסיימו, או מקסימום 5 שניות
        await Promise.race([
            Promise.allSettled(trackPromises),
            new Promise(resolve => setTimeout(resolve, 5000))
        ]);

        // שלב 2: אם עברו 5 שניות, יש עדיין תוספים שרצים, ויש לנו פחות מ-3 תוצאות - נמתין עוד 4 שניות גג (סה"כ 9 שניות)
        if (pendingCount > 0 && allStreams.length < 3) {
            console.log(`[Vecret Timer] ⚠️ Only ${allStreams.length} streams found. Waiting up to 4 more seconds for slower addons (Usenet/Yuki)...`);
            await Promise.race([
                Promise.allSettled(trackPromises),
                new Promise(resolve => setTimeout(resolve, 4000))
            ]);
        }

        // מעבירים את כל הסטרים שנאספו להמשך המיון והסינון בקוד
        let filteredStreams = allStreams;
        
        const uniqueStreamsMap = new Map();
        for (const stream of allStreams) {
            const key = stream.infoHash || stream.url || stream.title;
            if (!uniqueStreamsMap.has(key)) {
                uniqueStreamsMap.set(key, stream);
            }
        }
        filteredStreams = Array.from(uniqueStreamsMap.values());

        filteredStreams = filteredStreams.filter(stream => {
            const isStreamCached = isCached(stream);
            const isStreamUsenet = isUsenet(stream);
            const seeders = getSeeders(stream);
            const sizeGB = getSizeGB(stream);
            const text = getTextForAnalysis(stream);

            if (sizeGB > profile.maxSizeGB) return false;
            
            // מחמיר פחות: זורק רק אם יש לנו מידע וזה אכן 0
            if (!isStreamCached && !isStreamUsenet && seeders !== null && seeders === 0) return false;
            
            // לשאר הפרופילים, דורשים מינימום סידרים רק אם יש מידע (לא null)
            if (profileConfig !== 'everything') {
                if (!isStreamCached && !isStreamUsenet && seeders !== null && seeders < profile.minSeedersUncached) return false;
            }

            if (!profile.hasHDR) {
                const hasHDRTag = REGEX_HDR.test(text);
                const hasFallback = REGEX_HDR_FALLBACK.test(text);
                if (hasHDRTag && !hasFallback) return false;
            }

            if (!profile.hasHDAudio && REGEX_HD_AUDIO.test(text)) return false;
            
            return true;
        });

        filteredStreams.sort((a, b) => {
            const vipA = isVIPSource(a);
            const vipB = isVIPSource(b);
            
            if (vipA && !vipB) return -1;
            if (!vipA && vipB) return 1;

            const textA = getTextForAnalysis(a);
            const textB = getTextForAnalysis(b);
            const cachedA = isCached(a);
            const cachedB = isCached(b);
            const usenetA = isUsenet(a);
            const usenetB = isUsenet(b);
            const qA = getQualityWeight(textA);
            const qB = getQualityWeight(textB);
            const resA = getResWeight(textA);
            const resB = getResWeight(textB);
            const sizeA = getSizeGB(a);
            const sizeB = getSizeGB(b);

            if (profileConfig === 'everything') {
                if (qA !== qB) return qB - qA;
                if (resA !== resB) return resB - resA;
                if (sizeA !== sizeB) return sizeB - sizeA;
                
                // התיקון כאן: הגדרת המשתנים שחסרו
                const seedA = getSeeders(a) || 0;
                const seedB = getSeeders(b) || 0;
                if (!cachedA && !cachedB && seedA !== seedB) return seedB - seedA;
                
                return cachedA === cachedB ? 0 : (cachedA ? -1 : 1);
            }
            
            if (profileConfig === 'friends_heavy') {
                if (qA !== qB) return qB - qA;
                if (usenetA !== usenetB) return usenetA ? -1 : 1;
                if (resA !== resB) return resB - resA;
                if (sizeA !== sizeB) return sizeB - sizeA;
                return cachedA === cachedB ? 0 : (cachedA ? -1 : 1); 
            }

            if (cachedA !== cachedB) return cachedA ? -1 : 1;
            if (usenetA !== usenetB) return usenetA ? -1 : 1;
            if (qA !== qB) return qB - qA;
            return resB - resA;
        });

        // --- לוגיקת שריון מקומות ---
        // מפצלים את התוצאות המסודרות לכאלו שבקאש וכאלו שלא
        // --- לוגיקת חיתוך ושריון מקומות לפי פרופיל ---
        let finalSliced = [];

        if (profileConfig === 'friends_heavy') {
            // עבור חברים כבדים: שריון של 2 מקומות לפחות לטורנטים רגילים (Uncached) בסוף
            const cachedList = [];
            const uncachedList = [];
            
            filteredStreams.forEach(stream => {
                if (isCached(stream)) cachedList.push(stream);
                else uncachedList.push(stream);
            });

            const maxTotal = profile.maxResults;
            const uncachedSlots = Math.min(2, uncachedList.length);
            const cachedSlots = Math.min(cachedList.length, maxTotal - uncachedSlots);
            
            const remainingSpots = maxTotal - cachedSlots;
            const actualUncached = uncachedList.slice(0, remainingSpots);
            
            finalSliced = [...cachedList.slice(0, cachedSlots), ...actualUncached];
        } else {
            // עבור everything (ו-light): פשוט לוקחים את התוצאות הכי טובות מהטופ
            finalSliced = filteredStreams.slice(0, profile.maxResults);
        }

        // --- עיצוב התגיות ומחיקת שרידי לינקים פנימיים ---
        finalSliced = finalSliced.map(stream => {
            if (isCached(stream)) {
                let cleanName = (stream.name || '').replace(REGEX_CACHED_TAGS, '').trim();
                let cleanTitle = (stream.title || '').replace(REGEX_CACHED_TAGS, '').trim();
                cleanName = cleanName.replace(/^[\s|\-\n]+/, '').replace(/[\s|\-\n]+$/, '').trim();
                
                stream.name = cleanName ? `זמין לצפייה | ${cleanName}` : 'זמין לצפייה';
                stream.title = cleanTitle;
            }
            delete stream._sourceBaseUrl;
            return stream;
        });

        return res.status(200).json({ streams: finalSliced });

    } catch (error) {
        console.error('Stream Proxy Error:', error);
        return res.status(500).json({ streams: [] });
    }
}
