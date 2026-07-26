import fetch from 'node-fetch';
import { debugLog } from '../lib/debugLog.js';
import { isYastreamProviderId, rewriteMetaToImdbIfKnown } from '../lib/yastream.js';
import { resolveProvider, evaluateVip } from '../lib/providerCapabilities.js';

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Fetch + JSON under a single wall-clock budget.
 * Covers the common hang where headers arrive but the body stalls (r.json()
 * is not aborted by fetch's AbortSignal once the response has started).
 */
async function fetchJsonWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        if (!res.ok) return { metas: [] };
        const remaining = Math.max(200, timeoutMs - (Date.now() - started));
        const data = await Promise.race([
            res.json(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('json-timeout')), remaining)
            )
        ]);
        return data && typeof data === 'object' ? data : { metas: [] };
    } catch {
        return { metas: [] };
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Soft-deadline fan-out: return whatever settled by softMs (or all, if faster).
 * Unsettled slots become { metas: [] }.
 */
async function awaitSoftDeadline(promises, softMs) {
    const results = new Array(promises.length).fill(null);
    if (promises.length === 0) return results;

    return await new Promise((resolve) => {
        let settled = 0;
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(results.map(r => r || { metas: [] }));
        };
        const timer = setTimeout(finish, softMs);
        promises.forEach((p, i) => {
            Promise.resolve(p)
                .then(v => { results[i] = v; })
                .catch(() => { results[i] = { metas: [] }; })
                .finally(() => {
                    settled++;
                    if (settled >= promises.length) finish();
                });
        });
    });
}

/** Short-lived cache of meta ids from fast mixed searches — used by "full" to avoid overlap. */
const _fastSearchIdCache = new Map(); // queryKey → { ids: Set, ts }
const FAST_SEARCH_CACHE_TTL_MS = 60_000;

function searchQueryKey(extraPart) {
    const m = String(extraPart || '').match(/search=([^/]+)/);
    if (!m) return null;
    try {
        return decodeURIComponent(m[1]).toLowerCase().trim();
    } catch {
        return m[1].toLowerCase().trim();
    }
}

function rememberFastSearchIds(queryKey, mode, ids) {
    if (!queryKey || !ids?.size) return;
    const key = `${queryKey}::${mode}`;
    _fastSearchIdCache.set(key, { ids: new Set(ids), ts: Date.now() });
}

function collectFastSearchIds(queryKey) {
    if (!queryKey) return new Set();
    const out = new Set();
    const now = Date.now();
    for (const mode of ['movie', 'series', 'complete']) {
        const key = `${queryKey}::${mode}`;
        const entry = _fastSearchIdCache.get(key);
        if (!entry) continue;
        if (now - entry.ts > FAST_SEARCH_CACHE_TTL_MS) {
            _fastSearchIdCache.delete(key);
            continue;
        }
        for (const id of entry.ids) out.add(id);
    }
    return out;
}

let cachedTvCatalogIds = null;
let lastCacheTime = 0;
let activeManifestFetch = null;

async function getTvCatalogIds(tvAddonUrl, headers) {
    if (!tvAddonUrl) return [];

    if (cachedTvCatalogIds && (Date.now() - lastCacheTime < 1000 * 60 * 60)) {
        return cachedTvCatalogIds;
    }

    if (activeManifestFetch) {
        return await activeManifestFetch;
    }

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
            activeManifestFetch = null;
        }
    })();

    return await activeManifestFetch;
}

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

/**
 * VIP hosts are declared once in the provider capability registry, so adding a
 * curated source no longer means editing hostname substrings in several files.
 */
function isVipSearchHost(url) {
    const provider = resolveProvider(url, { configured: true });
    return evaluateVip(provider, { text: '', isSingleHopHttp: true, isIpLocked: false });
}

/**
 * @param {string|null} excludeTypes - when array, keep catalogs whose type is NOT in the list
 * @param {boolean} allTypes - when true, every searchable catalog (full mode)
 */
