import fetch from 'node-fetch';
import http from 'http';
import https from 'https';
import { getCleanMovieName } from './search.js';

const httpAgent = new http.Agent();
const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const dynamicAgent = (_parsedURL) => _parsedURL.protocol === 'http:' ? httpAgent : httpsAgent;

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}

// === מנוע הניקוד החכם ===
function calculateSmartScore(originalFilename, subId, baseScore) {
    let score = Number(baseScore) || 0;
    if (!originalFilename || !subId) return score;

    const file = String(originalFilename).toLowerCase();
    const sub = String(subId).toLowerCase();

    // בונוסים על התאמת רזולוציה
    if (file.includes('1080p') && sub.includes('1080p')) score += 30;
    if ((file.includes('2160p') || file.includes('4k')) && (sub.includes('2160p') || sub.includes('4k'))) score += 30;
    
    // התאמות סוג מקור
    if (file.includes('bluray') && sub.includes('bluray')) score += 50;
    if (file.includes('web') && sub.includes('web')) score += 50;
    
    // התאמות קבוצות שחרור פופולריות
    if (file.includes('yts') && sub.includes('yts')) score += 100;
    if (file.includes('rarbg') && sub.includes('rarbg')) score += 100;
    if (file.includes('tgx') && sub.includes('tgx')) score += 100;

    // עונשים על חוסר סנכרון ודאי
    if (file.includes('bluray') && sub.includes('web')) score -= 50;
    if (file.includes('web') && sub.includes('bluray')) score -= 50;

    return score;
}

function isAllowedLang(rawLang) {
    if (!rawLang) return false;
    const l = rawLang.toLowerCase().trim();
    
    const exactMatches = [
        'he', 'heb', 'hebrew', 'iw', 'he-il', 'עברית',
        'ru', 'rus', 'russian',
        'en', 'eng', 'english', 'en-us', 'en-gb',
        'submaker', 'make hebrew', 'forced'
    ];
    
    if (exactMatches.includes(l)) return true;
    if (l.includes('heb') || l.includes('עברית')) return true;
    if (l.includes('rus')) return true;
    if (l.startsWith('en ') || l.startsWith('eng ')) return true;
    
    return false;
}

