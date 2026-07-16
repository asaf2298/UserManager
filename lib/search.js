import fetch from 'node-fetch';
import https from 'https';

const keepAliveAgent = new https.Agent({ keepAlive: true });
const nameCache = new Map();
const MAX_CACHE_SIZE = 500;

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { agent: keepAliveAgent, ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getEnglishNameFromTMDB(imdbId) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    console.log(`[META HELPER] ⚠️ TMDB_API_KEY לא מוגדר בסביבה (Env).`);
    return null;
  }
  try {
    const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${apiKey}&external_source=imdb_id`;
    const response = await fetchWithTimeout(url, { headers: { 'Accept': 'application/json' } }, 3000);
    if (!response.ok) return null;
    const data = await response.json();
    const movie = data.movie_results?.[0];
    const tvShow = data.tv_results?.[0];
    if (movie) {
      console.log(`[META HELPER] 🎬 TMDB מצא סרט: "${movie.title}" (שם מקורי: "${movie.original_title}")`);
      return movie.title || movie.original_title;
    }
    if (tvShow) {
      console.log(`[META HELPER] 📺 TMDB מצא סדרה: "${tvShow.name}" (שם מקורי: "${tvShow.original_name}")`);
      return tvShow.name || tvShow.original_name;
    }
    return null;
  } catch (e) {
    console.error(`[META HELPER] 💥 שגיאה בפנייה ל-TMDB:`, e.message);
    return null;
  }
}

async function getMetaNameFromCinemeta(type, id) {
  try {
    const response = await fetchWithTimeout(`https://v3-cinemeta.strem.io/meta/${type}/${id}.json`, { headers: { 'Accept': 'application/json' } }, 2500);
    if (!response.ok) return null;
    const data = await response.json();
    return data.meta?.name || null;
  } catch (e) {
    return null;
  }
}

export async function getCleanMovieName(type, id) {
  const baseId = id.split(':')[0];

  if (nameCache.has(baseId)) {
    const cachedName = nameCache.get(baseId);
    console.log(`[META HELPER] ⚡ שם נשלף ישירות מהזיכרון ב-0ms עבור: ${baseId} ("${cachedName}")`);
    return cachedName;
  }

  let finalName = await getEnglishNameFromTMDB(baseId);

  if (!finalName) {
    console.log(`[META HELPER] 🔄 פונה ל-Cinemeta כפולבק עבור: ${baseId}`);
    finalName = await getMetaNameFromCinemeta(type, baseId);
  }

  if (finalName) {
    if (nameCache.size >= MAX_CACHE_SIZE) {
      const oldestKey = nameCache.keys().next().value;
      nameCache.delete(oldestKey);
    }
    nameCache.set(baseId, finalName);
  }

  return finalName;
}
