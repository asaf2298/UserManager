import fetch from 'node-fetch';
import http from 'http';
import https from 'https';
import { getContentMeta, buildSearchTitles, isDubbedQuery } from './search.js';
import { parseSubtitleDurationMinutes, detectSubtitleScriptLang } from '../lib/subtitleUtils.js';

const httpAgent = new http.Agent();
const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const dynamicAgent = (_parsedURL) => _parsedURL.protocol === 'http:' ? httpAgent : httpsAgent;

/** Bonus when subtitle duration matches video duration within ±5% */
const DURATION_MATCH_BONUS = 120;
const DURATION_MATCH_PCT = 0.05;

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

/**
 * Extract duration in minutes from common subtitle provider fields / title strings.
 */
function extractDeclaredDurationMin(sub) {
    const candidates = [
        sub.duration, sub.Duration, sub.movie_time_ms, sub.MovieTimeMS,
        sub.moviehash_duration, sub.seconds, sub.runtime, sub.VideoDuration
    ];
    for (const c of candidates) {
        if (c == null || c === '') continue;
        const n = Number(c);
        if (!Number.isFinite(n) || n <= 0) continue;
        // Heuristic: values > 1000 are likely milliseconds or seconds
        if (n > 10000) return n / 60000; // ms → min
        if (n > 300) return n / 60;       // seconds → min
        return n;                        // already minutes
    }

    const blob = `${sub.title || ''} ${sub.id || ''} ${sub.description || ''}`;
    // patterns: 2h22m, 142 min, 02:22:10
    const hm = blob.match(/(\d+)\s*h(?:ours?)?\s*(\d+)\s*m/i);
    if (hm) return parseInt(hm[1], 10) * 60 + parseInt(hm[2], 10);
    const mins = blob.match(/(\d+)\s*m(?:in(?:utes?)?)?\b/i);
    if (mins) {
        const v = parseInt(mins[1], 10);
        if (v >= 20 && v <= 400) return v;
    }
    const hms = blob.match(/(\d{1,2}):(\d{2}):(\d{2})/);
    if (hms) return parseInt(hms[1], 10) * 60 + parseInt(hms[2], 10) + parseInt(hms[3], 10) / 60;

    return null;
}

function durationWithinTolerance(subMin, videoMin) {
    if (!subMin || !videoMin || videoMin <= 0) return false;
    const deviation = Math.abs(subMin - videoMin) / videoMin;
    return deviation <= DURATION_MATCH_PCT;
}

/**
 * Map provider lang → heb|eng|rus. Returns null for unknown/other.
 * NEVER defaults unknown → heb (that caused English tracks labeled Hebrew on TVs).
 */
function classifySubtitleLang(rawLang) {
    if (!rawLang) return null;
    const l = String(rawLang).toLowerCase().trim();

    const isHeb =
        ['he', 'heb', 'hebrew', 'iw', 'he-il', 'עברית'].includes(l) ||
        l.includes('heb') ||
        l.includes('עברית') ||
        l.includes('make hebrew') ||
        l.includes('submaker');
    if (isHeb) return 'heb';

    const isRus =
        l === 'ru' || l === 'rus' || l === 'russian' ||
        l.startsWith('ru ') || l.startsWith('rus ') ||
        (l.includes('rus') && !l.includes('heb'));
    if (isRus) return 'rus';

    const isEng =
        l === 'en' || l === 'eng' || l === 'english' || l === 'en-us' || l === 'en-gb' ||
        l.startsWith('en ') || l.startsWith('eng ') ||
        (l.includes('eng') && !l.includes('heb'));
    if (isEng) return 'eng';

    return null;
}

function isAllowedLang(rawLang) {
    return classifySubtitleLang(rawLang) != null;
}

function buildProxyUrl(req, originalUrl) {
    try {
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
        if (!host) return originalUrl;
        return `${proto}://${host}/api/sub-proxy?url=${encodeURIComponent(originalUrl)}`;
    } catch {
        return originalUrl;
    }
}

