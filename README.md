
# 🚀 UserManager-Stremio (Vecret Proxy)

Vecret is a highly-optimized, serverless proxy and aggregator for Stremio addons, built to run on Vercel. It fetches, filters, pre-sorts, and deduplicates streams and subtitles from multiple addons simultaneously, delivering a blazing-fast, customizable, and buffer-free Stremio experience based on granular user profiles.

---

## 🌟 תכונות מרכזיות (Key Features)

* **מנגנון מירוץ דו-שלבי חכם (Smart Adaptive Timeout):**
הפרוקסי פונה לכל התוספים במקביל. כברירת מחדל, המערכת ממתינה **5.5 שניות** (`INITIAL_WAIT_MS`).
* **אם נאספו מספיק תוצאות** (לפחות חצי ממכסת הפרופיל) 👈 המערכת חותכת מיד למיון ושולחת את התוצאות לסטרימיו במהירות שיא.
* **אם התוצאות דלות** 👈 המערכת מנצלת באופן דינמי את יתרת הזמן שהוגדרה בפרופיל (עד 9.5 שניות) כדי לגרד מקורות מתוספים איטיים.


* **אלגוריתם המיון המוזהב (Pre-Sorting & Bucket Sort):**
כדי למנוע מקבצים פחות איכותיים לעקוף קבצים מובחרים, המערכת מבצעת **קדם-מיון (Pre-Sort) קפדני** על כל המאגר הגולמי לפני חלוקתו לדליים. המיון מבוסס על משקלי רזולוציה, קודקים, איכות שמע, כתוביות מובנות, כמות סידרים וגודל קובץ.
* **איחוד משקל HDR:**
כל משפחת ה-HDR (Dolby Vision, HDR10, HDR10+, ו-HDR רגיל) מקבלות עדיפות שווה וגבוהה (2 נקודות) כדי לאפשר בחירה חופשית של הסטרים המתאים ביותר למסך שלך.
* **ניהול מכסות וגלישת עודפים (`drawWithOverflow`):**
התוצאות מחולקות לדליים ייעודיים לפי רזולוציה וסוג (קאש מול טורנט להורדה). המערכת שואפת למלא את מכסת ה-Cached קודם. אם חסר קאש – היא מפצה על כך באנ-קאש, ואם חסר אנ-קאש – היא משלימה מקאש עודף כדי שהרשימה תמיד תישאר מלאה וזמינה.
* **הבחנה חכמה בין סוגי מקורות:**
* **זמין לצפייה (Cached):** קבצים המוזרמים ישירות משרתי ענן (RealDebrid, TorBox וכו').
* **מרשת דפדפן (Direct Web):** לינקים ישירים של `HTTP` המזוהים כצפייה ישירה (כמו Kan-Box או AnimeIL) שאינם דורשים Debrid.
* **Usenet:** לינקי HTTP המזוהים כ-Usenet מסומנים כ"זמין לצפייה" **אך ורק** אם הם מכילים מילות מפתח מפורשות של שרת ענן. אחרת, הם מתויגים כטורנט רגיל הדורש הורדה.


* **מערך כתוביות חסין קריסות (Resilient Subtitles):**
* **עקיפת SSL (Self-Signed Certificates):** מונע קריסות שרת במקרים בהם תוספי כתוביות (כמו `sub.scary.network`) משתמשים בתעודות אבטחה לא חתומות.
* **תיוג מקורות דינמי:** מוסיף בסוגריים את שם הספק האמיתי (`[opensubtitles-v3]`, `[ktuvit]`) לצד שם הכתובית בסטרימיו מבלי לדרוס את תיאור הקובץ המקורי.
* **זמן תגובה מקסימלי:** מוגבל ל-9 שניות קשיחות כדי למנוע מ-Vercel להוריד את השאלטר (מגבלת ה-10 שניות של השרת החינמי).


* **סינון וסידור קטלוגים ישראלי (Kan-Box Catalog Styling):**
המערכת טוענת את קטלוגי Kan-Box באופן דינמי: הקטלוג הראשון (הטלוויזיה החיה) מוצג בראש רשימת הקטלוגים של התוסף, שני הקטלוגים האחרונים של התוסף מסוננים החוצה אוטומטית, והשאר מקבלים תיוג יפה של `Israeli - ` לפני שמם.

---

## 🛠️ הגדרת משתני סביבה ב-Vercel (Environment Variables)

כדי שהמערכת תתפקד, יש להגדיר ב-Vercel את המשתנים הבאים בסעיף **Settings -> Environment Variables**:

### רשימת המשתנים הנדרשים:

| שם המשתנה | תפקיד המשתנה | דוגמה לערך תקין |
| --- | --- | --- |
| `ADDON_URLS` | רשימת אדאוני הסטרימינג לחיפוש (מופרדים ב-`|||`) | `[https://kan-box-addon.vercel.app](https://kan-box-addon.vercel.app)|||[https://torrentio.strem.fun/sort=](https://torrentio.strem.fun/sort=)...` |
| `SUBTITLE_URLS` | רשימת אדאוני הכתוביות לחיפוש (מופרדים ב-`|||`) | `[https://opensubtitles-v3.strem.io](https://opensubtitles-v3.strem.io)|||[https://sub.scary.network](https://sub.scary.network)` |
| `TV_ADDON_URL` | כתובת האדאון הייעודי לערוצי טלוויזיה ישראלים חיים | `[https://kan-box-addon.vercel.app](https://kan-box-addon.vercel.app)` |
| `TMDB_API_KEY` | מפתח ה-API הקצר של TMDB (גרסת v3 Auth בלבד!) | `KEY...` |
| `USER_CONFIGS` | אובייקט JSON המגדיר את הפרופילים ומפתחות הגישה של המשתמשים | *(ראה מבנה בהמשך)* |

> ⚠️ **חשוב מאוד:** אין להכניס `/manifest.json` בסוף הקישורים של האדאונים במשתני הסביבה! המערכת מנקה אותם לבד, אך עדיף להזין כתובת בסיס נקייה לחלוטין.

### מבנה ה-JSON של המשתנה `USER_CONFIGS`:

```json
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

```

---

## ⚙️ פרופילי משתמשים זמינים (User Profiles)

המערכת מיישמת הגבלות ומכסות שונות לכל פרופיל כדי להתאים לחומרה ולרוחב הפס של המשתמש:

* **`everything`:** מיועד למזרימי מדיה חזקים. עד 30 תוצאות, ללא הגבלת משקל קובץ, תמיכה מלאה ב-HDR ו-HD Audio. טיימאאוט: 9 שניות.
* **`friends_heavy`:** עד 30 תוצאות, ללא הגבלת משקל קובץ, תמיכה ב-HDR ובסאונד מתקדם. מינימום 3 סידרים לקבצים שאינם בקאש. טיימאאוט: 9 שניות.
* **`friends_light`:** פרופיל מאוזן. עד 10 תוצאות, משקל קובץ מקסימלי של 30GB, מינימום 4 סידרים לקבצים שאינם בקאש. טיימאאוט: 9 שניות.
* **`family`:** פרופיל מותאם לילדים / אינטרנט ביתי בסיסי. עד 10 תוצאות, משקל קובץ מקסימלי של 30GB, סינון אגרסיבי של קבצים ללא סידרים (מינימום 4). טיימאאוט: 9 שניות.

---

## 🔌 איך להתקין ב-Stremio

1. העתק את הכתובת של ה-Vercel Deployment שלך.
2. הרכב את הקישור בצורה הבאה:
`https://<YOUR-VERCEL-DOMAIN>/<USER_KEY>/manifest.json`
3. פתח את אפליקציית Stremio, הדבק את הקישור בשורת החיפוש/התקנת התוספים, ולחץ על **Install**.

---

## 📈 לוגים וניטור בזמן אמת (Diagnostics)

תוכל לעקוב אחר ביצועי השרת, זמני התגובה של התוספים השונים ומצב הכתוביות ישירות דרך לשונית ה-**Logs** ב-Vercel:

```text
======================================================
[ESAY DIAGNOSTIC] 🟢 בקשת סטרים חדשה!
[META HELPER] 📺 TMDB מצא סדרה: "The Five Star Weekend"
[ESAY DIAGNOSTIC] ⚡ התקבלו 44 סטרימים ב-5.5 שניות. מדלג על יתרת ההמתנה ורץ למיון!
[ESAY DIAGNOSTIC] 🏁 סיום מוצלח. נשלחו 30 תוצאות.
======================================================
[ESAY SUBTITLES] 📝 בקשת כתוביות חדשה התקבלה!
[ESAY SUBTITLES] ⏱️ תוסף https://opensubtitles-v3.strem.io (IMDb ID) סיים ב-242ms (הביא 8 כתוביות)
[ESAY SUBTITLES] ⏱️ תוסף https://KEY-ktuvit-stremio... (IMDb ID) סיים ב-539ms (הביא 3 כתוביות)
[ESAY SUBTITLES] 🏁 הליך הסתיים. נשלחו 11 כתוביות מסודרות ללקוח.
======================================================

```

---

*Built with passion for seamless, buffer-free, and high-quality Stremio streaming.*
