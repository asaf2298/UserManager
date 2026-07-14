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

function stripKnownDistributors(text) {
    return text.replace(KNOWN_DISTRIBUTOR_PATTERN, ' ');
}

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
    if (stream.size)                      return stream.size / (1024 ** 3);
    const match = getTextForAnalysis(stream).match(REGEX_SIZE);
    if (!match) return 0;
    const val = parseFloat(match[1]);
    return match[2].toUpperCase() === 'MB' ? val / 1024 : val;
}

function getQualityWeight(text) {
    if (text.includes('remux'))                                                  return 4;
    if (text.includes('bluray') || text.includes('bdrip') || text.includes('brrip')) return 3;
    if (text.includes('web-dl') || text.includes('webrip') || text.includes('web'))  return 2;
    if (text.includes('hdtv') || text.includes('tvrip'))                         return 1;
    return 0;
}

function getResWeight(stream) {
    if (isVIPSource(stream) || stream.behaviorHints?.bingeGroup === 'live-tv') return 3;

    const rawText = getTextForAnalysis(stream);
    const cleanedText = stripKnownDistributors(rawText);

    const found = cleanedText.match(REGEX_RES_ALL);
    if (!found) {
        // רשת ביטחון ל-Usenet/Remux: נותן משקל של 1080p לאיכויות גבוהות שלא ציינו רזולוציה
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
    } catch (e) {
        return null;
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    console.log(`[ESAY DIAGNOSTIC - STREAM] 🟢 בקשת סטרים נכנסת: ${req.url}`);

    // תיקון IP: חילוץ ה-IP הראשון בלבד (של הלקוח) למניעת שגיאת 403 בלייב VOD
    const forwardedIps = req.headers['x-forwarded-for'] || '';
    const clientIp = forwardedIps ? forwardedIps.split(',')[0].trim() : (req.socket?.remoteAddress || '');
    const clientUA = req.headers['user-agent'] || 'Stremio/4.4.156';

    try {
        const urlParts  = req.url.split('?')[0].split('/');
        const streamIdx = urlParts.indexOf('stream');
        if (streamIdx < 1 || streamIdx + 2 >= urlParts.length) {
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
                const headers    = { 'User-Agent': clientUA, 'X-Forwarded-For': clientIp, 'Accept': 'application/json, text/plain, */*' };
                const tvRes      = await fetch(targetUrl, { headers, timeout: 9500 });
                if (tvRes.ok) {
                    const tvData = await tvRes.json();
                    return res.status(200).json(tvData);
                }
            } catch (e) {
                console.error('[ESAY DIAGNOSTIC - LIVE] 💥 שגיאה בערוץ חי:', e);
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
            const targetUrl    = `${cleanBaseUrl}/stream/${forwardType}/${finalIdWithExt}`;
            const fetchHeaders = { 'User-Agent': clientUA, 'X-Forwarded-For': clientIp };
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
                const textSearchPromises = addons.map(baseUrl => fetchFromAddon(baseUrl, `search=${encodeURIComponent(movieName)}.json`));
                promises = promises.concat(textSearchPromises);
            }
        }

        let allStreams = [];
        const trackPromises = promises.map(p =>
            p.then(val => { if (Array.isArray(val)) allStreams = allStreams.concat(val); return val; }).catch(() => {})
        );
        await Promise.race([Promise.allSettled(trackPromises), new Promise(resolve => setTimeout(resolve, 5000))]);

        const deduplicatedStreams = [];
        for (const stream of allStreams) {
            const sIsCached = isCached(stream);
            const sSize     = getSizeGB(stream);
            const isDuplicate = deduplicatedStreams.some(existing => {
                if (sIsCached !== isCached(existing)) return false;
                if (sIsCached) {
                    return stream.url && existing.url && stream.url === existing.url;
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

        const buckets = {
            '4k_c': [], '4k_u': [],
            '1080p_c': [], '1080p_u': [],
            '720p_c': [], '720p_u': [],
            'sd_c': [], 'sd_u': []
        };

        for (const s of standardStreams) {
            const isC  = isCached(s);
            const rw   = getResWeight(s);
            const sfx  = isC ? '_c' : '_u';
            if      (rw === 4) buckets[`4k${sfx}`].push(s);
            else if (rw === 3) buckets[`1080p${sfx}`].push(s);
            else if (rw === 2) buckets[`720p${sfx}`].push(s);
            else               buckets[`sd${sfx}`].push(s);
        }

        for (const key of Object.keys(buckets)) {
            const isCachedBucket = key.endsWith('_c');
            buckets[key].sort((a, b) => {
                const qA = getQualityWeight(getTextForAnalysis(a));
                const qB = getQualityWeight(getTextForAnalysis(b));
                if (qA !== qB) return qB - qA;

                // תיקון Seeders: בדלי שהוא Cached (כמו Usenet) אנו מתעלמים מה-Seeders לחלוטין.
                if (!isCachedBucket) {
                    const seedA = getSeeders(a) ?? 0;
                    const seedB = getSeeders(b) ?? 0;
                    if (seedA !== seedB) return seedB - seedA;
                }

                return getSizeGB(b) - getSizeGB(a);
            });
        }

        const isBigProfile = (profileConfig === 'everything' || profileConfig === 'friends_heavy');
        const quotas = isBigProfile
            ? { '4k_c': 12, '4k_u': 3, '1080p_c': 6, '1080p_u': 2, '720p_c': 3, '720p_u': 1, 'sd_c': 2, 'sd_u': 1 }
            : { '4k_c':  3, '4k_u': 1, '1080p_c': 3, '1080p_u': 1, '720p_c': 2, '720p_u': 0, 'sd_c': 0, 'sd_u': 0 };

        const standardResult = [];

        function drawWithOverflow(resLevel, qC, qU) {
            const pulledC   = buckets[`${resLevel}_c`].splice(0, qC);
            standardResult.push(...pulledC);
            const missingC  = qC - pulledC.length;

            const targetU   = qU + missingC;
            const pulledU   = buckets[`${resLevel}_u`].splice(0, targetU);
            standardResult.push(...pulledU);
            let missing     = targetU - pulledU.length;

            if (missing > 0 && buckets[`${resLevel}_c`].length > 0) {
                const extraC = buckets[`${resLevel}_c`].splice(0, missing);
                standardResult.push(...extraC);
                missing -= extraC.length;
            }

            return missing;
        }

        let cascade = 0;
        cascade = drawWithOverflow('4k',    quotas['4k_c']    + cascade, quotas['4k_u']);
        cascade = drawWithOverflow('1080p', quotas['1080p_c'] + cascade, quotas['1080p_u']);
        cascade = drawWithOverflow('720p',  quotas['720p_c']  + cascade, quotas['720p_u']);
        cascade = drawWithOverflow('sd',    quotas['sd_c']    + cascade, quotas['sd_u']);

        for (const key of Object.keys(buckets)) {
            if (buckets[key].length > 0) {
                fallbackStreams.push(...buckets[key]);
                buckets[key] = [];
            }
        }

        const standardBudget  = profile.maxResults - vipStreams.length;
        const missingSlots    = standardBudget - standardResult.length;

        if (missingSlots > 0 && fallbackStreams.length > 0) {
            fallbackStreams.sort((a, b) => {
                const rA = getResWeight(a); const rB = getResWeight(b);
                if (rA !== rB) return rB - rA;

                const qA = getQualityWeight(getTextForAnalysis(a));
                const qB = getQualityWeight(getTextForAnalysis(b));
                if (qA !== qB) return qB - qA;

                const cA = isCached(a); const cB = isCached(b);
                if (cA !== cB) return cA ? -1 : 1;

                // תיקון Seeders גם בפולבק
                if (!cA && !cB) {
                    const seedA = getSeeders(a) ?? 0;
                    const seedB = getSeeders(b) ?? 0;
                    if (seedA !== seedB) return seedB - seedA;
                }

                return getSizeGB(b) - getSizeGB(a);
            });

            standardResult.push(...fallbackStreams.slice(0, missingSlots));
        }

        let finalSliced = [...vipStreams, ...standardResult].slice(0, profile.maxResults);

        const REGEX_BRACKETS = /\[[^\]]*(torbox|tb\b|rd|ad|pm|cached|real-?debrid|all-?debrid|premiumize|elfhosted|elfcache)[^\]]*\]/gi;
        const REGEX_PARENS   = /\([^)]*(torbox|tb\b|rd|ad|pm|cached|real-?debrid|all-?debrid|premiumize|elfhosted|elfcache)[^)]*\)/gi;
        const REGEX_DOWNLOAD = /\[[^\]]*(download|⬇️)[^\]]*\]/gi;

        const labelCounters = { vip: 0, cached: 0, uncached: 0 };

        finalSliced = finalSliced.map(stream => {
            const text        = getTextForAnalysis(stream);
            const isVip       = isVIPSource(stream);
            const isC         = isCached(stream);
            const hasDebridTag = /rd\+?|torbox|tb\b|comet|ad\+?|pm\+?|cached|real-?debrid|premiumize|elfhosted|elfcache|all-?debrid|stremthru/i.test(text);

            let cleanName = (stream.name || '').replace(REGEX_BRACKETS, '').replace(REGEX_PARENS, '').replace(REGEX_DOWNLOAD, '');
            cleanName = cleanName.replace(/\n+/g, ' ').replace(/^[\s\-\|]+|[\s\-\|]+$/g, '').replace(/\s{2,}/g, ' ').trim();

            // תיקון קיבוץ בסטרימיו (Grouping): לא מוחקים תגיות דבריד מהטייטל
            let cleanTitle = (stream.title || '').replace(REGEX_DOWNLOAD, '').trim();

            if (isVip || (stream.url && !stream.infoHash && !hasDebridTag)) {
                labelCounters.vip += 1;
                stream.name = cleanName ? `מרשת דפדפן #${labelCounters.vip} | ${cleanName}` : `מרשת דפדפן #${labelCounters.vip}`;
            } else {
                if (isC) {
                    labelCounters.cached += 1;
                    stream.name = cleanName ? `זמין לצפייה #${labelCounters.cached} | ${cleanName}` : `זמין לצפייה #${labelCounters.cached}`;
                } else {
                    labelCounters.uncached += 1;
                    stream.name = cleanName ? `דורש המתנה ואולי כניסה חוזרת #${labelCounters.uncached} | ${cleanName}` : `דורש המתנה ואולי כניסה חוזרת #${labelCounters.uncached}`;
                }
            }
            stream.title = cleanTitle;

            delete stream._sourceBaseUrl;
            return stream;
        });

        return res.status(200).json({ streams: finalSliced });

    } catch (error) {
        console.error('Stream Proxy Error:', error);
        return res.status(500).json({ streams: [] });
    }
}
