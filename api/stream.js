import fetch from 'node-fetch';
import { getCleanMovieName } from './search.js'; 

const PROFILES = {
    everything:    { maxResults: 30, maxSizeGB: Infinity, minSeedersUncached: 1, hasHDR: true, hasHDAudio: true, timeoutMs: 9500 },
    family:        { maxResults: 10, maxSizeGB: 30,       minSeedersUncached: 4, hasHDR: true, hasHDAudio: true, timeoutMs: 9150 },
    friends_light: { maxResults: 10, maxSizeGB: 30,       minSeedersUncached: 4, hasHDR: true, hasHDAudio: true, timeoutMs: 9150 },
    friends_heavy: { maxResults: 30, maxSizeGB: Infinity, minSeedersUncached: 3, hasHDR: true, hasHDAudio: true, timeoutMs: 9150 }
};

const REGEX_SIZE    = /(\d+(?:\.\d+)?)\s*(GB|MB)/i;
const REGEX_SEEDERS = /(?:👤|seeders?:?)\s*(\d+)/i;

const RES_WEIGHT_MAP = {
    '4k': 4, '2160p': 4, 'uhd': 4,
    '1080p': 3, 'fhd': 3,
    '720p': 2, 'hdrip': 2,
    '480p': 1, 'sd': 1,
};

function getTextForAnalysis(stream) {
    return ((stream.name || '') + ' ' + (stream.title || '') + ' ' + (stream.description || '')).toLowerCase();
}

// תוקן: Regex מדויק ללא False Positives
function isCached(stream) {
    const text = getTextForAnalysis(stream);
    if (text.includes('download') || text.includes('⬇️')) return false;
    const hasCacheKeywords = /torbox|\btb\b|comet|\bcached\b|\brd\+|elfhosted|elfcache|all-?debrid|\bad\+|premiumize|debrid-?link|stremthru/i.test(text);
    if (hasCacheKeywords) return true;
    if (stream.infoHash) return false;
    if (stream.url && (stream.url.startsWith('magnet:') || stream.url.toLowerCase().endsWith('.torrent'))) return false;
    if (!stream.url) return false;
    if (stream.url.startsWith('http') || stream.url.startsWith('acestream')) return true;
    return false;
}

