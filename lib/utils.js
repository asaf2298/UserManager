export const REGEX_SIZE = /(\d+(?:[\.,]\d+)?)\s*(TB|GB|MB)/i;
export const REGEX_SEEDERS = /(?:👤|seeders?:?)\s*(\d+)/i;
export const REGEX_BRACKETS = /\[[^\]]*\b(torbox|tb|rd\+?|ad\+?|pm|cached|real-?debrid|all-?debrid|premiumize|elfhosted|elfcache|comet)\b[^\]]*\]/gi;
export const REGEX_PARENS = /\([^)]*\b(torbox|tb|rd\+?|ad\+?|pm|cached|real-?debrid|all-?debrid|premiumize|elfhosted|elfcache|comet)\b[^)]*\)/gi;
export const REGEX_DOWNLOAD = /\[[^\]]*(download|un[\s._-]?cached|not[\s._-]?cached|⬇️|⬇|⏳|⌛)[^\]]*\]/gi;

/**
 * Non-content "notice" rows some addons inject as if they were real streams:
 * sign-in / auth prompts (e.g. PenguPlay unconfigured), donation / funding
 * announcements (e.g. PenguPlay "monthly cost covered" — hidden by a donor
 * token we don't have), "no results" placeholder videos (e.g. YukiStreams
 * "[YS INFO] No streams found"), metadata-lookup failures (e.g. Comet
 * returning "Unable to get metadata." with its own base URL as the link
 * when it can't resolve the title on its own metadata source), and Comet's
 * "[TB🔄] Comet Sync" / "/debrid-sync/" prompt telling the user to sync
 * their debrid library and retry instead of returning real results. These
 * carry a playable `url` so they pass every other filter and would
 * otherwise show up as a fake stream.
 */
export const REGEX_NOTICE_STREAM = /\bno (?:streams?|playable streams?|movies?|shows?|sources?|results?) (?:were )?found\b|\bno direct http rows? (?:were|was) available\b|\bcould not load streams?\b|\btry another source,?\s*episode,?\s*or playback option\b|you must sign in\b|sign[\s._-]?in (?:is )?required|authentication is (?:missing|invalid|revoked)|\b(?:monthly|server|hosting) costs? (?:is|are)?\s*covered\b|\bdonor token\b|please\s+(?:donate|consider donating)|please\s+re-?configure\s+the\s+plugin|select this stream to see how to sign in|\/stream-errors\/|the operation was aborted\b|unable to get metadata\b|\/debrid-sync\/|sync\s+debrid\s+account\s+library|select this stream,?\s*then retry this title\b/i;

/** HDR / Dolby Vision / HLG — word-boundary safe (avoids matching names like "Chdrak") */
export const REGEX_HDR_FAMILY = /\b(?:hdr10\+|hdr10|hlg|dolby[\s.-]?vision|dovi)\b|\bdv\b|\bhdr\b/i;

/** Modern HDR-capable codecs — genuine HDR/DV delivery needs one of these, not 8-bit x264 */
export const REGEX_MODERN_CODEC = /\b(hevc|x265|h265|av1)\b/i;

/**
 * MediaFusion / Torrentio / Comet style uncached signals.
 * Matches with or without spaces/underscores/hyphens between tokens.
 */
export const REGEX_UNCACHED_SIGNAL = /un[\s._-]?cached|not[\s._-]?cached|⏳|⌛|⬇️|⬇|downloading|\bdownload\b|download[\s._-]?to[\s._-]?debrid|add[\s._-]?to[\s._-]?debrid|to[\s._-]?debrid|nc[\s._-]?torrent|\[dl\]|\(dl\)|instant[\s:=_-]?false|cached[\s:=_-]*\s*(?:no|false|0)/i;

