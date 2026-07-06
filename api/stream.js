import fetch from 'node-fetch';

// --- תצורת פרופילים (Feature Flags & Limits) ---
const PROFILES = {
    everything: {
        maxResults: 25,
        maxSizeGB: Infinity,
        minSeedersUncached: 1, // מותר לא-Cached עם סידר 1
        hasHDR: true,
        hasHDAudio: true,
        timeoutMs: 18000
    },
    family: {
        maxResults: 7,
        maxSizeGB: 30,
        minSeedersUncached: 5, // דורש מעל 4 סידרים
        hasHDR: false,
        hasHDAudio: false,
        timeoutMs: 10000
    },
    friends_light: {
        maxResults: 7,
        maxSizeGB: 30,
        minSeedersUncached: 5,
        hasHDR: false,
        hasHDAudio: false,
        timeoutMs: 10000
    },
    friends_heavy: {
        maxResults: 25,
        maxSizeGB: Infinity,
        minSeedersUncached: 5,
        hasHDR: true,
        hasHDAudio: true,
        timeoutMs: 18000
    }
};

// --- פונקציות עזר וביטויים רגולריים (Regex) ---
const REGEX_HDR = /(hdr10|dolby\s?vision|dovi|dv\b|hdr)/i;
const REGEX_HDR_FALLBACK = /(fallback|hdr10\+?(\s|-)compatible|hybrid)/i;
const REGEX_HD_AUDIO = /(dts(-hd|:x|x|ma)?|truehd|atmos)/i;
const REGEX_SIZE = /(\d+(?:\.\d+)?)\s*(GB|MB)/i;
const REGEX_SEEDERS = /(?:👤|seeders?:?)\s*(\d+)/i;

function getTextForAnalysis(stream) {
    return ((stream.name || '') + ' ' + (stream.title || '') + ' ' + (stream.description || '')).toLowerCase();
}

function isCached(stream) {
    const text = getTextForAnalysis(stream);
    return text.includes('torbox+') || text.includes('cached') || text.includes('rd+') || (stream.url && stream.url.startsWith('http'));
}

function isUsenet(stream) {
    return getTextForAnalysis(stream).includes('usenet') || getTextForAnalysis(stream).includes('nzb');
}

function isAnimeIL(stream) {
    return getTextForAnalysis(stream).includes('animeil');
}

function getSeeders(stream) {
    const match = getTextForAnalysis(stream).match(REGEX_SEEDERS);
    return match ? parseInt(match[1], 10) : 0;
}

function getSizeGB(stream) {
    if (stream.size) return stream.size / (1024 ** 3);
    const match = getTextForAnalysis(stream).match(REGEX_SIZE);
    if (!match) return 0;
    const val = parseFloat(match[1]);
    return match[2].toUpperCase() === 'MB' ? val / 1024 : val;
}

// ניקוד לאיכות (Quality)
function getQualityWeight(text) {
    if (text.includes('remux')) return 4;
    if (text.includes('bluray') || text.includes('bdrip') || text.includes('brrip')) return 3;
    if (text.includes('web-dl') || text.includes('webrip') || text.includes('web')) return 2;
    if (text.includes('hdtv') || text.includes('tvrip')) return 1;
    return 0;
}

// ניקוד לרזולוציה (Resolution)
function getResWeight(text) {
    if (text.includes('4k') || text.includes('2160p')) return 4;
    if (text.includes('1080p') || text.includes('fhd')) return 3;
    if (text.includes('720p') || text.includes('hd')) return 2;
    return 1;
}

// --- מנגנון משיכה עם Timeout (Promise.race) ---
async function fetchAddonWithTimeout(url, timeoutMs) {
    const fetchPromise = fetch(url).then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    });
    
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Addon Timeout')), timeoutMs);
    });

    return Promise.race([fetchPromise, timeoutPromise]);
}