export default async function handler(req, res) {
    console.log(`[ESAY SUBTITLES] 🟢 NEW REQUEST DETECTED: ${req.url}`); 
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

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

        // Video duration (minutes) from TMDB/Cinemeta for ±5% sync bonus
        let videoRuntimeMin = null;
        let contentMeta = null;
        if (id.startsWith('tt') || id.startsWith('tmdb:')) {
            contentMeta = await getContentMeta(type, id);
            videoRuntimeMin = contentMeta?.runtimeMin || null;
            console.log(`[ESAY SUBTITLES] 🕒 משך וידאו ידוע: ${videoRuntimeMin ?? 'לא ידוע'} דקות`);
        }

        // המערך המשותף שמתמלא בזמן אמת ע"י הספקים
        let gatheredSubs = [];

        const fetchSubtitleAddon = async (baseUrl, customQuery, isSearch) => {
            const startTime = Date.now();
            const cleanBaseUrl = baseUrl.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
            const cleanQuery = customQuery.replace(/\.json$/, '');
            const targetUrl = `${cleanBaseUrl}/subtitles/${type}/${cleanQuery}.json`;

            let calculatedProvider = 'Personal Sub';
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

        // Multi-lang text-search backup (sequential titles) when ID path may miss regional packs
        if (id.startsWith('tt') || id.startsWith('tmdb:')) {
            const hint = decodeURIComponent(req.url || '');
            const titles = contentMeta
                ? buildSearchTitles(contentMeta, hint)
                : [];
            // Keep subtitle text-search lean: at most 2 titles (HE-first if dubbed, else EN+original)
            const titlesToTry = titles.slice(0, isDubbedQuery(hint) ? 2 : 2);
            for (const title of titlesToTry) {
                console.log(`[ESAY SUBTITLES] 🔤 מריץ גיבוי טקסט: "${title}"...`);
                const searchPromises = addons.map(url => fetchSubtitleAddon(url, `search=${encodeURIComponent(title)}`, true));
                fetchPromises.push(...searchPromises);
            }
        }

        // === לוגיקת הטיימר הדינמי (Race Condition) ===
        const dynamicTimeout = new Promise((resolve) => {
            setTimeout(() => {
                const hebCount = gatheredSubs.filter(sub => classifySubtitleLang(sub.lang) === 'heb').length;

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
            const classified = classifySubtitleLang(langStr);
            if (classified) {
                if (sub.url) seenUrls.add(sub.url);
                keptLangs[langStr] = (keptLangs[langStr] || 0) + 1;
                sub._providerName = (sub.id && sub.id.includes('opensubtitles')) ? 'OpenSubtitles' : sub.calculatedProvider;
                sub._classifiedLang = classified;
                uniqueSubs.push(sub);
            } else {
                droppedLangs[langStr] = (droppedLangs[langStr] || 0) + 1;
            }
        }

        // Honest empty > fake Hebrew. Never fall back to arbitrary langs labeled as heb.
        if (uniqueSubs.length === 0 && gatheredSubs.length > 0) {
            console.log(
                `[ESAY SUBTITLES] ⚠️ אין heb/eng/rus מאומתים מבין ${gatheredSubs.length} תוצאות — מחזיר ריק (לא מסמנים שפות אחרות כעברית)`
            );
        }

        console.log(`\n[ESAY DIAGNOSTIC] 📊 דו"ח סינון שפות:`);
        console.log(`✅ שפות שאושרו ונשמרו:`, keptLangs);
        console.log(`🚫 שפות שנחסמו ונמחקו:`, droppedLangs);

        async function peekSrt(url) {
            try {
                const resp = await fetchWithTimeout(url, {
                    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/plain,*/*', 'Range': 'bytes=0-65535' },
                    agent: dynamicAgent
                }, 2500);
                if (!resp.ok) return { durationMin: null, scriptLang: null };
                const text = await resp.text();
                return {
                    durationMin: parseSubtitleDurationMinutes(text),
                    scriptLang: detectSubtitleScriptLang(text),
                };
            } catch {
                return { durationMin: null, scriptLang: null };
            }
        }

        const cleanedSubs = [];
        const seenSubs = new Set();
        let durationBonusCount = 0;
        let mislabelDropped = 0;

        // Pre-compute declared durations; peek SRT for duration and/or Hebrew verification
        const withMeta = [];
        for (const sub of uniqueSubs) {
            if (!sub.url) continue;
            let subDur = extractDeclaredDurationMin(sub);
            withMeta.push({ sub, subDur, scriptLang: null });
        }

        const needPeek = withMeta
            .filter(x => (videoRuntimeMin && !x.subDur) || x.sub._classifiedLang === 'heb')
            .slice(0, 12);
        await Promise.all(needPeek.map(async (x) => {
            const peek = await peekSrt(x.sub.url);
            if (!x.subDur) x.subDur = peek.durationMin;
            x.scriptLang = peek.scriptLang;
        }));

        withMeta.forEach(({ sub, subDur, scriptLang }, index) => {
            const l = String(sub.lang || '').toLowerCase().trim();
            let lang = sub._classifiedLang || classifySubtitleLang(l);
            if (!lang) return;

            // Provider said Hebrew but file body is clearly not → drop (don't show fake HE on TV)
            if (lang === 'heb' && scriptLang && scriptLang !== 'heb') {
                mislabelDropped++;
                console.log(
                    `[ESAY SUBTITLES] 🚫 כתובית סומנה עברית אך התוכן=${scriptLang} — מושמטת | ${String(sub.title || sub.id || '').slice(0, 60)}`
                );
                return;
            }
            if (scriptLang === 'heb') lang = 'heb';

            let displayType = '';
            if (lang === 'heb' && (l.includes('make') || l.includes('submaker'))) {
                displayType = ' [AI 🤖]';
            }

            const subKey = `${sub.url}|${lang}`;
            if (seenSubs.has(subKey)) return;
            seenSubs.add(subKey);

            const providerScore = Number(sub.score || sub.SubRating || sub.rating || sub.downloads || 0);
            let smartScore = calculateSmartScore(originalFilename, sub.id, providerScore);

            let durationMatch = false;
            let deviationPct = null;
            if (videoRuntimeMin && subDur) {
                deviationPct = Math.abs(subDur - videoRuntimeMin) / videoRuntimeMin;
                if (deviationPct <= DURATION_MATCH_PCT) {
                    smartScore += DURATION_MATCH_BONUS;
                    durationMatch = true;
                    durationBonusCount++;
                }
            }

            const provider = sub._providerName || 'Personal Sub';
            const originalId = String(sub.id || `esay${index}`);
            const safeId = originalId.replace(/[^a-zA-Z0-9]/g, '').substring(0, 10);
            
            let warning = (sub.behaviorHints?.notWebReady) ? ' ⚠️ נגן חיצוני' : '';
            const rawTitle = String(sub.title || 'כתובית').replace(/\n+/g, ' ').trim();

            const scoreLabel = `★${Math.round(smartScore)}`;
            const durLabel = durationMatch
                ? ` sync✓${Math.round((1 - deviationPct) * 100)}%`
                : (subDur ? ` ${Math.round(subDur)}m` : '');
            const finalTitle = `${rawTitle}${displayType} [${provider}] ${scoreLabel}${durLabel}${warning}`.replace(/\s{2,}/g, ' ').trim();

            const proxiedUrl = buildProxyUrl(req, String(sub.url));

            const compliantSub = {
                id: `esay_${index}_${safeId}`,
                url: proxiedUrl,
                lang: lang,
                title: finalTitle,
                _isTextSearch: sub._isTextSearch,
                _rawScore: isNaN(smartScore) ? 0 : smartScore,
                _isAuto: (l.includes('make') || l.includes('submaker')) ? 1 : 0,
                _durationMatch: durationMatch ? 1 : 0
            };
            
            cleanedSubs.push(compliantSub);
        });

        if (durationBonusCount > 0) {
            console.log(`[ESAY SUBTITLES] 🎯 בונוס התאמת משך (±5%) הוענק ל-${durationBonusCount} כתוביות (וידאו=${videoRuntimeMin}m)`);
        }
        if (mislabelDropped > 0) {
            console.log(`[ESAY SUBTITLES] 🧹 הוסרו ${mislabelDropped} כתוביות שסומנו עברית אך אינן בעברית`);
        }

        // מיון חכם — best first (descending score), Hebrew preferred
        cleanedSubs.sort((a, b) => {
            const getScore = (l) => l === 'heb' ? 3 : (l === 'eng' ? 2 : (l === 'rus' ? 1 : 0));
            const scoreA = getScore(a.lang);
            const scoreB = getScore(b.lang);
            
            if (scoreA !== scoreB) return scoreB - scoreA;
            if (a._durationMatch !== b._durationMatch) return b._durationMatch - a._durationMatch;
            if (a._isAuto !== b._isAuto) return a._isAuto - b._isAuto; 
            if (a._isTextSearch !== b._isTextSearch) return a._isTextSearch ? 1 : -1;
            return b._rawScore - a._rawScore;
        });

        cleanedSubs.forEach(sub => {
            delete sub._isTextSearch;
            delete sub._rawScore;
            delete sub._isAuto;
            delete sub._durationMatch;
            delete sub.calculatedProvider;
        });

        console.log(`[ESAY SUBTITLES] 🏁 הליך הסתיים. נשלחו ${cleanedSubs.length} כתוביות סטריליות ללקוח.\n`);
        return res.status(200).json({ subtitles: cleanedSubs });

    } catch (error) {
        console.error('[ESAY SUBTITLES] 💥 Global Proxy Error:', error);
        return res.status(200).json({ subtitles: [] });
    }
}
