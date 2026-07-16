import fetch from 'node-fetch';
import { getCleanMovieName } from './search.js';
import {
  isCached, isUsenet, getSeeders, getSizeGB,
  getWeightTiers, getResWeight, getQualityScoreForPreSort, getTextForAnalysis
} from './utils.js';

export async function fetchAndSortStreams(type, idWithExt, context) {
  const { timeoutMs, maxSizeGB, minSeedersUncached, addons, clientUA, clientIp } = context;
  const id = idWithExt.replace('.json', '');
  
  // זיהוי האם הבקשה היא עבור פרק ספציפי
  const isEpisode = id.split(':').length >= 3;

  const fetchFromAddon = async (baseUrl, customIdWithExt = null) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const cleanBaseUrl = baseUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
    const finalIdWithExt = customIdWithExt || idWithExt;
    const targetUrl = `${cleanBaseUrl}/stream/${type}/${finalIdWithExt}`;
    const fetchHeaders = { 'User-Agent': clientUA };
    if (baseUrl.includes('kan-box-addon.vercel.app')) {
      fetchHeaders['X-Forwarded-For'] = clientIp;
    }
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

  let promises = addons.map(url => fetchFromAddon(url));

  if (id.startsWith('tt')) {
    const movieName = await getCleanMovieName(type, id);
    if (movieName) {
      const textSearchPromises = addons.map(baseUrl =>
        fetchFromAddon(baseUrl, `search=${encodeURIComponent(movieName)}.json`)
      );
      promises = promises.concat(textSearchPromises);
    }
  }

  const allStreams = [];
  const trackPromises = promises.map(p => p.then(val => {
    if (Array.isArray(val) && val.length > 0) {
        val.forEach(s => s._isEpisodeQuery = isEpisode); // מעביר מידע ל-VIP
        allStreams.push(...val);
    }
    return val;
  }).catch(() => {}));

  // לוגיקת הטיימרים נשמרת (עובדת מצוין)
  const INITIAL_WAIT_MS = Math.min(5500, timeoutMs);
  await Promise.race([
    Promise.allSettled(trackPromises),
    new Promise(resolve => setTimeout(resolve, INITIAL_WAIT_MS))
  ]);

  const remainingTime = timeoutMs - INITIAL_WAIT_MS;
  if (remainingTime > 0) {
    await Promise.race([
      Promise.allSettled(trackPromises),
      new Promise(resolve => setTimeout(resolve, remainingTime))
    ]);
  }

  // --- Deduplication & Size Normalization ---
  const deduplicatedStreams = [];
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

  getWeightTiers(deduplicatedStreams);

  deduplicatedStreams.sort((a, b) => {
    const scoreA = getQualityScoreForPreSort(a);
    const scoreB = getQualityScoreForPreSort(b);
    if (scoreA !== scoreB) return scoreB - scoreA;
    const sA = getSeeders(a) ?? 0;
    const sB = getSeeders(b) ?? 0;
    if (sA !== sB) return sB - sA;
    return (b._effectiveSizeGB || getSizeGB(b)) - (a._effectiveSizeGB || getSizeGB(a));
  });

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