// --- הפונקציה המרכזית (Serverless Handler) ---
export default async function handler(req, res) {
    try {
        // פירוק הנתיב. דוגמה: /api/everything/stream/movie/tt12345.json
        const urlParts = req.url.split('?')[0].split('/');
        // מציאת המיקומים של stream
        const streamIdx = urlParts.indexOf('stream');
        if (streamIdx < 1 || streamIdx + 2 >= urlParts.length) {
            return res.status(400).json({ streams: [] });
        }

        const profileName = urlParts[streamIdx - 1];
        const type = urlParts[streamIdx + 1]; // movie, series, anime
        const idWithExt = urlParts[streamIdx + 2]; // tt12345.json
        const id = idWithExt.replace('.json', '');

        const profile = PROFILES[profileName] || PROFILES.friends_light; // Fallback
        
        // שליפת כתובות התוספים מה-ENV (מופרדות בפסיק)
        const envAddons = process.env.ADDON_URLS || '';
        const addons = envAddons.split(',').map(url => url.trim()).filter(Boolean);

        if (addons.length === 0) {
            return res.status(200).json({ streams: [] });
        }

        // בניית הבקשות במקביל
        const requests = addons.map(baseUrl => {
            const cleanBase = baseUrl.replace(/\/$/, '');
            const targetUrl = `${cleanBase}/stream/${type}/${idWithExt}`;
            return fetchAddonWithTimeout(targetUrl, profile.timeoutMs);
        });

        // שימוש ב-Promise.allSettled כדי לספוג נפילות ו-Timeouts
        const responses = await Promise.allSettled(requests);
        
        let allStreams = [];
        for (const response of responses) {
            if (response.status === 'fulfilled' && response.value && Array.isArray(response.value.streams)) {
                allStreams = allStreams.concat(response.value.streams);
            }
        }

        // 1. ניקוי כפילויות (Deduplication לפי infoHash)
        const uniqueStreamsMap = new Map();
        for (const stream of allStreams) {
            // אם אין infoHash, נשתמש ב-URL או בשם כמפתח ייחודי
            const key = stream.infoHash || stream.url || stream.title;
            if (!uniqueStreamsMap.has(key)) {
                uniqueStreamsMap.set(key, stream);
            }
        }
        let filteredStreams = Array.from(uniqueStreamsMap.values());

        // 2. סינון (Business Logic)
        filteredStreams = filteredStreams.filter(stream => {
            const isStreamCached = isCached(stream);
            const isStreamUsenet = isUsenet(stream);
            const seeders = getSeeders(stream);
            const sizeGB = getSizeGB(stream);
            const text = getTextForAnalysis(stream);

            // חוק 0 סידרים גלובלי (לטורנטים בלבד)
            if (!isStreamCached && !isStreamUsenet && seeders === 0) return false;

            // חוק נפח
            if (sizeGB > profile.maxSizeGB) return false;

            // חוק מינימום סידרים לקובץ לא-Cached
            if (!isStreamCached && !isStreamUsenet && seeders < profile.minSeedersUncached) return false;

            // חוק HDR
            if (!profile.hasHDR) {
                const hasHDRTag = REGEX_HDR.test(text);
                const hasFallback = REGEX_HDR_FALLBACK.test(text);
                if (hasHDRTag && !hasFallback) return false;
            }

            // חוק HD Audio
            if (!profile.hasHDAudio) {
                if (REGEX_HD_AUDIO.test(text)) return false;
            }

            return true;
        });

        // 3. מיון לפי פרופיל
        filteredStreams.sort((a, b) => {
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

            if (profileName === 'everything') {
                if (qA !== qB) return qB - qA;
                if (resA !== resB) return resB - resA;
                if (sizeA !== sizeB) return sizeB - sizeA;
                return cachedA === cachedB ? 0 : (cachedA ? 1 : -1); // Cached בסוף
            }
            
            if (profileName === 'friends_heavy') {
                if (qA !== qB) return qB - qA;
                if (usenetA !== usenetB) return usenetA ? -1 : 1; // Usenet עוקף באותה איכות
                if (resA !== resB) return resB - resA;
                if (sizeA !== sizeB) return sizeB - sizeA;
                return cachedA === cachedB ? 0 : (cachedA ? 1 : -1); 
            }

            // family & friends_light
            if (cachedA !== cachedB) return cachedA ? -1 : 1;
            if (usenetA !== usenetB) return usenetA ? -1 : 1;
            if (qA !== qB) return qB - qA;
            return resB - resA;
        });

        // 4. חוק AnimeIL (עדיפות עליונה אם הסוג הוא anime)
        if (type === 'anime') {
            const animeIL = filteredStreams.filter(s => isAnimeIL(s));
            const others = filteredStreams.filter(s => !isAnimeIL(s));
            filteredStreams = [...animeIL, ...others];
        }

        // 5. קיצוץ לפי מגבלת כמות
        filteredStreams = filteredStreams.slice(0, profile.maxResults);

        return res.status(200).json({ streams: filteredStreams });

    } catch (error) {
        console.error('Stream Proxy Error:', error);
        return res.status(500).json({ streams: [] });
    }
}