/**
 * Short debrid bracket/paren tags follow a shared convention across addons
 * (Torrentio, Yastream, Comet, MediaFusion, ...): a trailing "+" or "⚡"
 * (or "instant") means the file is already cached and ready to stream
 * instantly (e.g. "[TB+]", "[RD⚡]"), while the bare abbreviation alone
 * (e.g. "[TB]", "[RD]") means the opposite — the file still needs to be
 * downloaded/cached to the debrid service first (Yastream: "Not cached
 * stream [TB] click will download stream to TorBox"). Applied uniformly
 * for every addon rather than assuming any bracketed tb/rd/ad/pm tag means
 * cached — a bare tag is actually an uncached signal.
 */
export const REGEX_BRACKET_DEBRID_CACHED = /[\(\[][^\)\]]*\b(?:tb|rd|ad|pm)[\s._-]?(?:\+|⚡|instant)[^\)\]]*[\)\]]|[\(\[][^\)\]]*\bcomet\b[^\)\]]*[\)\]]/i;
export const REGEX_BRACKET_DEBRID_UNCACHED = /[\(\[][^\)\]]*\b(?:tb|rd|ad|pm)\b(?![\s._-]?(?:\+|⚡|instant))[^\)\]]*[\)\]]/i;

export const RES_WEIGHT_MAP = {
  '4k': 4, '2160p': 4, '2160': 4, 'uhd': 4,
  '1080p': 3, 'fhd': 3,
  '720p': 2, 'hdrip': 2,
  '480p': 1, 'sd': 1
};

/** HDR era cutoff — used only as a mild caution signal, never a hard penalty on its own */
export const HDR_ERA_YEAR = 2015;
export const FAKE_HDR_PENALTY = 25;
export const OLD_HDR_CAUTION_PENALTY = 8;

/**
 * Self-declared AI/algorithmic upscales — the release explicitly says the
 * source isn't a native master at that resolution (e.g. "Ai-Upscaled",
 * "AI UPSCALE", "UPSCALE"). Otherwise these tie with genuine native remuxes
 * at the same resolution tier and rank arbitrarily.
 */
export const REGEX_UPSCALE_SIGNAL = /\bai[\s._-]?upscal(?:ed?|ing)?\b|\bupscal(?:ed?|ing)?\b/i;
export const UPSCALE_PENALTY = 20;

/**
 * Minimum P2P seeders for a *pure* torrent (no debrid backing at all) to be
 * treated as reliably finishable. Below this, whether the swarm can deliver
 * the file at all is a coin flip regardless of claimed quality.
 */
export const LOW_SEEDER_THRESHOLD = 3;

export function getTextForAnalysis(stream) {
  if (stream._text !== undefined) return stream._text;
  const fallbackText = stream.description || stream.behaviorHints?.filename || '';
  stream._text = ((stream.name || '') + ' ' + (stream.title || '') + ' ' + fallbackText).toLowerCase();
  return stream._text;
}

export function checkCacheKeywords(text) {
  const isStrongDebrid = /torbox|elfhosted|elfcache|all-?debrid|real-?debrid|premiumize|debrid-?link|stremthru|\bcached\b/i.test(text);
  const hasCachedBracketDebrid = REGEX_BRACKET_DEBRID_CACHED.test(text);
  return isStrongDebrid || hasCachedBracketDebrid;
}

/**
 * True if the stream is tied to *any* debrid service at all, cached or not
 * (e.g. bare "[TB]" meaning "queue this to TorBox"). Distinct from
 * `checkCacheKeywords`, which only matches the *cached* variant.
 */
export function hasDebridServiceTag(text) {
  return checkCacheKeywords(text) || REGEX_BRACKET_DEBRID_UNCACHED.test(text);
}

export function isNoticeStream(stream) {
  if (stream._isNotice !== undefined) return stream._isNotice;
  const text = getTextForAnalysis(stream) + ' ' + (stream.url || '');
  stream._isNotice = REGEX_NOTICE_STREAM.test(text);
  return stream._isNotice;
}

export function isUsenet(stream) {
  if (stream._isUsenet !== undefined) return stream._isUsenet;
  const text = getTextForAnalysis(stream);
  stream._isUsenet = text.includes('usenet') || text.includes('nzb');
  return stream._isUsenet;
}