export default async function handler(req, res) {
    console.log(`[ESAY SUBTITLES] 🟢 NEW REQUEST DETECTED: ${req.url}`); 
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const urlParts = req.url.split('?')[0].split('/');
        const subIdx = urlParts.indexOf('subtitles');
        if (subIdx < 1 || subIdx + 2 >= urlParts.length) return res.status(400).json({ subtitles: [] });

        const type = urlParts[subIdx + 1];
        
        // חילוץ נתיב וקריאת משתני עזר (Extra)
        const remainingParts = urlParts.slice(subIdx + 2);
        let fullQueryPath = remainingParts.join('/'); 
        if (fullQueryPath.includes('%')) fullQueryPath = decodeURIComponent(fullQueryPath);
        
        const id = remainingParts[0].replace('.json', '');
        
        // חילוץ שם הקובץ לטובת ציון הסנכרון
        const urlParams = new URLSearchParams(req.url.split('?')[1] || '');
        const extraParam = urlParams.get('extra') || '';
        let originalFilename = '';
        if (extraParam.includes('filename=')) {
            const match = extraParam.match(/filename=([^&]+)/);
            if (match) originalFilename = decodeURIComponent(match[1]);
        }

        console.log(`[ESAY SUBTITLES] 🔎 חולץ מזהה: ${id} | שם קובץ לסנכרון: ${originalFilename || 'לא נמצא'}`);
        
        // סינון ספקים: חוסם את Submaker באופן אקטיבי כדי שלא יתקע את השרת
        const addonUrlsStr = process.env.SUBTITLE_URLS || '';
        const addons = addonUrlsStr.split('|||')
            .map(u => u.trim())
            .filter(url => url && !url.toLowerCase().includes('submaker'));

        if (addons.length === 0) return res.status(200).json({ subtitles: [] });

        // המערך המשותף שמתמלא בזמן אמת ע"י הספקים
        let gatheredSubs = [];

        const fetchSubtitleAddon = async (baseUrl, customQuery, isSearch) => {
            const startTime = Date.now();
            const cleanBaseUrl = baseUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
            const cleanQuery = customQuery.replace(/\.json$/, '');
            const targetUrl = `${cleanBaseUrl}/subtitles/${type}/${cleanQuery}.json`;

            let calculatedProvider = 'Esay Sub';
            const match = cleanBaseUrl.match(/https?:\/\/([^\/]+)/);
            if (match && match[1]) {
                calculatedProvider = match[1]
                    .replace('.strem.io', '')
                    .replace('.elfhosted.com', '')
                    .replace('.onrender.com', '')
                    .replace('-stremio', '')
                    .replace('.club', '');
            }

            const fetchOptions = { 
                headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json, text/plain, */*' } 
            };
            if (cleanBaseUrl.includes('sub.scary.network')) fetchOptions.agent = dynamicAgent;
            const reqTypeStr = isSearch ? '(Text Search)' : '(IMDb ID)';

            try {
                // כל ספק מקבל 9 שניות גג בפני עצמו
                const response = await fetchWithTimeout(targetUrl, fetchOptions, 9000);
                const elapsed = Date.now() - startTime;

                if (!response.ok) return;
                const data = await response.json();
                
                if (data.subtitles && data.subtitles.length > 0) {
                    const subCount = data.subtitles.length;
                    console.log(`[ESAY SUBTITLES] ⏱️ ספק ${calculatedProvider} ${reqTypeStr} הביא ${subCount} תוצאות ב-${elapsed}ms`);
                    
                    // מתייגים את התוצאות ודוחפים למערך הכללי מיד
                    const subsToAdd = data.subtitles.map(s => {
                        s._isTextSearch = isSearch;
                        s.calculatedProvider = calculatedProvider;
                        return s;
                    });
                    gatheredSubs.push(...subsToAdd);
                }
            } catch (err) {
                // התעלמות משגיאות שקטות כדי לא לתקוע את שאר הספקים
            }
        };

        const fetchPromises = addons.map(url => fetchSubtitleAddon(url, fullQueryPath, false));

        if (id.startsWith('tt') || id.startsWith('tmdb:')) {
            const cleanName = await getCleanMovieName(type, id);
            if (cleanName) {
                console.log(`[ESAY SUBTITLES] 🔤 מריץ גיבוי TMDB: "${cleanName}"...`);
                const searchPromises = addons.map(url => fetchSubtitleAddon(url, `search=${encodeURIComponent(cleanName)}`, true));
                fetchPromises.push(...searchPromises);
            }
        }

        // === לוגיקת הטיימר הדינמי (Race Condition) ===
        const dynamicTimeout = new Promise((resolve) => {
            setTimeout(() => {
                // סופרים כמה כתוביות בעברית נאספו עד נקודת ה-6 שניות
                const hebCount = gatheredSubs.filter(sub => {
                    const l = String(sub.lang || '').toLowerCase().trim();
                    return l.includes('heb') || l.includes('עברית') || l === 'he' || l === 'iw' || l === 'he-il';
                }).length;

                if (hebCount >= 3) {
                    console.log(`[ESAY TIMEOUT] ⏱️ עברו 6 שניות. יש ${hebCount} כתוביות בעברית -> חותך את ההמתנה!`);
                    resolve('TIMEOUT_6');
                } else {
                    console.log(`[ESAY TIMEOUT] ⏱️ עברו 6 שניות, חסרות כתוביות בעברית (${hebCount}/3) -> מאריך ל-9 שניות...`);
                    setTimeout(() => resolve('TIMEOUT_9'), 3000);
                }
            }, 6000);
        });

        const raceResult = await Promise.race([
            Promise.allSettled(fetchPromises),
            dynamicTimeout
        ]);

        if (typeof raceResult === 'string') {
            console.warn(`[ESAY TIMEOUT] ⚠️ הסתיים בעקבות טיימר: ${raceResult}`);
        }

        // עיבוד הנתונים שנאספו
        const seenUrls = new Set();
        let uniqueSubs = [];
        const droppedLangs = {};
        const keptLangs = {};

        for (const sub of gatheredSubs) {
            if (sub.url && seenUrls.has(sub.url)) continue;
            
            const langStr = (sub.lang || 'unknown').toLowerCase().trim();
            if (isAllowedLang(langStr)) {
                if (sub.url) seenUrls.add(sub.url);
                keptLangs[langStr] = (keptLangs[langStr] || 0) + 1;
                sub._providerName = (sub.id && sub.id.includes('opensubtitles')) ? 'OpenSubtitles' : sub.calculatedProvider;
                uniqueSubs.push(sub);
            } else {
                droppedLangs[langStr] = (droppedLangs[langStr] || 0) + 1;
            }
        }

        console.log(`\n[ESAY DIAGNOSTIC] 📊 דו"ח סינון שפות:`);
        console.log(`✅ שפות שאושרו ונשמרו:`, keptLangs);
        console.log(`🚫 שפות שנחסמו ונמחקו:`, droppedLangs);

        const cleanedSubs = [];
        const seenSubs = new Set();

        uniqueSubs.forEach((sub, index) => {
            if (!sub.url) return;

            const l = String(sub.lang || '').toLowerCase().trim();
            let lang = 'heb';
            let displayType = ''; 

            if (['ru', 'rus', 'russian'].some(s => l.includes(s))) {
                lang = 'rus';
            } else if (['en', 'eng', 'english', 'en-us', 'en-gb'].some(s => l.includes(s))) {
                lang = 'eng';
            } else {
                lang = 'heb';
                if (l.includes('make') || l.includes('submaker')) displayType = ' [AI 🤖]';
            }

            const subKey = `${sub.url}|${lang}`;
            if (seenSubs.has(subKey)) return;
            seenSubs.add(subKey);

            // הפעלת מנוע הניקוד החכם!
            const providerScore = Number(sub.score || sub.SubRating || sub.rating || sub.downloads || 0);
            const smartScore = calculateSmartScore(originalFilename, sub.id, providerScore);

            const provider = sub._providerName || 'Esay Sub';
            const originalId = String(sub.id || `esay${index}`);
            const safeId = originalId.replace(/[^a-zA-Z0-9]/g, '').substring(0, 10);
            
            let warning = (sub.behaviorHints?.notWebReady) ? ' ⚠️ נגן חיצוני' : '';
            const rawTitle = String(sub.title || 'כתובית').replace(/\n+/g, ' ').trim();
            const finalTitle = `${rawTitle}${displayType} [${provider}]${warning}`;

            const compliantSub = {
                id: `esay_${index}_${safeId}`,
                url: String(sub.url),
                lang: lang,
                title: finalTitle,
                _isTextSearch: sub._isTextSearch,
                _rawScore: isNaN(smartScore) ? 0 : smartScore,
                _isAuto: (l.includes('make') || l.includes('submaker')) ? 1 : 0 
            };
            
            cleanedSubs.push(compliantSub);
        });

        // מיון חכם
        cleanedSubs.sort((a, b) => {
            const getScore = (l) => l === 'heb' ? 3 : (l === 'eng' ? 2 : (l === 'rus' ? 1 : 0));
            const scoreA = getScore(a.lang);
            const scoreB = getScore(b.lang);
            
            if (scoreA !== scoreB) return scoreB - scoreA;
            if (a._isAuto !== b._isAuto) return a._isAuto - b._isAuto; 
            if (a._isTextSearch !== b._isTextSearch) return a._isTextSearch ? 1 : -1;
            return b._rawScore - a._rawScore;
        });

        cleanedSubs.forEach(sub => {
            delete sub._isTextSearch;
            delete sub._rawScore;
            delete sub._isAuto; 
            delete sub.calculatedProvider;
        });

        console.log(`[ESAY SUBTITLES] 🏁 הליך הסתיים. נשלחו ${cleanedSubs.length} כתוביות סטריליות ללקוח.\n`);
        return res.status(200).json({ subtitles: cleanedSubs });

    } catch (error) {
        console.error('[ESAY SUBTITLES] 💥 Global Proxy Error:', error);
        return res.status(200).json({ subtitles: [] });
    }
}
