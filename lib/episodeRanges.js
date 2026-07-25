/**
 * AniBridge-style episode range parsing and 1:1 expansion.
 * Skips comma-separated targets and ratio suffixes (|n) in v1.
 */

/** @returns {{ start: number, end: number | null } | null} */
export function parseRangePart(part) {
  const s = String(part || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] !== undefined ? Number(m[2]) : start;
  if (!Number.isFinite(start) || start < 1) return null;
  if (!Number.isFinite(end) || end < start) return null;
  return { start, end };
}

/** @returns {{ start: number, end: number | null } | null} */
export function parseSourceRange(src) {
  const s = String(src || '').trim();
  const open = s.match(/^(\d+)-$/);
  if (open) {
    const start = Number(open[1]);
    if (!Number.isFinite(start) || start < 1) return null;
    return { start, end: null };
  }
  return parseRangePart(s);
}

/** Simple contiguous target only (no commas, no |ratio). */
export function isSimpleTargetRange(tgt) {
  const s = String(tgt || '').trim();
  if (!s || s.includes(',') || s.includes('|')) return false;
  return Boolean(parseRangePart(s.replace(/-$/, '')) || s.match(/^\d+-$/));
}

/**
 * Expand one AniBridge rule into per-episode pairs.
 * @returns {{ from_e: number, to_e: number }[]}
 */
export function expandSimpleRule(srcRange, tgtRange, maxEpisodes = 80) {
  if (!isSimpleTargetRange(tgtRange)) return [];

  const src = parseSourceRange(srcRange);
  if (!src) return [];

  const tgtOpen = String(tgtRange).trim().match(/^(\d+)-$/);
  const tgt = tgtOpen
    ? { start: Number(tgtOpen[1]), end: null }
    : parseRangePart(String(tgtRange).trim());
  if (!tgt) return [];

  const srcEnd = src.end ?? (src.start + maxEpisodes - 1);
  const tgtEnd = tgt.end ?? (tgt.start + (srcEnd - src.start));
  const len = Math.min(srcEnd - src.start + 1, maxEpisodes);
  if (len <= 0) return [];

  const out = [];
  for (let i = 0; i < len; i++) {
    out.push({ from_e: src.start + i, to_e: tgt.start + i });
  }
  return out;
}

/** @returns {{ provider: string, id: string, scope?: string }} */
export function parseDescriptor(descriptor) {
  const parts = String(descriptor || '').split(':');
  if (parts.length < 2) return { provider: '', id: '' };
  return {
    provider: parts[0],
    id: parts[1],
    scope: parts[2] || undefined,
  };
}

/** Stremio season number from tvdb/tmdb/imdb scope `s1` → 1 */
export function seasonFromScope(scope) {
  if (!scope) return null;
  const m = String(scope).match(/^s(\d+)$/i);
  return m ? Number(m[1]) : null;
}
