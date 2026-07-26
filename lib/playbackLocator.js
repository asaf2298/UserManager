/**
 * Extract torrent identity from playable URLs when structured fields are missing.
 *
 * Debrid resolve links (Torrentio/Comet/etc.) often bury the infoHash in the path
 * even when the Stremio stream object omits `infoHash`. Sync jobs need that hash
 * to ask TorBox for a CDN locator the droplet can actually ffprobe.
 */

const INFO_HASH_RE = /\b([a-f0-9]{40})\b/i;

/**
 * @param {string} rawUrl
 * @returns {{ infoHash: string|null, fileIdx: number|null }}
 */
export function parseTorrentIdentityFromUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return { infoHash: null, fileIdx: null };

  let pathname = value;
  try {
    pathname = new URL(value).pathname;
  } catch {
    // Keep raw string.
  }

  const segments = pathname.split('/').filter(Boolean);
  let infoHash = null;
  let fileIdx = null;

  // Torrentio: /resolve/torbox/<token>/<infoHash>/<name>/<fileIdx>/<name>
  const resolveIdx = segments.findIndex(s => s.toLowerCase() === 'resolve');
  if (resolveIdx >= 0 && segments[resolveIdx + 3]) {
    const candidate = segments[resolveIdx + 3];
    if (INFO_HASH_RE.test(candidate)) {
      infoHash = candidate.toLowerCase();
      const idxSeg = segments[resolveIdx + 5];
      if (idxSeg != null && /^\d+$/.test(idxSeg)) fileIdx = Number(idxSeg);
    }
  }

  // Comet-style: /playback/<infoHash>/<fileIdx>/...
  if (!infoHash) {
    const playbackIdx = segments.findIndex(s => s.toLowerCase() === 'playback');
    if (playbackIdx >= 0 && segments[playbackIdx + 1] && INFO_HASH_RE.test(segments[playbackIdx + 1])) {
      infoHash = segments[playbackIdx + 1].toLowerCase();
      const idxSeg = segments[playbackIdx + 2];
      if (idxSeg != null && /^\d+$/.test(idxSeg)) fileIdx = Number(idxSeg);
    }
  }

  // Last resort: first 40-hex token in the path.
  if (!infoHash) {
    const match = pathname.match(INFO_HASH_RE);
    if (match) infoHash = match[1].toLowerCase();
  }

  return { infoHash, fileIdx: Number.isFinite(fileIdx) ? fileIdx : null };
}

/**
 * Best-effort release filename from a debrid resolve URL path segment.
 * Used only as a TorBox file-picker hint when structured filename is absent.
 */
export function parseFilenameFromPlaybackUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return null;
  let pathname = value;
  try {
    pathname = new URL(value).pathname;
  } catch {
    // Keep raw string.
  }
  const segments = pathname.split('/').filter(Boolean);
  const resolveIdx = segments.findIndex(s => s.toLowerCase() === 'resolve');
  if (resolveIdx >= 0 && segments[resolveIdx + 4]) {
    try {
      return decodeURIComponent(segments[resolveIdx + 4]).replace(/\+/g, ' ').trim() || null;
    } catch {
      return String(segments[resolveIdx + 4]).trim() || null;
    }
  }
  return null;
}

/**
 * Prefer structured fields; fall back to URL parsing.
 * @param {{ infoHash?: string|null, fileIdx?: number|null, playableUrl?: string|null }} input
 */
export function resolveTorrentIdentity(input = {}) {
  const fromUrl = parseTorrentIdentityFromUrl(input.playableUrl || '');
  const hash = normalizeInfoHash(input.infoHash) || fromUrl.infoHash;
  const fileIdx = Number.isFinite(Number(input.fileIdx))
    ? Number(input.fileIdx)
    : fromUrl.fileIdx;
  return { infoHash: hash, fileIdx: Number.isFinite(fileIdx) ? fileIdx : null };
}

export function normalizeInfoHash(value) {
  const clean = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{40}$/.test(clean) ? clean : null;
}

/** True when a URL is likely blocked from datacenter IPs (Cloudflare in front). */
export function looksCloudflareProxiedPlayback(rawUrl) {
  const host = (() => {
    try {
      return new URL(String(rawUrl || '')).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  if (!host) return false;
  return (
    host.includes('torrentio.strem.fun')
    || host.includes('torrentio.')
    || host.endsWith('.elfhosted.com')
    || host.includes('beamup.club')
    || host.includes('strem.fun')
  );
}
