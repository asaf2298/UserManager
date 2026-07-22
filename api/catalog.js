import fetch from 'node-fetch';
import { debugLog } from '../lib/debugLog.js';

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
let activeManifestFetch = null; // 🟢 התוספת שלנו: שומר על הבקשה כדי שכל שאר הבקשות המקבילות "ירכבו" עליה

// הלוגיקה המקורית והדינמית שלך נשארת!
async function getTvCatalogIds(tvAddonUrl, headers) {
    if (!tvAddonUrl) return [];
    
    // אם יש קאש חם מהשעה האחרונה - נחזיר מיד
    if (cachedTvCatalogIds && (Date.now() - lastCacheTime < 1000 * 60 * 60)) {
        return cachedTvCatalogIds;
    }
    
    // 🟢 אם כבר יש בקשה באוויר למניפסט (בגלל שסטרימיו טוען את כל ה-Board במקביל) - נמתין לה!
    if (activeManifestFetch) {
        return await activeManifestFetch;
    }

    // מוציאים בקשה אחת בודדת, ושומרים אותה במשתנה שכולם רואים
    activeManifestFetch = (async () => {
        try {
            const res = await fetchWithTimeout(`${tvAddonUrl}/manifest.json`, { headers }, 7500);
            if (!res.ok) return [];
            const manifest = await res.json();
            cachedTvCatalogIds = manifest.catalogs?.map(c => c.id) || [];
            lastCacheTime = Date.now();
            return cachedTvCatalogIds;
        } catch (e) {
            return [];
        } finally {
            activeManifestFetch = null; // מנקים בסיום כדי שבקשות עתידיות (בעוד שעה) יעבדו רגיל
        }
    })();

    return await activeManifestFetch;
}

// פונקציה משודרגת: שולפת את כל הקטלוגים שתומכים בחיפוש + שומרת את ה-Type המקורי
async function getSearchCatalogs(baseUrl, type, headers) {
    try {
        const res = await fetchWithTimeout(`${baseUrl}/manifest.json`, { headers }, 7500);
        if (!res.ok) return [];
        const manifest = await res.json();
        
        // טריק האנימה: אם חיפשו סדרה, נמשוך גם קטלוגים של אנימה
        const targetTypes = type === 'series' ? ['series', 'anime'] : [type];
        
        const catalogs = manifest.catalogs?.filter(c => 
            targetTypes.includes(c.type) && c.extra?.some(e => e.name === 'search')
        );
        
        // מחזיר מערך של אובייקטים כדי לשמור על ה-type הייעודי של כל קטלוג
        return catalogs ? catalogs.map(c => ({ id: c.id, type: c.type })) : [];
    } catch { 
        return []; 
    }
}

