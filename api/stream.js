import fetch from 'node-fetch';
import { fetchAndSortStreams } from '../lib/streamEngine.js';
import {
  isCached, isVIPSource, isDirectWebStream, getResWeight,
  masterSortFunc, REGEX_BRACKETS, REGEX_PARENS, REGEX_DOWNLOAD
} from '../lib/utils.js';

const PROFILES = {
  // Capable profiles push closer to Vercel's ~10s ceiling for richer fan-out
  everything: { maxResults: 30, maxSizeGB: Infinity, minSeedersUncached: 1, timeoutMs: 9500 },
  friends_heavy: { maxResults: 30, maxSizeGB: Infinity, minSeedersUncached: 3, timeoutMs: 9500 },
  friends_light: { maxResults: 10, maxSizeGB: 30, minSeedersUncached: 4, timeoutMs: 9000 },
  family: { maxResults: 10, maxSizeGB: 30, minSeedersUncached: 4, timeoutMs: 9000 }
};

const MAX_VIP_SLOTS = 3;
const MIN_PER_RESOLUTION = 2;

function applyQuotasAndSlice(streams, profileConfig, maxResults) {
  const vipStreams = [];
  const standardStreams = [];
  for (const stream of streams) {
    (isVIPSource(stream) ? vipStreams : standardStreams).push(stream);
  }

  const buckets = { '4k_c': [], '4k_u': [], '1080p_c': [], '1080p_u': [], '720p_c': [], '720p_u': [], 'sd_c': [], 'sd_u': [] };
  for (const s of standardStreams) {
    const isC = isCached(s);
    const rw = getResWeight(s);
    const sfx = isC ? '_c' : '_u';
    if (rw === 4) buckets[`4k${sfx}`].push(s);
    else if (rw === 3) buckets[`1080p${sfx}`].push(s);
    else if (rw === 2) buckets[`720p${sfx}`].push(s);
    else buckets[`sd${sfx}`].push(s);
  }

  const isBigProfile = (profileConfig === 'everything' || profileConfig === 'friends_heavy');
  // Cached-first quotas; uncached absorbs shortage via drawWithOverflow
  const quotas = isBigProfile
    ? { '4k_c': 12, '4k_u': 3, '1080p_c': 6, '1080p_u': 3, '720p_c': 3, '720p_u': 1, 'sd_c': 2, 'sd_u': 1 }
    : { '4k_c': 3, '4k_u': 1, '1080p_c': 3, '1080p_u': 1, '720p_c': 2, '720p_u': 0, 'sd_c': 0, 'sd_u': 0 };

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

  // Fill Cached first per resolution: 4K -> 1080p -> 720p -> SD
  drawWithOverflow('4k', quotas['4k_c'], quotas['4k_u']);
  drawWithOverflow('1080p', quotas['1080p_c'], quotas['1080p_u']);
  drawWithOverflow('720p', quotas['720p_c'], quotas['720p_u']);
  drawWithOverflow('sd', quotas['sd_c'], quotas['sd_u']);

  // Enforce minimum of 2 items per resolution when available (pull from leftover buckets)
  for (const resLevel of ['4k', '1080p', '720p', 'sd']) {
    const countInResult = standardResult.filter(s => {
      const rw = getResWeight(s);
      return (resLevel === '4k' && rw === 4) ||
        (resLevel === '1080p' && rw === 3) ||
        (resLevel === '720p' && rw === 2) ||
        (resLevel === 'sd' && rw <= 1);
    }).length;
    let need = Math.max(0, MIN_PER_RESOLUTION - countInResult);
    while (need > 0) {
      const fromC = buckets[`${resLevel}_c`].splice(0, 1);
      const fromU = fromC.length ? [] : buckets[`${resLevel}_u`].splice(0, 1);
      const taken = fromC.length ? fromC : fromU;
      if (!taken.length) break;
      standardResult.push(...taken);
      need--;
    }
  }

  const quotaOverflow = [];
  for (const key of Object.keys(buckets)) {
    if (buckets[key].length > 0) quotaOverflow.push(...buckets[key]);
  }

  // VIP always first in line, capped
  const cappedVipStreams = vipStreams.slice(0, MAX_VIP_SLOTS);
  let finalCandidates = [...cappedVipStreams, ...standardResult];
  let missingSlots = maxResults - finalCandidates.length;

  if (missingSlots > 0 && quotaOverflow.length > 0) {
    const taken = quotaOverflow.slice(0, missingSlots);
    finalCandidates.push(...taken);
    missingSlots -= taken.length;
  }

  finalCandidates.sort(masterSortFunc);

  // Reserve uncached 4K / uncached 1080p / Direct Web slots
  // Big profiles: 3 each; light/family: 1 each
  const resCount = isBigProfile ? 3 : 1;

  const nonVipStreams = finalCandidates.filter(s => !isVIPSource(s));

  const poolDirectWeb = [];
  const poolUncached4K = [];
  const poolUncached1080p = [];
  const poolMain = [];

  for (const stream of nonVipStreams) {
    if (isDirectWebStream(stream)) {
      poolDirectWeb.push(stream);
    } else if (!isCached(stream)) {
      const resWeight = getResWeight(stream);
      if (resWeight === 4) poolUncached4K.push(stream);
      else if (resWeight === 3) poolUncached1080p.push(stream);
      else poolMain.push(stream);
    } else {
      poolMain.push(stream);
    }
  }

  poolUncached4K.sort(masterSortFunc);
  poolUncached1080p.sort(masterSortFunc);
  poolDirectWeb.sort(masterSortFunc);

  const reservedU4K = poolUncached4K.splice(0, resCount);
  const reservedU1080p = poolUncached1080p.splice(0, resCount);
  const reservedDirectWeb = poolDirectWeb.splice(0, resCount);

  console.log(
    `[ESAY QUOTA] profile=${profileConfig} vip=${cappedVipStreams.length}/${MAX_VIP_SLOTS}` +
    ` reserve U4K=${reservedU4K.length} U1080=${reservedU1080p.length} web=${reservedDirectWeb.length}`
  );

  const restToFill = [...poolMain, ...poolUncached4K, ...poolUncached1080p, ...poolDirectWeb];
  restToFill.sort(masterSortFunc);

  const currentReservedCount = reservedU4K.length + reservedU1080p.length + reservedDirectWeb.length;
  const remainingSlots = Math.max(0, maxResults - cappedVipStreams.length - currentReservedCount);
  const standardFill = restToFill.slice(0, remainingSlots);

  const combinedStandardAndUncached = [...standardFill, ...reservedU4K, ...reservedU1080p];
  combinedStandardAndUncached.sort(masterSortFunc);

  // VIP always first
  return [...cappedVipStreams, ...combinedStandardAndUncached, ...reservedDirectWeb];
}