async function getSearchCatalogs(baseUrl, type, headers, excludeTypes = null, allTypes = false) {
    try {
        const manifest = await getCachedManifest(baseUrl, headers);
        if (!manifest) return [];

        let catalogs;
        if (allTypes) {
            catalogs = manifest.catalogs?.filter(c =>
                c.extra?.some(e => e.name === 'search')
            );
        } else if (excludeTypes) {
            catalogs = manifest.catalogs?.filter(c =>
                !excludeTypes.includes(c.type) && c.extra?.some(e => e.name === 'search')
            );
        } else {
            catalogs = manifest.catalogs?.filter(c =>
                c.type === type && c.extra?.some(e => e.name === 'search')
            );
        }

        return catalogs ? catalogs.map(c => ({ id: c.id, type: c.type, baseUrl })) : [];
    } catch {
        return [];
    }
}

async function getAllSearchCatalogs(tvAddonUrl, addonUrls, reqType, proxyHeaders, {
    excludeTypes = null,
    includeVip = true,
    allTypes = false
} = {}) {
    const sources = [
        ...(includeVip && tvAddonUrl ? [tvAddonUrl] : []),
        ...addonUrls
            .map(u => u.replace(/\/manifest\.json$/i, '').replace(/\/$/, ''))
            .filter(u => {
                if (!u || u === tvAddonUrl) return false;
                if (!includeVip && isVipSearchHost(u)) return false;
                return true;
            })
    ];

    const perSource = await Promise.all(
        sources.map(url => getSearchCatalogs(url, reqType, proxyHeaders, excludeTypes, allTypes))
    );

    return perSource.flat();
}

