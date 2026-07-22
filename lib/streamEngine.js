import fetch from 'node-fetch';
import { getContentMeta, buildSearchTitles, isDubbedQuery } from './search.js';
import {
  isCached, isUsenet, getSeeders, getSizeGB,
  getWeightTiers, getResWeight, getQualityScoreForPreSort, getTextForAnalysis
} from './utils.js';

/** Minimum ID-based results before we skip the multi-lang text-search fallback */
const MIN_ID_RESULTS_BEFORE_TEXT_SEARCH = 4;

export async function fetchAndSortStreams(type, idWithExt, context) {
  const { timeoutMs, maxSizeGB, minSeedersUncached, addons, clientUA, clientIp, queryHint = '' } = context;
  const id = idWithExt.replace('.json', '');
  
  // זיהוי האם הבקשה היא עבור פרק ספציפי
  const isEpisode = id.split(':').length >= 3;

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
    try {
      const response = await fetch(targetUrl, { signal: controller.signal, headers: fetchHeaders });
      if (!response.ok) return [];
      const data = await response.json();
      if (data && Array.isArray(data.streams)) {
        data.streams.forEach(s => s._sourceBaseUrl = baseUrl);
        return data.streams;
      }
      return [];
    } catch (err) {
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

  // --- Phase 1: primary ID-based fan-out ---
  const idPromises = addons.map(url => fetchFromAddon(url));
  const trackId = idPromises.map(p => p.then(pushResults).catch(() => {}));

  // Smart two-phase wait: initial burst, then remainder of budget
  // Capable clients (Nuvio / everything profiles with timeoutMs >= 9500) get closer to Vercel's 10s ceiling.
  const INITIAL_WAIT_MS = Math.min(5500, timeoutMs);
  console.log(`[ESAY STREAM] ⏱️ timeoutMs=${timeoutMs} | initialWait=${INITIAL_WAIT_MS}ms`);

  await Promise.race([
    Promise.allSettled(trackId),
    new Promise(resolve => setTimeout(resolve, INITIAL_WAIT_MS))
  ]);

  // --- Phase 2 (sequential): multi-lang text search ONLY if ID results are thin ---
  const idHitCount = allStreams.length;
  const needsTextSearch = (id.startsWith('tt') || id.startsWith('tmdb:')) && idHitCount < MIN_ID_RESULTS_BEFORE_TEXT_SEARCH;

  let releaseYear = null;
  let contentMeta = null;

  if (id.startsWith('tt') || id.startsWith('tmdb:')) {
    contentMeta = await getContentMeta(type, id);
    releaseYear = contentMeta?.year || null;
  }

  if (needsTextSearch && contentMeta) {
    const hint = queryHint || id;
    const titles = buildSearchTitles(contentMeta, hint);
    console.log(
      `[ESAY STREAM] 🔤 ID הביא רק ${idHitCount} תוצאות (<${MIN_ID_RESULTS_BEFORE_TEXT_SEARCH})` +
      ` → מריץ חיפוש טקסט סדרתי: ${JSON.stringify(titles)}` +
      (isDubbedQuery(hint) ? ' [DUBBED→HE]' : '')
    );

    for (const title of titles) {
      if (allStreams.length >= MIN_ID_RESULTS_BEFORE_TEXT_SEARCH * 3) {
        console.log(`[ESAY STREAM] ✅ מספיק תוצאות אחרי חיפוש "${title}" — עוצר חיפושי טקסט נוספים`);
        break;
      }
      const textPromises = addons.map(baseUrl =>
        fetchFromAddon(baseUrl, `search=${encodeURIComponent(title)}.json`)
      );
      // Bound each title search by remaining budget slice
      const perTitleBudget = Math.min(2500, Math.max(1200, Math.floor((timeoutMs - INITIAL_WAIT_MS) / Math.max(1, titles.length))));
      await Promise.race([
        Promise.allSettled(textPromises.map(p => p.then(pushResults).catch(() => {}))),
        new Promise(resolve => setTimeout(resolve, perTitleBudget))
      ]);
      console.log(`[ESAY STREAM] 🔤 אחרי חיפוש "${title}" — סה"כ ${allStreams.length} סטרימים גולמיים`);
    }
  } else if (id.startsWith('tt') || id.startsWith('tmdb:')) {
    console.log(`[ESAY STREAM] ⚡ מדלג על חיפוש טקסט — ID הביא ${idHitCount} תוצאות`);
  }

  // Drain remaining ID fetches up to the full timeout budget
  const remainingTime = Math.max(0, timeoutMs - INITIAL_WAIT_MS);
  if (remainingTime > 0) {
    await Promise.race([
      Promise.allSettled(trackId),
      new Promise(resolve => setTimeout(resolve, remainingTime))
    ]);
  }

  // Stamp release year onto streams for fake-HDR scoring
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
            stream._effectiveSizeGB = size / 20; // חילוק העונה לממוצע פרקים כדי להוריד בדירוג
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

  const validStreams = deduplicatedStreams.filter(stream => {
    const sizeGB = getSizeGB(stream); // משתמשים בגודל האמיתי לסינון מוחלט
    const isStreamCached = isCached(stream);
    const isStreamUsenet = isUsenet(stream);
    const seeders = getSeeders(stream);
    
    if (sizeGB > maxSizeGB) return false;
    if (!isStreamCached && !isStreamUsenet && seeders !== null && seeders < minSeedersUncached) return false;
    return true;
  });

  const safeStreams = validStreams.filter(s => s && (s.url || s.infoHash || s.externalUrl));

  return safeStreams;
}
