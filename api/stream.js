import fetch from 'node-fetch';
import { getCleanMovieName } from './search.js'; 

const PROFILES = {
    everything:    { maxResults: 30, maxSizeGB: Infinity, minSeedersUncached: 1, hasHDR: true, hasHDAudio: true, timeoutMs: 9000 },
    family:        { maxResults: 10, maxSizeGB: 30,       minSeedersUncached: 4, hasHDR: true, hasHDAudio: true, timeoutMs: 9000 },
    friends_light: { maxResults: 10, maxSizeGB: 30,       minSeedersUncached: 4, hasHDR: true, hasHDAudio: true, timeoutMs: 9000 },
    friends_heavy: { maxResults: 30, maxSizeGB: Infinity, minSeedersUncached: 3, hasHDR: true, hasHDAudio: true, timeoutMs: 9000 }
};

const MAX_VIP_SLOTS = 6;

const REGEX_SIZE    = /(\d+(?:[\.,]\d+)?)\s*(GB|MB)/i;
const REGEX_SEEDERS = /(?:👤|seeders?:?)\s*(\d+)/i;

const REGEX_BRACKETS = /\[[^\]]*\b(torbox|tb|rd\+?|ad\+?|pm|cached|real-?debrid|all-?debrid|premiumize|elfhosted|elfcache|comet)\b[^\]]*\]/gi;
const REGEX_PARENS   = /\([^)]*\b(torbox|tb|rd\+?|ad\+?|pm|cached|real-?debrid|all-?debrid|premiumize|elfhosted|elfcache|comet)\b[^)]*\)/gi;
const REGEX_DOWNLOAD = /\[[^\]]*(download|⬇️)[^\]]*\]/gi;

const RES_WEIGHT_MAP = {
    '4k': 4, '2160p': 4, 'uhd': 4,
    '1080p': 3, 'fhd': 3,
    '720p': 2, 'hdrip': 2,
    '480p': 1, 'sd': 1,
};

// ==========================================
// פונקציות עזר מבוססות Memoization לביצועים 
// ==========================================

function getTextForAnalysis(stream) {
    if (stream._text !== undefined) return stream._text;
    const fallbackText = stream.description || stream.behaviorHints?.filename || '';
    stream._text = ((stream.name || '') + ' ' + (stream.title || '') + ' ' + fallbackText).toLowerCase();
    return stream._text;
}

function checkCacheKeywords(text) {
    const isStrongDebrid = /torbox|elfhosted|elfcache|all-?debrid|real-?debrid|premiumize|debrid-?link|stremthru|\bcached\b/i.test(text);
    const hasBracketDebrid = /[\(\[][^\)\]]*\b(tb|rd\+?|ad\+?|pm|comet)\b[^\)\]]*[\)\]]/i.test(text);
    return isStrongDebrid || hasBracketDebrid;
}

function isUsenet(stream) {
    if (stream._isUsenet !== undefined) return stream._isUsenet;
    const text = getTextForAnalysis(stream);
    stream._isUsenet = text.includes('usenet') || text.includes('nzb');
    return stream._isUsenet;
}

function isCached(stream) {
    if (stream._isCached !== undefined) return stream._isCached;
    const text = getTextForAnalysis(stream);
    let res = false;
    
    if (text.includes('download') || text.includes('⬇️')) {
        res = false;
    } else {
        const hasCacheKeywords = checkCacheKeywords(text);
        if (isUsenet(stream)) res = hasCacheKeywords;
        else if (hasCacheKeywords) res = true;
        else if (stream.infoHash) res = false;
        else if (stream.url && (stream.url.startsWith('magnet:') || stream.url.toLowerCase().endsWith('.torrent') || stream.url.toLowerCase().endsWith('.nzb'))) res = false;
        else if (!stream.url) res = false;
        else if (stream.url.startsWith('http') || stream.url.startsWith('acestream')) res = true;
    }
    
    stream._isCached = res;
    return res;
}

