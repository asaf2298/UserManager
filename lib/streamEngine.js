import fetch from 'node-fetch';
import { getContentMeta, buildSearchTitles, isDubbedQuery } from './search.js';
import {
  isCached, isUsenet, getSeeders, getSizeGB, isVIPSource, isNoticeStream,
  getWeightTiers, getResWeight, masterSortFunc, getTextForAnalysis,
  hasWeakSeederHealth, HDR_ERA_YEAR
} from './utils.js';
import { debugLog } from './debugLog.js';
import {
  getExtraStreamIds,
  planExtraStreamFanout,
  planAliasFanoutPhases,
  isIdResolveShadow,
  logShadowResolve,
} from './idResolve.js';
import {
  filterStreamsByTitleRelevance,
  isConfirmedHebrewMatch,
} from './titleMatch.js';

/** Extra multi-lang titles only when primary ID+EN search is still thin */
const MIN_RESULTS_FOR_EXTRA_LANG = 4;

/** Textual evidence this is a season pack / multi-episode bundle, not a single file */
const SEASON_PACK_REGEX = /season|complete|\bs\d+\s*-\s*s?\d+|\bpacks?\b/i;
/** Explicit single-episode marker (e.g. "S03E01") — strong evidence it's NOT a pack */
const SINGLE_EPISODE_MARKER_REGEX = /\bs\d{1,2}e\d{1,3}\b/i;

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

function addonHost(url) {
  try {
    return new URL(String(url).replace(/\/manifest\.json$/i, '').replace(/\/$/, '')).hostname;
  } catch {
    return String(url).slice(0, 40);
  }
}

