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

function getTextForAnalysis(stream) {
    const combinedText = ((stream.name || '') + ' ' + (stream.title || '') + ' ' + (stream.description || '')).toLowerCase();
    return combinedText;
}

function isCached(stream) {
    // אם לסטרים יש infoHash ישיר, הוא בהכרח טורנט רגיל (Uncached)
    if (stream.infoHash) return false;
    // אם אין לו URL בכלל, הוא לא קובץ מוזרם ישירות
    if (!stream.url) return false;
    
    const text = getTextForAnalysis(stream);
    // הגנה מפני לינקים של Torrentio/Meteor מסוג Uncached שמכילים כפתור הורדה
    if (text.includes('download')) return false;
    
    const isDirectStream = stream.url.startsWith('http') || stream.url.startsWith('acestream');
    const hasCacheKeywords = text.includes('torbox+') || text.includes('cached') || text.includes('rd+');
    
    return hasCacheKeywords || isDirectStream;
}

function isUsenet(stream) {
    const text = getTextForAnalysis(stream);
    return text.includes('usenet') || text.includes('nzb');
}

function isVIPSource(stream) {
    const sourceUrl = (stream._sourceBaseUrl || '').toLowerCase();
    return sourceUrl.includes('kan-box-addon.vercel.app');
}

function getSeeders(stream) {
    const match = getTextForAnalysis(stream).match(REGEX_SEEDERS);
    return match ? parseInt(match[1], 10) : null; 
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
    console.log(`[ESAY DIAGNOSTIC - CINEMETA] 🔍 מנסה לתרגם את המזהה ${id} לשם סרט מול סינמטה...`);
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2500);
        
        const targetUrl = `https://v3-cinemeta.strem.io/meta/${type}/${id}.json`;
        const response = await fetch(targetUrl, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            console.log(`[ESAY DIAGNOSTIC - CINEMETA] ❌ סינמטה החזירה סטטוס שגיאה: ${response.status}`);
            return null;
        }
        
        const data = await response.json();
        const name = data.meta?.name || null;
        console.log(`[ESAY DIAGNOSTIC - CINEMETA] ✅ סינמטה החזירה שם: "${name}"`);
        return name;
    } catch (e) {
        console.log(`[ESAY DIAGNOSTIC - CINEMETA] 💥 שגיאה או Timeout בפנייה לסינמטה: ${e.message}`);
        return null;
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    console.log(`[ESAY DIAGNOSTIC - STREAM] 🟢 בקשת סטרים נכנסת: ${req.url}`);

    try {
        const urlParts = req.url.split('?')[0].split('/');
        const streamIdx = urlParts.indexOf('stream');
        if (streamIdx < 1 || streamIdx + 2 >= urlParts.length) {
            console.log(`[ESAY DIAGNOSTIC - STREAM] ❌ מבנה URL לא חוקי בסטרימים.`);
            return res.status(400).json({ streams: [] });
        }

        const userKey = urlParts[streamIdx - 1];
        const type = urlParts[streamIdx + 1];
        let rawIdWithExt = urlParts[streamIdx + 2];
        
        if (rawIdWithExt.includes('%')) {
            const decoded = decodeURIComponent(rawIdWithExt);
            console.log(`[ESAY DIAGNOSTIC - STREAM] 🔄 ניקוי קידוד כפול בסטרים: "${rawIdWithExt}" -> "${decoded}"`);
            rawIdWithExt = decoded;
        }
        const idWithExt = rawIdWithExt;
        const id = idWithExt.replace('.json', '');

        console.log(`[ESAY DIAGNOSTIC - STREAM] נתוני מפתח חולצו -> UserKey: "${userKey}", Type: "${type}", ID: "${id}"`);

        // ==========================================
        // 1. טיפול קשיח ומוגן בערוצי טלוויזיה / לייב קנבוקס
        // ==========================================
        if (type === 'tv' || type === 'channel') {
            const tvAddonUrl = process.env.TV_ADDON_URL;
            console.log(`[ESAY DIAGNOSTIC - STREAM LIVE] 📺 ערוץ לייב זוהה. TV_ADDON_URL: "${tvAddonUrl}"`);
            
            if (!tvAddonUrl) {
                console.log(`[ESAY DIAGNOSTIC - STREAM LIVE] ❌ שגיאה: TV_ADDON_URL לא מוגדר ב-Env.`);
                return res.status(200).json({ streams: [] });
            }
            
            try {
                const cleanTvUrl = tvAddonUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
                // הזרקת המפרט: שליחת הבקשה תחת type של 'series' כיוון שקנבוקס מאזין שם
                const targetUrl = `${cleanTvUrl}/stream/series/${idWithExt}`;
                console.log(`[ESAY DIAGNOSTIC - STREAM LIVE] 🚀 מוציא בקשת סטרים לייב אל: "${targetUrl}"`);
                
                const headers = { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/json, text/plain, */*'
                };
                
                const tvRes = await fetch(targetUrl, { headers, timeout: 9500 });
                console.log(`[ESAY DIAGNOSTIC - STREAM LIVE] 📥 שרת הלייב החזיר סטטוס: ${tvRes.status}`);
                
                if (tvRes.ok) {
                    const tvData = await tvRes.json();
                    console.log(`[ESAY DIAGNOSTIC - STREAM LIVE] ✅ נמצאו קישורי לייב: ${JSON.stringify(tvData)}`);
                    return res.status(200).json(tvData);
                } else {
                    const tvErrBody = await tvRes.text().catch(() => 'N/A');
                    console.log(`[ESAY DIAGNOSTIC - STREAM LIVE] ❌ שרת הלייב נכשל. פירוט שגיאה: ${tvErrBody.substring(0, 300)}`);
                }
            } catch (e) {
                console.log(`[ESAY DIAGNOSTIC - STREAM LIVE] 💥 קריסה בשליפת ערוצי לייב:`, e.stack || e);
            }
            return res.status(200).json({ streams: [] });
        }

        // קריאת הגדרות פרופילים
        const configs = JSON.parse(process.env.USER_CONFIGS || '{}');
        const profileConfig = configs[userKey]?.profile || 'friends_light';
        const profile = PROFILES[profileConfig] || PROFILES.friends_light;
        
        const addons = (process.env.ADDON_URLS || '').split('|||').map(u => u.trim()).filter(Boolean);
        console.log(`[ESAY DIAGNOSTIC - STREAM] פרופיל: "${profileConfig}". כמות ספקים לסריקה: ${addons.length}`);

        // פונקציית שליפה מספק בודד
        const fetchFromAddon = async (baseUrl, customIdWithExt = null) => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), profile.timeoutMs); 
            
            const cleanBaseUrl = baseUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
            const finalIdWithExt = customIdWithExt || idWithExt;
            
            // המרת נתיב לסדרות בתוך ספקים ישראלים במידה ויש זליגת סוג תוכן
            let forwardType = type;
            if (baseUrl.includes('kan-box-addon.vercel.app') && (type === 'tv' || type === 'channel')) {
                forwardType = 'series';
            }
            
            const targetUrl = `${cleanBaseUrl}/stream/${forwardType}/${finalIdWithExt}`;
            const startTime = performance.now();

            try {
                const response = await fetch(targetUrl, { 
                    signal: controller.signal, 
                    headers: { 'User-Agent': 'Mozilla/5.0' }, 
                    timeout: profile.timeoutMs 
                });
                
                const durationMs = (performance.now() - startTime).toFixed(0);
                if (!response.ok) {
                    console.log(`[ESAY DIAGNOSTIC - FETCH] ❌ ${baseUrl.substring(0, 40)}... החזיר סטטוס ${response.status} ב-${durationMs}ms`);
                    return [];
                }
                
                const data = await response.json();
                if (data && Array.isArray(data.streams)) {
                    console.log(`[ESAY DIAGNOSTIC - FETCH] ⏱️ ${baseUrl.substring(0, 40)}... הגיב ב-${durationMs}ms (נמצאו ${data.streams.length} סטרים)`);
                    data.streams.forEach(s => s._sourceBaseUrl = baseUrl);
                    return data.streams;
                }
                return [];
            } catch (err) {
                const durationMs = (performance.now() - startTime).toFixed(0);
                console.log(`[ESAY DIAGNOSTIC - FETCH] ❌ שגיאה/Timeout בספק ${baseUrl.substring(0, 40)}... אחרי ${durationMs}ms: ${err.message}`);
                return [];
            } finally {
                clearTimeout(timeoutId);
            }
        };

        // בניית משימות השליפה הראשיות (באנגלית)
        let promises = addons.map(url => fetchFromAddon(url));

        // ==========================================
        // 2. מנגנון תרגום וחיפוש טקסטואלי בעברית (Kanbox)
        // ==========================================
        if (id.startsWith('tt')) {
            const baseId = id.split(':')[0]; 
            const movieName = await getMetaName(type, baseId);
            
            if (movieName) {
                console.log(`[ESAY DIAGNOSTIC - STREAM] 🔄 יוצר בקשות חיפוש טקסטואליות בעברית עבור: "${movieName}"`);
                const textSearchPromises = addons.map(baseUrl => {
                    return fetchFromAddon(baseUrl, `search=${encodeURIComponent(movieName)}.json`);
                });
                promises = promises.concat(textSearchPromises);
            }
        }
        
        let allStreams = [];
        let pendingCount = promises.length;

        const trackPromises = promises.map(p => p.then(val => {
            if (Array.isArray(val)) {
                allStreams = allStreams.concat(val);
            }
            pendingCount--;
            return val;
        }).catch(e => { 
            pendingCount--; 
        }));

        // המתנה לחלק הראשון של הבקשות
        await Promise.race([
            Promise.allSettled(trackPromises),
            new Promise(resolve => setTimeout(resolve, 5000))
        ]);

        console.log(`[ESAY DIAGNOSTIC - STREAM] מקצה א' הסתיים. נאספו: ${allStreams.length} סטרים גולמיים. בקשות תלויות באוויר: ${pendingCount}`);

        // מקצה זמן נוסף במידה והרשימה ריקה או קטנה
        if (pendingCount > 0 && allStreams.length < 3) {
            console.log(`[ESAY DIAGNOSTIC - STREAM] ⚠️ כמות תוצאות נמוכה (${allStreams.length}). ממתין עוד 4 שניות לספקים איטיים...`);
            await Promise.race([
                Promise.allSettled(trackPromises),
                new Promise(resolve => setTimeout(resolve, 4000))
            ]);
        }

        console.log(`[ESAY DIAGNOSTIC - STREAM] סך הכל בקשות הסתיימו. סטרים גולמיים כולל: ${allStreams.length}`);

        // ==========================================
        // 3. לוגיקת סינון כפילויות קשיחה (Deduplication)
        // ==========================================
        let filteredStreams = [];
        let dupCachedCount = 0;
        let dupUncachedCount = 0;

        for (const stream of allStreams) {
            const sIsCached = isCached(stream);
            const sSize = getSizeGB(stream);
            
            const isDuplicate = filteredStreams.some(existing => {
                const eIsCached = isCached(existing);
                
                // קובץ קאש וטורנט רגיל לעולם לא ימחקו אחד את השני
                if (sIsCached !== eIsCached) return false; 
                
                if (sIsCached) {
                    // לשני קבצי קאש: השוואה אבסולוטית של ה-URL
                    if (stream.url && existing.url) {
                        const match = stream.url === existing.url;
                        if (match) dupCachedCount++;
                        return match;
                    }
                } else {
                    // לשני טורנטים רגילים: השוואה של Hash + Title + Size עד גמישות של 1MB
                    if (stream.infoHash && existing.infoHash && stream.infoHash === existing.infoHash) {
                        if (stream.title === existing.title) {
                            const eSize = getSizeGB(existing);
                            const diffMB = Math.abs(sSize - eSize) * 1024;
                            if (diffMB <= 1.0) {
                                dupUncachedCount++;
                                return true;
                            }
                        }
                    }
                }
                return false;
            });

            if (!isDuplicate) {
                filteredStreams.push(stream);
            }
        }
        console.log(`[ESAY DIAGNOSTIC - DUP] סינון כפילויות הסתיים. נשארו: ${filteredStreams.length}. (נמחקו: ${dupCachedCount} קאש כפולים, ${dupUncachedCount} טורנטים כפולים)`);

        // ==========================================
        // 4. לוגיקת מסננים ופרופילים (Filters)
        // ==========================================
        let beforeFilterCount = filteredStreams.length;
        
        filteredStreams = filteredStreams.filter((stream, index) => {
            const isStreamCached = isCached(stream);
            const isStreamUsenet = isUsenet(stream);
            const seeders = getSeeders(stream);
            const sizeGB = getSizeGB(stream);
            const text = getTextForAnalysis(stream);

            // א) פילטר משקל קובץ מקסימלי
            if (sizeGB > profile.maxSizeGB) {
                console.log(`[ESAY DIAGNOSTIC - FILTER ITEM #${index}] ❌ נזרק: משקל גדול מדי (${sizeGB.toFixed(2)}GB > ${profile.maxSizeGB}GB)`);
                return false;
            }
            
            // ב) פילטר טורנטים מתים (0 סידרס)
            if (!isStreamCached && !isStreamUsenet && seeders !== null && seeders === 0) {
                console.log(`[ESAY DIAGNOSTIC - FILTER ITEM #${index}] ❌ נזרק: טורנט Uncached עם 0 סידרים.`);
                return false;
            }
            
            // ג) פילטר מינימום סידרס לפרופילים מוגבלים
            if (profileConfig !== 'everything') {
                if (!isStreamCached && !isStreamUsenet && seeders !== null && seeders < profile.minSeedersUncached) {
                    console.log(`[ESAY DIAGNOSTIC - FILTER ITEM #${index}] ❌ נזרק: כמות סידרים נמוכה מהפרופיל (${seeders} < ${profile.minSeedersUncached})`);
                    return false;
                }
            }

            // ד) פילטר HDR
            if (!profile.hasHDR) {
                const hasHDRTag = REGEX_HDR.test(text);
                const hasFallback = REGEX_HDR_FALLBACK.test(text);
                if (hasHDRTag && !hasFallback) {
                    console.log(`[ESAY DIAGNOSTIC - FILTER ITEM #${index}] ❌ נזרק: מכיל HDR והפרופיל חסום לזה.`);
                    return false;
                }
            }

            // ה) פילטר אודיו כבד
            if (!profile.hasHDAudio && REGEX_HD_AUDIO.test(text)) {
                console.log(`[ESAY DIAGNOSTIC - FILTER ITEM #${index}] ❌ נזרק: מכיל אודיו HD והפרופיל חסום לזה.`);
                return false;
            }
            
            return true;
        });
        
        console.log(`[ESAY DIAGNOSTIC - FILTER] שלב הפילטרים הסתיים. נשארו: ${filteredStreams.length} מתוך ${beforeFilterCount}`);

        // ==========================================
        // 5. מנוע המיון המלא והמשוחזר (Sorting)
        // ==========================================
        console.log(`[ESAY DIAGNOSTIC - SORT] מתחיל מיון מורכב לפי חוקי הפרופיל: "${profileConfig}"`);
        
        filteredStreams.sort((a, b) => {
            // חוק ברזל: ספק ישראלי VIP (קנבוקס) תמיד עוקף את כולם לראש הרשימה
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

            // א) לוגיקת מיון לפרופיל EVERYTHING
            if (profileConfig === 'everything') {
                if (qA !== qB) return qB - qA;
                if (resA !== resB) return resB - resA;
                if (sizeA !== sizeB) return sizeB - sizeA;
                
                const seedA = getSeeders(a) || 0;
                const seedB = getSeeders(b) || 0;
                if (!cachedA && !cachedB && seedA !== seedB) return seedB - seedA;
                
                return cachedA === cachedB ? 0 : (cachedA ? -1 : 1);
            }
            
            // ב) לוגיקת מיון לפרופיל FRIENDS_HEAVY
            if (profileConfig === 'friends_heavy') {
                if (qA !== qB) return qB - qA;
                if (usenetA !== usenetB) return usenetA ? -1 : 1;
                if (resA !== resB) return resB - resA;
                if (sizeA !== sizeB) return sizeB - sizeA;
                return cachedA === cachedB ? 0 : (cachedA ? -1 : 1); 
            }

            // ג) לוגיקת מיון ברירת מחדל (friends_light / family)
            if (cachedA !== cachedB) return cachedA ? -1 : 1;
            if (usenetA !== usenetB) return usenetA ? -1 : 1;
            if (qA !== qB) return qB - qA;
            return resB - resA;
        });

        // ==========================================
        // 6. חיתוך וחלוקת משבצות (Slicing)
        // ==========================================
        let finalSliced = [];

        if (profileConfig === 'friends_heavy') {
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
            console.log(`[ESAY DIAGNOSTIC - SLICE] חיתוך מיוחד לחברים כבדים: ${cachedSlots} קאש, ${actualUncached.length} טורנטים.`);
        } else {
            finalSliced = filteredStreams.slice(0, profile.maxResults);
            console.log(`[ESAY DIAGNOSTIC - SLICE] חיתוך רגיל לפרופיל. נלקחו ה- ${finalSliced.length} הראשונים.`);
        }

        // ==========================================
        // 7. תבנית שמות סופית (Formatting והזרקת תגיות)
        // ==========================================
        finalSliced = finalSliced.map((stream, index) => {
            const text = getTextForAnalysis(stream);
            const sIsCached = isCached(stream);
            const isVip = isVIPSource(stream);
            const hasDebridTag = /rd\+?|torbox\+?|tb\+?|ad\+?|pm\+?|cached|real-?debrid|premiumize/i.test(text);

            console.log(`[ESAY DIAGNOSTIC - FINAL ITEM #${index}] כותרת מקורית: "${stream.name}". VIP: ${isVip}, Cached: ${sIsCached}, HasDebrid: ${hasDebridTag}, URL: ${stream.url ? 'יש' : 'אין'}, Hash: ${stream.infoHash || 'אין'}`);

            // א) עיצוב חשבונות Debrid מרוחקים -> "זמין לצפייה"
            if (hasDebridTag && !isVip) {
                const REGEX_CACHED = /\[?(torbox\+?|tb\+?|rd\+?|ad\+?|pm\+?|cached|real-?debrid|all-?debrid|premiumize)\]?/gi;
                let cleanName = (stream.name || '').replace(REGEX_CACHED, '').trim();
                let cleanTitle = (stream.title || '').replace(REGEX_CACHED, '').trim();
                
                cleanName = cleanName.replace(/^[\]|\]\s\-\n]+/, '').replace(/[\[|\[\s\-\n]+$/, '').trim();
                
                stream.name = cleanName ? `זמין לצפייה | ${cleanName}` : 'זמין לצפייה';
                stream.title = cleanTitle;
            } 
            // ב) עיצוב קישורי HTTP ישירים או הספק הישראלי -> "מרשת דפדפן"
            else if (isVip || (stream.url && !stream.infoHash)) {
                let cleanName = (stream.name || '').trim().replace(/^[\s|\-\n]+/, '').trim();
                stream.name = cleanName ? `מרשת דפדפן | ${cleanName}` : 'מרשת דפדפן';
            }

            delete stream._sourceBaseUrl;
            return stream;
        });

        return res.status(200).json({ streams: finalSliced });

    } catch (error) {
        console.log(`[ESAY DIAGNOSTIC - STREAM] 💥 קריסה קריטית מוחלטת בסטרימים:`, error.stack || error);
        return res.status(500).json({ streams: [] });
    }
}