export function hasUncachedSignal(text) {
  return REGEX_UNCACHED_SIGNAL.test(text) || REGEX_BRACKET_DEBRID_UNCACHED.test(text);
}

/**
 * A stream can only be verified as cached/debrid-ready if it resolves to an
 * actual playable link right now (http(s)/acestream). A magnet, raw
 * .torrent, or .nzb is a *request* to fetch content, not proof it's already
 * available — so a text claim like "[TB+]"/"real-debrid" attached to one of
 * those is unverified metadata (or a fake prefix an uploader added), not a
 * real cache signal. Applies uniformly to torrents and usenet alike.
 */
export function hasDirectLink(stream) {
  const url = stream.url;
  if (!url) return false;
  const lower = url.toLowerCase();
  if (lower.startsWith('magnet:') || lower.endsWith('.torrent') || lower.endsWith('.nzb')) return false;
  return lower.startsWith('http') || lower.startsWith('acestream');
}

/**
 * ElfHosted's "elfmagic"/ElfCache community cache layer (surfaced through
 * AIOStreams as a "Your Media" personal-library entry) binds the generated
 * playback URL to whichever IP address first requested it. Confirmed via a
 * live playback failure ("Wrong IP — Expected IP: <server IP>, Current IP:
 * <viewer's real ISP IP>"): when a server-side aggregator like this one
 * resolves the link, it gets bound to the aggregator's own egress IP, which
 * can never match the end viewer's device — the link is structurally
 * unplayable through this architecture, not just occasionally flaky.
 */
export function hasIpLockRisk(stream) {
  return (stream.url || '').toLowerCase().includes('/elfmagic/');
}

export function isCached(stream) {
  if (stream._isCached !== undefined) return stream._isCached;
  const text = getTextForAnalysis(stream);

  // חסימה אגרסיבית: זיהוי Uncached / הורדה / שעון חול (גם בלי רווחים)
  stream._isCached = (hasUncachedSignal(text) || hasIpLockRisk(stream)) ? false : hasDirectLink(stream);
  return stream._isCached;
}

export function isVIPSource(stream) {
  if (stream._isVip !== undefined) return stream._isVip;
  const sourceUrl = (stream._sourceBaseUrl || '').toLowerCase();
  
  // Host-based VIP (Kan-Box / AnimeIL)
  const vipHost = sourceUrl.includes('kan-box-addon.vercel.app') || sourceUrl.includes('animeil');

  // Content-prefix VIP: MediaFusion "telegram_bot" source / Your Media branded streams
  // (name, title, description). Matches "telegram_bot", "telegram-bot", "telegram bot"
  // (always sourced from MediaFusion), and "your media", "yourmedia", "your-media".
  // A bare "telegram" match was too broad — regional/Telegram-ripped content is often
  // re-uploaded to plain torrent/usenet indexers with an uploader credit like "-TELEGRAM"
  // in the filename, which incidentally matched and hijacked a normal cached/uncached
  // item into showing as VIP/direct-web. The specific "telegram_bot" source tag doesn't
  // have that collision risk. Genuine VIP sources are always plain single-hop HTTP links,
  // so restrict the text match to that shape. Exclude ElfCache/"elfmagic" IP-locked
  // "Your Media" entries specifically — confirmed structurally unplayable through this
  // aggregator (see hasIpLockRisk), so they must never win the VIP promotion or the
  // forced FHD resolution override that comes with it.
  const isPlainHttpLink = !stream.infoHash && !isUsenet(stream) &&
    !!stream.url && (stream.url.startsWith('http') || stream.url.startsWith('acestream'));
  const text = getTextForAnalysis(stream);
  const vipBrand = isPlainHttpLink && !hasIpLockRisk(stream) && /\btelegram[\s._-]?bot\b|your[\s._-]?media/i.test(text);

  stream._isVip = !!(vipHost || vipBrand);
  return stream._isVip;
}

export function getSeeders(stream) {
  if (stream._seeders !== undefined) return stream._seeders;
  const match = getTextForAnalysis(stream).match(REGEX_SEEDERS);
  stream._seeders = match ? parseInt(match[1], 10) : null;
  return stream._seeders;
}