export default async function handler(req, res) {
    // מניעת שמירת קטלוג ריק בזיכרון של Vercel
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const clientUA = req.headers['user-agent'] || 'Stremio/4.4.156';
    const forwardedIps = req.headers['x-forwarded-for'] || '';
    const clientIp = forwardedIps ? forwardedIps.split(',')[0].trim() : (req.socket?.remoteAddress || '');
    
    // Same header set as manifest/meta — AIOMETADATA often requires X-Forwarded-For
    const proxyHeaders = { 'User-Agent': clientUA, 'X-Forwarded-For': clientIp };

    try {
        const urlParts = req.url.split('?')[0].split('/');
        const catIdx = urlParts.indexOf('catalog');
        if (catIdx < 1 || catIdx + 2 >= urlParts.length) return res.status(400).json({ metas: [] });

        const userKey = urlParts[catIdx - 1];
        const reqType = urlParts[catIdx + 1];
        const rawCatalogId = urlParts[catIdx + 2];
        const cleanCatalogId = rawCatalogId.replace('.json', '');
        const extraPart = urlParts.slice(catIdx + 3).join('/'); 
        
        const configs = JSON.parse(process.env.USER_CONFIGS || '{}');
        const userConfig = configs[userKey] || {};
        const tvAddonUrl = (process.env.TV_ADDON_URL || '').replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
        const catalogBaseUrl = (userConfig.catalogBase || '').replace(/\/manifest\.json$/i, '').replace(/\/$/, '');

        // ==========================================
        // 1. טיפול בחיפוש מעורב (Mixed Search)
        // ==========================================
        if (cleanCatalogId.startsWith('esay_mixed_search') && extraPart.includes('search=')) {
            const [tvSearchCatalogs, aioSearchCatalogs] = await Promise.all([
                tvAddonUrl ? getSearchCatalogs(tvAddonUrl, reqType, proxyHeaders) : Promise.resolve([]),
                catalogBaseUrl ? getSearchCatalogs(catalogBaseUrl, reqType, proxyHeaders) : Promise.resolve([])
            ]);

            const searchPromises = [];

            // שליחת בקשות חיפוש לאד-און הישראלי (מאקו, דרגון בול וכו')
            for (const cat of tvSearchCatalogs) {
                searchPromises.push(
                    fetchWithTimeout(`${tvAddonUrl}/catalog/${cat.type}/${cat.id}/${extraPart}`, { headers: proxyHeaders }, 7500)
                        .then(r => r.ok ? r.json() : { metas: [] })
                        .catch(() => ({ metas: [] }))
                );
            }

            // שליחת בקשות חיפוש ל-AIO (כולל YukiStreams עם Type מותאם)
            for (const cat of aioSearchCatalogs) {
                searchPromises.push(
                    fetchWithTimeout(`${catalogBaseUrl}/catalog/${cat.type}/${cat.id}/${extraPart}`, { headers: proxyHeaders }, 7500)
                        .then(r => r.ok ? r.json() : { metas: [] })
                        .catch(() => ({ metas: [] }))
                );
            }

            const results = await Promise.all(searchPromises);
            const combinedMetas = [];
            const seenIds = new Set();
            
            // איחוד תוצאות וסינון כפילויות (לפי meta.id)
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
            return res.status(200).json({ metas: combinedMetas });
        }

        // ==========================================
        // 2. ניתוב קטלוגים רגיל (הגנה על דרגון בול)
        // ==========================================
        let targetUrl = '';
        let requestHeaders = proxyHeaders;
        const tvCatalogIds = await getTvCatalogIds(tvAddonUrl, proxyHeaders);

        const isDbzCatalog = cleanCatalogId.startsWith('dbz_');

        if ((reqType === 'tv' || reqType === 'channel') || isDbzCatalog || tvCatalogIds.includes(cleanCatalogId)) {
            if (!tvAddonUrl) return res.status(404).json({ metas: [] });
            targetUrl = `${tvAddonUrl}/catalog/${reqType}/${rawCatalogId}${extraPart ? '/' + extraPart : ''}`;
            requestHeaders = proxyHeaders;
        } else {
            if (!catalogBaseUrl) return res.status(404).json({ metas: [] });
            targetUrl = `${catalogBaseUrl}/catalog/${reqType}/${rawCatalogId}${extraPart ? '/' + extraPart : ''}`;
        }

        // #region agent log
        debugLog('H2', 'api/catalog.js:proxy', 'catalog proxy attempt', {
            userKey,
            cleanCatalogId,
            reqType,
            branch: ((reqType === 'tv' || reqType === 'channel') || isDbzCatalog || tvCatalogIds.includes(cleanCatalogId)) ? 'tv' : 'aio',
            targetHost: targetUrl.split('/').slice(0, 3).join('/'),
            hasXff: !!requestHeaders['X-Forwarded-For']
        });
        // #endregion
        
        const fetchRes = await fetchWithTimeout(targetUrl, { headers: requestHeaders }, 8000);
        if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}`);
        
        const data = await fetchRes.json();
        // #region agent log
        debugLog('H2', 'api/catalog.js:proxy', 'catalog proxy ok', {
            cleanCatalogId,
            metasLength: Array.isArray(data?.metas) ? data.metas.length : -1,
            upstreamStatus: fetchRes.status
        });
        // #endregion
        return res.status(200).json(data);

    } catch (error) {
        console.error(`[ESAY CATALOG PROXY ERROR]: ${error.message}`);
        // #region agent log
        debugLog('H2', 'api/catalog.js:error', 'catalog proxy error', { err: String(error.message || error) });
        // #endregion
        return res.status(200).json({ metas: [] });
    }
}
