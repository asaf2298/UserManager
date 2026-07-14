import fetch from 'node-fetch';

// פונקציית העזר האחידה למניעת תקיעות ודליפות זיכרון
async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        // עכשיו הניקוי מובטח במאת האחוזים, גם אם הייתה שגיאה!
        clearTimeout(timeoutId);
    }
}

/**
 * שליפת שם באנגלית מ-TMDB באמצעות IMDb ID (tt...)
 */
async function getEnglishNameFromTMDB(imdbId) {
    const apiKey = process.env.TMDB_API_KEY;
    if (!apiKey) {
        console.log(`[META HELPER] ⚠️ TMDB_API_KEY לא מוגדר בסביבה (Env).`);
        return null;
    }

    try {
        const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${apiKey}&external_source=imdb_id`;
        const response = await fetchWithTimeout(url, {}, 3000);

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

/**
 * שליפת שם מ-Cinemeta (פולבק בטוח)
 */
async function getMetaNameFromCinemeta(type, id) {
    try {
        const response = await fetchWithTimeout(`https://v3-cinemeta.strem.io/meta/${type}/${id}.json`, {}, 2500);
        if (!response.ok) return null;
        const data = await response.json();
        return data.meta?.name || null;
    } catch (e) {
        return null;
    }
}

/**
 * פונקציית העל המאוחדת שתשמש את הראוטרים שלנו
 */
export async function getCleanMovieName(type, id) {
    const baseId = id.split(':')[0]; // חיתוך tt11378946:1:2 ל-tt11378946
    
    // ניסיון ראשון: שליפת שם אנגלי רשמי מ-TMDB
    const englishName = await getEnglishNameFromTMDB(baseId);
    if (englishName) return englishName;

    // פולבק: שליפת שם מ-Cinemeta
    console.log(`[META HELPER] 🔄 פונה ל-Cinemeta כפולבק עבור: ${baseId}`);
    return await getMetaNameFromCinemeta(type, baseId);
}
