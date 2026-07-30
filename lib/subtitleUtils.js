/**
 * Shared subtitle helpers (duration parsing, encoding hints, language sniff).
 */

/**
 * Parse last SRT/VTT timestamp → duration in minutes (float).
 */
export function parseSubtitleDurationMinutes(text) {
  if (!text) return null;
  // SRT: 00:01:02,000 --> 00:01:05,000
  // VTT: 00:01:02.000 --> 00:01:05.000
  const re = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/g;
  let match;
  let lastSeconds = 0;
  while ((match = re.exec(text)) !== null) {
    const h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    const s = parseInt(match[3], 10);
    const total = h * 3600 + m * 60 + s;
    if (total > lastSeconds) lastSeconds = total;
  }
  if (lastSeconds <= 0) return null;
  return lastSeconds / 60;
}

/**
 * Sniff subtitle body script. Used to catch mislabeled "Hebrew" tracks that are actually English.
 * @returns {'heb'|'rus'|'eng'|null}
 */
export function detectSubtitleScriptLang(text) {
  if (!text) return null;
  const sample = String(text).slice(0, 12000);
  const hebrew = (sample.match(/[\u0590-\u05ff]/g) || []).length;
  const cyrillic = (sample.match(/[\u0400-\u04ff]/g) || []).length;
  const latin = (sample.match(/[A-Za-z]/g) || []).length;

  if (hebrew >= 15) return 'heb';
  if (cyrillic >= 15) return 'rus';
  if (latin >= 40 && hebrew < 5 && cyrillic < 5) return 'eng';
  return null;
}

/**
 * Count cue blocks in an SRT/VTT body.
 * Used as coverage evidence when choosing an embedded reference track: a forced
 * track with 40 cues is a far weaker alignment anchor than a dialogue track with
 * 900, even though both are valid text.
 */
export function countSubtitleCues(text) {
  if (!text) return 0;
  const matches = String(text).match(/\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/g);
  return matches ? matches.length : 0;
}

function formatSrtTimestamp(totalSeconds) {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const hh = String(Math.floor(sec / 3600)).padStart(2, '0');
  const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss},000`;
}

/**
 * Build a status SRT the player will actually show mid-playback.
 *
 * A single cue at 00:00:00 is invisible once the viewer is deep into a film.
 * Emit short repeating cues across a long window so reselecting a pending/failed
 * sync track surfaces the message near the current position.
 */
export function buildOneCueSrt(message, {
  durationSeconds = 3 * 60 * 60,
  cueSeconds = 45,
} = {}) {
  const safe = String(message || '').replace(/\r?\n/g, ' ').trim() || '...';
  const total = Math.max(cueSeconds, Math.min(6 * 60 * 60, Math.round(durationSeconds)));
  const step = Math.max(10, Math.round(cueSeconds));
  const lines = [];
  let index = 1;
  for (let start = 0; start < total; start += step) {
    const end = Math.min(total, start + step);
    lines.push(String(index));
    lines.push(`${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}`);
    lines.push(safe);
    lines.push('');
    index++;
  }
  return lines.join('\n');
}

/**
 * Stable fingerprint of a subtitle source.
 *
 * Keys the sync cache, so the same base subtitle always resolves to the same
 * aligned output. Proxy wrappers are unwrapped first: `/api/sub-proxy?url=X` and
 * a bare `X` are the same underlying subtitle.
 */
export function computeSubFingerprint(rawUrl) {
  let target = String(rawUrl || '').trim();
  if (!target) return null;
  try {
    const parsed = new URL(target, 'http://local');
    const inner = parsed.searchParams.get('url');
    if (inner) target = inner;
  } catch {
    // Not a parseable URL: fingerprint the raw string as given.
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < target.length; i++) {
    hash ^= target.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return `sub_${hash.toString(16).padStart(8, '0')}_${target.length.toString(16)}`;
}

export function looksLikeUtf8(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decode a subtitle body buffer into a UTF-8 JS string.
 * Tries UTF-8 / BOM first, then Hebrew legacy encodings, then latin1.
 */
export function decodeSubtitleBuffer(buf) {
  if (!buf || !buf.length) return '';

  // UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.slice(3).toString('utf8');
  }
  // UTF-16 LE BOM
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return buf.slice(2).toString('utf16le');
  }

  if (looksLikeUtf8(buf)) {
    return buf.toString('utf8');
  }

  for (const enc of ['windows-1255', 'iso-8859-8', 'latin1']) {
    try {
      const decoded = new TextDecoder(enc).decode(buf);
      if (/[\u0590-\u05FF]/.test(decoded) || enc === 'latin1') {
        console.log(`[PERSONAL SUB] 🔤 decoded via ${enc}`);
        return decoded;
      }
    } catch {
      // encoding unsupported on this runtime
    }
  }

  return buf.toString('utf8');
}
