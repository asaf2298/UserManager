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
// excludeTypes: optional array of types to exclude (used by the "complete" search)
const _manifestCache = new Map();
async function getCachedManifest(baseUrl, headers) {
    const cached = _manifestCache.get(baseUrl);
    if (cached && Date.now() - cached.ts < 60_000) return cached.manifest;
    try {
        const res = await fetchWithTimeout(`${baseUrl}/manifest.json`, { headers }, 7500);
        if (!res.ok) return null;
        const manifest = await res.json();
        _manifestCache.set(baseUrl, { manifest, ts: Date.now() });
        return manifest;
    } catch {
        return null;
    }
}

function isVipSearchHost(url) {
    const u = (url || '').toLowerCase();
    return u.includes('kan-box-addon.vercel.app') || u.includes('animeil');
}

// Returns [{ id, type, baseUrl }, ...] — baseUrl is needed so the caller
// knows which host to send the actual catalog/search request to.
async function getSearchCatalogs(baseUrl, type, headers, excludeTypes = null) {
    try {
        const manifest = await getCachedManifest(baseUrl, headers);
        if (!manifest) return [];

        let catalogs;
        if (excludeTypes) {
            // "complete" mode: all searchable types EXCEPT the excluded ones
            // (anime / tv / channel / … — VIP + anime live here)
            catalogs = manifest.catalogs?.filter(c =>
                !excludeTypes.includes(c.type) && c.extra?.some(e => e.name === 'search')
            );
        } else {
            // Movie/series mixed search: exact type only (no anime/tv/channel bleed)
            catalogs = manifest.catalogs?.filter(c =>
                c.type === type && c.extra?.some(e => e.name === 'search')
            );
        }

        return catalogs ? catalogs.map(c => ({ id: c.id, type: c.type, baseUrl })) : [];
    } catch {
        return [];
    }
}

// Collects search-capable catalogs from every addon that supports catalog search
// (TV addon + all ADDON_URLS), excluding the user's catalogBase (aiometadata) since
// it manages its own search entries in our manifest.
// includeVip: when false (movie/series חיפוש משולב), skip TV_ADDON / AnimeIL hosts.
async function getAllSearchCatalogs(tvAddonUrl, addonUrls, catalogBaseUrl, reqType, proxyHeaders, excludeTypes = null, includeVip = true) {
    // Every URL except catalogBase is a candidate; normalise them first
    const cleanCatalogBase = catalogBaseUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
    const sources = [
        ...(includeVip && tvAddonUrl ? [tvAddonUrl] : []),
        ...addonUrls
            .map(u => u.replace(/\/manifest\.json$/i, '').replace(/\/$/, ''))
            .filter(u => {
                if (!u || u === cleanCatalogBase || u === tvAddonUrl) return false;
                if (!includeVip && isVipSearchHost(u)) return false;
                return true;
            })
    ];

    const perSource = await Promise.all(
        sources.map(url => getSearchCatalogs(url, reqType, proxyHeaders, excludeTypes))
    );

    // Flatten — no dedup needed because each source has a unique baseUrl+id combo
    return perSource.flat();
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
            // Fan-out to every addon that exposes catalog/search support:
            //   • TV addon (Kan-Box/Israeli)
            //   • All ADDON_URLS (e.g. YukiStreams anime catalogs, etc.)
            // We intentionally skip catalogBaseUrl (aiometadata) — it manages its own
            // search entries in our manifest, so including it here would double-send.
            //
            // "חיפוש משולב - complete" = VIP + anime + tv/channel (everything except movie/series).
            // Movie/series חיפוש משולב deliberately exclude VIP hosts and non-matching types.
            const isComplete = cleanCatalogId === 'esay_mixed_search_complete';
            const addonUrls = (process.env.ADDON_URLS || '').split('|||').map(u => u.trim()).filter(Boolean);
            const allSearchCatalogs = await getAllSearchCatalogs(
                tvAddonUrl, addonUrls, catalogBaseUrl, reqType, proxyHeaders,
                isComplete ? ['movie', 'series'] : null,
                isComplete // includeVip only for complete
            );
            console.log(`[ESAY SEARCH] 🔍 ${cleanCatalogId} | ${allSearchCatalogs.length} search catalogs from ${new Set(allSearchCatalogs.map(c => c.baseUrl)).size} addons`);

            const searchPromises = [];

            // שליחת בקשות חיפוש — כל קטלוג מושלח לשרת המתאים לו
            for (const cat of allSearchCatalogs) {
                searchPromises.push(
                    fetchWithTimeout(`${cat.baseUrl}/catalog/${cat.type}/${cat.id}/${extraPart}`, { headers: proxyHeaders }, 7500)
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
