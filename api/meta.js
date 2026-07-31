import fetch from 'node-fetch';
import { findYastreamBaseUrl, isYastreamProviderId } from '../lib/yastream.js';
import { isDailymotionId, getDailymotionMeta } from '../lib/dailymotion.js';

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}

async function fetchMetaJson(targetUrl, headers, timeoutMs) {
    const response = await fetchWithTimeout(targetUrl, { headers }, timeoutMs);
    if (!response.ok) return { ok: false, status: response.status, data: null };
    const data = await response.json();
    if (data && data.meta) return { ok: true, status: response.status, data };
    return { ok: false, status: response.status, data: null };
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const urlParts = req.url.split('?')[0].split('/');
        const metaIdx = urlParts.indexOf('meta');

        if (metaIdx < 1 || metaIdx + 2 >= urlParts.length) return res.status(404).json({ meta: null });

        const userKey = urlParts[metaIdx - 1];
        const type = urlParts[metaIdx + 1];
        let rawIdWithExt = urlParts[metaIdx + 2];

        if (rawIdWithExt.includes('%')) rawIdWithExt = decodeURIComponent(rawIdWithExt);
        const idWithExt = rawIdWithExt;
        const id = idWithExt.replace('.json', '');

        // Own id prefix, own catalog: must be checked before the tv/channel
        // branch below, which would otherwise forward it to Kan-Box's
        // TV_ADDON_URL since Dailymotion also uses type "channel".
        if (isDailymotionId(id)) {
            return res.status(200).json(await getDailymotionMeta(id));
        }

        const tvAddonUrl = process.env.TV_ADDON_URL;
        const cleanTvUrl = tvAddonUrl ? tvAddonUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '') : '';

        const forwardType = (type === 'tv' || type === 'channel') ? 'series' : type;

        const forwardedIps = req.headers['x-forwarded-for'] || '';
        const clientIp = forwardedIps ? forwardedIps.split(',')[0].trim() : (req.socket?.remoteAddress || '');

        const headers = {
            'User-Agent': req.headers['user-agent'] || 'Stremio/4.4.156',
            'Accept': 'application/json, text/plain, */*',
            'X-Forwarded-For': clientIp
        };

        const addonUrls = (process.env.ADDON_URLS || '').split('|||').map(u => u.trim()).filter(Boolean);
        const yastreamBase = findYastreamBaseUrl(addonUrls, process.env.YASTREAM_URL || '');

        let targetUrl = '';
        let branch = 'cinemeta';
        if (id.startsWith('dbz:') || id.startsWith('il_') || type === 'tv' || type === 'channel') {
            if (!cleanTvUrl) return res.status(404).json({ meta: null });
            targetUrl = `${cleanTvUrl}/meta/${forwardType}/${idWithExt}`;
            branch = 'tv';
        } else if (isYastreamProviderId(id)) {
            if (!yastreamBase) {
                console.log(`[PERSONAL META] ⚠️ Yastream provider id ${id.slice(0, 40)} but no Yastream URL in ADDON_URLS`);
                return res.status(404).json({ meta: null });
            }
            targetUrl = `${yastreamBase}/meta/${forwardType}/${idWithExt}`;
            branch = 'yastream';
        } else if (id.startsWith('tt')) {
            targetUrl = `https://v3-cinemeta.strem.io/meta/${type}/${idWithExt}`;
            branch = 'cinemeta';
        } else {
            targetUrl = '';
            branch = 'none';
        }

        let result = targetUrl ? await fetchMetaJson(targetUrl, headers, 5000) : { ok: false, status: 0, data: null };

        if (result.ok && result.data?.meta) {
            const data = result.data;
            data.meta.type = type;
            data.meta.id = id;

            if ((type === 'tv' || type === 'channel')) {
                const channelName = data.meta.name || id.replace(/_/g, ' ');
                if (!data.meta.description || data.meta.description.trim() === '') {
                    data.meta.description = `שידור חי - ${channelName}`;
                }
            }
            return res.status(200).json(data);
        }

        return res.status(404).json({ meta: null });

    } catch (error) {
        return res.status(404).json({ meta: null });
    }
}
