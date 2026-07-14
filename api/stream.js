import fetch from 'node-fetch';

const PROFILES = {
    everything:    { maxResults: 30, maxSizeGB: Infinity, minSeedersUncached: 1, hasHDR: true, hasHDAudio: true, timeoutMs: 9500 },
    family:        { maxResults: 10, maxSizeGB: 30,       minSeedersUncached: 4, hasHDR: true, hasHDAudio: true, timeoutMs: 9150 },
    friends_light: { maxResults: 10, maxSizeGB: 30,       minSeedersUncached: 4, hasHDR: true, hasHDAudio: true, timeoutMs: 9150 },
    friends_heavy: { maxResults: 30, maxSizeGB: Infinity, minSeedersUncached: 3, hasHDR: true, hasHDAudio: true, timeoutMs: 9150 }
};

const REGEX_SIZE    = /(\d+(?:\.\d+)?)\s*(GB|MB)/i;
const REGEX_SEEDERS = /(?:👤|seeders?:?)\s*(\d+)/i;
const KNOWN_DISTRIBUTOR_PATTERN = /\b(wolf-?4k|not-?4kyet|team-?4k|group-?720p?|rd-?480|yify|rarbg|ettv|eztv|fgt|shaanig|galaxyrg|tigole|qxr)\b/gi;

function stripKnownDistributors(text) { return text.replace(KNOWN_DISTRIBUTOR_PATTERN, ' '); }

const RES_WEIGHT_MAP = {
    '4k': 4, '2160p': 4, 'uhd': 4,
    '1080p': 3, 'fhd': 3,
    '720p': 2, 'hdrip': 2,
    '480p': 1, 'sd': 1,
};
const REGEX_RES_ALL = /\b(4k|2160p|uhd|1080p|fhd|720p|hdrip|480p|sd)\b/gi;

function getTextForAnalysis(stream) {
    return ((stream.name || '') + ' ' + (stream.title || '') + ' ' + (stream.description || '')).toLowerCase();
}

