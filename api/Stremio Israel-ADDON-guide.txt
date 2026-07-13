--- מפרט קישוריות מעודכן לתוסף Stremio Israel (LiveTV & VOD) ---

1. נתיבי Endpoint (עבור ה-Proxy שלך):
   - סדרות וערוצי טלוויזיה: /meta/series/{id}.json
   - סרטים: /meta/movie/{id}.json
   - סטרימים (לניגון): /stream/{type}/{id}.json

2. מבנה אובייקט ה-Meta (הבדלים בין סוגי תוכן):
   - עבור ערוצי לייב (tv):
     "meta": { "type": "tv", "videos": [] }
   - עבור סדרות (series):
     "meta": {
        "type": "series",
        "videos": [
           { "id": "{id:season:episode}", "title": "{שם הפרק}", "season": 1, "episode": 1 }
        ]
     }

3. מבנה אובייקט ה-Stream (לפי סוג תוכן):
   - עבור ערוצי לייב (חובה לניגון תקין):
     {
       "streams": [{
         "url": "{URL_מניפסט_HLS_סופי}",
         "behaviorHints": { "isWebReady": true, "notWebReady": false, "bingeGroup": "live-tv" }
       }]
     }
   - עבור סדרות (VOD):
     {
       "streams": [{
         "url": "{URL_מניפסט_HLS_סופי}",
         "behaviorHints": { "notWebReady": true }
       }]
     }

4. דרישות טכניות לפרוקסי ולאדון (Kan-Box):
   - Unwrapping: האדון חייב להחזיר לינק Raw HLS (.m3u8). פרוקסי לא אמור לבצע סקרייפינג.
   - BehaviorHints: עבור לייב - שימוש ב-isWebReady/bingeGroup. עבור סדרות - השארת notWebReady כ-true לניהול Progress (המשך צפייה).
   - Headers: העברה מלאה של User-Agent ו-X-Forwarded-For מהלקוח.
   - Cache: הגדרת cacheMaxAge: 0 לערוצי לייב בלבד.

הערות חשובות לפרוקסי:
- סדרות (Series): חובה להחזיר מערך "videos" מלא עם פירוט עונות ופרקים כדי שסטרימיו יציג את הניווט.
- ערוצי לייב: השדה "videos" חייב להישאר רשימה ריקה [] כדי לאפשר כפתור "Play" בודד ללא תפריט עונות.
- רענון Cache: כל שינוי במידע ה-Meta (במיוחד בסדרות) מחייב לעיתים רענון Cache בסטרימיו/שינוי ID זמני.