function median(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Episode-only: oversized pack vs peers + pack text / missing SxxExx */
function isSeasonPackCandidate(stream, isEpisode, peerMedianGB) {
  if (!isEpisode) return false;
  const size = getSizeGB(stream);
  if (!(size > 0)) return false;
  const text = getTextForAnalysis(stream);
  const packText = SEASON_PACK_REGEX.test(text);
  const hasEpisodeMarker = SINGLE_EPISODE_MARKER_REGEX.test(text);
  const outlierFloor = Number.isFinite(peerMedianGB) && peerMedianGB > 0
    ? Math.max(peerMedianGB * 5, 40)
    : 80;
  const isHuge = size >= outlierFloor;
  if (packText && size > 15) return true;
  if (isHuge && !hasEpisodeMarker) return true;
  return false;
}

/**
 * Dedupe → pack-size normalize → sort → size/seeder filters.
 * Drops confirmed season packs only when the remaining list can still fill maxResults.
 * Drops clear wrong-title matches when expectedTitles are known (e.g. Utena on Re:Zero).
 */
function finalizeStreams(rawStreams, { isEpisode, sizeLimitGB, minSeedersUncached, releaseYear, maxResults, type, expectedTitles = [] }) {
  const streams = rawStreams.slice();
  if (releaseYear) {
    streams.forEach(s => { s._releaseYear = releaseYear; });
  }

  // Soft title filter: drop clear wrong-show matches; re-admit borderline when list is thin
  let titleFiltered = streams;
  if (expectedTitles.length) {
    const { streams: filtered, hardDropped, softDropped, readmitted } =
      filterStreamsByTitleRelevance(streams, expectedTitles, maxResults);
    titleFiltered = filtered;
    if (hardDropped > 0 || softDropped > 0) {
      console.log(
        `[ESAY STREAM] 🚫 Title filter: dropped hard=${hardDropped} soft=${softDropped}` +
        ` (expected ${expectedTitles.slice(0, 2).map(t => `"${t}"`).join('/')})` +
        (readmitted > 0 ? ` | re-admitted ${readmitted} borderline (thin list)` : '')
      );
    }
  }

  const peerMedianGB = median(
    titleFiltered
      .filter(s => {
        const size = getSizeGB(s);
        if (!(size > 0)) return false;
        const text = getTextForAnalysis(s);
        return !SEASON_PACK_REGEX.test(text) && SINGLE_EPISODE_MARKER_REGEX.test(text);
      })
      .map(s => getSizeGB(s))
  );

  const deduplicatedStreams = [];
  let uncachedTagged = 0;
  for (const stream of titleFiltered) {
    // תיקון דרגון בול: נרמול גדלים מטורפים של Pack לחיפוש של פרק
    //
    // Only normalize when there's actual textual evidence of a pack (season/
    // complete/pack/season-range wording), or the size is ambiguous AND there's
    // no explicit single-episode marker (e.g. "S03E01") to say otherwise. A
    // genuinely large single-episode file (a real UHD remux can legitimately
    // be 40-60+ GB for one episode) must not get discounted just for crossing
    // a raw size threshold — that previously tanked its size tier and buried
    // it below much weaker releases despite being honestly labeled.
    const size = getSizeGB(stream);
    if (isEpisode && size > 15) {
      const text = getTextForAnalysis(stream);
      const looksLikePack = SEASON_PACK_REGEX.test(text);
      const hasEpisodeMarker = SINGLE_EPISODE_MARKER_REGEX.test(text);
      if (looksLikePack || (!hasEpisodeMarker && size > 30)) {
        stream._effectiveSizeGB = size / 20;
      } else {
        stream._effectiveSizeGB = size;
      }
    } else {
      stream._effectiveSizeGB = size;
    }

    stream._isSeasonPack = isSeasonPackCandidate(stream, isEpisode, peerMedianGB);

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

  // Pre-sort with the exact same comparator used for the final display order
  // (masterSortFunc) instead of a separate weighted-sum heuristic — keeps
  // quota-bucket selection and final ranking fully consistent, so a stream
  // that wins the final sort was also preferred when buckets got trimmed.
  deduplicatedStreams.sort(masterSortFunc);

  const upscaleCount = deduplicatedStreams.filter(s => s._upscalePenalized).length;
  if (upscaleCount > 0) {
    console.log(`[ESAY STREAM] 📉 AI/upscale penalty applied to ${upscaleCount} streams (self-declared non-native resolution)`);
  }
  const fakeHdrCount = deduplicatedStreams.filter(s => s._fakeHdrPenalized).length;
  if (fakeHdrCount > 0) {
    console.log(`[ESAY STREAM] 📉 Fake-quality contradiction penalty applied to ${fakeHdrCount} streams (claimed 4K/HDR doesn't match source/codec/size evidence)`);
  }
  const oldHdrCautionCount = deduplicatedStreams.filter(s => s._oldHdrCaution).length;
  if (oldHdrCautionCount > 0) {
    console.log(`[ESAY STREAM] ⚠️ Mild old-HDR caution applied to ${oldHdrCautionCount} streams (pre-${HDR_ERA_YEAR} title, HDR tag, non-premium source — not demoted, just a small nudge)`);
  }
  const weakSeederCount = deduplicatedStreams.filter(s => hasWeakSeederHealth(s)).length;
  if (weakSeederCount > 0) {
    console.log(`[ESAY STREAM] 🐌 Reliability demotion applied to ${weakSeederCount} pure P2P streams (no debrid backing, seeders < threshold — sorts one resolution tier lower)`);
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

  // Tag confirmed Hebrew same-title hits for quota reservation in api/stream.js
  if (expectedTitles.length) {
    for (const s of safeStreams) {
      s._hebrewMatch = isConfirmedHebrewMatch(s, expectedTitles);
    }
  }

  // Drop season packs only when the non-pack list can still fill the user quota
  const targetCount = Number.isFinite(maxResults) && maxResults > 0 ? maxResults : Infinity;
  const nonPacks = safeStreams.filter(s => !s._isSeasonPack);
  const packs = safeStreams.filter(s => s._isSeasonPack);
  let finalSafe = safeStreams;
  if (packs.length > 0 && nonPacks.length >= targetCount) {
    console.log(`[ESAY STREAM] 📦 Dropping ${packs.length} season-pack stream(s); non-pack list already has ${nonPacks.length} (>= ${targetCount})`);
    finalSafe = nonPacks;
  } else if (packs.length > 0) {
    console.log(`[ESAY STREAM] 📦 Keeping ${packs.length} season-pack stream(s); non-pack only ${nonPacks.length} < ${targetCount}`);
  }

  debugLog('H1', 'lib/streamEngine.js:return', 'final stream counts', {
    raw: rawStreams.length,
    deduped: deduplicatedStreams.length,
    afterSize: sizeFiltered.length,
    safe: finalSafe.length,
    vipFinal: finalSafe.filter(s => isVIPSource(s)).length,
    sizeLimitGB,
    packsDropped: packs.length > 0 && nonPacks.length >= targetCount ? packs.length : 0
  });

  return finalSafe;
}

export async function fetchAndSortStreams(type, idWithExt, context) {
  const {
    timeoutMs, maxSizeGB, minSeedersUncached, addons, clientUA, clientIp,
    queryHint = '', maxResults = Infinity,
    idResolveContext = null,
    idResolvePromise = null,
  } = context;
  const id = idWithExt.replace('.json', '');

  // זיהוי האם הבקשה היא עבור פרק ספציפי
  const isEpisode = id.split(':').length >= 3;
  const sizeLimitGB = resolveSizeLimitGB(type, isEpisode, maxSizeGB);
  const finalizeOpts = { isEpisode, sizeLimitGB, minSeedersUncached, maxResults, type };

  // Start/reuse resolve alongside meta — never blocks when both are null (default)
  const pendingResolve = idResolveContext
    ? Promise.resolve(idResolveContext)
    : (idResolvePromise || null);

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
  finalizeOpts.releaseYear = releaseYear;

  // Resolve finishes during meta (or is already null). Empty extras → Phase 1 identical to main.
  let resolvedCtx = idResolveContext;
  if (!resolvedCtx && pendingResolve) {
    try {
      resolvedCtx = await pendingResolve;
    } catch {
      resolvedCtx = null;
    }
  }
  if (resolvedCtx && isIdResolveShadow()) logShadowResolve(resolvedCtx);

  // --- Phase 1: ID fan-out + ALWAYS primary text search (old behavior that kept VIP working) ---
  // Order preserved: (1) every addon with original tt/tmdb id, (2) optional additive mal/kitsu,
  // (3) primary text search. Extras never replace or reorder the base tt queries.
  let promises = addons.map(url => fetchFromAddon(url));

  const extraStreamIds = getExtraStreamIds(resolvedCtx);
  const extraFanout = planExtraStreamFanout(addons, extraStreamIds);
  if (extraFanout.length > 0) {
    console.log(
      `[ID-RESOLVE] extra fan-out (additive, capped): ${extraFanout.map(p => `${p.extraId}@${addonHost(p.url)}`).join(', ')}`
    );
    promises = promises.concat(extraFanout.map(({ url, extraId }) => fetchFromAddon(url, extraId)));
  }

  const hint = queryHint || id;
  const titles = contentMeta ? buildSearchTitles(contentMeta, hint) : [];
  const primaryTitle = titles[0] || null;
  // Titles used to reject wrong-show matches (Utena on Re:Zero) and confirm Hebrew hits
  const expectedTitles = [
    ...titles,
    contentMeta?.original,
    contentMeta?.he,
    ...(resolvedCtx?.aliasSearchTitles || []),
    resolvedCtx?.row?.primary_title,
  ].filter(Boolean);
  finalizeOpts.expectedTitles = [...new Set(expectedTitles)];

  const { immediate: aliasFanout, deferred: deferredAliasFanout } =
    planAliasFanoutPhases(addons, resolvedCtx, titles);
  if (aliasFanout.length > 0) {
    const uniqueTitles = [...new Set(aliasFanout.map(p => p.searchTitle))];
    console.log(
      `[ID-RESOLVE] alias text search (additive): ${uniqueTitles.map(t => `"${t}"`).join(', ')}` +
        ` on ${[...new Set(aliasFanout.map(p => addonHost(p.url)))].join(', ')}`
    );
    promises = promises.concat(
      aliasFanout.map(({ url, searchTitle }) =>
        fetchFromAddon(url, `search=${encodeURIComponent(searchTitle)}.json`)
      )
    );
  }

  // Always fire the first (preferred) title in parallel with ID — this is what Kan-Box/AnimeIL need for tt posters
  if (primaryTitle && (id.startsWith('tt') || id.startsWith('tmdb:'))) {
    console.log(`[ESAY STREAM] 🔤 חיפוש טקסט ראשי במקביל ל-ID: "${primaryTitle}"${isDubbedQuery(hint) ? ' [DUBBED→HE]' : ''}`);
    promises = promises.concat(
      addons.map(baseUrl => fetchFromAddon(baseUrl, `search=${encodeURIComponent(primaryTitle)}.json`))
    );
  }

  const trackPromises = promises.map(p => p.then(pushResults).catch(() => {}));

  const INITIAL_WAIT_MS = Math.min(5500, timeoutMs);
  const targetCount = Number.isFinite(maxResults) && maxResults > 0 ? maxResults : Infinity;
  console.log(`[ESAY STREAM] ⏱️ timeoutMs=${timeoutMs} | initialWait=${INITIAL_WAIT_MS}ms | sizeLimit=${sizeLimitGB} | maxResults=${targetCount}`);

  await Promise.race([
    Promise.allSettled(trackPromises),
    new Promise(resolve => setTimeout(resolve, INITIAL_WAIT_MS))
  ]);

  // Early stop: same finalize pipeline as the real return — stop if list can fill user quota
  const earlySafe = finalizeStreams(allStreams, finalizeOpts);
  if (earlySafe.length >= targetCount) {
    console.log(`[ESAY STREAM] ⚡ Early stop after ${INITIAL_WAIT_MS}ms — finalized ${earlySafe.length} >= maxResults ${targetCount}`);
    return earlySafe;
  }

  const afterPrimaryCount = allStreams.length;
  const vipAfterPrimary = allStreams.filter(s => isVIPSource(s)).length;
  let streamCount = afterPrimaryCount;
  let vipCount = vipAfterPrimary;
  let safeCount = earlySafe.length;
  debugLog('H1', 'lib/streamEngine.js:afterPrimary', 'after ID+primary text', {
    id: id.slice(0, 40),
    afterPrimaryCount,
    vipAfterPrimary,
    primaryTitle,
    sizeLimitGB,
    earlySafe: safeCount
  });

  // --- Phase 1b: deferred alias ONLY if still thin after initial burst (max alias >= 2) ---
  const needsDeferredAlias =
    deferredAliasFanout.length > 0 &&
    safeCount < targetCount &&
    (streamCount < MIN_RESULTS_FOR_EXTRA_LANG || vipCount === 0);

  if (needsDeferredAlias) {
    const deferredTitle = deferredAliasFanout[0].searchTitle;
    console.log(
      `[ID-RESOLVE] deferred alias text search (thin after ${INITIAL_WAIT_MS}ms, safe=${safeCount}/${targetCount}):` +
        ` "${deferredTitle}" on ${[...new Set(deferredAliasFanout.map(p => addonHost(p.url)))].join(', ')}`
    );
    const deferredPromises = deferredAliasFanout.map(({ url, searchTitle }) =>
      fetchFromAddon(url, `search=${encodeURIComponent(searchTitle)}.json`)
    );
    const remainingBudget = Math.max(0, timeoutMs - INITIAL_WAIT_MS);
    const aliasBudget = Math.min(2500, Math.max(1200, Math.floor(remainingBudget / 3)));
    if (aliasBudget >= 1200) {
      await Promise.race([
        Promise.allSettled(deferredPromises.map(p => p.then(pushResults).catch(() => {}))),
        new Promise(resolve => setTimeout(resolve, aliasBudget))
      ]);
      streamCount = allStreams.length;
      vipCount = allStreams.filter(s => isVIPSource(s)).length;
      const safeAfterDeferred = finalizeStreams(allStreams, finalizeOpts);
      safeCount = safeAfterDeferred.length;
      console.log(`[ID-RESOLVE] after deferred alias "${deferredTitle}" — raw=${streamCount} safe=${safeCount}`);
      if (safeCount >= targetCount) {
        console.log(`[ESAY STREAM] ⚡ Early stop after deferred alias — finalized ${safeCount} >= maxResults ${targetCount}`);
        return safeAfterDeferred;
      }
    } else {
      console.log(`[ID-RESOLVE] skipped deferred alias — only ${remainingBudget}ms left in timeout budget`);
    }
  }

  // --- Phase 2: extra languages ONLY if still thin OR VIP hosts returned nothing ---
  const needsExtraLang =
    (id.startsWith('tt') || id.startsWith('tmdb:')) &&
    titles.length > 1 &&
    safeCount < targetCount &&
    (streamCount < MIN_RESULTS_FOR_EXTRA_LANG || vipCount === 0);

  if (needsExtraLang) {
    const extraTitles = titles.slice(1);
    console.log(
      `[ESAY STREAM] 🔤 מרחיב לשפות נוספות (count=${streamCount}, vip=${vipCount}, safe=${safeCount}): ${JSON.stringify(extraTitles)}`
    );
    for (const title of extraTitles) {
      if (allStreams.length >= MIN_RESULTS_FOR_EXTRA_LANG * 3 && vipCount > 0) break;
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

  // Drain remaining fetches up to the full timeout budget (only when early stop did not fire)
  const remainingTime = Math.max(0, timeoutMs - INITIAL_WAIT_MS);
  if (remainingTime > 0) {
    await Promise.race([
      Promise.allSettled(trackPromises),
      new Promise(resolve => setTimeout(resolve, remainingTime))
    ]);
  }

  return finalizeStreams(allStreams, finalizeOpts);
}