export function getSizeGB(stream) {
  if (stream._sizeGB !== undefined) return stream._sizeGB;
  let size = 0;
  if (stream.behaviorHints?.videoSize) {
    size = stream.behaviorHints.videoSize / (1024 ** 3);
  } else if (stream.size) {
    size = stream.size / (1024 ** 3);
  } else {
    const match = getTextForAnalysis(stream).match(REGEX_SIZE);
    if (match) {
      const val = parseFloat(match[1].replace(',', '.'));
      const unit = match[2].toUpperCase();
      size = unit === 'MB' ? val / 1024 : unit === 'TB' ? val * 1024 : val;
    }
  }
  stream._sizeGB = size;
  return size;
}

// תיקון המיון: דליים קשיחים לפי רזולוציה שמונעים השפעה של קבצים מנופחים
export function getWeightTiers(streams) {
  for (const s of streams) {
    const size = s._effectiveSizeGB !== undefined ? s._effectiveSizeGB : getSizeGB(s);
    const res = getResWeight(s);
    let tier = 0;
    if (res === 4) {
      if (size >= 25 && size <= 150) tier = 3; else if (size >= 12) tier = 2; else if (size >= 1) tier = 1;
    } else if (res === 3) {
      if (size >= 8 && size <= 150) tier = 3; else if (size >= 3.5) tier = 2; else if (size >= 1.5) tier = 1;
    } else if (res === 2 && size <= 150) {
      if (size >= 3 && size <= 150) tier = 3; else if (size >= 1.5) tier = 2; else if (size >= 0.5) tier = 1;
    } else {
      if (size >= 1.5 && size <= 150) tier = 3; else if (size >= 0.5) tier = 2; else if (size >= 0.2) tier = 1;
    }
    s._weightTier = tier;
  }
}

export function getQualityWeight(stream) {
  if (stream._qualityWeight !== undefined) return stream._qualityWeight;
  const text = getTextForAnalysis(stream);
  let score = 0;
  if (text.includes('remux')) score = 4;
  else if (text.includes('bluray') || text.includes('bdrip') || text.includes('brrip')) score = 3;
  else if (text.includes('web-dl') || text.includes('webrip') || text.includes('web')) score = 2;
  else if (text.includes('hdtv') || text.includes('tvrip')) score = 1;
  stream._qualityWeight = score;
  return score;
}

export function getResWeight(stream) {
  if (stream._resWeight !== undefined) return stream._resWeight;
  if (isVIPSource(stream) || stream.behaviorHints?.bingeGroup === 'live-tv') {
    stream._resWeight = 3;
    return 3;
  }
  const rawText = getTextForAnalysis(stream);
  let match;
  const found = [];
  const regexRes = /(?:^|[\s\[\(\.\-_])(4k|2160p|2160|uhd|1080p|fhd|720p|hdrip|480p|sd)(?:[\s\]\)\.\-_]|$)/gi;
  while ((match = regexRes.exec(rawText)) !== null) {
    found.push(match[1].toLowerCase());
  }
  let weight = 0;
  if (found.length === 0) {
    if (rawText.includes('remux') || rawText.includes('bluray')) weight = 3;
  } else {
    const weights = [...new Set(found.map(tag => RES_WEIGHT_MAP[tag]))];
    weight = weights.length === 1 ? weights[0] : Math.max(...weights);
  }
  stream._resWeight = weight;
  return weight;
}

export function hasHdrFamilyTag(text) {
  return REGEX_HDR_FAMILY.test(text);
}

export function hasUpscaleSignal(text) {
  return REGEX_UPSCALE_SIGNAL.test(text);
}

