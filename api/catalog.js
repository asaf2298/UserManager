import fetch from 'node-fetch';

// משתנים גלובליים לשמירת מזהי הקטלוגים של הספק הישראלי בזיכרון (Cache)
// זה חוסך קריאות רשת והופך את הניתוב למהיר במיוחד
let cachedTvCatalogIds = null;
let lastCacheTime = 0;

async function getTvCatalogIds(tvAddonUrl) {
    if (!tvAddonUrl) return [];
    // שומר את הקטלוגים בזיכרון למשך שעה
    if (cachedTvCatalogIds && (Date.now() - lastCacheTime < 1000 * 60 * 60)) {
        return cachedTvCatalogIds;
    }
    try {
        const res = await fetch(`${tvAddonUrl}/manifest.json`, { timeout: 4300 });
        const manifest = await res.json();
        cachedTvCatalogIds = manifest.catalogs?.map(c => c.id) || [];
        lastCacheTime = Date.now();
        return cachedTvCatalogIds;
    } catch (e) {
        return [];
    }
}

// פונקציית עזר למציאת קטלוג החיפוש הייעודי של כל ספק
async function getSearchCatalogId(baseUrl, type) {
    try {
        const res = await fetch(`${baseUrl}/manifest.json`, { timeout: 4300 });
        const manifest = await res.json();
        // מחפש קטלוג שתומך באקסטרה "search" עבור סוג התוכן המבוקש
        const cat = manifest.catalogs?.find(c => c.type === type && c.extra?.some(e => e.name === 'search'));
        return cat ? cat.id : null;
    } catch { 
        return null; 
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        // פירוק ה-URL המגיע מסטרימיו
        const urlParts = req.url.split('?')[0].split('/');
        const catIdx = urlParts.indexOf('catalog');
        if (catIdx < 1 || catIdx + 2 >= urlParts.length) return res.status(400).json({ metas: [] });

        const userKey = urlParts[catIdx - 1];
        const type = urlParts[catIdx + 1];
        const rawCatalogId = urlParts[catIdx + 2];
        const cleanCatalogId = rawCatalogId.replace('.json', ''); // ניקוי סיומת אם קיימת כאן
        
        // כל מה שמגיע אחרי הקטלוג (למשל: 'search=avatar.json' או מסנני ז'אנרים)
        const extraPart = urlParts.slice(catIdx + 3).join('/'); 

        const configs = JSON.parse(process.env.USER_CONFIGS || '{}');
        const userConfig = configs[userKey] || {};
        
        const tvAddonUrl = (process.env.TV_ADDON_URL || '').replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
        const catalogBaseUrl = (userConfig.catalogBase || '').replace(/\/manifest\.json$/i, '').replace(/\/$/, '');

        // ==========================================
        // 1. לוגיקת החיפוש המאוחד (Unified Search)
        // ==========================================
        if (cleanCatalogId.startsWith('esay_mixed_search') && extraPart.includes('search=')) {
            console.log(`[Esay Search] Executing unified search for: ${extraPart}`);
            
            // מושכים דינמית את מזהי קטלוגי החיפוש של שני הספקים
            const [tvSearchId, aioSearchId] = await Promise.all([
                tvAddonUrl ? getSearchCatalogId(tvAddonUrl, type) : null,
                catalogBaseUrl ? getSearchCatalogId(catalogBaseUrl, type) : null
            ]);

            const searchPromises = [];

            // בקשה לספק הישראלי
            if (tvSearchId) {
                const url = `${tvAddonUrl}/catalog/${type}/${tvSearchId}/${extraPart}`;
                searchPromises.push(fetch(url).then(r => r.json()).catch(() => ({ metas: [] })));
            }

            // בקשה ל-AIO / תוכן עולמי
            if (aioSearchId) {
                const url = `${catalogBaseUrl}/catalog/${type}/${aioSearchId}/${extraPart}`;
                searchPromises.push(fetch(url).then(r => r.json()).catch(() => ({ metas: [] })));
            }

            const results = await Promise.all(searchPromises);

            // איחוד התוצאות ללא כפילויות 
            const combinedMetas = [];
            const seenIds = new Set();
            
            for (const result of results) {
                if (result && Array.isArray(result.metas)) {
                    for (const meta of result.metas) {
                        if (!seenIds.has(meta.id)) {
                            seenIds.add(meta.id);
                            combinedMetas.push(meta);
                        }
                    }
                }
            }

            return res.status(200).json({ metas: combinedMetas });
        }

        // ==========================================
        // 2. ניתוב קטלוגים רגיל (Discovery / מסך הבית)
        // ==========================================
        let targetUrl = '';
        const tvCatalogIds = await getTvCatalogIds(tvAddonUrl);

        // אם הבקשה היא לטלוויזיה חיה, *או* אם ה-ID שייך לקטלוג VOD של הספק הישראלי
        if ((type === 'tv' || type === 'channel') || tvCatalogIds.includes(cleanCatalogId)) {
            if (!tvAddonUrl) return res.status(404).json({ metas: [] });
            targetUrl = `${tvAddonUrl}/catalog/${type}/${rawCatalogId}${extraPart ? '/' + extraPart : ''}`;
        } 
        // אחרת, הבקשה שייכת ל-AIO (סרטים וסדרות גלובליים)
        else {
            if (!catalogBaseUrl) return res.status(404).json({ metas: [] });
            targetUrl = `${catalogBaseUrl}/catalog/${type}/${rawCatalogId}${extraPart ? '/' + extraPart : ''}`;
        }
        
        const fetchRes = await fetch(targetUrl);
        if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}`);
        
        const data = await fetchRes.json();
        return res.status(200).json(data);

    } catch (error) {
        console.error('Catalog Proxy Error:', error);
        return res.status(500).json({ metas: [] });
    }
}