// Maps our internal resolution weight to the short label the user sees next to the provider name
const RES_LABELS = { 4: '4K', 3: 'FHD', 2: 'HD', 1: 'SD', 0: 'SD' };

/**
 * Providers pack extra info into `name` besides their own brand, e.g.
 * "[RD⚡] Comet 1080p" (Comet), "MediaFusion RD 2160p ⚡️" (MediaFusion),
 * "Torrentio\n4k" (Torrentio). After stripping known debrid/uncached tags,
 * the brand is reliably the first real word — keep just that.
 */
function extractProviderName(rawName, fallback) {
  const cleaned = String(rawName || '')
    .replace(REGEX_BRACKETS, '').replace(REGEX_PARENS, '').replace(REGEX_DOWNLOAD, '')
    .replace(/\n+/g, ' ').replace(/[|·•]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const word = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (word) return word;
  }
  return fallback;
}

function formatForStremio(streams) {
  return streams.map((stream, index) => {
    const isVip = isVIPSource(stream);
    const isC = isCached(stream);
    const position = index + 1;
    const isDirectWeb = isDirectWebStream(stream);

    const providerName = extractProviderName(stream.name, 'מקור');
    const resLabel = RES_LABELS[getResWeight(stream)] ?? 'SD';
    const cleanName = `${providerName} ${resLabel}`;

    let rawTitle = stream.title || stream.description || stream.behaviorHints?.filename || '';
    let cleanTitle = rawTitle.replace(REGEX_DOWNLOAD, '').replace(/\n+/g, '\n').trim();
    if (!cleanTitle) cleanTitle = cleanName || 'תוצאה ללא כותרת מהמקור';

    let prefix = (isVip || isDirectWeb) ? 'מרשת דפדפן' : (isC ? 'זמין לצפייה' : 'דורש המתנה ואולי כניסה חוזרת');
    if (stream.behaviorHints && stream.behaviorHints.notWebReady) {
      prefix += ' (לנגן תומך)';
    }
    
    stream.name = `[#${position}] ${prefix} | ${cleanName}`;
    stream.title = cleanTitle;

    if (stream.behaviorHints) {
      delete stream.behaviorHints.notWebReady;
      delete stream.behaviorHints.bingeGroup;
    }
    delete stream.description;

    const keysToDelete = [
      '_sourceBaseUrl', '_text', '_sizeGB', '_effectiveSizeGB', '_isEpisodeQuery', '_isCached', '_isUsenet',
      '_isVip', '_isNotice', '_seeders', '_resWeight', '_qualityWeight',
      '_visualWeight', '_audioWeight', '_langWeight', '_weightTier',
      '_releaseYear', '_fakeHdrPenalized'
    ];
    keysToDelete.forEach(k => delete stream[k]);
    return stream;
  });
}

