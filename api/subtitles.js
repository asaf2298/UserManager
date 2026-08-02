import fetch from 'node-fetch';
import http from 'http';
import https from 'https';
import { getContentMeta, buildSearchTitles, isDubbedQuery } from './search.js';
import { parseSubtitleDurationMinutes, detectSubtitleScriptLang } from '../lib/subtitleUtils.js';
import { parseRelease, jaccard, FIELD } from '../lib/releaseParser.js';
import { buildVideoKey, parseVideoIdentityFromUrl } from '../lib/streamSighting.js';
import { pickHebrewSyncBases, buildSyncTrackDescriptors, hasKnownNoEmbeds } from '../lib/subtitleSync.js';
import { signValue } from '../lib/urlSigning.js';

const httpAgent = new http.Agent();
const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const dynamicAgent = (_parsedURL) => _parsedURL.protocol === 'http:' ? httpAgent : httpsAgent;

/** Duration agreement tolerance used by the Gaussian duration term. */
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

/**
 * Compatibility of one release attribute between the video and the subtitle.
 * Unknown is deliberately 0.5, not 0: a subtitle that simply does not state its
 * source should not be ranked as though it stated a conflicting one.
 */
function attributeCompatibility(videoValue, subValue, videoState, subState) {
    const known = videoState === FIELD.PARSED && subState === FIELD.PARSED;
    if (!known) return 0.5;
    return videoValue === subValue ? 1 : 0;
}

/** Gaussian agreement between subtitle runtime and video runtime. */
function durationCompatibility(subMinutes, videoMinutes) {
    if (!subMinutes || !videoMinutes || videoMinutes <= 0) return 0.5;
    const deviation = Math.abs(subMinutes - videoMinutes) / videoMinutes;
    return Math.exp(-0.5 * Math.pow(deviation / DURATION_MATCH_PCT, 2));
}

/**
 * Continuous subtitle relevance score in [0,100].
 *
 * Replaces the old additive keyword bonuses, which were unbounded and let one
 * lucky release-group substring outweigh every real timing signal. Provider
 * popularity is reduced to a within-request percentile so a provider that reports
 * download counts in the millions cannot dominate one that reports none.
 */
function calculateSubtitleScore({ videoRelease, subRelease, subDurationMin, videoRuntimeMin, providerPercentile }) {
    const tokenSimilarity = videoRelease
        ? jaccard(videoRelease.canonicalTokens, subRelease.canonicalTokens)
        : 0.5;

    const sourceCompat = videoRelease
        ? attributeCompatibility(
            videoRelease.source.family, subRelease.source.family,
            videoRelease.source.state, subRelease.source.state,
        )
        : 0.5;

    const groupCompat = videoRelease && videoRelease.releaseGroup && subRelease.releaseGroup
        ? (videoRelease.releaseGroup === subRelease.releaseGroup ? 1 : 0)
        : 0.5;

    const resolutionCompat = videoRelease
        ? attributeCompatibility(
            videoRelease.resolution.value, subRelease.resolution.value,
            videoRelease.resolution.state, subRelease.resolution.state,
        )
        : 0.5;

    const durationCompat = durationCompatibility(subDurationMin, videoRuntimeMin);

    return 100 * (
        0.35 * tokenSimilarity +
        0.20 * sourceCompat +
        0.15 * groupCompat +
        0.10 * resolutionCompat +
        0.15 * durationCompat +
        0.05 * providerPercentile
    );
}

/**
 * Log-normalized percentile of provider-reported popularity within this request.
 * Cross-provider raw numbers are not comparable, so they are never used directly.
 */
