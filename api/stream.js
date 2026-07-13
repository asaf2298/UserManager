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
    return ((stream.name || '') + ' ' + (stream.title || '') + ' ' + (stream.description || '')).toLowerCase();
}

function isCached(stream) {
    if (stream.infoHash) return false;
    if (!stream.url) return false;
    
    const text = getTextForAnalysis(stream);
    if (text.includes('download') || text.includes('⬇️')) return false;
    
    const isDirectStream = stream.url.startsWith('http') || stream.url.startsWith('acestream');
    const hasCacheKeywords = text.includes('torbox+') || text.includes('cached') || text.includes('rd+');
    
    return hasCacheKeywords || isDirectStream;
}

function isUsenet(stream) {
    return getTextForAnalysis(stream).includes('usenet') || getTextForAnalysis(stream).includes('nzb');
}

function isVIPSource(stream) {
    const sourceUrl = (stream._sourceBaseUrl || '').toLowerCase();
    return sourceUrl.includes('kan-box-addon.vercel.app') || sourceUrl.includes('animeil');
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
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2500);
        const response = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${id}.json`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!response.ok) return null;
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

    console.log(`[ESAY DIAGNOSTIC - STREAM] 🟢 בקשת סטרים נכנסת: ${req.url}`);

    // חילוץ מדויק של Headers לפי המפרט כדי לשמור על IP ומזהה של סטרימיו
    const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
    const clientUA = req.headers['user-agent'] || 'Stremio/4.4.156';

    try {
        const urlParts = req.url.split('?')[0].split('/');
        const streamIdx = urlParts.indexOf('stream');
        if (streamIdx < 1 || streamIdx + 2 >= urlParts.length) {
            return res.status(400).json({ streams: [] });
        }

        const userKey = urlParts[streamIdx - 1];
        const type = urlParts[streamIdx + 1];
        let rawIdWithExt = urlParts[streamIdx + 2];
        
        if (rawIdWithExt.includes('%')) {
            rawIdWithExt = decodeURIComponent(rawIdWithExt);
        }
        const idWithExt = rawIdWithExt;
        const id = idWithExt.replace('.json', '');

        // ==========================================
        // ערוצי טלוויזיה / לייב 
        // ==========================================
        if (type === 'tv' || type === 'channel') {
            const tvAddonUrl = process.env.TV_ADDON_URL;
            console.log(`[ESAY DIAGNOSTIC - LIVE] ערוץ חי זוהה: ${idWithExt}. כתובת בסיס: ${tvAddonUrl}`);
            
            if (!tvAddonUrl) return res.status(200).json({ streams: [] });
            
            try {
                const cleanTvUrl = tvAddonUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
                const targetUrl = `${cleanTvUrl}/stream/series/${idWithExt}`;
                
                // הזרקת ה-Headers המקוריים לפי הנחיות ה-Kanbox!
                const headers = { 
                    'User-Agent': clientUA,
                    'X-Forwarded-For': clientIp,
                    'Accept': 'application/json, text/plain, */*',
                };
                console.log(`[ESAY DIAGNOSTIC - LIVE] 🚀 מוציא בקשה ל-Kanbox: ${targetUrl}. Headers:`, headers);
                const tvRes = await fetch(targetUrl, { headers, timeout: 9500 });
                
                console.log(`[ESAY DIAGNOSTIC - LIVE] 📥 סטטוס תגובה מ-Kanbox: ${tvRes.status}`);
                if (tvRes.ok) {
                    const tvData = await tvRes.json();
                    // העברת ה-behaviorHints כפי שהם מהתוסף (ללא דריסה)
                    const streamsCount = (tvData && Array.isArray(tvData.streams)) ? tvData.streams.length : 0;
                    console.log(`[ESAY DIAGNOSTIC - LIVE] ✅ נמצאו ${streamsCount} קישורים. תוכן אובייקט:`, JSON.stringify(tvData));
                    return res.status(200).json(tvData);
                }
            } catch (e) {
                console.error('[ESAY DIAGNOSTIC - LIVE] 💥 שגיאה בערוץ חי:', e);
            }
            return res.status(200).json({ streams: [] });
        }

        const configs = JSON.parse(process.env.USER_CONFIGS || '{}');
        const profileConfig = configs[userKey]?.profile || 'friends_light';
        const profile = PROFILES[profileConfig] || PROFILES.friends_light;
        const addons = (process.env.ADDON_URLS || '').split('|||').map(u => u.trim()).filter(Boolean);
        if (addons.length === 0) return res.status(200).json({ streams: [] });
        
        const fetchFromAddon = async (baseUrl, customIdWithExt = null) => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), profile.timeoutMs); 
            const cleanBaseUrl = baseUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
            const finalIdWithExt = customIdWithExt || idWithExt;
            
            let forwardType = type;
            if (baseUrl.includes('kan-box-addon.vercel.app') && (type === 'tv' || type === 'channel')) {
                forwardType = 'series';
            }
            const targetUrl = `${cleanBaseUrl}/stream/${forwardType}/${finalIdWithExt}`;

            // העברת ה-Headers גם לשאר הספקים (פרקטיקה מומלצת לפרוקסי)
            const fetchHeaders = { 
                'User-Agent': clientUA,
                'X-Forwarded-For': clientIp 
            };

            try {
                const response = await fetch(targetUrl, { signal: controller.signal, headers: fetchHeaders, timeout: profile.timeoutMs });
                if (!response.ok) return [];
                const data = await response.json();
                if (data && Array.isArray(data.streams)) {
                    data.streams.forEach(s => s._sourceBaseUrl = baseUrl);
                    return data.streams;
                }
                return [];
            } catch (err) {
                return [];
            } finally {
                clearTimeout(timeoutId);
            }
        };

        let promises = addons.map(url => fetchFromAddon(url));

        if (id.startsWith('tt')) {
            const baseId = id.split(':')[0]; 
            const movieName = await getMetaName(type, baseId); 
            if (movieName) {
                console.log(`[ESAY DIAGNOSTIC - SEARCH] 🔍 נמצא שם באנגלית (Cinemeta): "${movieName}". מזריק לתוספים...`);
                const textSearchPromises = addons.map(baseUrl => fetchFromAddon(baseUrl, `search=${encodeURIComponent(movieName)}.json`));
                promises = promises.concat(textSearchPromises);
            }
        }
        
        let allStreams = [];
        const trackPromises = promises.map(p => p.then(val => {
            if (Array.isArray(val)) allStreams = allStreams.concat(val);
            return val;
        }).catch(() => {}));

        await Promise.race([Promise.allSettled(trackPromises), new Promise(resolve => setTimeout(resolve, 5000))]);

        let filteredStreams = [];
        for (const stream of allStreams) {
            const sIsCached = isCached(stream);
            const sSize = getSizeGB(stream);
            
            const isDuplicate = filteredStreams.some(existing => {
                const eIsCached = isCached(existing);
                if (sIsCached !== eIsCached) return false; 
                if (sIsCached) {
                    if (stream.url && existing.url) return stream.url === existing.url;
                } else {
                    if (stream.infoHash && existing.infoHash && stream.infoHash === existing.infoHash) {
                        if (stream.title === existing.title) {
                            const eSize = getSizeGB(existing);
                            const diffMB = Math.abs(sSize - eSize) * 1024;
                            if (diffMB <= 1.0) return true;
                        }
                    }
                }
                return false;
            });
            if (!isDuplicate) filteredStreams.push(stream);
        }

        filteredStreams = filteredStreams.filter(stream => {
            const sizeGB = getSizeGB(stream);
            if (sizeGB > profile.maxSizeGB) return false;
            
            const isStreamCached = isCached(stream);
            const isStreamUsenet = isUsenet(stream);
            const seeders = getSeeders(stream);
            if (!isStreamCached && !isStreamUsenet && seeders !== null && seeders === 0) return false;
            
            return true;
        });

        const vipStreams = [];
        const standardStreams = [];
        
        for (const stream of filteredStreams) {
            if (isVIPSource(stream)) {
                vipStreams.push(stream);
            } else {
                standardStreams.push(stream);
            }
        }
        
        const buckets = {
            '4k_c': [], '4k_u': [],
            '1080p_c': [], '1080p_u': [],
            '720p_c': [], '720p_u': [],
            'sd_c': [], 'sd_u': []
        };

        for (const s of standardStreams) {
            const isC = isCached(s);
            const isU = isUsenet(s);
            const titleLog = (s.title || s.name || '').substring(0, 40).replace(/\n/g, ' ');

            if (isU) {
                console.log(`[ESAY DIAGNOSTIC - IDENTIFY] 🗄️ זוהה Usenet: ${titleLog}`);
            } else if (!isC) {
                console.log(`[ESAY DIAGNOSTIC - IDENTIFY] ⏳ זוהה Uncached: ${titleLog}`);
            }

            const res = getResWeight(getTextForAnalysis(s));
            if (res === 4) { isC ? buckets['4k_c'].push(s) : buckets['4k_u'].push(s); }
            else if (res === 3) { isC ? buckets['1080p_c'].push(s) : buckets['1080p_u'].push(s); }
            else if (res === 2) { isC ? buckets['720p_c'].push(s) : buckets['720p_u'].push(s); }
            else { isC ? buckets['sd_c'].push(s) : buckets['sd_u'].push(s); }
        }

        for (const key in buckets) {
            buckets[key].sort((a, b) => {
                const qA = getQualityWeight(getTextForAnalysis(a));
                const qB = getQualityWeight(getTextForAnalysis(b));
                if (qA !== qB) return qB - qA;
                const seedA = getSeeders(a) || 0;
                const seedB = getSeeders(b) || 0;
                return seedB - seedA;
            });
        }

        const isBigProfile = (profileConfig === 'everything' || profileConfig === 'friends_heavy');
        let quotas = {};
        if (isBigProfile) {
            quotas = { '4k_c': 12, '4k_u': 3, '1080p_c': 6, '1080p_u': 2, '720p_c': 3, '720p_u': 1, 'sd_c': 2, 'sd_u': 1 };
        } else {
            quotas = { '4k_c': 3, '4k_u': 1, '1080p_c': 3, '1080p_u': 1, '720p_c': 2, '720p_u': 0, 'sd_c': 0, 'sd_u': 0 };
        }

        const standardResult = [];

        function drawWithOverflow(resLevel, qC, qU) {
            let targetC = qC;
            let pulledC = buckets[`${resLevel}_c`].splice(0, targetC);
            standardResult.push(...pulledC);
            let missingC = targetC - pulledC.length;

            let targetU = qU + missingC; 
            let pulledU = buckets[`${resLevel}_u`].splice(0, targetU);
            standardResult.push(...pulledU);
            let missingU = targetU - pulledU.length;

            if (missingU > 0 && buckets[`${resLevel}_c`].length > 0) {
                let extraC = buckets[`${resLevel}_c`].splice(0, missingU);
                standardResult.push(...extraC);
                missingU -= extraC.length;
            }
            return missingU; 
        }

        let cascade = 0;
        cascade = drawWithOverflow('4k', quotas['4k_c'] + cascade, quotas['4k_u']);
        cascade = drawWithOverflow('1080p', quotas['1080p_c'] + cascade, quotas['1080p_u']);
        cascade = drawWithOverflow('720p', quotas['720p_c'] + cascade, quotas['720p_u']);
        cascade = drawWithOverflow('sd', quotas['sd_c'] + cascade, quotas['sd_u']);

        standardResult.sort((a, b) => {
            const textA = getTextForAnalysis(a); const textB = getTextForAnalysis(b);
            const cachedA = isCached(a); const cachedB = isCached(b);
            const usenetA = isUsenet(a); const usenetB = isUsenet(b);
            const qA = getQualityWeight(textA); const qB = getQualityWeight(textB);
            const resA = getResWeight(textA); const resB = getResWeight(textB);
            const sizeA = getSizeGB(a); const sizeB = getSizeGB(b);

            if (profileConfig === 'everything') {
                if (resA !== resB) return resB - resA;
                if (qA !== qB) return qB - qA;
                if (sizeA !== sizeB) return sizeB - sizeA;
                const seedA = getSeeders(a) || 0; const seedB = getSeeders(b) || 0;
                if (!cachedA && !cachedB && seedA !== seedB) return seedB - seedA;
                return cachedA === cachedB ? 0 : (cachedA ? -1 : 1);
            } else {
                if (cachedA !== cachedB) return cachedA ? -1 : 1;
                if (usenetA !== usenetB) return usenetA ? -1 : 1;
                if (resA !== resB) return resB - resA;
                if (qA !== qB) return qB - qA;
                if (sizeA !== sizeB) return sizeB - sizeA;
                return 0;
            }
        });

        // ==========================================
        // שילוב ה-VIP בראש הרשימה
        // ==========================================
        let finalSliced = [...vipStreams, ...standardResult];

        finalSliced = finalSliced.map(stream => {
            const text = getTextForAnalysis(stream);
            const isVip = isVIPSource(stream);
            const isC = isCached(stream);
            const hasDebridTag = /rd\+?|torbox|tb|ad\+?|pm\+?|cached|real-?debrid|premiumize/i.test(text);

            const REGEX_BRACKETS = /\[[^\]]*(torbox|tb|rd|ad|pm|cached|real-?debrid|all-?debrid|premiumize)[^\]]*\]/gi;
            const REGEX_PARENS = /\([^)]*(torbox|tb|rd|ad|pm|cached|real-?debrid|all-?debrid|premiumize)[^)]*\)/gi;
            const REGEX_DOWNLOAD = /\[[^\]]*(download|⬇️)[^\]]*\]/gi;

            let cleanName = (stream.name || '').replace(REGEX_BRACKETS, '').replace(REGEX_PARENS, '').replace(REGEX_DOWNLOAD, '');
            cleanName = cleanName.replace(/\n+/g, ' ').replace(/^[\s\-\|]+|[\s\-\|]+$/g, '').replace(/\s{2,}/g, ' ').trim();
            
            let cleanTitle = (stream.title || '').replace(REGEX_BRACKETS, '').replace(REGEX_PARENS, '').replace(REGEX_DOWNLOAD, '');
            cleanTitle = cleanTitle.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();

            if (isVip || (stream.url && !stream.infoHash && !hasDebridTag)) {
                stream.name = cleanName ? `מרשת דפדפן | ${cleanName}` : 'מרשת דפדפן';
            } 
            else {
                if (isC) {
                    stream.name = cleanName ? `זמין לצפייה | ${cleanName}` : 'זמין לצפייה';
                } else {
                    stream.name = cleanName ? `דורש המתנה ואולי כניסה חוזרת | ${cleanName}` : 'דורש המתנה ואולי כניסה חוזרת | ';
                }
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