/**
 * Contradiction-based fake-quality detection. An upscaled/noisy fake master
 * is often *larger* than a clean native one (extra bitrate spent re-encoding
 * noise/artifacts) — so file size alone can't tell a real UHD remux apart
 * from an inflated fake, and shouldn't be trusted as a quality signal on its
 * own. We instead look for internal inconsistency between the resolution
 * claim and the source/codec evidence: genuine HDR/DV delivery needs a
 * modern 10-bit-capable codec (HEVC/AV1), so HDR slapped on an 8-bit WEB/
 * HDTV rip with no BluRay/UHD/Remux source is a common "fake 4K HDR"
 * pattern regardless of how large the resulting file is. A claimed 2160p
 * file too small to plausibly hold real 4K video is also a hard tell.
 */
export function hasFakeResolutionContradiction(stream) {
  if (stream._fakeResContradiction !== undefined) return stream._fakeResContradiction;
  let suspicious = false;
  if (getResWeight(stream) === 4) {
    const text = getTextForAnalysis(stream);
    const weakSource = getQualityWeight(stream) < 3; // not remux/bluray-level
    if (hasHdrFamilyTag(text) && weakSource && !REGEX_MODERN_CODEC.test(text)) suspicious = true;
    const size = stream._effectiveSizeGB !== undefined ? stream._effectiveSizeGB : getSizeGB(stream);
    if (size > 0 && size < 1) suspicious = true;
  }
  stream._fakeResContradiction = suspicious;
  return suspicious;
}

/**
 * Combined "don't trust this claimed resolution" signal: either the uploader
 * explicitly admits it's an upscale, or the technical claims contradict each
 * other. Used to demote ranking (see `getSortResWeight`) without hiding the
 * stream or lying about its labeled resolution.
 */
export function isFakeQualitySignal(stream) {
  if (stream._fakeQuality !== undefined) return stream._fakeQuality;
  stream._fakeQuality = hasUpscaleSignal(getTextForAnalysis(stream)) || hasFakeResolutionContradiction(stream);
  return stream._fakeQuality;
}

/**
 * Mild caution (not a hard penalty): an old pre-HDR-era title tagged HDR/DV
 * on a merely-decent (not premium remux/BluRay) source. Legitimate UHD
 * restorations of classic films exist, so this never demotes sort
 * resolution — it only trims a few visual points, well below the fake-
 * quality penalty.
 */
function isOldHdrCaution(stream, releaseYear) {
  const year = releaseYear ?? stream._releaseYear ?? null;
  if (!year || year >= HDR_ERA_YEAR) return false;
  if (!hasHdrFamilyTag(getTextForAnalysis(stream))) return false;
  return getQualityWeight(stream) < 3;
}

export function getVisualWeight(stream, releaseYear = null) {
  if (stream._visualWeight !== undefined) return stream._visualWeight;
  const text = getTextForAnalysis(stream);
  let score = 0;
  if (hasHdrFamilyTag(text)) score += 2;
  if (/\b(hevc|x265|h265)\b/i.test(text)) score += 1;
  if (/\b10bit\b/i.test(text)) score += 1;

  if (hasUpscaleSignal(text)) {
    // Self-declared AI/algorithmic upscale — should rank below genuine
    // same-tier releases regardless of file size.
    score -= UPSCALE_PENALTY;
    stream._upscalePenalized = true;
  } else if (hasFakeResolutionContradiction(stream)) {
    score -= FAKE_HDR_PENALTY;
    stream._fakeHdrPenalized = true;
  } else if (isOldHdrCaution(stream, releaseYear)) {
    score -= OLD_HDR_CAUTION_PENALTY;
    stream._oldHdrCaution = true;
  }

  stream._visualWeight = score;
  return score;
}

export function getAudioWeight(stream) {
  if (stream._audioWeight !== undefined) return stream._audioWeight;
  const text = getTextForAnalysis(stream);
  let score = 1;
  if (/\b(atmos|eac3?|flac|truehd|dts-hd|dtsx)\b/i.test(text) || /\bdts[\s.-]?x\b/i.test(text)) score = 3;
  else if (/\b(dd5\.1|dd\+5\.1|5\.1|7\.1|aac5\.1)\b/i.test(text)) score = 2;
  stream._audioWeight = score;
  return score;
}

