/**
 * Title relevance helpers — drop wrong-show matches (e.g. Utena on a Re:Zero request)
 * and detect confirmed Hebrew streams for the same content.
 */
import { getTextForAnalysis } from './utils.js';

const STOP = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'to', 'for', 'from', 'with',
  'season', 'episode', 'series', 'movie', 'film', 'vol', 'part', 'complete',
  'bluray', 'webrip', 'webdl', 'web', 'hdtv', 'remux', 'dual', 'audio', 'multi',
  'hevc', 'x264', 'x265', 'h264', 'h265', 'avc', 'aac', 'flac', 'dts', 'truehd',
  'atmos', 'hdr', 'sdr', 'uhd', 'fhd', 'bdrip', 'dvdrip',
]);

const HEBREW_RE = /[\u0590-\u05ff]|עברית|\bheb(?:rew)?\b|\bhe[\s._-]?sub|\bhe[\s._-]?dub/i;
const HEBREW_SCRIPT_RE = /[\u0590-\u05ff]/;
const NIQQUD_RE = /[\u059b-\u05c7]/g;

/**
 * Hebrew function words carry no title identity -- matching on them makes any
 * two Hebrew titles look related (#55).
 */
const HE_STOP = new Set([
  'של', 'את', 'על', 'לא', 'אל', 'הוא', 'היא', 'זה', 'זאת', 'אני', 'אנחנו',
  'עם', 'כל', 'גם', 'רק', 'אם', 'כי', 'מה', 'מי', 'יש', 'אין', 'בית',
]);

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[:'’`]/g, '')
    .replace(/[^a-z0-9\u0590-\u05ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Significant tokens from a title (latin words ≥3 chars, or any non-latin chunk). */
export function titleTokens(title) {
  const n = normalize(title);
  if (!n) return [];
  const out = [];
  for (const raw of n.split(' ')) {
    if (!raw || STOP.has(raw)) continue;
    if (/^s\d{1,2}e\d{1,3}$/i.test(raw)) continue;
    if (/^\d{3,4}p$/.test(raw)) continue;
    if (/^\d+$/.test(raw) && raw.length <= 4) continue;
    if (/^[a-z]{1,2}$/.test(raw)) continue;
    if (raw.length < 3 && !/[\u0590-\u05ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(raw)) continue;
    out.push(raw);
  }
  return out;
}

/**
 * Compact fingerprint strings for includes checks (rezero, shinigeki, etc.).
 */
export function titleFingerprints(titles) {
  const fps = new Set();
  for (const t of titles || []) {
    const n = normalize(t).replace(/\s+/g, '');
    if (n.length >= 4) fps.add(n);
    const toks = titleTokens(t);
    if (toks.length) fps.add(toks.join(''));
  }
  return [...fps];
}

/**
 * Extract the likely show name portion from a release string (before SxxExx / year / quality).
 */
export function extractReleaseShowName(text) {
  const raw = String(text || '');
  const cut = raw.split(/\bS\d{1,2}E\d{1,3}\b/i)[0]
    || raw.split(/\b(?:1080p|2160p|720p|4k|uhd|bluray|web-?dl|webrip)\b/i)[0]
    || raw.slice(0, 80);
  return cut.replace(/[\[\(].*?[\]\)]/g, ' ').trim();
}

function hebrewChunks(text) {
  return (String(text || '').match(/[\u0590-\u05ff]{2,}/g) || [])
    .map(chunk => chunk.replace(NIQQUD_RE, ''))
    .filter(chunk => chunk.length >= 2 && !HE_STOP.has(chunk));
}

/**
 * Hebrew-letter release text vs Hebrew expected titles (meta.he bridge).
 * Handles transliteration variants without requiring Latin token overlap.
 */
function hebrewTitleOverlap(releaseText, hebrewTitles) {
  const relChunks = hebrewChunks(releaseText);
  if (!relChunks.length) return false;
  const relJoined = relChunks.join('');

  for (const title of hebrewTitles) {
    const expChunks = hebrewChunks(title);
    if (!expChunks.length) continue;
    const expJoined = expChunks.join('');

    if (relJoined.length >= 3 && expJoined.length >= 3) {
      if (relJoined.includes(expJoined) || expJoined.includes(relJoined)) return true;
      const prefixLen = Math.min(4, relJoined.length, expJoined.length);
      if (prefixLen >= 3 && relJoined.slice(0, prefixLen) === expJoined.slice(0, prefixLen)) return true;
    }

    // Require a genuinely distinctive shared chunk, or two independent ones
    // (#55 -- generic 2-char chunks made any two Hebrew titles look related).
    let sharedChunks = 0;
    for (const rc of relChunks) {
      for (const ec of expChunks) {
        if (rc.length < 4 || ec.length < 4) continue;
        if (rc.includes(ec) || ec.includes(rc)) {
          if (Math.min(rc.length, ec.length) >= 5) return true;
          sharedChunks++;
        }
      }
    }
    if (sharedChunks >= 2) return true;
  }
  return false;
}

/**
 * True when stream text clearly matches expected content titles.
 * Conservative: returns true (keep) when we lack enough expected title signal.
 */
export function streamMatchesExpectedTitles(stream, expectedTitles = []) {
  const titles = (expectedTitles || []).map(t => String(t || '').trim()).filter(t => t.length >= 2);
  if (titles.length < 1) return true;

  const text = getTextForAnalysis(stream);
  const normText = normalize(text).replace(/\s+/g, '');
  const spacedText = normalize(text);
  if (!spacedText) return true;

  const fps = titleFingerprints(titles);
  for (const fp of fps) {
    if (fp.length >= 5 && normText.includes(fp)) return true;
  }

  const textTokens = new Set(titleTokens(spacedText));
  for (const title of titles) {
    const toks = titleTokens(title);
    if (toks.length < 1) continue;
    const hits = toks.filter(t => textTokens.has(t) || spacedText.includes(t));
    const strongHit = hits.some(t => t.length >= 5);
    const need = strongHit ? 1 : (toks.length <= 2 ? 1 : Math.min(2, Math.ceil(toks.length * 0.4)));
    if (hits.length >= need) return true;
  }

  const compactText = spacedText.replace(/\s+/g, '');
  for (const fp of fps) {
    if (fp.length >= 5 && compactText.includes(fp.slice(0, Math.min(fp.length, 12)))) return true;
  }

  for (const title of titles) {
    if (/[\u0590-\u05ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(title)) {
      const n = normalize(title);
      if (n.length >= 2 && spacedText.includes(n)) return true;
    }
  }

  // Hebrew-letter release ↔ meta.he (ties Hebrew release names to English/TMDB via TMDB he title)
  if (HEBREW_SCRIPT_RE.test(spacedText)) {
    const hebrewExpected = titles.filter(t => HEBREW_SCRIPT_RE.test(t));
    if (hebrewExpected.length) {
      if (hebrewTitleOverlap(spacedText, hebrewExpected)) return true;
      const releaseName = extractReleaseShowName(text);
      if (hebrewTitleOverlap(releaseName, hebrewExpected)) return true;
    }
  }

  return false;
}

function releaseTextForTitleCheck(stream) {
  const title = String(stream?.title || '').trim();
  if (title) return title;
  return getTextForAnalysis(stream);
}

/**
 * - null: keep (match or not enough signal to drop)
 * - hard: clear wrong show (e.g. Utena on Re:Zero)
 * - soft: suspected mismatch but weak / ambiguous release name
 */
export function getTitleConflictLevel(stream, expectedTitles = []) {
  const titles = (expectedTitles || []).map(t => String(t || '').trim()).filter(t => t.length >= 3);
  if (titles.length < 1) return null;
  if (streamMatchesExpectedTitles(stream, titles)) return null;

  const text = releaseTextForTitleCheck(stream);
  const releaseName = extractReleaseShowName(text);
  const releaseToks = titleTokens(releaseName);

  // Hebrew-letter release with no Latin show tokens: only hard-conflict when Hebrew also fails meta.he
  if (HEBREW_SCRIPT_RE.test(releaseName) && !releaseToks.some(t => /^[a-z]/.test(t))) {
    const hebrewExpected = titles.filter(t => HEBREW_SCRIPT_RE.test(t));
    if (hebrewExpected.length && hebrewTitleOverlap(releaseName, hebrewExpected)) return null;
    return hebrewExpected.length ? 'hard' : 'soft';
  }

  if (releaseToks.length < 1) return null;
  if (releaseToks.length < 2 && !(releaseToks[0] && releaseToks[0].length >= 6)) return 'soft';

  const expectedToks = new Set(titles.flatMap(titleTokens));
  // A title made entirely of stopword-like tokens ("1917", "300", "1984") yields
  // no tokens at all. With nothing to compare against we have no evidence of a
  // mismatch -- never hard-drop on absence (#55).
  if (expectedToks.size === 0) return null;
  const overlap = releaseToks.filter(t => expectedToks.has(t));
  if (overlap.length === 0) return 'hard';
  return 'soft';
}

/**
 * True when the release name looks like a *different* show than expected.
 * Only flags hard conflicts (backward-compatible strict check).
 */
export function streamConflictsWithExpectedTitles(stream, expectedTitles = []) {
  return getTitleConflictLevel(stream, expectedTitles) === 'hard';
}

/**
 * Soft title filter retained for callers that still want an explicit hard-drop
 * pass. Soft conflicts are *kept* (they compete via match confidence X); only
 * hard wrong-show matches are removed. Soft re-admission is gone (plan §5.1).
 */
export function filterStreamsByTitleRelevance(streams, expectedTitles = []) {
  if (!expectedTitles?.length) {
    return { streams, hardDropped: 0, softDropped: 0, readmitted: 0 };
  }

  const kept = [];
  let hardDropped = 0;

  for (const s of streams) {
    const level = getTitleConflictLevel(s, expectedTitles);
    if (level === 'hard') {
      hardDropped++;
      continue;
    }
    // Soft conflicts stay in the pool; X will down-rank them. Never drop-then-
    // re-admit based on list thinness — that was first-arrival nondeterminism.
    kept.push(s);
  }

  return { streams: kept, hardDropped, softDropped: 0, readmitted: 0 };
}

/**
 * Graded title evidence for the ranking model's match-confidence feature.
 *
 * Distinguishes "strong" (a fingerprint or a long distinctive token matched)
 * from "partial" (only short/ambiguous overlap) from "none" (we have nothing to
 * compare against) from "conflict" (this is a different show). The ranker maps
 * these to numeric confidence; unknown evidence must never score like a
 * detected conflict.
 *
 * @returns {{ level: 'strong'|'partial'|'none'|'conflict', reason: string }}
 */
export function titleMatchEvidence(stream, expectedTitles = []) {
  const titles = (expectedTitles || []).map(t => String(t || '').trim()).filter(t => t.length >= 2);
  if (titles.length < 1) return { level: 'none', reason: 'no_expected_titles' };

  const text = getTextForAnalysis(stream);
  const spacedText = normalize(text);
  if (!spacedText) return { level: 'none', reason: 'no_release_text' };
  const compactText = spacedText.replace(/\s+/g, '');

  for (const fp of titleFingerprints(titles)) {
    if (fp.length >= 5 && compactText.includes(fp)) {
      return { level: 'strong', reason: 'fingerprint' };
    }
  }

  const textTokens = new Set(titleTokens(spacedText));
  let partial = false;
  for (const title of titles) {
    const toks = titleTokens(title);
    if (!toks.length) continue;
    const hits = toks.filter(t => textTokens.has(t) || spacedText.includes(t));
    if (!hits.length) continue;
    if (hits.some(t => t.length >= 5)) return { level: 'strong', reason: 'distinctive_token' };
    const need = toks.length <= 2 ? 1 : Math.min(2, Math.ceil(toks.length * 0.4));
    if (hits.length >= need) partial = true;
  }

  if (HEBREW_SCRIPT_RE.test(spacedText)) {
    const hebrewExpected = titles.filter(t => HEBREW_SCRIPT_RE.test(t));
    if (hebrewExpected.length) {
      if (hebrewTitleOverlap(spacedText, hebrewExpected)) return { level: 'strong', reason: 'hebrew_overlap' };
      if (hebrewTitleOverlap(extractReleaseShowName(text), hebrewExpected)) {
        return { level: 'strong', reason: 'hebrew_release_name_overlap' };
      }
    }
  }

  if (partial) return { level: 'partial', reason: 'weak_token_overlap' };

  const conflict = getTitleConflictLevel(stream, titles);
  if (conflict === 'hard') return { level: 'conflict', reason: 'no_token_overlap' };
  if (conflict === 'soft') return { level: 'partial', reason: 'ambiguous_release_name' };
  return { level: 'none', reason: 'insufficient_signal' };
}

/** Hebrew audio/subs tag in stream text. */
export function streamHasHebrew(stream) {
  return HEBREW_RE.test(getTextForAnalysis(stream) || '')
    || HEBREW_RE.test(stream?.title || '')
    || HEBREW_RE.test(stream?.name || '');
}

/** Hebrew script in the release show-name portion (not just heb-sub tags). */
export function streamHasHebrewLetters(stream) {
  const text = extractReleaseShowName(releaseTextForTitleCheck(stream));
  return HEBREW_SCRIPT_RE.test(text);
}

/**
 * Confirmed Hebrew result for this content: Hebrew signal (tag or letters) + same-title match.
 */
export function isConfirmedHebrewMatch(stream, expectedTitles = []) {
  const hasHebrewSignal = streamHasHebrew(stream) || streamHasHebrewLetters(stream);
  if (!hasHebrewSignal) return false;
  if (expectedTitles?.length) return streamMatchesExpectedTitles(stream, expectedTitles);
  return true;
}
