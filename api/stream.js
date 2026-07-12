import fetch from 'node-fetch';

const PROFILES = {
    everything: { maxResults: 25, maxSizeGB: Infinity, minSeedersUncached: 1, hasHDR: true, hasHDAudio: true, timeoutMs: 8500 },
    family: { maxResults: 7, maxSizeGB: 30, minSeedersUncached: 5, hasHDR: true, hasHDAudio: true, timeoutMs: 4000 },
    friends_light: { maxResults: 7, maxSizeGB: 30, minSeedersUncached: 5, hasHDR: true, hasHDAudio: true, timeoutMs: 3000 },
    friends_heavy: { maxResults: 25, maxSizeGB: Infinity, minSeedersUncached: 5, hasHDR: true, hasHDAudio: true, timeoutMs: 8500 }
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
    return text.includes('torbox+') || text.includes('cached') || text.includes('rd+') || (stream.url && stream.url.startsWith('http'));
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
    return match ? parseInt(match[1], 10) : 0;
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
                const targetUrl = `${tvAddonUrl.replace(/\/$/, '')}/stream/${type}/${idWithExt}`;
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
        
        // פיצול לפי מפריד ||| החדש
        const addons = (process.env.ADDON_URLS || '').split('|||').map(u => u.trim()).filter(Boolean);[cite: 1]
        if (addons.length === 0) return res.status(200).json({ streams: [] });

        // שליפה מופרדת, מקבילית ומנוטרת בזמנים[cite: 1]
        const fetchFromAddon = async (baseUrl) => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), profile.timeoutMs); 

            const targetUrl = `${baseUrl.replace(/\/$/, '')}/stream/${type}/${idWithExt}`;
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
                    data.streams.forEach(s => s._sourceBaseUrl = baseUrl);[cite: 1]
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

        const promises = addons.map(baseUrl => fetchFromAddon(baseUrl));
        const settledResults = await Promise.allSettled(promises);
        
        let allStreams = [];
        for (const r of settledResults) {
            if (r.status === 'fulfilled' && Array.isArray(r.value)) {
                allStreams = allStreams.concat(r.value);
            }
        }

        const uniqueStreamsMap = new Map();
        for (const stream of allStreams) {
            const key = stream.infoHash || stream.url || stream.title;
            if (!uniqueStreamsMap.has(key)) {
                uniqueStreamsMap.set(key, stream);
            }
        }
        let filteredStreams = Array.from(uniqueStreamsMap.values());

        filteredStreams = filteredStreams.filter(stream => {
            const isStreamCached = isCached(stream);
            const isStreamUsenet = isUsenet(stream);
            const seeders = getSeeders(stream);
            const sizeGB = getSizeGB(stream);
            const text = getTextForAnalysis(stream);

            if (!isStreamCached && !isStreamUsenet && seeders === 0) return false;
            if (sizeGB > profile.maxSizeGB) return false;
            if (!isStreamCached && !isStreamUsenet && seeders < profile.minSeedersUncached) return false;

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
                return cachedA === cachedB ? 0 : (cachedA ? 1 : -1);
            }
            
            if (profileConfig === 'friends_heavy') {
                if (qA !== qB) return qB - qA;
                if (usenetA !== usenetB) return usenetA ? -1 : 1;
                if (resA !== resB) return resB - resA;
                if (sizeA !== sizeB) return sizeB - sizeA;
                return cachedA === cachedB ? 0 : (cachedA ? 1 : -1); 
            }

            if (cachedA !== cachedB) return cachedA ? -1 : 1;
            if (usenetA !== usenetB) return usenetA ? -1 : 1;
            if (qA !== qB) return qB - qA;
            return resB - resA;
        });

        filteredStreams = filteredStreams.map(stream => {
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

        return res.status(200).json({ streams: filteredStreams.slice(0, profile.maxResults) });

    } catch (error) {
        console.error('Stream Proxy Error:', error);
        return res.status(500).json({ streams: [] });
    }
}
