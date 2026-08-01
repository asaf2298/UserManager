import fetch from 'node-fetch';
import { retrieveRankAndSelect } from '../lib/streamEngine.js';
import { REGEX_BRACKETS, REGEX_PARENS, REGEX_DOWNLOAD, isNoticeStream } from '../lib/utils.js';
import { findYastreamBaseUrl, isYastreamProviderId } from '../lib/yastream.js';
import { isDailymotionId, getDailymotionStream } from '../lib/dailymotion.js';
import { resolveProfile, DEFAULT_PROFILE, scoreBreakdown } from '../lib/streamRanker.js';
import { RESOLUTION } from '../lib/releaseParser.js';
import { TRANSPORT, CACHE_CLAIM } from '../lib/providerCapabilities.js';
import { upsertStreamSightings } from '../lib/streamSighting.js';
import { recordRankingAudits } from '../lib/rankingTelemetry.js';
import { waitUntil } from '@vercel/functions';
import {
  isIdResolveEnabled,
  isIdResolveShadow,
  isIdResolveQueryEnabled,
  resolveContentContext,
  logShadowResolve,
} from '../lib/idResolve.js';

/** Short resolution badge shown next to the provider name. */
const RES_LABELS = {
  [RESOLUTION.R2160]: '4K',
  [RESOLUTION.R1440]: '2K',
  [RESOLUTION.R1080]: 'FHD',
  [RESOLUTION.R720]: 'HD',
  [RESOLUTION.SD]: 'SD',
  [RESOLUTION.R360]: 'SD',
  [RESOLUTION.UNKNOWN]: '',
};

/** Client classes that can handle demanding codecs/containers without transcode. */
function isCapableClient(ua) {
  const u = (ua || '').toLowerCase();
  return u.includes('nuvio') || u.includes('libmpv') || u.includes('kodi');
}

/**
 * Providers pack extra info into `name` besides their own brand, e.g.
 * "[RD⚡] Comet 1080p" or "Torrentio\n4k". After stripping delivery tags the
 * brand is reliably the first real word.
 */