export function getLanguageWeight(stream) {
  if (stream._langWeight !== undefined) return stream._langWeight;
  const text = getTextForAnalysis(stream);
  let score = 0;
  if (text.includes('heb') || text.includes('עברית')) score = 1;
  stream._langWeight = score;
  return score;
}

/**
 * True for a raw torrent with no debrid service tie whatsoever — its
 * playback depends entirely on P2P swarm health. Debrid "download to cache"
 * items (which carry a debrid keyword/bracket tag even though they aren't
 * cached *yet*) download server-side and are not swarm-dependent, so they're
 * excluded here.
 */
export function isPureP2PUncached(stream) {
  if (!stream.infoHash || isCached(stream)) return false;
  return !hasDebridServiceTag(getTextForAnalysis(stream));
}

/** A pure P2P torrent with too few (or unknown) seeders to reliably finish. */
export function hasWeakSeederHealth(stream) {
  if (!isPureP2PUncached(stream)) return false;
  const seeders = getSeeders(stream);
  return seeders === null || seeders < LOW_SEEDER_THRESHOLD;
}

/**
 * Ranking resolution used only for sort order — never for the display badge
 * or quota bucketing, both of which keep using the true `getResWeight` so
 * labeling stays honest and per-resolution variety guarantees stay intact.
 * A claimed 4K/HDR that fails the fake-quality check, or a plain P2P
 * torrent with too few seeders to reliably finish, is treated as one
 * resolution tier lower purely for sort position, so it no longer
 * automatically outranks an honest, reliable stream just by claiming a
 * higher number. A genuine high-resolution release with healthy seeders is
 * unaffected and can still outrank weaker cached options — that's by design
 * (e.g. a strong uncached 4K remux over a weak cached 720p).
 */
export function getSortResWeight(stream) {
  const raw = getResWeight(stream);
  let weight = raw;
  if (raw >= 2 && isFakeQualitySignal(stream)) weight -= 1;
  if (raw >= 2 && hasWeakSeederHealth(stream)) weight -= 1;
  return Math.max(weight, 1);
}

export function isDirectWebStream(stream) {
  const text = getTextForAnalysis(stream);
  const hasCacheKeywords = checkCacheKeywords(text);
  return !!(stream.url &&
    (stream.url.startsWith('http') || stream.url.startsWith('acestream')) &&
    !hasCacheKeywords &&
    !isUsenet(stream) &&
    !stream.infoHash);
}

export function masterSortFunc(a, b) {
  const vipA = isVIPSource(a); const vipB = isVIPSource(b);
  if (vipA !== vipB) return vipA ? -1 : 1;
  const rA = getSortResWeight(a); const rB = getSortResWeight(b);
  if (rA !== rB) return rB - rA;
  const cA = isCached(a); const cB = isCached(b);
  if (cA !== cB) return cA ? -1 : 1;
  const wA = a._weightTier ?? 0; const wB = b._weightTier ?? 0;
  if (wA !== wB) return wB - wA;
  const qA = getQualityWeight(a); const qB = getQualityWeight(b);
  if (qA !== qB) return qB - qA;
  const vA = getVisualWeight(a); const vB = getVisualWeight(b);
  if (vA !== vB) return vB - vA;
  const aA = getAudioWeight(a); const aB = getAudioWeight(b);
  if (aA !== aB) return aB - aA;
  const lA = getLanguageWeight(a); const lB = getLanguageWeight(b);
  if (lA !== lB) return lB - lA;
  const sA = getSeeders(a) ?? 0; const sB = getSeeders(b) ?? 0;
  if (sA !== sB) return sB - sA;
  
  // השוואת משקל סופית משתמשת בגודל האפקטיבי (מנמיך פאקים של עונות)
  const sizeA = a._effectiveSizeGB !== undefined ? a._effectiveSizeGB : getSizeGB(a);
  const sizeB = b._effectiveSizeGB !== undefined ? b._effectiveSizeGB : getSizeGB(b);
  return sizeB - sizeA;
}