function isUsenet(stream) {
    const text = getTextForAnalysis(stream);
    return text.includes('usenet') || text.includes('nzb');
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
    if (stream.behaviorHints?.videoSize) return stream.behaviorHints.videoSize / (1024 ** 3);
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

// תוקן: זיהוי רזולוציה מתקדם באמצעות תוחמים למניעת טעויות זיהוי
function getResWeight(stream) {
    if (isVIPSource(stream) || stream.behaviorHints?.bingeGroup === 'live-tv') return 3;
    const rawText = getTextForAnalysis(stream);
    let match;
    const found = [];
    const regexRes = /(?:^|[.\s\[\-_(])(4k|2160p|uhd|1080p|fhd|720p|hdrip|480p|sd)(?:[.\s\]\-_)]|$)/gi;
    
    while ((match = regexRes.exec(rawText)) !== null) {
        found.push(match[1].toLowerCase());
    }
    
    if (found.length === 0) {
        if (rawText.includes('remux') || rawText.includes('bluray')) return 3;
        return 0; 
    }
    const weights = [...new Set(found.map(tag => RES_WEIGHT_MAP[tag]))];
    if (weights.length === 1) return weights[0];
    return Math.max(...weights);
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const forwardedIps = req.headers['x-forwarded-for'] || '';
    const clientIp = forwardedIps ? forwardedIps.split(',')[0].trim() : (req.socket?.remoteAddress || '');
    const clientUA = req.headers['user-agent'] || 'Stremio/4.4.156';

    console.log(`\n[ESAY DIAGNOSTIC - STREAM] 🟢 בקשת סטרים חדשה התקבלה!`);
    console.log(`[ESAY DIAGNOSTIC - STREAM] 🌐 URL: ${req.url}`);

    try {
        const urlParts  = req.url.split('?')[0].split('/');
        const streamIdx = urlParts.indexOf('stream');
        if (streamIdx < 1 || streamIdx + 2 >= urlParts.length) {
            console.error(`[ESAY DIAGNOSTIC - STREAM] ❌ שגיאה: מבנה URL לא תקין.`);
            return res.status(400).json({ streams: [] });
        }

        const userKey = urlParts[streamIdx - 1];
        const type    = urlParts[streamIdx + 1];
        let rawIdWithExt = urlParts[streamIdx + 2];
        if (rawIdWithExt.includes('%')) rawIdWithExt = decodeURIComponent(rawIdWithExt);
        const idWithExt = rawIdWithExt;
        const id        = idWithExt.replace('.json', '');

        // הוספת הגנת Timeout לענף ה-Live TV הקריטי
        if (type === 'tv' || type === 'channel') {
            const tvAddonUrl = process.env.TV_ADDON_URL;
            if (!tvAddonUrl) return res.status(200).json({ streams: [] });
            try {
                const cleanTvUrl = tvAddonUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
                const targetUrl  = `${cleanTvUrl}/stream/series/${idWithExt}`;
                const headers    = { 'User-Agent': clientUA, 'X-Forwarded-For': clientIp, 'Accept': 'application/json, text/plain, */*' };
                
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 9500);
                let tvRes;
                try {
                    tvRes = await fetch(targetUrl, { headers, signal: controller.signal });
                } finally {
                    clearTimeout(timeoutId);
                }

                if (tvRes.ok) {
                    const tvData = await tvRes.json();
                    return res.status(200).json(tvData);
                }
            } catch (e) {
                console.error('[ESAY DIAGNOSTIC - LIVE] 💥 שגיאה בשליפת ערוץ חי:', e.message);
            }
            return res.status(200).json({ streams: [] });
        }

        const configs       = JSON.parse(process.env.USER_CONFIGS || '{}');
        const profileConfig = configs[userKey]?.profile || 'friends_light';
        const profile       = PROFILES[profileConfig] || PROFILES.friends_light;
        const addons        = (process.env.ADDON_URLS || '').split('|||').map(u => u.trim()).filter(Boolean);
        
        if (addons.length === 0) return res.status(200).json({ streams: [] });

        const fetchFromAddon = async (baseUrl, customIdWithExt = null) => {
            const controller    = new AbortController();
            const timeoutId     = setTimeout(() => controller.abort(), profile.timeoutMs);
            const cleanBaseUrl  = baseUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
            const finalIdWithExt = customIdWithExt || idWithExt;
            let forwardType = type;
            
            if (baseUrl.includes('kan-box-addon.vercel.app') && (type === 'tv' || type === 'channel')) forwardType = 'series';
            const targetUrl = `${cleanBaseUrl}/stream/${forwardType}/${finalIdWithExt}`;
            
            const fetchHeaders = { 'User-Agent': clientUA };
            if (baseUrl.includes('kan-box-addon.vercel.app')) {
                fetchHeaders['X-Forwarded-For'] = clientIp;
            }  
            
            try {
                const response = await fetch(targetUrl, { signal: controller.signal, headers: fetchHeaders });
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
            const movieName = await getCleanMovieName(type, id);
            if (movieName) {
                const textSearchPromises = addons.map(baseUrl => fetchFromAddon(baseUrl, `search=${encodeURIComponent(movieName)}.json`));
                promises = promises.concat(textSearchPromises);
            }
        }

        let allStreams = [];
        const trackPromises = promises.map(p => p.then(val => { if (Array.isArray(val)) allStreams = allStreams.concat(val); return val; }).catch(() => {}));
        await Promise.race([Promise.allSettled(trackPromises), new Promise(resolve => setTimeout(resolve, 5000))]);

        const deduplicatedStreams = [];
        for (const stream of allStreams) {
            const sIsCached = isCached(stream);
            const sSize     = getSizeGB(stream);
            const isDuplicate = deduplicatedStreams.some(existing => {
                if (sIsCached !== isCached(existing)) return false;
                if (sIsCached) {
                    if (stream.url && existing.url && stream.url === existing.url) return true;
                    if (stream.title === existing.title && Math.abs(sSize - getSizeGB(existing)) * 1024 <= 1.0) return true;
                    return false;
                } else {
                    if (stream.infoHash && existing.infoHash && stream.infoHash === existing.infoHash && stream.title === existing.title) {
                        return Math.abs(sSize - getSizeGB(existing)) * 1024 <= 1.0;
                    }
                }
                return false;
            });
            if (!isDuplicate) deduplicatedStreams.push(stream);
        }

        const topTierStreams = [];
        const fallbackStreams = [];
        for (const stream of deduplicatedStreams) {
            const sizeGB         = getSizeGB(stream);
            const isStreamCached = isCached(stream);
            const isStreamUsenet = isUsenet(stream);
            const seeders        = getSeeders(stream);
            let isTopTier = true;

            if (sizeGB > profile.maxSizeGB) isTopTier = false;
            if (!isStreamCached && !isStreamUsenet && seeders !== null && seeders < profile.minSeedersUncached) isTopTier = false;

            (isTopTier ? topTierStreams : fallbackStreams).push(stream);
        }

        const vipStreams      = [];
        const standardStreams = [];
        for (const stream of topTierStreams) {
            (isVIPSource(stream) ? vipStreams : standardStreams).push(stream);
        }

        const buckets = { '4k_c': [], '4k_u': [], '1080p_c': [], '1080p_u': [], '720p_c': [], '720p_u': [], 'sd_c': [], 'sd_u': [] };

        for (const s of standardStreams) {
            const isC = isCached(s); const rw = getResWeight(s); const sfx = isC ? '_c' : '_u';
            if (rw === 4) buckets[`4k${sfx}`].push(s);
            else if (rw === 3) buckets[`1080p${sfx}`].push(s);
            else if (rw === 2) buckets[`720p${sfx}`].push(s);
            else buckets[`sd${sfx}`].push(s);
        }

        const isBigProfile = (profileConfig === 'everything' || profileConfig === 'friends_heavy');
        const quotas = isBigProfile
            ? { '4k_c': 12, '4k_u': 3, '1080p_c': 6, '1080p_u': 2, '720p_c': 3, '720p_u': 1, 'sd_c': 2, 'sd_u': 1 }
            : { '4k_c':  3, '4k_u': 1, '1080p_c': 3, '1080p_u': 1, '720p_c': 2, '720p_u': 0, 'sd_c': 0, 'sd_u': 0 };

        const standardResult = [];
        function drawWithOverflow(resLevel, qC, qU) {
            const pulledC = buckets[`${resLevel}_c`].splice(0, qC);
            standardResult.push(...pulledC);
            const missingC = qC - pulledC.length;

            const targetU = qU + missingC;
            const pulledU = buckets[`${resLevel}_u`].splice(0, targetU);
            standardResult.push(...pulledU);
            let missing = targetU - pulledU.length;

            if (missing > 0 && buckets[`${resLevel}_c`].length > 0) {
                const extraC = buckets[`${resLevel}_c`].splice(0, missing);
                standardResult.push(...extraC);
                missing -= extraC.length;
            }
            return missing;
        }

        drawWithOverflow('4k', quotas['4k_c'], quotas['4k_u']);
        drawWithOverflow('1080p', quotas['1080p_c'], quotas['1080p_u']);
        drawWithOverflow('720p', quotas['720p_c'], quotas['720p_u']);
        drawWithOverflow('sd', quotas['sd_c'], quotas['sd_u']);

        for (const key of Object.keys(buckets)) {
            if (buckets[key].length > 0) fallbackStreams.push(...buckets[key]);
        }

        // תוקן: מיון מוחלט (Sort before Slice) לפי הסדר החדש: VIP > Res > Cached > Quality > Size
        let finalCandidates = [...vipStreams, ...standardResult];
        
        const standardBudget  = profile.maxResults - vipStreams.length;
        const missingSlots    = standardBudget - standardResult.length;

        if (missingSlots > 0 && fallbackStreams.length > 0) {
            finalCandidates.push(...fallbackStreams.slice(0, missingSlots));
        }

        console.log(`[ESAY DIAGNOSTIC - STREAM] ⚖️ מבצע מיון אבסולוטי על ${finalCandidates.length} תוצאות לפני חיתוך.`);
        
        finalCandidates.sort((a, b) => {
            const vipA = isVIPSource(a); const vipB = isVIPSource(b);
            if (vipA !== vipB) return vipA ? -1 : 1; // 1. VIP מנצח

            const rA = getResWeight(a); const rB = getResWeight(b);
            if (rA !== rB) return rB - rA; // 2. רזולוציה קובעת (4K > 1080p)

            const cA = isCached(a); const cB = isCached(b);
            if (cA !== cB) return cA ? -1 : 1; // 3. מטמון קובע (Cached > Uncached) בתוך אותה רזולוציה

            const qA = getQualityWeight(getTextForAnalysis(a)); const qB = getQualityWeight(getTextForAnalysis(b));
            if (qA !== qB) return qB - qA; // 4. איכות משנית (Remux > WebDL)

            if (!cA && !cB) {
                const sA = getSeeders(a) ?? 0; const sB = getSeeders(b) ?? 0;
                if (sA !== sB) return sB - sA; // 5. מספר סידרים חשוב ל-Uncached
            }

            return getSizeGB(b) - getSizeGB(a); // 6. גודל יכריע שובר שוויון (כבד יותר > קל יותר)
        });

        // החיתוך (Slice) מתבצע רק אחרי שהכל סודר למופת!
        let finalSliced = finalCandidates.slice(0, profile.maxResults);

        const REGEX_BRACKETS = /\[[^\]]*(torbox|tb\b|rd|ad|pm|cached|real-?debrid|all-?debrid|premiumize|elfhosted|elfcache)[^\]]*\]/gi;
        const REGEX_PARENS   = /\([^)]*(torbox|tb\b|rd|ad|pm|cached|real-?debrid|all-?debrid|premiumize|elfhosted|elfcache)[^)]*\)/gi;
        const REGEX_DOWNLOAD = /\[[^\]]*(download|⬇️)[^\]]*\]/gi;

        finalSliced = finalSliced.map((stream, index) => {
            const isVip       = isVIPSource(stream);
            const isC         = isCached(stream);
            const position    = index + 1;

            let cleanName = (stream.name || '').replace(REGEX_BRACKETS, '').replace(REGEX_PARENS, '').replace(REGEX_DOWNLOAD, '');
            cleanName = cleanName.replace(/\n+/g, ' ').replace(/^[\s\-\|]+|[\s\-\|]+$/g, '').replace(/\s{2,}/g, ' ').trim();
            let cleanTitle = (stream.title || '').replace(REGEX_DOWNLOAD, '').trim();

            let prefix = isVip ? 'מרשת דפדפן' : (isC ? 'זמין לצפייה' : 'דורש המתנה ואולי כניסה חוזרת');
            
            stream.name = `[#${position}] ${prefix} | ${cleanName}`;
            stream.title = `[#${position}]\n${cleanTitle}`;

            delete stream._sourceBaseUrl;
            return stream;
        });

        console.log(`[ESAY DIAGNOSTIC - STREAM] 🏁 סיום מוצלח. נשלחו ${finalSliced.length} סטרימים ללקוח!`);
        return res.status(200).json({ streams: finalSliced });
    } catch (error) { 
        console.error('[ESAY DIAGNOSTIC - STREAM] 💥 שגיאת קריסה כללית ב-Proxy:', error.stack || error);
        return res.status(500).json({ streams: [] }); 
    }
}
