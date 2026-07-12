# UserManager-Stremio 🚀

Vecret is a high-performance, serverless proxy and aggregator for Stremio addons, built to run on Vercel. It fetches, filters, sorts, and deduplicates streams and subtitles from multiple addons simultaneously, delivering a blazing-fast, customized Stremio experience based on user profiles.

## תכונות מרכזיות (Key Features)

* **חיפוש מקבילי אגרסיבי (Parallel Fetching & Timeouts):** פונה למספר אדאונים במקביל (Torrentio, Comet, Meteor, AnimeIL, Kan-Box ועוד) עם טיימאאוט קשיח. אם תוסף איטי מדי (כמו AIOStreams), הוא נחתך כדי לא לעכה את הטעינה בסטרימיו.
* **ניהול פרופילים חכם (User Profiles):** 
  * everything: מביא את 25 התוצאות באיכות הגבוהה ביותר (4K Remux, משקל מקסימלי), ללא תלות בקאש, עבור החומרה החזקה ביותר.
  * friends_heavy / friends_light / family: פרופילים מוגבלים בתוצאות, במשקל ובסידרים, עם תעדוף לתוכן "זמין לצפייה" (Cached) ומנגנון שריון מקומות לטורנטים איכותיים להורדה (Uncached).
* **ניקוי כפילויות מתקדם (Deduplication):** מזהה קבצים זהים שמגיעים מתוספים שונים (לפי Hash, URL או כותרת) ומציג רק תוצאה אחת נקייה.
* **סינון כתוביות סלקטיבי (Smart Subtitles):** חוסם שפות לא רלוונטיות (פורטוגזית, צרפתית וכו') ומשאיר רק עברית, אנגלית, רוסית ו-Submaker. הכתוביות בעברית תמיד קופצות לראש הרשימה.
* **תמיכה ב-Live TV ולקטלוגים:** ניתוב ישיר (Proxy Routing) ומוגן שגיאות עבור תוספי טלוויזיה חיה וקטלוגים מותאמים (כמו AIOMetadata).

---

## התקנה והגדרות ב-Vercel (Deployment)

1. צור פרויקט חדש ב-Vercel וחבר אותו למאגר ה-GitHub הזה.
2. כנס ל-Settings -> Environment Variables והוסף את המשתנים הבאים:

### משתני סביבה (Environment Variables)

⚠️ חשוב: לעולם אל תכניס /manifest.json בסוף הלינקים של האדאונים במשתני הסביבה! השרת מנקה אותם אוטומטית, אבל עדיף להזין כתובת בסיס נקייה. יש להפריד בין אדאונים שונים באמצעות המפריד ||| (שלושה קווים אנכיים).

* ADDON_URLS: רשימת האדאונים לחיפוש סרטים וסדרות (לדוגמה: https://kan-box-addon.vercel.app|||https://torrentio.strem.fun/sort=...). הקישור הראשון ברשימה יסומן כ-VIP ויקבל עדיפות עליונה במיון.
* SUBTITLE_URLS: רשימת האדאונים לחיפוש כתוביות מופרדים ב-|||.
* TV_ADDON_URL: לינק יחיד לאדאון האחראי על ערוצי טלוויזיה חיה (Live TV).
* USER_CONFIGS: אובייקט JSON המגדיר את מפתחות הגישה, הפרופילים וכתובות הקטלוג של המשתמשים (ראה מבנה למטה).

### מבנה ה-JSON של המשתנה USER_CONFIGS:

{
  "my_secret_master_key": {
    "profile": "everything",
    "catalogBase": "https://aiometadata.elfhosted.com/stremio/YOUR_KEY"
  },
  "friend_key_1": {
    "profile": "friends_heavy",
    "catalogBase": "https://aiometadata.elfhosted.com/stremio/FRIEND_KEY"
  },
  "kids_room_key": {
    "profile": "family"
  }
}

---

## איך להתקין ב-Stremio

כדי להשתמש בשרת, פתח את אפליקציית סטרימיו, והדבק את כתובת ה-Vercel שלך יחד עם מפתח המשתמש שהגדרת ב-USER_CONFIGS.

מבנה הקישור להתקנה:
https://<YOUR-VERCEL-DOMAIN>/<USER_KEY>/manifest.json

דוגמה:
https://vecret-proxy.vercel.app/my_secret_master_key/manifest.json

---

## לוגים וניטור (Monitoring)

המערכת כוללת מנגנון מדידת זמנים (Timer) מובנה. בעת הפעלת סרט או כתובית, ניתן להיכנס ללשונית ה-Logs ב-Vercel ולראות בזמן אמת:
* כמה מילישניות לקח לכל אדאון להגיב.
* כמה תוצאות כל אדאון מצא.
* אילו אדאונים נחתכו על ידי טיימאאוט (TIMEOUT hit).
* שגיאות רשת (כגון שגיאות 404 או 500 בתוספי קצה).

דוגמה לפלט לוגים תקין:
[Vecret Timer] ⏱️  https://cometfortheweebs... responded in 180ms (Found 54 streams)
[Vecret Timer] ⏱️  https://kan-box-addon... responded in 245ms (Found 12 streams)
[Vecret Timer] ❌  https://aiostreams... TIMEOUT hit after 8500ms!

---
Built for seamless, buffer-free, and high-quality Stremio streaming.