function isVIPSource(stream) {
    if (stream._isVip !== undefined) return stream._isVip;
    const sourceUrl = (stream._sourceBaseUrl || '').toLowerCase();
    stream._isVip = sourceUrl.includes('kan-box-addon.vercel.app') || sourceUrl.includes('animeil');
    return stream._isVip;
}

function getSeeders(stream) {
    if (stream._seeders !== undefined) return stream._seeders;
    const match = getTextForAnalysis(stream).match(REGEX_SEEDERS);
    stream._seeders = match ? parseInt(match[1], 10) : null;
    return stream._seeders;
}

function getSizeGB(stream) {
    if (stream._sizeGB !== undefined) return stream._sizeGB;
    let size = 0;
    if (stream.behaviorHints?.videoSize) {
        size = stream.behaviorHints.videoSize / (1024 ** 3);
    } else if (stream.size) {
        size = stream.size / (1024 ** 3);
    } else {
        const match = getTextForAnalysis(stream).match(REGEX_SIZE);
        if (match) {
            const val = parseFloat(match[1].replace(',', '.'));
            size = match[2].toUpperCase() === 'MB' ? val / 1024 : val;
        }
    }
    stream._sizeGB = size;
    return size;
}

function getWeightTiers(streams) {
    if (!streams || streams.length === 0) return;
    
    // חלוקה לקבוצות לפי משקל הרזולוציה
    const resGroups = {};
    for (let i = 0; i < streams.length; i++) {
        const rw = getResWeight(streams[i]);
        if (!resGroups[rw]) resGroups[rw] = [];
        resGroups[rw].push(streams[i]);
    }
    
    // חישוב Tiers נפרד לחלוטין לכל רזולוציה
    for (const key in resGroups) {
        const group = resGroups[key];
        let minSize = Infinity;
        let maxSize = -Infinity;
        
        for (let i = 0; i < group.length; i++) {
            const size = getSizeGB(group[i]);
            if (size < minSize) minSize = size;
            if (size > maxSize) maxSize = size;
        }
        
        const range = maxSize - minSize;
        for (let i = 0; i < group.length; i++) {
            const s = group[i];
            if (range <= 0.3) { // אם הפער בקבוצה קטן מ-300MB, כולם זהים
                s._weightTier = 0;
            } else {
                const normalized = (s._sizeGB - minSize) / range;
                s._weightTier = Math.floor(normalized * 3.99); // 0 עד 3
            }
        }
    }
}

function getQualityWeight(stream) {
    if (stream._qualityWeight !== undefined) return stream._qualityWeight;
    const text = getTextForAnalysis(stream);
    let score = 0;
    if (text.includes('remux')) score = 4;
    else if (text.includes('bluray') || text.includes('bdrip') || text.includes('brrip')) score = 3;
    else if (text.includes('web-dl') || text.includes('webrip') || text.includes('web')) score = 2;
    else if (text.includes('hdtv') || text.includes('tvrip')) score = 1;
    stream._qualityWeight = score;
    return score;
}

function getResWeight(stream) {
    if (stream._resWeight !== undefined) return stream._resWeight;
    if (isVIPSource(stream) || stream.behaviorHints?.bingeGroup === 'live-tv') {
        stream._resWeight = 3;
        return 3;
    }
    
    const rawText = getTextForAnalysis(stream);
    let match;
    const found = [];
    const regexRes = /(?:^|[\s\[\(\.\-_])(4k|2160p|uhd|1080p|fhd|720p|hdrip|480p|sd)(?:[\s\]\)\.\-_]|$)/gi;
    
    while ((match = regexRes.exec(rawText)) !== null) {
        found.push(match[1].toLowerCase());
    }
    
    let weight = 0;
    if (found.length === 0) {
        if (rawText.includes('remux') || rawText.includes('bluray')) weight = 3;
    } else {
        const weights = [...new Set(found.map(tag => RES_WEIGHT_MAP[tag]))];
        weight = weights.length === 1 ? weights[0] : Math.max(...weights);
    }
    
    stream._resWeight = weight;
    return weight;
}