function isCached(stream) {
    const text = getTextForAnalysis(stream);
    if (text.includes('download') || text.includes('⬇️')) return false;
    const hasCacheKeywords = /torbox|tb\b|comet|cached|rd\+?|elfhosted|elfcache|all-?debrid|\bad\b|\bad\+|premiumize|\bpm\b|debrid-?link|\bdl\b|stremthru/i.test(text);
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

function getResWeight(stream) {
    if (isVIPSource(stream) || stream.behaviorHints?.bingeGroup === 'live-tv') return 3;
    const rawText = getTextForAnalysis(stream);
    const cleanedText = stripKnownDistributors(rawText);
    const found = cleanedText.match(REGEX_RES_ALL);
    if (!found) {
        if (cleanedText.includes('remux') || cleanedText.includes('bluray')) return 3;
        return 0; 
    }
    const weights = [...new Set(found.map(tag => RES_WEIGHT_MAP[tag.toLowerCase()]))];
    if (weights.length === 1) return weights[0];
    return Math.max(...weights);
}

async function getMetaName(type, id) {
    try {
        const controller = new AbortController();
        const timeoutId  = setTimeout(() => controller.abort(), 2500);
        const response   = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${id}.json`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!response.ok) return null;
        const data = await response.json();
        return data.meta?.name || null;
    } catch (e) { return null; }
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
    console.log(`[ESAY DIAGNOSTIC - STREAM] 🕵️ Client IP: ${clientIp}`);

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

        if (type === 'tv' || type === 'channel') {
            const tvAddonUrl = process.env.TV_ADDON_URL;
            if (!tvAddonUrl) return res.status(200).json({ streams: [] });
            try {
                const cleanTvUrl = tvAddonUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
                const targetUrl  = `${cleanTvUrl}/stream/series/${idWithExt}`;
                console.log(`[ESAY DIAGNOSTIC - LIVE] 🚀 ניתוב ישיר לערוץ חי: ${targetUrl}`);
                const headers    = { 'User-Agent': clientUA, 'X-Forwarded-For': clientIp, 'Accept': 'application/json, text/plain, */*' };
                const tvRes      = await fetch(targetUrl, { headers, timeout: 9500 });
                if (tvRes.ok) {
                    const tvData = await tvRes.json();
                    console.log(`[ESAY DIAGNOSTIC - LIVE] ✅ התקבלו ${tvData.streams?.length || 0} סטרימים של ערוץ חי בהצלחה.`);
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
        
        console.log(`[ESAY DIAGNOSTIC - STREAM] ⚙️ פרופיל מוגדר: ${profileConfig} | תוספים לפניה: ${addons.length}`);
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
            // הוספת ה-IP רק עבור התוסף הספציפי שזקוק לו
            if (baseUrl.includes('kan-box-addon.vercel.app')) {
                fetchHeaders['X-Forwarded-For'] = clientIp;
            }  
            
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
            const baseId    = id.split(':')[0];
            const movieName = await getMetaName(type, baseId);
            if (movieName) {
                console.log(`[ESAY DIAGNOSTIC - STREAM] 🔎 מבצע חיפוש טקסטואלי נלווה עבור: "${movieName}"`);
                const textSearchPromises = addons.map(baseUrl => fetchFromAddon(baseUrl, `search=${encodeURIComponent(movieName)}.json`));
                promises = promises.concat(textSearchPromises);
            }
        }

        let allStreams = [];
        const trackPromises = promises.map(p => p.then(val => { if (Array.isArray(val)) allStreams = allStreams.concat(val); return val; }).catch(() => {}));
        await Promise.race([Promise.allSettled(trackPromises), new Promise(resolve => setTimeout(resolve, 5000))]);

        console.log(`[ESAY DIAGNOSTIC - STREAM] 📥 סה"כ סטרימים גולמיים שנאספו: ${allStreams.length}`);

        const sortedByWeightRaw = [...allStreams].sort((a,b) => getSizeGB(b) - getSizeGB(a));
        console.log(`[ESAY DIAGNOSTIC - STREAM] 🏋️‍♂️ 5 הסטרימים הכבדים ביותר שהתקבלו מהתוספים (לפני ניקוי):`);
        sortedByWeightRaw.slice(0, 5).forEach((s, i) => {
            const cleanT = s.title ? s.title.replace(/\n/g, ' ').substring(0, 35) : 'No Title';
            console.log(`   --> ${i+1}. המשקל: ${getSizeGB(s).toFixed(2)}GB | Source: ${s.name || 'Unknown'} | Title: ${cleanT}...`);
        });

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

        console.log(`[ESAY DIAGNOSTIC - STREAM] 🔄 אחרי Deduplication (מחיקת כפילויות): נותרו ${deduplicatedStreams.length} סטרימים יחודיים.`);

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

        console.log(`[ESAY DIAGNOSTIC - STREAM] ✂️ סינון פרופיל: נכנסו ל-Top Tier: ${topTierStreams.length} | נפלו ל-Fallback: ${fallbackStreams.length}`);

        const vipStreams      = [];
        const standardStreams = [];
        for (const stream of topTierStreams) {
            (isVIPSource(stream) ? vipStreams : standardStreams).push(stream);
        }

        console.log(`[ESAY DIAGNOSTIC - STREAM] ⭐ סיווג VIP (מרשת דפדפן): נמצאו ${vipStreams.length}. רגילים: ${standardStreams.length}`);

        const buckets = { '4k_c': [], '4k_u': [], '1080p_c': [], '1080p_u': [], '720p_c': [], '720p_u': [], 'sd_c': [], 'sd_u': [] };

        for (const s of standardStreams) {
            const isC = isCached(s); const rw = getResWeight(s); const sfx = isC ? '_c' : '_u';
            if (rw === 4) buckets[`4k${sfx}`].push(s);
            else if (rw === 3) buckets[`1080p${sfx}`].push(s);
            else if (rw === 2) buckets[`720p${sfx}`].push(s);
            else buckets[`sd${sfx}`].push(s);
        }

        console.log(`[ESAY DIAGNOSTIC - STREAM] 🪣 מצב דליים: 4k_c(${buckets['4k_c'].length}), 4k_u(${buckets['4k_u'].length}), 1080p_c(${buckets['1080p_c'].length}), 1080p_u(${buckets['1080p_u'].length})`);

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

        let cascade = 0;
        cascade = drawWithOverflow('4k', quotas['4k_c'] + cascade, quotas['4k_u']);
        cascade = drawWithOverflow('1080p', quotas['1080p_c'] + cascade, quotas['1080p_u']);
        cascade = drawWithOverflow('720p', quotas['720p_c'] + cascade, quotas['720p_u']);
        cascade = drawWithOverflow('sd', quotas['sd_c'] + cascade, quotas['sd_u']);

        console.log(`[ESAY DIAGNOSTIC - STREAM] 📊 נשאבו ${standardResult.length} סטרימים לפי חוקי המכסות. (חורים שנגררו: ${cascade})`);

        for (const key of Object.keys(buckets)) {
            if (buckets[key].length > 0) fallbackStreams.push(...buckets[key]);
        }

        const standardBudget  = profile.maxResults - vipStreams.length;
        const missingSlots    = standardBudget - standardResult.length;

        if (missingSlots > 0 && fallbackStreams.length > 0) {
            console.log(`[ESAY DIAGNOSTIC - STREAM] 🛡️ מפעיל רשת ביטחון: חסרים ${missingSlots} מקומות. שואב תוכן בצורה נאמנה לסדר הרזולוציות של הדליים.`);
            standardResult.push(...fallbackStreams.slice(0, missingSlots));
        }

        let finalSliced = [...vipStreams, ...standardResult].slice(0, profile.maxResults);

        console.log(`[ESAY DIAGNOSTIC - STREAM] ⚖️ מבצע מיון אבסולוטי ואחרון לפני שילוח על ${finalSliced.length} תוצאות סופיות.`);
        
        finalSliced.sort((a, b) => {
            const vipA = isVIPSource(a); const vipB = isVIPSource(b);
            if (vipA !== vipB) return vipA ? -1 : 1;

            const cA = isCached(a); const cB = isCached(b);
            if (cA !== cB) return cA ? -1 : 1;

            const rA = getResWeight(a); const rB = getResWeight(b);
            if (rA !== rB) return rB - rA;

            const qA = getQualityWeight(getTextForAnalysis(a)); const qB = getQualityWeight(getTextForAnalysis(b));
            if (qA !== qB) return qB - qA;

            if (!cA && !cB) {
                const sA = getSeeders(a) ?? 0; const sB = getSeeders(b) ?? 0;
                if (sA !== sB) return sB - sA;
            }

            return getSizeGB(b) - getSizeGB(a);
        });

        const REGEX_BRACKETS = /\[[^\]]*(torbox|tb\b|rd|ad|pm|cached|real-?debrid|all-?debrid|premiumize|elfhosted|elfcache)[^\]]*\]/gi;
        const REGEX_PARENS   = /\([^)]*(torbox|tb\b|rd|ad|pm|cached|real-?debrid|all-?debrid|premiumize|elfhosted|elfcache)[^)]*\)/gi;
        const REGEX_DOWNLOAD = /\[[^\]]*(download|⬇️)[^\]]*\]/gi;

        finalSliced = finalSliced.map((stream, index) => {
            const text        = getTextForAnalysis(stream);
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
