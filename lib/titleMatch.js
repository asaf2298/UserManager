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
    // Also joined significant tokens
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

  // Token overlap with any expected title
  const textTokens = new Set(titleTokens(spacedText));
  for (const title of titles) {
    const toks = titleTokens(title);
    if (toks.length < 1) continue;
    const hits = toks.filter(t => textTokens.has(t) || spacedText.includes(t));
    // One distinctive token (≥5 chars) is enough; otherwise require ~40% (min 2)
    const strongHit = hits.some(t => t.length >= 5);
    const need = strongHit ? 1 : (toks.length <= 2 ? 1 : Math.min(2, Math.ceil(toks.length * 0.4)));
    if (hits.length >= need) return true;
  }

  // Compact fingerprint: expected "rezero…" appears inside release text
  const compactText = spacedText.replace(/\s+/g, '');
  for (const fp of fps) {
    if (fp.length >= 5 && compactText.includes(fp.slice(0, Math.min(fp.length, 12)))) return true;
  }

  // Hebrew / CJK expected title substring
  for (const title of titles) {
    if (/[\u0590-\u05ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(title)) {
      const n = normalize(title);
      if (n.length >= 2 && spacedText.includes(n)) return true;
    }
  }

  return false;
}

/**
 * True when the release name looks like a *different* show than expected.
 * Only flags conflict when release has a clear show name that fails the match.
 */
export function streamConflictsWithExpectedTitles(stream, expectedTitles = []) {
  const titles = (expectedTitles || []).map(t => String(t || '').trim()).filter(t => t.length >= 3);
  if (titles.length < 1) return false;
  if (streamMatchesExpectedTitles(stream, titles)) return false;

  const text = getTextForAnalysis(stream);
  const releaseName = extractReleaseShowName(text);
  const releaseToks = titleTokens(releaseName);
  // Need a substantial alternate show name (2+ tokens or one long token)
  if (releaseToks.length < 2 && !(releaseToks[0] && releaseToks[0].length >= 6)) return false;

  // If release name tokens share almost nothing with expected → conflict
  const expectedToks = new Set(titles.flatMap(titleTokens));
  const overlap = releaseToks.filter(t => expectedToks.has(t));
  return overlap.length === 0;
}

/** Hebrew audio/subs signal in stream text. */
export function streamHasHebrew(stream) {
  return HEBREW_RE.test(getTextForAnalysis(stream) || '')
    || HEBREW_RE.test(stream?.title || '')
    || HEBREW_RE.test(stream?.name || '');
}

/**
 * Confirmed Hebrew result for this content: Hebrew signal + title match (or VIP host).
 */
export function isConfirmedHebrewMatch(stream, expectedTitles = []) {
  if (!streamHasHebrew(stream)) return false;
  if (expectedTitles?.length) return streamMatchesExpectedTitles(stream, expectedTitles);
  return true;
}