function getVisualWeight(stream) {
    if (stream._visualWeight !== undefined) return stream._visualWeight;
    const text = getTextForAnalysis(stream);
    let score = 0;
    if (/\b(dv|dovi|dolby vision|hdr|hdr10|hdr10\+)\b/i.test(text)) score += 2;
    if (/\b(hevc|x265|h265)\b/i.test(text)) score += 1;
    if (/\b10bit\b/i.test(text)) score += 1;
    stream._visualWeight = score;
    return score;
}

function getAudioWeight(stream) {
    if (stream._audioWeight !== undefined) return stream._audioWeight;
    const text = getTextForAnalysis(stream);
    let score = 1;
    if (/\b(atmos|eac3?|flac|truehd|dts-hd|dtsx)\b/i.test(text) || /\bdts[\s.-]?x\b/i.test(text)) score = 3;
    else if (/\b(dd5\.1|dd\+5\.1|5\.1|7\.1|aac5\.1)\b/i.test(text)) score = 2;
    stream._audioWeight = score;
    return score;
}

function getLanguageWeight(stream) {
    if (stream._langWeight !== undefined) return stream._langWeight;
    const text = getTextForAnalysis(stream);
    let score = 0;
    if (text.includes('heb') || text.includes('עברית')) score = 1;
    stream._langWeight = score;
    return score;
}

function getQualityScoreForPreSort(stream) {
    const weightTier = stream._weightTier || 0;
    return (getResWeight(stream) * 1000) + 
           (getQualityWeight(stream) * 100) + 
           (weightTier * 300) +
           (getVisualWeight(stream) * 10) + 
           getAudioWeight(stream);
}

function isDirectWebStream(stream) {
    const text = getTextForAnalysis(stream);
    const hasCacheKeywords = checkCacheKeywords(text);
    return !!(stream.url && 
             (stream.url.startsWith('http') || stream.url.startsWith('acestream')) && 
             !hasCacheKeywords && 
             !isUsenet(stream) && 
             !stream.infoHash);
}