function buildProviderPercentiles(values) {
    const scaled = values
        .map(v => Math.log1p(Math.max(0, Number(v) || 0)))
        .filter(v => v > 0)
        .sort((a, b) => a - b);
    return (raw) => {
        if (!scaled.length) return 0.5;
        const value = Math.log1p(Math.max(0, Number(raw) || 0));
        if (value <= 0) return 0;
        let below = 0;
        for (const entry of scaled) {
            if (entry < value) below++;
            else break;
        }
        return below / scaled.length;
    };
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

function publicBaseUrl(req) {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    return host ? `${proto}://${host}` : null;
}

function buildProxyUrl(req, originalUrl) {
    try {
        const base = publicBaseUrl(req);
        if (!base) return originalUrl;
        const sig = signValue(originalUrl);
        // Without a signing key the proxy refuses anyway, so hand the client the
        // upstream URL directly rather than a link that will 403.
        if (!sig) return originalUrl;
        return `${base}/api/sub-proxy?url=${encodeURIComponent(originalUrl)}&sig=${sig}`;
    } catch {
        return originalUrl;
    }
}

export default async function handler(req, res) {
    console.log(`[PERSONAL SUBTITLES] 🟢 NEW REQUEST DETECTED: ${req.url}`); 
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

        // Stremio sends playback identity as path extras on some clients and as
        // query params on others; accept both so file matching works either way.
        const videoIdentity = parseVideoIdentityFromUrl(req.url);
        const originalFilename = videoIdentity.filename || '';
        const videoKey = buildVideoKey({ ...videoIdentity, contentId: id });

        console.log(
            `[PERSONAL SUBTITLES] 🔎 מזהה: ${id} | קובץ: ${originalFilename || 'לא נמצא'}` +
            ` | hash=${videoIdentity.videoHash || '-'} size=${videoIdentity.videoSize || '-'}` +
            ` | videoKey=${videoKey || 'none'}`
        );
        
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
            console.log(`[PERSONAL SUBTITLES] 🕒 משך וידאו ידוע: ${videoRuntimeMin ?? 'לא ידוע'} דקות`);
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
                    console.log(`[PERSONAL SUBTITLES] ⏱️ ספק ${calculatedProvider} ${reqTypeStr} הביא ${subCount} תוצאות ב-${elapsed}ms`);
                    
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
                console.log(`[PERSONAL SUBTITLES] 🔤 מריץ גיבוי טקסט: "${title}"...`);
                const searchPromises = addons.map(url => fetchSubtitleAddon(url, `search=${encodeURIComponent(title)}`, true));
                fetchPromises.push(...searchPromises);
            }
        }

        // === לוגיקת הטיימר הדינמי (Race Condition) ===
        const dynamicTimeout = new Promise((resolve) => {
            setTimeout(() => {
                const hebCount = gatheredSubs.filter(sub => classifySubtitleLang(sub.lang) === 'heb').length;

                if (hebCount >= 3) {
                    console.log(`[PERSONAL TIMEOUT] ⏱️ עברו 6 שניות. יש ${hebCount} כתוביות בעברית -> חותך את ההמתנה!`);
                    resolve('TIMEOUT_6');
                } else {
                    console.log(`[PERSONAL TIMEOUT] ⏱️ עברו 6 שניות, חסרות כתוביות בעברית (${hebCount}/3) -> מאריך ל-9 שניות...`);
                    setTimeout(() => resolve('TIMEOUT_9'), 3000);
                }
            }, 6000);
        });

        const raceResult = await Promise.race([
            Promise.allSettled(fetchPromises),
            dynamicTimeout
        ]);

        if (typeof raceResult === 'string') {
            console.warn(`[PERSONAL TIMEOUT] ⚠️ הסתיים בעקבות טיימר: ${raceResult}`);
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
                `[PERSONAL SUBTITLES] ⚠️ אין heb/eng/rus מאומתים מבין ${gatheredSubs.length} תוצאות — מחזיר ריק (לא מסמנים שפות אחרות כעברית)`
            );
        }

        console.log(`\n[PERSONAL DIAGNOSTIC] 📊 דו"ח סינון שפות:`);
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

        // The playing file's own release attributes are the comparison target for
        // every subtitle. Parsed once so all candidates score against the same facts.
        const videoRelease = originalFilename
            ? parseRelease({ title: originalFilename, name: '' }, {})
            : null;

        const providerPercentile = buildProviderPercentiles(
            withMeta.map(({ sub }) => sub.score || sub.SubRating || sub.rating || sub.downloads || 0)
        );

        withMeta.forEach(({ sub, subDur, scriptLang }, index) => {
            const l = String(sub.lang || '').toLowerCase().trim();
            let lang = sub._classifiedLang || classifySubtitleLang(l);
            if (!lang) return;

            // Provider said Hebrew but file body is clearly not → drop (don't show fake HE on TV)
            if (lang === 'heb' && scriptLang && scriptLang !== 'heb') {
                mislabelDropped++;
                console.log(
                    `[PERSONAL SUBTITLES] 🚫 כתובית סומנה עברית אך התוכן=${scriptLang} — מושמטת | ${String(sub.title || sub.id || '').slice(0, 60)}`
                );
                return;
            }
            if (scriptLang === 'heb') lang = 'heb';

            const isAuto = (l.includes('make') || l.includes('submaker')) ? 1 : 0;
            const displayType = (lang === 'heb' && isAuto) ? ' [AI 🤖]' : '';

            const subKey = `${sub.url}|${lang}`;
            if (seenSubs.has(subKey)) return;
            seenSubs.add(subKey);

            const subRelease = parseRelease(
                { title: `${sub.title || ''} ${sub.id || ''}`, name: '' },
                {},
            );
            const score = calculateSubtitleScore({
                videoRelease,
                subRelease,
                subDurationMin: subDur,
                videoRuntimeMin,
                providerPercentile: providerPercentile(sub.score || sub.SubRating || sub.rating || sub.downloads || 0),
            });

            const deviationPct = (videoRuntimeMin && subDur)
                ? Math.abs(subDur - videoRuntimeMin) / videoRuntimeMin
                : null;
            const durationMatch = deviationPct !== null && deviationPct <= DURATION_MATCH_PCT;
            if (durationMatch) durationBonusCount++;

            const provider = sub._providerName || 'Personal Sub';
            const safeId = String(sub.id || `personal${index}`).replace(/[^a-zA-Z0-9]/g, '').substring(0, 10);
            const warning = (sub.behaviorHints?.notWebReady) ? ' ⚠️ נגן חיצוני' : '';
            const rawTitle = String(sub.title || 'כתובית').replace(/\n+/g, ' ').trim();

            const durLabel = durationMatch
                ? ` sync✓${Math.round((1 - deviationPct) * 100)}%`
                : (subDur ? ` ${Math.round(subDur)}m` : '');
            const finalTitle = `${rawTitle}${displayType} [${provider}] ★${Math.round(score)}${durLabel}${warning}`
                .replace(/\s{2,}/g, ' ').trim();

            cleanedSubs.push({
                id: `personal_${index}_${safeId}`,
                url: buildProxyUrl(req, String(sub.url)),
                lang,
                title: finalTitle,
                // Kept only for sorting and sync-base selection; stripped before response.
                sourceUrl: String(sub.url),
                _classifiedLang: lang,
                _isTextSearch: sub._isTextSearch,
                _rawScore: Number.isFinite(score) ? score : 0,
                _isAuto: isAuto,
                _durationMatch: durationMatch ? 1 : 0,
            });
        });

        if (durationBonusCount > 0) {
            console.log(`[PERSONAL SUBTITLES] 🎯 התאמת משך (±5%) נמצאה ב-${durationBonusCount} כתוביות (וידאו=${videoRuntimeMin}m)`);
        }
        if (mislabelDropped > 0) {
            console.log(`[PERSONAL SUBTITLES] 🧹 הוסרו ${mislabelDropped} כתוביות שסומנו עברית אך אינן בעברית`);
        }

        // Language first (Hebrew audience), human before machine translation, then
        // the continuous relevance score.
        cleanedSubs.sort((a, b) => {
            const langRank = (l) => l === 'heb' ? 3 : (l === 'eng' ? 2 : (l === 'rus' ? 1 : 0));
            const rankDelta = langRank(b.lang) - langRank(a.lang);
            if (rankDelta !== 0) return rankDelta;
            if (a._isAuto !== b._isAuto) return a._isAuto - b._isAuto;
            if (b._rawScore !== a._rawScore) return b._rawScore - a._rawScore;
            if (a._isTextSearch !== b._isTextSearch) return a._isTextSearch ? 1 : -1;
            return a.id < b.id ? -1 : 1;
        });

        // Auto-sync tracks are advertised on the very first list. Selecting one is
        // what starts the alignment job; listing them costs nothing. Once a prior
        // job proved this file has no text embeds, stop offering the picker.
        let syncTracks = [];
        const base = publicBaseUrl(req);
        if (videoKey && base) {
            const knownNoEmbeds = await hasKnownNoEmbeds(videoKey, id);
            if (knownNoEmbeds) {
                console.log(`[PERSONAL SUBTITLES] 🔄 דילוג על סנכרון כתוביות: אין כתוביות מוטמעות בקובץ (${videoKey})`);
            } else {
                syncTracks = buildSyncTrackDescriptors({
                    bases: pickHebrewSyncBases(cleanedSubs),
                    videoKey,
                    contentType: type,
                    contentId: id,
                    publicBaseUrl: base,
                    filename: videoIdentity.filename || '',
                    videoSize: videoIdentity.videoSize,
                });
                if (syncTracks.length) {
                    console.log(`[PERSONAL SUBTITLES] 🔄 הוצעו ${syncTracks.length} מסלולי סנכרון כתוביות`);
                }
            }
        }

        const responseSubs = [...syncTracks, ...cleanedSubs].map((sub) => {
            const { sourceUrl, _classifiedLang, _isTextSearch, _rawScore, _isAuto, _durationMatch,
                _syncTrack, _syncSlot, _syncFingerprint, calculatedProvider, ...clean } = sub;
            return clean;
        });

        console.log(`[PERSONAL SUBTITLES] 🏁 הליך הסתיים. נשלחו ${responseSubs.length} כתוביות ללקוח.\n`);
        return res.status(200).json({ subtitles: responseSubs });

    } catch (error) {
        console.error('[PERSONAL SUBTITLES] 💥 Global Proxy Error:', error);
        return res.status(200).json({ subtitles: [] });
    }
}

export { calculateSubtitleScore, classifySubtitleLang, durationCompatibility };
