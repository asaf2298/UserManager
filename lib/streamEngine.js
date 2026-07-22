import fetch from 'node-fetch';
import { getContentMeta, buildSearchTitles, isDubbedQuery } from './search.js';
import {
  isCached, isUsenet, getSeeders, getSizeGB, isVIPSource, isNoticeStream,
  getWeightTiers, getResWeight, getQualityScoreForPreSort, getTextForAnalysis
} from './utils.js';
import { debugLog } from './debugLog.js';

/** Extra multi-lang titles only when primary ID+EN search is still thin */
const MIN_RESULTS_FOR_EXTRA_LANG = 4;

/**
 * Resolve soft size ceiling from profile + content type.
 * Movies: up to 30GB (or profile cap). Episodes/series/anime: up to 10GB (or profile cap).
 * Infinity profiles stay unlimited.
 */
export function resolveSizeLimitGB(type, isEpisode, profileMaxSizeGB) {
  if (!Number.isFinite(profileMaxSizeGB)) return Infinity;
  const isShow = isEpisode || type === 'series' || type === 'anime';
  const typeCap = isShow ? 10 : 30;
  return Math.min(profileMaxSizeGB, typeCap);
}

function isVipAddonUrl(url) {
  const u = (url || '').toLowerCase();
  return u.includes('kan-box-addon.vercel.app') || u.includes('animeil');
}

