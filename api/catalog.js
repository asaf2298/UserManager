import fetch from 'node-fetch';

let cachedTvCatalogIds = null;
let lastCacheTime = 0;

async function getTvCatalogIds(tvAddonUrl) {
    if (!tvAddonUrl) return [];
    if (cachedTvCatalogIds && (Date.now() - lastCacheTime < 1000 * 60 * 60)) {
        return cachedTvCatalogIds;
    }
    try {
        const res = await fetch(`${tvAddonUrl}/manifest.json`, { timeout: 4000 });
        if (!res.ok) return [];
        const manifest = await res.json();
        cachedTvCatalogIds = manifest.catalogs?.map(c => c.id) || [];
        lastCacheTime = Date.now();
        return cachedTvCatalogIds;
    } catch (e) {
        return [];
    }
}

async function getSearchCatalogId(baseUrl, type) {
    try {
        const res = await fetch(`${baseUrl}/manifest.json`, { timeout: 4000 });
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

    try {
        const urlParts = req.url.split('?')[0].split('/');
        const catIdx = urlParts.indexOf('catalog');
        if (catIdx < 1 || catIdx + 2 >= urlParts.length) return res.status(400).json({ metas: [] });

        const userKey = urlParts[catIdx - 1];
        const type = urlParts[catIdx + 1];
        const rawCatalogId = urlParts[catIdx + 2];
        const cleanCatalogId = rawCatalogId.replace('.json', '');
        const extraPart = urlParts.slice(catIdx + 3).join('/'); 
        
        console.log(`[ESAY CATALOG] 🔍 בקשה: type=${type}, id=${cleanCatalogId}, extra=${extraPart}`);
        
        const configs = JSON.parse(process.env.USER_CONFIGS || '{}');
        const userConfig = configs[userKey] || {};
        const tvAddonUrl = (process.env.TV_ADDON_URL || '').replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
        const catalogBaseUrl = (userConfig.catalogBase || '').replace(/\/manifest\.json$/i, '').replace(/\/$/, '');

        // 1. חיפוש מאוחד
        if (cleanCatalogId.startsWith('esay_mixed_search') && extraPart.includes('search=')) {
            console.log(`[ESAY CATALOG] 🔎 מזהה חיפוש מאוחד! מנתב ל-TV ו-AIO.`);
            const [tvSearchId, aioSearchId] = await Promise.all([
                tvAddonUrl ? getSearchCatalogId(tvAddonUrl, type) : null,
                catalogBaseUrl ? getSearchCatalogId(catalogBaseUrl, type) : null
            ]);

            const searchPromises = [];
            if (tvSearchId) {
                searchPromises.push(fetch(`${tvAddonUrl}/catalog/${type}/${tvSearchId}/${extraPart}`, { timeout: 5000 }).then(r => r.ok ? r.json() : { metas: [] }).catch(() => ({ metas: [] })));
            }
            if (aioSearchId) {
                console.log(`[ESAY CATALOG] 🚀 מבקש מ-AIO SEARCH: ${catalogBaseUrl}/catalog/${type}/${aioSearchId}/${extraPart}`);
                searchPromises.push(fetch(`${catalogBaseUrl}/catalog/${type}/${aioSearchId}/${extraPart}`, { timeout: 5000 }).then(r => r.ok ? r.json() : { metas: [] }).catch(() => ({ metas: [] })));
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
            console.log(`[ESAY CATALOG] ✅ נמצאו ${combinedMetas.length} תוצאות בחיפוש המאוחד.`);
            return res.status(200).json({ metas: combinedMetas });
        }

        // 2. ניתוב קטלוגים רגיל
        let targetUrl = '';
        const tvCatalogIds = await getTvCatalogIds(tvAddonUrl);

        if ((type === 'tv' || type === 'channel') || tvCatalogIds.includes(cleanCatalogId)) {
            if (!tvAddonUrl) return res.status(404).json({ metas: [] });
            targetUrl = `${tvAddonUrl}/catalog/${type}/${rawCatalogId}${extraPart ? '/' + extraPart : ''}`;
        } else {
            if (!catalogBaseUrl) return res.status(404).json({ metas: [] });
            targetUrl = `${catalogBaseUrl}/catalog/${type}/${rawCatalogId}${extraPart ? '/' + extraPart : ''}`;
        }

        console.log(`[ESAY CATALOG] 🚀 מנתב קטלוג רגיל ל: ${targetUrl}`);
        const fetchRes = await fetch(targetUrl, { timeout: 6000 });
        if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}`);
        
        const data = await fetchRes.json();
        console.log(`[ESAY CATALOG] ✅ התקבלה תגובה מהקטלוג. כמות פריטים: ${data.metas?.length || 0}`);
        return res.status(200).json(data);

    } catch (error) {
        console.error('Catalog Proxy Error:', error);
        return res.status(200).json({ metas: [] });
    }
}
