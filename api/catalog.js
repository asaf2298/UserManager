import fetch from 'node-fetch';

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}

let cachedTvCatalogIds = null;
let lastCacheTime = 0;

async function getTvCatalogIds(tvAddonUrl, headers) {
    if (!tvAddonUrl) return [];
    if (cachedTvCatalogIds && (Date.now() - lastCacheTime < 1000 * 60 * 60)) {
        return cachedTvCatalogIds;
    }
    try {
        const res = await fetchWithTimeout(`${tvAddonUrl}/manifest.json`, { headers }, 7500);
        if (!res.ok) return [];
        const manifest = await res.json();
        cachedTvCatalogIds = manifest.catalogs?.map(c => c.id) || [];
        lastCacheTime = Date.now();
        return cachedTvCatalogIds;
    } catch (e) {
        return [];
    }
}

async function getSearchCatalogId(baseUrl, type, headers) {
    try {
        const res = await fetchWithTimeout(`${baseUrl}/manifest.json`, { headers }, 7500);
        if (!res.ok) return null;
        const manifest = await res.json();
        const cat = manifest.catalogs?.find(c => c.type === type && c.extra?.some(e => e.name === 'search'));
        return cat ? cat.id : null;
    } catch { 
        return null; 
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const clientUA = req.headers['user-agent'] || 'Stremio/4.4.156';
    const forwardedIps = req.headers['x-forwarded-for'] || '';
    const clientIp = forwardedIps ? forwardedIps.split(',')[0].trim() : (req.socket?.remoteAddress || '');
    const fetchHeaders = { 'User-Agent': clientUA, 'X-Forwarded-For': clientIp };

    try {
        const urlParts = req.url.split('?')[0].split('/');
        const catIdx = urlParts.indexOf('catalog');
        if (catIdx < 1 || catIdx + 2 >= urlParts.length) return res.status(400).json({ metas: [] });

        const userKey = urlParts[catIdx - 1];
        const type = urlParts[catIdx + 1];
        const rawCatalogId = urlParts[catIdx + 2];
        const cleanCatalogId = rawCatalogId.replace('.json', '');
        const extraPart = urlParts.slice(catIdx + 3).join('/'); 
        
        console.log(`\n[ESAY CATALOG] 🔍 בקשת קטלוג חדשה: type=${type}, id=${cleanCatalogId}`);
        
        const configs = JSON.parse(process.env.USER_CONFIGS || '{}');
        const userConfig = configs[userKey] || {};
        const tvAddonUrl = (process.env.TV_ADDON_URL || '').replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
        const catalogBaseUrl = (userConfig.catalogBase || '').replace(/\/manifest\.json$/i, '').replace(/\/$/, '');

        if (cleanCatalogId.startsWith('esay_mixed_search') && extraPart.includes('search=')) {
            console.log(`[ESAY CATALOG] 🔎 מזהה בקשת חיפוש מאוחד! מנתב חיפושים ל-TV ו-AIO...`);
            const searchStartTime = Date.now();
            
            const [tvSearchId, aioSearchId] = await Promise.all([
                tvAddonUrl ? getSearchCatalogId(tvAddonUrl, type, fetchHeaders) : null,
                catalogBaseUrl ? getSearchCatalogId(catalogBaseUrl, type, fetchHeaders) : null
            ]);

            const searchPromises = [];
            if (tvSearchId) {
                searchPromises.push(fetchWithTimeout(`${tvAddonUrl}/catalog/${type}/${tvSearchId}/${extraPart}`, { headers: fetchHeaders }, 7500).then(r => r.ok ? r.json() : { metas: [] }).catch(() => ({ metas: [] })));
            }
            if (aioSearchId) {
                searchPromises.push(fetchWithTimeout(`${catalogBaseUrl}/catalog/${type}/${aioSearchId}/${extraPart}`, { headers: fetchHeaders }, 7500).then(r => r.ok ? r.json() : { metas: [] }).catch(() => ({ metas: [] })));
            }

            const results = await Promise.all(searchPromises);
            const combinedMetas = [];
            const seenIds = new Set();
            
            for (const result of results) {
                if (result && Array.isArray(result.metas)) {
                    for (const meta of result.metas) {
                        if (!seenIds.has(meta.id)) {
                            seenIds.add(meta.id);
                            combinedMetas.push(meta);
                        }
                    }
                }
            }
            const elapsed = Date.now() - searchStartTime;
            console.log(`[ESAY CATALOG] ✅ חיפוש מאוחד הסתיים תוך ${elapsed}ms. אוחדו ${combinedMetas.length} תוצאות.`);
            return res.status(200).json({ metas: combinedMetas });
        }

        let targetUrl = '';
        const tvCatalogIds = await getTvCatalogIds(tvAddonUrl, fetchHeaders);

        if ((type === 'tv' || type === 'channel') || tvCatalogIds.includes(cleanCatalogId)) {
            if (!tvAddonUrl) return res.status(404).json({ metas: [] });
            targetUrl = `${tvAddonUrl}/catalog/${type}/${rawCatalogId}${extraPart ? '/' + extraPart : ''}`;
        } else {
            if (!catalogBaseUrl) return res.status(404).json({ metas: [] });
            targetUrl = `${catalogBaseUrl}/catalog/${type}/${rawCatalogId}${extraPart ? '/' + extraPart : ''}`;
        }

        const catStartTime = Date.now();
        console.log(`[ESAY CATALOG] 🚀 ניתוב קטלוג ל: ${targetUrl}`);
        
        const fetchRes = await fetchWithTimeout(targetUrl, { headers: fetchHeaders }, 8000);
        if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}`);
        
        const data = await fetchRes.json();
        console.log(`[ESAY CATALOG] ✅ הקטלוג הוחזר בהצלחה תוך ${Date.now() - catStartTime}ms. פריטים: ${data.metas?.length || 0}`);
        return res.status(200).json(data);

    } catch (error) {
        console.error(`[ESAY CATALOG] ❌ שגיאת קטלוג: ${error.message}`);
        return res.status(200).json({ metas: [] });
    }
}