export async function fetchAndSortStreams(type, idWithExt, context) {
  const { timeoutMs, maxSizeGB, minSeedersUncached, addons, clientUA, clientIp, queryHint = '' } = context;
  const id = idWithExt.replace('.json', '');
  
  // זיהוי האם הבקשה היא עבור פרק ספציפי
  const isEpisode = id.split(':').length >= 3;
  const sizeLimitGB = resolveSizeLimitGB(type, isEpisode, maxSizeGB);

  const fetchFromAddon = async (baseUrl, customIdWithExt = null) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const cleanBaseUrl = baseUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
    const finalIdWithExt = customIdWithExt || idWithExt;
    const targetUrl = `${cleanBaseUrl}/stream/${type}/${finalIdWithExt}`;
    // מעבירים את ה-IP האמיתי של הלקוח ל*כל* התוספים, כדי ששירותי Debrid ייצרו לינקים ל-IP הנכון
    const fetchHeaders = { 
        'User-Agent': clientUA,
        'X-Forwarded-For': clientIp
    };
    const started = Date.now();
    try {
      const response = await fetch(targetUrl, { signal: controller.signal, headers: fetchHeaders });
      if (!response.ok) {
        debugLog('H1', 'lib/streamEngine.js:fetchFromAddon', 'addon non-ok', {
          host: cleanBaseUrl, mode: customIdWithExt ? 'text' : 'id', status: response.status, ms: Date.now() - started
        });
        return [];
      }
      const data = await response.json();
      if (data && Array.isArray(data.streams)) {
        const realStreams = data.streams.filter(s => !isNoticeStream(s));
        const noticeCount = data.streams.length - realStreams.length;
        realStreams.forEach(s => s._sourceBaseUrl = baseUrl);
        debugLog('H1', 'lib/streamEngine.js:fetchFromAddon', 'addon ok', {
          host: cleanBaseUrl,
          mode: customIdWithExt ? 'text' : 'id',
          query: String(finalIdWithExt).slice(0, 80),
          count: realStreams.length,
          noticeDropped: noticeCount,
          vipHost: isVipAddonUrl(baseUrl),
          ms: Date.now() - started
        });
        if (noticeCount > 0) {
          console.log(`[ESAY STREAM] 🧹 סוננו ${noticeCount} שורות הודעה/פרסום (לא תוכן) ממקור: ${cleanBaseUrl}`);
        }
        return realStreams;
      }
      return [];
    } catch (err) {
      debugLog('H1', 'lib/streamEngine.js:fetchFromAddon', 'addon error/abort', {
        host: cleanBaseUrl, mode: customIdWithExt ? 'text' : 'id', err: String(err && err.name || err), ms: Date.now() - started
      });
      return [];
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const allStreams = [];
  const pushResults = (val) => {
    if (Array.isArray(val) && val.length > 0) {
      val.forEach(s => { s._isEpisodeQuery = isEpisode; });
      allStreams.push(...val);
    }
  };

  // Meta early so we can always parallelize primary-title text search (restores Kan-Box VIP on official posters)
  let releaseYear = null;
  let contentMeta = null;
  if (id.startsWith('tt') || id.startsWith('tmdb:')) {
    contentMeta = await getContentMeta(type, id);
    releaseYear = contentMeta?.year || null;
  }

  // --- Phase 1: ID fan-out + ALWAYS primary text search (old behavior that kept VIP working) ---
  let promises = addons.map(url => fetchFromAddon(url));

  const hint = queryHint || id;
  const titles = contentMeta ? buildSearchTitles(contentMeta, hint) : [];
  // Always fire the first (preferred) title in parallel with ID — this is what Kan-Box/AnimeIL need for tt posters
  const primaryTitle = titles[0] || null;
  if (primaryTitle && (id.startsWith('tt') || id.startsWith('tmdb:'))) {
    console.log(`[ESAY STREAM] 🔤 חיפוש טקסט ראשי במקביל ל-ID: "${primaryTitle}"${isDubbedQuery(hint) ? ' [DUBBED→HE]' : ''}`);
    promises = promises.concat(
      addons.map(baseUrl => fetchFromAddon(baseUrl, `search=${encodeURIComponent(primaryTitle)}.json`))
    );
  }

  const trackPromises = promises.map(p => p.then(pushResults).catch(() => {}));

  const INITIAL_WAIT_MS = Math.min(5500, timeoutMs);
  console.log(`[ESAY STREAM] ⏱️ timeoutMs=${timeoutMs} | initialWait=${INITIAL_WAIT_MS}ms | sizeLimit=${sizeLimitGB}`);

  await Promise.race([
    Promise.allSettled(trackPromises),
    new Promise(resolve => setTimeout(resolve, INITIAL_WAIT_MS))
  ]);

  const afterPrimaryCount = allStreams.length;
  const vipAfterPrimary = allStreams.filter(s => isVIPSource(s)).length;
  debugLog('H1', 'lib/streamEngine.js:afterPrimary', 'after ID+primary text', {
    id: id.slice(0, 40),
    afterPrimaryCount,
    vipAfterPrimary,
    primaryTitle,
    sizeLimitGB
  });

  // --- Phase 2: extra languages ONLY if still thin OR VIP hosts returned nothing ---
  const needsExtraLang =
    (id.startsWith('tt') || id.startsWith('tmdb:')) &&
    titles.length > 1 &&
    (afterPrimaryCount < MIN_RESULTS_FOR_EXTRA_LANG || vipAfterPrimary === 0);

  if (needsExtraLang) {
    const extraTitles = titles.slice(1);
    console.log(
      `[ESAY STREAM] 🔤 מרחיב לשפות נוספות (count=${afterPrimaryCount}, vip=${vipAfterPrimary}): ${JSON.stringify(extraTitles)}`
    );
    for (const title of extraTitles) {
      if (allStreams.length >= MIN_RESULTS_FOR_EXTRA_LANG * 3 && vipAfterPrimary > 0) break;
      const textPromises = addons.map(baseUrl =>
        fetchFromAddon(baseUrl, `search=${encodeURIComponent(title)}.json`)
      );
      const perTitleBudget = Math.min(2500, Math.max(1200, Math.floor((timeoutMs - INITIAL_WAIT_MS) / Math.max(1, extraTitles.length))));
      await Promise.race([
        Promise.allSettled(textPromises.map(p => p.then(pushResults).catch(() => {}))),
        new Promise(resolve => setTimeout(resolve, perTitleBudget))
      ]);
      console.log(`[ESAY STREAM] 🔤 אחרי חיפוש "${title}" — סה"כ ${allStreams.length} סטרימים גולמיים`);
    }
  }

  // Drain remaining fetches up to the full timeout budget
  const remainingTime = Math.max(0, timeoutMs - INITIAL_WAIT_MS);
  if (remainingTime > 0) {
    await Promise.race([
      Promise.allSettled(trackPromises),
      new Promise(resolve => setTimeout(resolve, remainingTime))
    ]);
  }

  if (releaseYear) {
    allStreams.forEach(s => { s._releaseYear = releaseYear; });
  }

  // --- Deduplication & Size Normalization ---
  const deduplicatedStreams = [];
  let uncachedTagged = 0;
  for (const stream of allStreams) {
    
    // תיקון דרגון בול: נרמול גדלים מטורפים של Pack לחיפוש של פרק
    const size = getSizeGB(stream);
    if (isEpisode && size > 15) {
        const text = getTextForAnalysis(stream);
        if (/season|complete|\bs\d+\s*-\s*s?\d+|\bpacks?\b/i.test(text) || size > 30) {
            stream._effectiveSizeGB = size / 20;
        } else {
            stream._effectiveSizeGB = size;
        }
    } else {
        stream._effectiveSizeGB = size;
    }

    const sIsCached = isCached(stream);
    if (!sIsCached) uncachedTagged++;
    const sSize = stream._effectiveSizeGB;
    const sSeeders = getSeeders(stream);
    
    const isDuplicate = deduplicatedStreams.some(existing => {
      if (sIsCached !== isCached(existing)) return false;
      if (stream.url && existing.url && stream.url === existing.url) return true;
      
      const eSize = existing._effectiveSizeGB;
      if (stream.infoHash && existing.infoHash && stream.infoHash === existing.infoHash) {
        if (Math.abs(sSize - eSize) * 1024 <= 5.0) return true;
      }
      if (stream.title === existing.title && Math.abs(sSize - eSize) * 1024 <= 1.0) return true;
      
      const eSeeders = getSeeders(existing);
      if (sSeeders !== null && sSeeders === eSeeders && sSeeders > 0) {
        const t1 = (stream.title || '').trim().substring(0, 25);
        const t2 = (existing.title || '').trim().substring(0, 25);
        if (t1 && t1 === t2 && getResWeight(stream) === getResWeight(existing)) return true;
      }
      return false;
    });
    
    if (!isDuplicate) deduplicatedStreams.push(stream);
  }

  console.log(`[ESAY STREAM] 🏷️ אחרי דה-דופ: ${deduplicatedStreams.length} | uncached-tagged=${uncachedTagged} | year=${releaseYear}`);

  getWeightTiers(deduplicatedStreams);

  deduplicatedStreams.sort((a, b) => {
    const scoreA = getQualityScoreForPreSort(a, releaseYear);
    const scoreB = getQualityScoreForPreSort(b, releaseYear);
    if (scoreA !== scoreB) return scoreB - scoreA;
    const sA = getSeeders(a) ?? 0;
    const sB = getSeeders(b) ?? 0;
    if (sA !== sB) return sB - sA;
    return (b._effectiveSizeGB || getSizeGB(b)) - (a._effectiveSizeGB || getSizeGB(a));
  });

  const fakeHdrCount = deduplicatedStreams.filter(s => s._fakeHdrPenalized).length;
  if (fakeHdrCount > 0) {
    console.log(`[ESAY STREAM] 📉 Fake-HDR penalty applied to ${fakeHdrCount} streams (year=${releaseYear} < 2015)`);
  }

  // Size filter with never-empty fallback (H4)
  let sizeDropped = 0;
  const withinSize = deduplicatedStreams.filter(stream => {
    const sizeGB = getSizeGB(stream);
    if (Number.isFinite(sizeLimitGB) && sizeGB > sizeLimitGB) {
      sizeDropped++;
      debugLog('H4', 'lib/streamEngine.js:sizeFilter', 'size drop candidate', {
        name: String(stream.name || stream.title || '').slice(0, 60),
        sizeGB: Number(sizeGB.toFixed?.(2) ?? sizeGB),
        sizeLimitGB,
        isVip: isVIPSource(stream),
        type,
        isEpisode
      });
      return false;
    }
    return true;
  });
  const sizeFiltered = withinSize.length > 0 ? withinSize : deduplicatedStreams;
  if (withinSize.length === 0 && deduplicatedStreams.length > 0) {
    console.log(`[ESAY STREAM] ⚠️ כל הסטרימים מעל ${sizeLimitGB}GB — מחזיר הכל כדי לא להשאיר את המשתמש בלי תוצאות`);
    debugLog('H4', 'lib/streamEngine.js:sizeFilter', 'fallback keep all oversize', {
      total: deduplicatedStreams.length, sizeLimitGB, type, isEpisode
    });
  } else if (sizeDropped > 0) {
    console.log(`[ESAY STREAM] 📦 סוננו ${sizeDropped} סטרימים מעל ${sizeLimitGB}GB (נשארו ${withinSize.length})`);
  }

  const validStreams = sizeFiltered.filter(stream => {
    const isStreamCached = isCached(stream);
    const isStreamUsenet = isUsenet(stream);
    const seeders = getSeeders(stream);
    if (!isStreamCached && !isStreamUsenet && seeders !== null && seeders < minSeedersUncached) return false;
    return true;
  });

  const safeStreams = validStreams.filter(s => s && (s.url || s.infoHash || s.externalUrl));

  debugLog('H1', 'lib/streamEngine.js:return', 'final stream counts', {
    raw: allStreams.length,
    deduped: deduplicatedStreams.length,
    afterSize: sizeFiltered.length,
    safe: safeStreams.length,
    vipFinal: safeStreams.filter(s => isVIPSource(s)).length,
    sizeLimitGB
  });

  return safeStreams;
}