function logDiagnostics(finalSliced) {
  console.log(`\n[ESAY DIAGNOSTIC] 📊 רשימת ה-${finalSliced.length} הסופית שנשלחת לסטרימיו:`);
  const hashTracker = new Set();
  let invisibleDrops = 0;

  finalSliced.forEach((s, index) => {
    const statusTag = s.name.includes('זמין לצפייה') ? '🟩 CACHED ' : (s.name.includes('דפדפן') ? '🟪 VIP/WEB ' : '🟥 UNCACHED');
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
}

function isCapableClient(ua) {
  const u = (ua || '').toLowerCase();
  return u.includes('nuvio') || u.includes('libmpv') || u.includes('kodi');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const forwardedIps = req.headers['x-forwarded-for'] || '';
  const clientIp = forwardedIps ? forwardedIps.split(',')[0].trim() : (req.socket?.remoteAddress || '');
  const clientUA = req.headers['user-agent'] || 'Stremio/4.4.156';

  try {
    const urlParts = req.url.split('?')[0].split('/');
    const streamIdx = urlParts.indexOf('stream');
    if (streamIdx < 1 || streamIdx + 2 >= urlParts.length) return res.status(400).json({ streams: [] });

    const userKey = urlParts[streamIdx - 1];
    const type = urlParts[streamIdx + 1];
    let rawIdWithExt = urlParts[streamIdx + 2];
    if (rawIdWithExt.includes('%')) rawIdWithExt = decodeURIComponent(rawIdWithExt);
    const idWithExt = rawIdWithExt;

    // === בלוק השכמה (Pre-warming) לשרתים חינמיים "נרדמים" בלבד ===
    if (type === 'movie' || type === 'series' || type === 'anime') {
      const sleepyAddons = [
        `https://submaker.elfhosted.com/addon/6c38c5872b2797b33729f954a9d1c5f7/subtitles/${type}/${idWithExt}`,
        `https://pgssubtitle.onrender.com/subtitles/${type}/${idWithExt}`
      ];
      
      sleepyAddons.forEach(url => {
        // Fire and Forget
        fetch(url).catch(() => {});
      });
      console.log(`[ESAY WAKEUP] ⏰ נשלחו פינגים להשכמת שרתים (Render + Elfhosted) עבור סוג ${type} | מזהה: ${idWithExt}`);
    }
    // ============================================
    
    if (type === 'tv' || type === 'channel') {
      const tvAddonUrl = process.env.TV_ADDON_URL;
      if (!tvAddonUrl) return res.status(200).json({ streams: [] });
      try {
        const cleanTvUrl = tvAddonUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
        const targetUrl = `${cleanTvUrl}/stream/${type}/${idWithExt}`;
        const headers = { 'User-Agent': clientUA, 'X-Forwarded-For': clientIp, 'Accept': 'application/json, text/plain, */*' };
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

    const configs = JSON.parse(process.env.USER_CONFIGS || '{}');
    const profileConfig = configs[userKey]?.profile || 'friends_light';
    const profile = { ...(PROFILES[profileConfig] || PROFILES.friends_light) };
    const addons = (process.env.ADDON_URLS || '').split('|||').map(u => u.trim()).filter(Boolean);

    // Capable clients (Nuvio etc.) get the full near-ceiling budget even on light profiles
    if (isCapableClient(clientUA) && profile.timeoutMs < 9500) {
      console.log(`[ESAY STREAM] 🚀 Capable client detected (${clientUA.substring(0, 40)}) → timeout 9500ms`);
      profile.timeoutMs = 9500;
    }

    if (addons.length === 0) return res.status(200).json({ streams: [] });

    const engineContext = {
      timeoutMs: profile.timeoutMs,
      maxSizeGB: profile.maxSizeGB,
      minSeedersUncached: profile.minSeedersUncached,
      addons,
      clientUA,
      clientIp,
      queryHint: decodeURIComponent(req.url || '')
    };

    const allValidStreams = await fetchAndSortStreams(type, idWithExt, engineContext);
    const sliced = applyQuotasAndSlice(allValidStreams, profileConfig, profile.maxResults);
    const finalSliced = formatForStremio(sliced);

    logDiagnostics(finalSliced);

    return res.status(200).json({ streams: finalSliced });
  } catch (error) {
    console.error('[ESAY DIAGNOSTIC] 💥 שגיאת קריסה כללית ב-Proxy:', error.stack || error);
    return res.status(200).json({ streams: [] });
  }
}