// ==========================================
// ה-Handler המרכזי 
// ==========================================

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const forwardedIps = req.headers['x-forwarded-for'] || '';
    const clientIp = forwardedIps ? forwardedIps.split(',')[0].trim() : (req.socket?.remoteAddress || '');
    const clientUA = req.headers['user-agent'] || 'Stremio/4.4.156';

    try {
        const urlParts  = req.url.split('?')[0].split('/');
        const streamIdx = urlParts.indexOf('stream');
        if (streamIdx < 1 || streamIdx + 2 >= urlParts.length) return res.status(400).json({ streams: [] });

        const userKey = urlParts[streamIdx - 1];
        const type    = urlParts[streamIdx + 1];
        let rawIdWithExt = urlParts[streamIdx + 2];
        if (rawIdWithExt.includes('%')) rawIdWithExt = decodeURIComponent(rawIdWithExt);
        const idWithExt = rawIdWithExt;
        const id        = idWithExt.replace('.json', '');

        if (type === 'tv' || type === 'channel') {
            const tvAddonUrl = process.env.TV_ADDON_URL;
            if (!tvAddonUrl) return res.status(200).json({ streams: [] });
            try {
                const cleanTvUrl = tvAddonUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
                const targetUrl  = `${cleanTvUrl}/stream/${type}/${idWithExt}`;
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
                console.error(`[ESAY DIAGNOSTIC] 💥 שגיאה בשליפת ערוץ חי: ${e.message}`);
            }
            return res.status(200).json({ streams: [] });
        }

        const configs       = JSON.parse(process.env.USER_CONFIGS || '{}');
        const profileConfig = configs[userKey]?.profile || 'friends_light';
        const profile       = PROFILES[profileConfig] || PROFILES.friends_light;
        const addons        = (process.env.ADDON_URLS || '').split('|||').map(u => u.trim()).filter(Boolean);
        
        if (addons.length === 0) return res.status(200).json({ streams: [] });

        const fetchFromAddon = async (baseUrl, customIdWithExt = null) => {
            const controller = new AbortController();
            const timeoutId  = setTimeout(() => controller.abort(), profile.timeoutMs);
            const cleanBaseUrl = baseUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
            const finalIdWithExt = customIdWithExt || idWithExt;
            const targetUrl = `${cleanBaseUrl}/stream/${type}/${finalIdWithExt}`;
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

        const allStreams = [];
        // שימוש ב-push במקום concat לחסכון משמעותי בהקצאות זיכרון
        const trackPromises = promises.map(p => p.then(val => { 
            if (Array.isArray(val) && val.length > 0) allStreams.push(...val); 
            return val; 
        }).catch(() => {}));
        
        const INITIAL_WAIT_MS = 5500;
        await Promise.race([
            Promise.allSettled(trackPromises),
            new Promise(resolve => setTimeout(resolve, INITIAL_WAIT_MS))
        ]);

        if (allStreams.length < (profile.maxResults / 2)) {
            const remainingTime = profile.timeoutMs - INITIAL_WAIT_MS;
            if (remainingTime > 0) {
                await Promise.race([
                    Promise.allSettled(trackPromises),
                    new Promise(resolve => setTimeout(resolve, remainingTime))
                ]);
            }
        }

        const deduplicatedStreams = [];
        for (const stream of allStreams) {
            const sIsCached = isCached(stream);
            const sSize     = getSizeGB(stream);
            const sSeeders  = getSeeders(stream);
            const isDuplicate = deduplicatedStreams.some(existing => {
                if (sIsCached !== isCached(existing)) return false;    
                // 1. זיהוי URL זהה (לרוב קבצי דבריד מדויקים)
                if (stream.url && existing.url && stream.url === existing.url) return true;    
                // 2. זיהוי InfoHash זהה עם סטיית גודל קלה
                if (stream.infoHash && existing.infoHash && stream.infoHash === existing.infoHash) {
                    if (Math.abs(sSize - getSizeGB(existing)) * 1024 <= 5.0) return true;
                }
                // 3. כפילות קלאסית (שם זהה לחלוטין + משקל דומה)
                if (stream.title === existing.title && Math.abs(sSize - getSizeGB(existing)) * 1024 <= 1.0) return true;

                // 4. חומת אש נגד PACK/SPAM (כמו המקרה של Feibanyama)
                // אם יש להם אותם סידרים, אותה רזולוציה, וההתחלה של השם זהה לחלוטין
                const eSeeders = getSeeders(existing);
                if (sSeeders !== null && sSeeders === eSeeders && sSeeders > 0) {
                    const t1 = (stream.title || '').trim().substring(0, 25);
                    const t2 = (existing.title || '').trim().substring(0, 25);
                    if (t1 && t1 === t2 && getResWeight(stream) === getResWeight(existing)) {
                        return true;
                    }
                } 
                return false;
            });
            if (!isDuplicate) deduplicatedStreams.push(stream);
        }

        // חישוב דרגות משקל לפני המיון - ירוץ פעם אחת ב-$O(N)$
        getWeightTiers(deduplicatedStreams);

        deduplicatedStreams.sort((a, b) => {
            const scoreA = getQualityScoreForPreSort(a);
            const scoreB = getQualityScoreForPreSort(b);
            if (scoreA !== scoreB) return scoreB - scoreA;

            const sA = getSeeders(a) ?? 0; const sB = getSeeders(b) ?? 0;
            if (sA !== sB) return sB - sA;

            return getSizeGB(b) - getSizeGB(a);
        });

        const topTierStreams = [];
        const qualityRejected = [];
        for (const stream of deduplicatedStreams) {
            const sizeGB         = getSizeGB(stream);
            const isStreamCached = isCached(stream);
            const isStreamUsenet = isUsenet(stream);
            const seeders        = getSeeders(stream);
            let isTopTier = true;

            if (sizeGB > profile.maxSizeGB) isTopTier = false;
            if (!isStreamCached && !isStreamUsenet && seeders !== null && seeders < profile.minSeedersUncached) isTopTier = false;

            (isTopTier ? topTierStreams : qualityRejected).push(stream);
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
        
        const quotaOverflow = [];
        for (const key of Object.keys(buckets)) {
            if (buckets[key].length > 0) quotaOverflow.push(...buckets[key]);
        }

        const cappedVipStreams = vipStreams.slice(0, MAX_VIP_SLOTS);
        let finalCandidates = [...cappedVipStreams, ...standardResult];
        
        let missingSlots = profile.maxResults - finalCandidates.length;

        if (missingSlots > 0 && quotaOverflow.length > 0) {
            const taken = quotaOverflow.slice(0, missingSlots);
            finalCandidates.push(...taken);
            missingSlots -= taken.length;
        }
        if (missingSlots > 0 && qualityRejected.length > 0) {
            finalCandidates.push(...qualityRejected.slice(0, missingSlots));
        }
        // המיון הסופי עכשיו רץ באלפיות השנייה - הכל כבר חושב ונמצא בזיכרון!
        // המיון הסופי עם העדפת משקל מוחלטת בתוך אותה רזולוציה וסטטוס רשת
        // -----------------------------------------------------------------------------
        // 1. המיון הסופי המרכזי
        // -----------------------------------------------------------------------------
        /*finalCandidates.sort((a, b) => {
            const vipA = isVIPSource(a); const vipB = isVIPSource(b);
            if (vipA !== vipB) return vipA ? -1 : 1;
            
            const rA = getResWeight(a); const rB = getResWeight(b);
            if (rA !== rB) return rB - rA;

            const cA = isCached(a); const cB = isCached(b);
            if (cA !== cB) return cA ? -1 : 1;

            const wA = a._weightTier ?? 0; const wB = b._weightTier ?? 0;
            if (wA !== wB) return wB - wA;

            const qA = getQualityWeight(a); const qB = getQualityWeight(b);
            if (qA !== qB) return qB - qA;

            const vA = getVisualWeight(a); const vB = getVisualWeight(b);
            if (vA !== vB) return vB - vA;

            const aA = getAudioWeight(a); const aB = getAudioWeight(b);
            if (aA !== aB) return aB - aA;

            const lA = getLanguageWeight(a); const lB = getLanguageWeight(b);
            if (lA !== lB) return lB - lA;

            const sA = getSeeders(a) ?? 0; const sB = getSeeders(b) ?? 0;
            if (sA !== sB) return sB - sA;

            return getSizeGB(b) - getSizeGB(a);
        });*/

        // -----------------------------------------------------------------------------
        // 2. חומת מגן: סינון קריטי של ערכים פגומים או ריקים
        // -----------------------------------------------------------------------------
        let safeCandidates = finalCandidates.filter(stream => stream && (stream.url || stream.infoHash || stream.externalUrl));

        // -----------------------------------------------------------------------------
        // 3. מערכת שריון מקומות חכמה (Dynamic Allocation)
        // -----------------------------------------------------------------------------
        const isLargeProfile = profile.maxResults >= 30;
        const resCount = isLargeProfile ? 2 : 1;

        // חילוץ VIPs ראשונים כדי שלא יתערבבו בשאר הבריכות
        const nonVipStreams = safeCandidates.filter(s => !isVIPSource(s));
        
        const poolDirectWeb = [];
        const poolUncached4K = [];
        const poolUncached1080p = [];
        const poolMain = [];

        for (const stream of nonVipStreams) {
            // התיקון הקריטי: אם זה VIP, אנחנו מדלגים עליו כי כבר שמרנו אותו ב-vipStreams
            if (isVIPSource(stream)) continue;
            
            if (isDirectWebStream(stream)) {
                poolDirectWeb.push(stream);
            } else if (!isCached(stream) && !isVIPSource(stream)) {
                const resWeight = getResWeight(stream);
                if (resWeight === 4) poolUncached4K.push(stream);
                else if (resWeight === 3) poolUncached1080p.push(stream);
                else poolMain.push(stream);
            } else {
                poolMain.push(stream);
            }
        }

        const masterSortFunc = (a, b) => {
            const vipA = isVIPSource(a); const vipB = isVIPSource(b);
            if (vipA !== vipB) return vipA ? -1 : 1;
            const rA = getResWeight(a); const rB = getResWeight(b);
            if (rA !== rB) return rB - rA;
            const cA = isCached(a); const cB = isCached(b);
            if (cA !== cB) return cA ? -1 : 1;
            const wA = a._weightTier ?? 0; const wB = b._weightTier ?? 0;
            if (wA !== wB) return wB - wA;
            const qA = getQualityWeight(a); const qB = getQualityWeight(b);
            if (qA !== qB) return qB - qA;
            const vA = getVisualWeight(a); const vB = getVisualWeight(b);
            if (vA !== vB) return vB - vA;
            const aA = getAudioWeight(a); const aB = getAudioWeight(b);
            if (aA !== aB) return aB - aA;
            const lA = getLanguageWeight(a); const lB = getLanguageWeight(b);
            if (lA !== lB) return lB - lA;
            const sA = getSeeders(a) ?? 0; const sB = getSeeders(b) ?? 0;
            if (sA !== sB) return sB - sA;
            return getSizeGB(b) - getSizeGB(a);
        };

        poolUncached4K.sort(masterSortFunc);
        poolUncached1080p.sort(masterSortFunc);
        poolDirectWeb.sort(masterSortFunc);

        const reservedU4K = poolUncached4K.splice(0, resCount);
        const reservedU1080p = poolUncached1080p.splice(0, resCount);
        const reservedDirectWeb = poolDirectWeb.splice(0, resCount);

        const restToFill = [...poolMain, ...poolUncached4K, ...poolUncached1080p, ...poolDirectWeb];
        restToFill.sort(masterSortFunc);

        const currentReservedCount = reservedU4K.length + reservedU1080p.length + reservedDirectWeb.length;
        const remainingSlots = Math.max(0, profile.maxResults - currentReservedCount);
        const standardFill = restToFill.slice(0, remainingSlots);

        const combinedStandardAndUncached = [...standardFill, ...reservedU4K, ...reservedU1080p];
        combinedStandardAndUncached.sort(masterSortFunc);

        // שימוש במשתנה חדש וסופי שמרכז את הכל
        let finalSliced = [...cappedVipStreams, ...combinedStandardAndUncached, ...reservedDirectWeb];

       // -----------------------------------------------------------------------------
        // 4. עיצוב השמות (Map) וניקוי זיכרון וניטרול הגבלות צד-לקוח של סטרימיו
        // -----------------------------------------------------------------------------
        finalSliced = finalSliced.map((stream, index) => {
            const isVip       = isVIPSource(stream);
            const isC         = isCached(stream);
            const position    = index + 1;
            const isDirectWeb = isDirectWebStream(stream);

            let cleanName = (stream.name || '').replace(REGEX_BRACKETS, '').replace(REGEX_PARENS, '').replace(REGEX_DOWNLOAD, '');
            cleanName = cleanName.replace(/\n+/g, ' ').replace(/^[\s\-\|]+|[\s\-\|]+$/g, '').replace(/\s{2,}/g, ' ').trim();
            
            // משיכת כותרת מכל שדה זמין כדי למנוע העלמה על ידי סטרימיו עקב שדות ריקים
            let rawTitle = stream.title || stream.description || stream.behaviorHints?.filename || '';
            let cleanTitle = rawTitle.replace(REGEX_DOWNLOAD, '').replace(/\n+/g, '\n').trim();
            if (!cleanTitle) cleanTitle = cleanName || 'תוצאה ללא כותרת מהמקור';

            // בניית תחילית עם אזהרת תאימות לקבצים "כבדים"
            let prefix = (isVip || isDirectWeb) ? 'מרשת דפדפן' : (isC ? 'זמין לצפייה' : 'דורש המתנה ואולי כניסה חוזרת'); 
            // זיהוי הגבלת נגן לפני שאנחנו מוחקים אותה, והוספת אזהרה לטקסט
            if (stream.behaviorHints && stream.behaviorHints.notWebReady) {
                prefix += ' (לנגן תומך)';
            }   
            stream.name = `[#${position}] ${prefix} | ${cleanName}`;
            stream.title = cleanTitle;
            // --- מנטרל הגבלות פנימיות של ממשק סטרימיו ---
            if (stream.behaviorHints) {
                // חייבים למחוק כדי שסטרימיו-ווב יציג את התוצאה במקום להעלים אותה!
                delete stream.behaviorHints.notWebReady; 
                // מונע מסטרימיו לקבץ ולהסתיר תוצאות דומות
                delete stream.behaviorHints.bingeGroup;  
            }
            // מחיקת התיאור המקורי למקרה שסטרימיו משתמש בו לסינון כפילויות
            delete stream.description;
            
            // ניקוי המשתנים הפנימיים שלנו
            const keysToDelete = [
                '_sourceBaseUrl', '_text', '_sizeGB', '_isCached', '_isUsenet', 
                '_isVip', '_seeders', '_resWeight', '_qualityWeight', 
                '_visualWeight', '_audioWeight', '_langWeight', '_weightTier'
            ];
            keysToDelete.forEach(k => delete stream[k]);

            return stream;
        });

        // -----------------------------------------------------------------------------
        // 5. מערכת דיאגנוסטיקה ובקרת איכות - הלוג!
        // -----------------------------------------------------------------------------
        console.log(`\n[ESAY DIAGNOSTIC] 📊 רשימת ה-${finalSliced.length} הסופית שנשלחת לסטרימיו:`);
        
        const hashTracker = new Set();
        let invisibleDrops = 0;

        finalSliced.forEach((s, index) => {
            const statusTag = s.name.includes('זמין לצפייה') ? '🟩 CACHED  ' : (s.name.includes('דפדפן') ? '🟪 VIP/WEB ' : '🟥 UNCACHED');
            
            let linkType = 'UNKNOWN';
            if (s.url) linkType = 'URL';
            else if (s.infoHash) linkType = `HASH:${s.infoHash.substring(0, 8)}...`;
            else if (s.externalUrl) linkType = 'EXTERNAL';

            let warning = '';
            if (s.infoHash) {
                const normalizedHash = s.infoHash.toLowerCase();
                if (hashTracker.has(normalizedHash)) {
                    warning = ' ⚠️ [STREMIO WILL HIDE THIS - DUPLICATE HASH]';
                    invisibleDrops++;
                }
                hashTracker.add(normalizedHash);
            }

            const displayTitle = (s.title || '').replace(/\n/g, ' ').substring(0, 60);
            console.log(`[#${index + 1}] | ${statusTag} | ${linkType} | ${displayTitle}${warning}`);
        });

        if (invisibleDrops > 0) {
            console.log(`[ESAY DIAGNOSTIC] 🚨 אזהרה: יש ${invisibleDrops} כפילויות InfoHash ברשימה! סטרימיו יציג בפועל רק ${finalSliced.length - invisibleDrops} תוצאות.`);
        }
        console.log(`[ESAY DIAGNOSTIC] 🏁 סיום מוצלח. נשלחו ${finalSliced.length} תוצאות.\n--------------------------------------------------\n`);

        // -----------------------------------------------------------------------------
        // 6. שליחת התשובה הסופית
        // -----------------------------------------------------------------------------
        return res.status(200).json({ streams: finalSliced });

    } catch (error) { 
        console.error('[ESAY DIAGNOSTIC] 💥 שגיאת קריסה כללית ב-Proxy:', error.stack || error);
        return res.status(200).json({ streams: [] }); 
    }
}
