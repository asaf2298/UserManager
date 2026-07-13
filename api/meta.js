import fetch from 'node-fetch';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    console.log(`[ESAY DIAGNOSTIC - META] 🟢 בקשת מטא נכנסת: ${req.url}`);
    console.log(`[ESAY DIAGNOSTIC - META] Headers מקוריים מהקליאנט: ${JSON.stringify(req.headers)}`);

    try {
        const urlParts = req.url.split('?')[0].split('/');
        const metaIdx = urlParts.indexOf('meta');
        
        if (metaIdx < 0 || metaIdx + 2 >= urlParts.length) {
            console.log(`[ESAY DIAGNOSTIC - META] ❌ מבנה URL לא תקין. מערך חלקים: ${JSON.stringify(urlParts)}`);
            return res.status(404).json({ meta: null });
        }

        const type = urlParts[metaIdx + 1];
        let rawIdWithExt = urlParts[metaIdx + 2];
        console.log(`[ESAY DIAGNOSTIC - META] נתונים שחולצו מה-URL -> Type: "${type}", Raw ID: "${rawIdWithExt}"`);

        // בדיקה ותיקון של קידוד כפול (Double Encoding) במזהה
        if (rawIdWithExt.includes('%')) {
            const decoded = decodeURIComponent(rawIdWithExt);
            console.log(`[ESAY DIAGNOSTIC - META] 🔄 זוהה קידוד כפול בכתובת! ניקוי: "${rawIdWithExt}" -> "${decoded}"`);
            rawIdWithExt = decoded;
        }
        
        const idWithExt = rawIdWithExt;
        const id = idWithExt.replace('.json', '');
        console.log(`[ESAY DIAGNOSTIC - META] מזהה נקי לעבודה (ללא סיומת): "${id}"`);

        // אם זה מזהה IMDb רגיל (tt), אנחנו מחזירים בכוונה 404 כדי שסטרימיו יפנה לסינמטה הרשמית
        if (id.startsWith('tt')) {
            console.log(`[ESAY DIAGNOSTIC - META] ⏩ מזהה IMDb זוהה (${id}). מחזיר 404 כדי לאפשר פולבק ל-Cinemeta.`);
            return res.status(404).json({ meta: null });
        }

        const tvAddonUrl = process.env.TV_ADDON_URL;
        console.log(`[ESAY DIAGNOSTIC - META] TV_ADDON_URL מהסביבה (Env): "${tvAddonUrl}"`);
        
        if (!tvAddonUrl) {
            console.log(`[ESAY DIAGNOSTIC - META] ❌ שגיאה: משתנה הסביבה TV_ADDON_URL ריק או לא מוגדר!`);
            return res.status(404).json({ meta: null });
        }

        const cleanTvUrl = tvAddonUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
        
        // מיפוי נתיב חובה עבור הספק המקומי: גם tv וגם channel חייבים לעבור כ-series במפרט ה-URL
        const forwardType = (type === 'tv' || type === 'channel') ? 'series' : type;
        const targetUrl = `${cleanTvUrl}/meta/${forwardType}/${idWithExt}`;
        console.log(`[ESAY DIAGNOSTIC - META] 🚀 מנתב פניית מטא אל עבר השרת המקומי: "${targetUrl}"`);

        const headers = {
            'User-Agent': req.headers['user-agent'] || 'Stremio/4.4.156',
            'Accept': 'application/json, text/plain, */*',
            'X-Forwarded-For': req.headers['x-forwarded-for'] || req.socket.remoteAddress,
            'Accept-Encoding': 'gzip'
        };
        console.log(`[ESAY DIAGNOSTIC - META] Headers שנשלחים בבקשת ה-Fetch: ${JSON.stringify(headers)}`);

        const response = await fetch(targetUrl, { headers, timeout: 5000 });
        console.log(`[ESAY DIAGNOSTIC - META] 📥 תגובה התקבלה מהשרת המקומי. סטטוס: ${response.status} ${response.statusText}`);

        if (response.ok) {
            const data = await response.json();
            console.log(`[ESAY DIAGNOSTIC - META] ✅ ה-JSON פורסר בהצלחה. הצצה לאובייקט המטא: ${JSON.stringify(data).substring(0, 300)}...`);
            return res.status(200).json(data);
        } else {
            const errorBody = await response.text().catch(() => 'N/A');
            console.log(`[ESAY DIAGNOSTIC - META] ❌ השרת המקומי החזיר קוד שגיאה. גוף התשובה הגולמי: ${errorBody.substring(0, 400)}`);
        }

        return res.status(404).json({ meta: null });

    } catch (error) {
        console.error(`[ESAY DIAGNOSTIC - META] 💥 קריסה קריטית ב-Meta Handler:`, error.stack || error);
        return res.status(404).json({ meta: null });
    }
}
