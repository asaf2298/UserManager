import fetch from 'node-fetch';
import https from 'https';

// ==========================================
// אופטימיזציות פרודקשן וניהול זיכרון
// ==========================================

// סוכן רשת השומר על חיבור פתוח לחסכון אדיר בזמני TLS Handshake מול מנועי החיפוש
const keepAliveAgent = new https.Agent({ keepAlive: true });

// מטמון זיכרון לביצועים ב-0 מילישניות מול בקשות חוזרות (Warm Cache)
const nameCache = new Map();
const MAX_CACHE_SIZE = 500; // הגנה מדליפות זיכרון בקונטיינרים ארוכי טווח

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        // הזרקת סוכן ה-Keep-Alive לכל בקשה יוצאת
        return await fetch(url, { agent: keepAliveAgent, ...options, signal: controller.signal });
    } finally {
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

/**
 * שליפת שם מ-Cinemeta (פולבק בטוח)
 */
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

/**
 * פונקציית העל המאוחדת שתשמש את הראוטרים שלנו
 */
export async function getCleanMovieName(type, id) {
    const baseId = id.split(':')[0]; // חיתוך tt11378946:1:2 ל-tt11378946
    
    // --- חומת המטמון (Cache Barrier) ---
    // אם המזהה כבר תורגם לאחרונה, מחזירים אותו מיד מבלי לפנות לרשת!
    if (nameCache.has(baseId)) {
        const cachedName = nameCache.get(baseId);
        console.log(`[META HELPER] ⚡ שם נשלף ישירות מהזיכרון ב-0ms עבור: ${baseId} ("${cachedName}")`);
        return cachedName;
    }

    let finalName = null;

    // ניסיון ראשון: שליפת שם אנגלי רשמי מ-TMDB
    finalName = await getEnglishNameFromTMDB(baseId);

    // פולבק: שליפת שם מ-Cinemeta
    if (!finalName) {
        console.log(`[META HELPER] 🔄 פונה ל-Cinemeta כפולבק עבור: ${baseId}`);
        finalName = await getMetaNameFromCinemeta(type, baseId);
    }

    // אם נמצא שם תקין, מכניסים אותו למטמון לשימוש עתידי
    if (finalName) {
        // מנגנון חכם: אם המטמון מלא, מוחקים את הערך הכי ישן (FIFO)
        if (nameCache.size >= MAX_CACHE_SIZE) {
            const oldestKey = nameCache.keys().next().value;
            nameCache.delete(oldestKey);
        }
        nameCache.set(baseId, finalName);
    }

    return finalName;
}
