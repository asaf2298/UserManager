/**
 * Shared subtitle helpers (duration parsing, encoding hints).
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
        console.log(`[ESAY SUB] 🔤 decoded via ${enc}`);
        return decoded;
      }
    } catch {
      // encoding unsupported on this runtime
    }
  }

  return buf.toString('utf8');
}