function mergeMetas(results, { excludeIds = null, rewriteYastream = true } = {}) {
    const combinedMetas = [];
    const seenIds = new Set();

    for (const result of results) {
        if (!result || !Array.isArray(result.metas)) continue;
        for (const meta of result.metas) {
            if (!meta || !meta.id) continue;
            let out = meta;
            if (rewriteYastream && isYastreamProviderId(meta.id)) {
                out = rewriteMetaToImdbIfKnown(meta);
            }
            if (excludeIds && excludeIds.has(out.id)) continue;
            // Also skip if the pre-rewrite provider id was already shown by a fast search
            if (excludeIds && excludeIds.has(meta.id)) continue;
            if (seenIds.has(out.id)) continue;
            seenIds.add(out.id);
            combinedMetas.push(out);
        }
    }
    return { combinedMetas, seenIds };
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const clientUA = req.headers['user-agent'] || 'Stremio/4.4.156';
    const forwardedIps = req.headers['x-forwarded-for'] || '';
    const clientIp = forwardedIps ? forwardedIps.split(',')[0].trim() : (req.socket?.remoteAddress || '');

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

        const tvAddonUrl = (process.env.TV_ADDON_URL || '').replace(/\/manifest\.json$/i, '').replace(/\/$/, '');

        // ==========================================
        // 1. Mixed Search (fast movie/series/complete + full)
        // ==========================================
        if (cleanCatalogId.startsWith('esay_mixed_search') && extraPart.includes('search=')) {
            const handlerStarted = Date.now();
            const isComplete = cleanCatalogId === 'esay_mixed_search_complete';
            const isFull = cleanCatalogId === 'esay_mixed_search_full';
            // VIP hosts (Kan-Box / AnimeIL) only on complete + full
            const includeVip = isComplete || isFull;

            // Wall-clock budget under Vercel Hobby ~10s. Discovery (manifest fan-out)
            // eats into this; soft deadline uses whatever remains so "full" cannot stick.
            // Fast trio target ~3s total; full target ~8s total (leave headroom).
            const hardBudgetMs = isFull ? 8000 : 3000;

            const addonUrls = (process.env.ADDON_URLS || '').split('|||').map(u => u.trim()).filter(Boolean);
            const allSearchCatalogs = await getAllSearchCatalogs(
                tvAddonUrl, addonUrls, reqType, proxyHeaders,
                {
                    excludeTypes: isComplete ? ['movie', 'series'] : null,
                    includeVip,
                    allTypes: isFull
                }
            );

            const afterDiscoveryMs = Date.now() - handlerStarted;
            // Keep at least 400ms for a partial response; never exceed remaining budget
            const softMs = Math.max(400, hardBudgetMs - afterDiscoveryMs);
            const perFetchMs = softMs;

            console.log(
                `[ESAY SEARCH] 🔍 ${cleanCatalogId} | budget=${hardBudgetMs}ms discovery=${afterDiscoveryMs}ms ` +
                `soft=${softMs}ms vip=${includeVip} ` +
                `| ${allSearchCatalogs.length} catalogs / ${new Set(allSearchCatalogs.map(c => c.baseUrl)).size} addons`
            );

            // #region agent log
            debugLog('H-SEARCH', 'api/catalog.js:mixedSearch', 'search budget', {
                cleanCatalogId, isFull, hardBudgetMs, afterDiscoveryMs, softMs,
                catalogCount: allSearchCatalogs.length,
                query: String(extraPart).slice(0, 80)
            });
            // #endregion

            const searchPromises = allSearchCatalogs.map(cat =>
                fetchJsonWithTimeout(
                    `${cat.baseUrl}/catalog/${cat.type}/${cat.id}/${extraPart}`,
                    { headers: proxyHeaders },
                    perFetchMs
                )
            );

            const results = await awaitSoftDeadline(searchPromises, softMs);
            const afterFanoutMs = Date.now() - handlerStarted;
            const queryKey = searchQueryKey(extraPart);

            let excludeIds = null;
            if (isFull) {
                excludeIds = collectFastSearchIds(queryKey);
                if (excludeIds.size > 0) {
                    console.log(`[ESAY SEARCH] 🧹 full excludes ${excludeIds.size} ids already returned by fast searches`);
                }
            }

            const { combinedMetas, seenIds } = mergeMetas(results, {
                excludeIds,
                rewriteYastream: true
            });

            if (!isFull) {
                const mode = isComplete ? 'complete' : (cleanCatalogId.includes('series') ? 'series' : 'movie');
                rememberFastSearchIds(queryKey, mode, seenIds);
            }

            console.log(
                `[ESAY SEARCH] ✅ ${cleanCatalogId} done in ${afterFanoutMs}ms → ${combinedMetas.length} metas`
            );
            // #region agent log
            debugLog('H-SEARCH', 'api/catalog.js:mixedSearch', 'search done', {
                cleanCatalogId, afterFanoutMs, metas: combinedMetas.length, softMs
            });
            // #endregion

            return res.status(200).json({ metas: combinedMetas });
        }

        // ==========================================
        // 2. Regular catalogs (Kan-Box / Live TV only)
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
            return res.status(200).json({ metas: [] });
        }

        debugLog('H2', 'api/catalog.js:proxy', 'catalog proxy attempt', {
            userKey,
            cleanCatalogId,
            reqType,
            branch: 'tv',
            targetHost: targetUrl.split('/').slice(0, 3).join('/'),
            hasXff: !!requestHeaders['X-Forwarded-For']
        });

        const fetchRes = await fetchWithTimeout(targetUrl, { headers: requestHeaders }, 8000);
        if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}`);

        const data = await fetchRes.json();
        debugLog('H2', 'api/catalog.js:proxy', 'catalog proxy ok', {
            cleanCatalogId,
            metasLength: Array.isArray(data?.metas) ? data.metas.length : -1,
            upstreamStatus: fetchRes.status
        });
        return res.status(200).json(data);

    } catch (error) {
        console.error(`[ESAY CATALOG PROXY ERROR]: ${error.message}`);
        debugLog('H2', 'api/catalog.js:error', 'catalog proxy error', { err: String(error.message || error) });
        return res.status(200).json({ metas: [] });
    }
}