function extractProviderName(rawName, fallback) {
  const cleaned = String(rawName || '')
    .replace(REGEX_BRACKETS, '').replace(REGEX_PARENS, '').replace(REGEX_DOWNLOAD, '')
    .replace(/\n+/g, ' ').replace(/[|·•]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  for (const token of cleaned.split(/\s+/).filter(Boolean)) {
    const word = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (word) return word;
  }
  return fallback;
}

/**
 * Availability wording derived from the availability feature and transport, not
 * from title text. The viewer sees a promise we can actually justify.
 */
function availabilityLabel(features) {
  if (features.transport === TRANSPORT.DIRECT_OWNER) return 'זמין לצפייה';
  if (features.cacheClaim?.claim === CACHE_CLAIM.POSITIVE) return 'זמין לצפייה';
  if (features.F >= 0.90) return 'זמין לצפייה';
  if (features.transport === TRANSPORT.EXTERNAL) return 'נגן חיצוני';
  if (features.cacheClaim?.claim === CACHE_CLAIM.QUEUED) return 'דורש המתנה ואולי כניסה חוזרת';
  if (features.transport === TRANSPORT.P2P) return 'תלוי במהירות הרשת';
  return 'דורש המתנה ואולי כניסה חוזרת';
}

/** Internal analysis fields that must never reach the client. */
const INTERNAL_KEYS = [
  '_sourceBaseUrl', '_provenance', '_text', '_sizeGB', '_effectiveSizeGB', '_isEpisodeQuery',
  '_isCached', '_isUsenet', '_isVip', '_isNotice', '_seeders', '_resWeight', '_qualityWeight',
  '_visualWeight', '_audioWeight', '_langWeight', '_weightTier', '_releaseYear',
  '_fakeHdrPenalized', '_upscalePenalized', '_oldHdrCaution', '_fakeQuality',
  '_fakeResContradiction', '_isSeasonPack', '_hebrewMatch', '_titleMatched',
  '_score', '_features', '_scoreBreakdown', '_clusterId', '_clusterSize',
];

/**
 * Shape selected candidates into Stremio stream objects.
 *
 * Playback-relevant behaviorHints (`filename`, `videoSize`, `videoHash`) are
 * preserved on purpose: clients echo them back on subtitle requests, which is how
 * auto-sync identifies the file being played.
 */
function formatForStremio(selected) {
  return selected.map((candidate, index) => {
    const stream = candidate.stream;
    const features = candidate.features;
    const providerName = extractProviderName(stream.name, features.provider.label || 'מקור');
    const resLabel = RES_LABELS[features.release.resolution.value] ?? '';
    const cleanName = resLabel ? `${providerName} ${resLabel}` : providerName;

    const rawTitle = stream.title || stream.description || stream.behaviorHints?.filename || '';
    let cleanTitle = String(rawTitle).replace(REGEX_DOWNLOAD, '').replace(/\n+/g, '\n').trim();
    if (!cleanTitle) cleanTitle = cleanName || 'תוצאה ללא כותרת מהמקור';

    let prefix = availabilityLabel(features);
    if (stream.behaviorHints?.notWebReady) prefix += ' (לנגן תומך)';

    stream.name = `[#${index + 1}] ${prefix} | ${cleanName}`;
    stream.title = cleanTitle;

    if (stream.behaviorHints) {
      delete stream.behaviorHints.notWebReady;
      delete stream.behaviorHints.bingeGroup;
    }
    delete stream.description;
    for (const key of INTERNAL_KEYS) delete stream[key];
    return stream;
  });
}

/**
 * Operator-facing explanation of the final list. Every row can be justified by
 * its dominant score contributions, which is the point of a weighted model.
 */
function logRankingDiagnostics(selected, diagnostics, profile) {
  console.log(
    `\n[PERSONAL RANK] 📊 profile=${diagnostics.profile} model=${diagnostics.modelVersion}` +
    ` trust=${diagnostics.trustSnapshotVersion} raw=${diagnostics.rawCount}` +
    ` eligible=${diagnostics.eligibleCount} clusters=${diagnostics.dedup.clusters}` +
    ` merged=${diagnostics.dedup.merged} (${diagnostics.dedup.mode})` +
    ` selected=${diagnostics.selection.selected} vip=${diagnostics.selection.vip}` +
    ` relaxed=${diagnostics.selection.relaxed}` +
    ` | features=${diagnostics.timings.featureMs}ms dedup=${diagnostics.timings.dedupMs}ms` +
    ` select=${diagnostics.timings.selectMs}ms`
  );

  const hashSeen = new Set();
  let duplicateHashes = 0;
  selected.forEach((candidate, index) => {
    const features = candidate.features;
    const breakdown = scoreBreakdown(features, profile);
    const top = Object.entries(breakdown)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([key, value]) => `${key}=${value.toFixed(1)}`)
      .join(' ');
    const hash = String(candidate.stream.infoHash || '').toLowerCase();
    if (hash) {
      if (hashSeen.has(hash)) duplicateHashes++;
      hashSeen.add(hash);
    }
    console.log(
      `[#${index + 1}] score=${candidate.baseScore.toFixed(2)}` +
      ` ${features.isVip ? 'VIP ' : ''}${features.transport}` +
      ` F=${features.F.toFixed(2)} T=${features.T.toFixed(2)} V=${features.V.toFixed(2)}` +
      ` C=${features.C.toFixed(2)} | ${top}` +
      ` | ${features.explanation.availability}` +
      (candidate.clusterSize > 1 ? ` | merged=${candidate.clusterSize}` : '') +
      ` | ${String(candidate.stream.title || '').replace(/\n/g, ' ').slice(0, 60)}`
    );
  });

  if (duplicateHashes > 0) {
    console.log(`[PERSONAL RANK] 🚨 ${duplicateHashes} duplicate infoHash rows survived dedup — Stremio will hide them.`);
  }
  console.log(`[PERSONAL RANK] 🏁 sent ${selected.length} streams.\n`);
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
    const idNoExt = idWithExt.replace(/\.json$/i, '');

    // Own id prefix, own catalog: must be checked before the tv/channel
    // branch below, which would otherwise forward it to Kan-Box's
    // TV_ADDON_URL since Dailymotion also uses type "channel".
    if (isDailymotionId(idNoExt)) {
      return res.status(200).json(await getDailymotionStream(idNoExt));
    }

    // Wake free-tier subtitle hosts that sleep, so the later subtitle request is warm.
    if (type === 'movie' || type === 'series' || type === 'anime') {
      const sleepyAddons = [
        `https://submaker.elfhosted.com/addon/6c38c5872b2797b33729f954a9d1c5f7/subtitles/${type}/${idWithExt}`,
        `https://pgssubtitle.onrender.com/subtitles/${type}/${idWithExt}`,
      ];
      sleepyAddons.forEach(url => { fetch(url).catch(() => {}); });
      console.log(`[PERSONAL WAKEUP] ⏰ נשלחו פינגים להשכמת שרתים עבור סוג ${type} | מזהה: ${idWithExt}`);
    }

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
        if (tvRes.ok) return res.status(200).json(await tvRes.json());
      } catch (e) {
        console.error(`[PERSONAL DIAGNOSTIC] 💥 שגיאה בשליפת ערוץ חי: ${e.message}`);
      }
      return res.status(200).json({ streams: [] });
    }

    // Yastream Asian provider ids proxy straight through; normal tt titles still
    // fan out to every configured addon below.
    if (isYastreamProviderId(idNoExt)) {
      const addonUrls = (process.env.ADDON_URLS || '').split('|||').map(u => u.trim()).filter(Boolean);
      const yastreamBase = findYastreamBaseUrl(addonUrls, process.env.YASTREAM_URL || '');
      if (!yastreamBase) {
        console.log(`[PERSONAL STREAM] ⚠️ provider id without Yastream in ADDON_URLS: ${idNoExt.slice(0, 48)}`);
        return res.status(200).json({ streams: [] });
      }
      try {
        const targetUrl = `${yastreamBase}/stream/${type}/${idWithExt}`;
        const headers = { 'User-Agent': clientUA, 'X-Forwarded-For': clientIp, 'Accept': 'application/json' };
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 9500);
        let ysRes;
        try {
          ysRes = await fetch(targetUrl, { headers, signal: controller.signal });
        } finally {
          clearTimeout(timeoutId);
        }
        if (!ysRes.ok) return res.status(200).json({ streams: [] });
        const ysData = await ysRes.json();
        const raw = Array.isArray(ysData?.streams) ? ysData.streams : [];
        const streams = raw.filter(s => s && !isNoticeStream(s));
        console.log(`[PERSONAL STREAM] 🌏 Yastream provider ${idNoExt.slice(0, 40)} → ${streams.length} streams`);
        return res.status(200).json({ streams });
      } catch (e) {
        console.error(`[PERSONAL STREAM] 💥 Yastream provider fetch: ${e.message}`);
        return res.status(200).json({ streams: [] });
      }
    }

    const configs = JSON.parse(process.env.USER_CONFIGS || '{}');
    const profileName = configs[userKey]?.profile || DEFAULT_PROFILE;
    const baseProfile = resolveProfile(profileName);
    const addons = (process.env.ADDON_URLS || '').split('|||').map(u => u.trim()).filter(Boolean);
    if (addons.length === 0) return res.status(200).json({ streams: [] });

    // Capable clients decode more formats, so device compatibility stops being a
    // constraint and they can use the wider collection window.
    const capable = isCapableClient(clientUA);
    const profile = capable
      ? {
        ...baseProfile,
        clientClass: 'capable',
        timeoutMs: Math.max(baseProfile.timeoutMs, 9500),
        collectionCutoffMs: Math.max(baseProfile.collectionCutoffMs, 7000),
      }
      : baseProfile;
    if (capable) {
      console.log(`[PERSONAL STREAM] 🚀 Capable client (${clientUA.substring(0, 40)}) → capable compatibility profile`);
    }

    // ID resolve stays opt-in and never delays the base fan-out.
    let idResolvePromise = null;
    if (isIdResolveEnabled()) {
      if (isIdResolveQueryEnabled()) {
        idResolvePromise = resolveContentContext(type, idWithExt).catch(() => null);
      } else if (isIdResolveShadow()) {
        resolveContentContext(type, idWithExt)
          .then((ctx) => { if (ctx) logShadowResolve(ctx); })
          .catch(() => {});
      }
    }

    const result = await retrieveRankAndSelect(type, idWithExt, {
      profile,
      profileName,
      addons,
      clientUA,
      clientIp,
      queryHint: decodeURIComponent(req.url || ''),
      idResolvePromise,
    });

    logRankingDiagnostics(result.selected, result.diagnostics, profile);

    // Auxiliary writes must not delay the response, but they also must not race
    // it: Vercel freezes the invocation the instant the handler returns, which
    // tears down any in-flight socket and aborts a plain fire-and-forget write.
    // waitUntil() keeps the invocation alive until these settle.
    waitUntil(upsertStreamSightings({
      contentType: type,
      contentId: idNoExt,
      candidates: result.selected,
    }).catch(() => {}));
    waitUntil(recordRankingAudits(result.selected, { contentId: idNoExt }).catch(() => {}));

    const finalStreams = formatForStremio(result.selected);
    return res.status(200).json({ streams: finalStreams });
  } catch (error) {
    console.error('[PERSONAL DIAGNOSTIC] 💥 שגיאת קריסה כללית ב-Proxy:', error.stack || error);
    return res.status(200).json({ streams: [] });
  }
}

export { formatForStremio, availabilityLabel, extractProviderName, isCapableClient };
