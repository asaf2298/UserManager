export const REGEX_SIZE = /(\d+(?:[\.,]\d+)?)\s*(GB|MB)/i;
export const REGEX_SEEDERS = /(?:👤|seeders?:?)\s*(\d+)/i;
export const REGEX_BRACKETS = /\[[^\]]*\b(torbox|tb|rd\+?|ad\+?|pm|cached|real-?debrid|all-?debrid|premiumize|elfhosted|elfcache|comet)\b[^\]]*\]/gi;
export const REGEX_PARENS = /\([^)]*\b(torbox|tb|rd\+?|ad\+?|pm|cached|real-?debrid|all-?debrid|premiumize|elfhosted|elfcache|comet)\b[^)]*\)/gi;
export const REGEX_DOWNLOAD = /\[[^\]]*(download|un[\s._-]?cached|not[\s._-]?cached|⬇️|⬇|⏳|⌛)[^\]]*\]/gi;

/**
 * Non-content "notice" rows some addons inject as if they were real streams:
 * sign-in / auth prompts (e.g. PenguPlay unconfigured), donation / funding
 * announcements (e.g. PenguPlay "monthly cost covered" — hidden by a donor
 * token we don't have), and "no results" placeholder videos (e.g. YukiStreams
 * "[YS INFO] No streams found"). These carry a playable `url` so they pass
 * every other filter and would otherwise show up as a fake stream.
 */
export const REGEX_NOTICE_STREAM = /\bno (?:streams?|playable streams?|movies?|shows?|sources?|results?) (?:were )?found\b|\bno direct http rows? (?:were|was) available\b|\bcould not load streams?\b|\btry another source,?\s*episode,?\s*or playback option\b|you must sign in\b|sign[\s._-]?in (?:is )?required|authentication is (?:missing|invalid|revoked)|\b(?:monthly|server|hosting) costs? (?:is|are)?\s*covered\b|\bdonor token\b|please\s+(?:donate|consider donating)|please\s+re-?configure\s+the\s+plugin|select this stream to see how to sign in|\/stream-errors\/|the operation was aborted\b/i;

/** HDR / Dolby Vision / HLG — word-boundary safe (avoids matching names like "Chdrak") */
export const REGEX_HDR_FAMILY = /\b(?:hdr10\+|hdr10|hlg|dolby[\s.-]?vision|dovi)\b|\bdv\b|\bhdr\b/i;

/**
 * MediaFusion / Torrentio / Comet style uncached signals.
 * Matches with or without spaces/underscores/hyphens between tokens.
 */
export const REGEX_UNCACHED_SIGNAL = /un[\s._-]?cached|not[\s._-]?cached|⏳|⌛|⬇️|⬇|downloading|\bdownload\b|download[\s._-]?to[\s._-]?debrid|add[\s._-]?to[\s._-]?debrid|to[\s._-]?debrid|nc[\s._-]?torrent|\[dl\]|\(dl\)|instant[\s:=_-]?false|cached[\s:=_-]*\s*(?:no|false|0)/i;

export const RES_WEIGHT_MAP = {
  '4k': 4, '2160p': 4, '2160': 4, 'uhd': 4,
  '1080p': 3, 'fhd': 3,
  '720p': 2, 'hdrip': 2,
  '480p': 1, 'sd': 1
};

/** HDR era cutoff — titles tagged HDR/DV before this year get a scoring penalty */
export const HDR_ERA_YEAR = 2015;
export const FAKE_HDR_PENALTY = 25;

/**
 * Self-declared AI/algorithmic upscales — the release explicitly says the
 * source isn't a native master at that resolution (e.g. "Ai-Upscaled",
 * "AI UPSCALE", "UPSCALE"). Otherwise these tie with genuine native remuxes
 * at the same resolution tier and rank arbitrarily.
 */
export const REGEX_UPSCALE_SIGNAL = /\bai[\s._-]?upscal(?:ed?|ing)?\b|\bupscal(?:ed?|ing)?\b/i;
export const UPSCALE_PENALTY = 20;

export function getTextForAnalysis(stream) {
  if (stream._text !== undefined) return stream._text;
  const fallbackText = stream.description || stream.behaviorHints?.filename || '';
  stream._text = ((stream.name || '') + ' ' + (stream.title || '') + ' ' + fallbackText).toLowerCase();
  return stream._text;
}

export function checkCacheKeywords(text) {
  const isStrongDebrid = /torbox|elfhosted|elfcache|all-?debrid|real-?debrid|premiumize|debrid-?link|stremthru|\bcached\b/i.test(text);
  const hasBracketDebrid = /[\(\[][^\)\]]*\b(tb|rd\+?|ad\+?|pm|comet)\b[^\)\]]*[\)\]]/i.test(text);
  return isStrongDebrid || hasBracketDebrid;
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
  return REGEX_UNCACHED_SIGNAL.test(text);
}

export function isCached(stream) {
  if (stream._isCached !== undefined) return stream._isCached;
  const text = getTextForAnalysis(stream);
  let res = false;

  // חסימה אגרסיבית: זיהוי Uncached / הורדה / שעון חול (גם בלי רווחים)
  if (hasUncachedSignal(text)) {
    res = false;
  } else {
    const hasCacheKeywords = checkCacheKeywords(text);
    if (isUsenet(stream)) res = hasCacheKeywords;
    else if (hasCacheKeywords) res = true;
    else if (stream.infoHash) res = false;
    else if (stream.url && (stream.url.startsWith('magnet:') || stream.url.toLowerCase().endsWith('.torrent') || stream.url.toLowerCase().endsWith('.nzb'))) res = false;
    else if (!stream.url) res = false;
    else if (stream.url.startsWith('http') || stream.url.startsWith('acestream')) res = true;
  }
  stream._isCached = res;
  return res;
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
  // so restrict the text match to that shape.
  const isPlainHttpLink = !stream.infoHash && !isUsenet(stream) &&
    !!stream.url && (stream.url.startsWith('http') || stream.url.startsWith('acestream'));
  const text = getTextForAnalysis(stream);
  const vipBrand = isPlainHttpLink && /\btelegram[\s._-]?bot\b|your[\s._-]?media/i.test(text);

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
      size = match[2].toUpperCase() === 'MB' ? val / 1024 : val;
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

export function getVisualWeight(stream, releaseYear = null) {
  if (stream._visualWeight !== undefined) return stream._visualWeight;
  const text = getTextForAnalysis(stream);
  let score = 0;
  if (hasHdrFamilyTag(text)) score += 2;
  if (/\b(hevc|x265|h265)\b/i.test(text)) score += 1;
  if (/\b10bit\b/i.test(text)) score += 1;

  // Fake HDR penalty: pre-HDR-era titles tagged HDR/DV/HLG are usually upscales
  const year = releaseYear ?? stream._releaseYear ?? null;
  if (year && year < HDR_ERA_YEAR && hasHdrFamilyTag(text)) {
    score -= FAKE_HDR_PENALTY;
    stream._fakeHdrPenalized = true;
  }

  // Fake resolution penalty: release explicitly admits it's an AI/algorithmic
  // upscale, not a native master — should rank below genuine same-tier releases
  if (hasUpscaleSignal(text)) {
    score -= UPSCALE_PENALTY;
    stream._upscalePenalized = true;
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

export function getQualityScoreForPreSort(stream, releaseYear = null) {
  const weightTier = stream._weightTier || 0;
  return (getResWeight(stream) * 1000) +
    (getQualityWeight(stream) * 100) +
    (weightTier * 500) +
    (getVisualWeight(stream, releaseYear) * 10) +
    getAudioWeight(stream);
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
  const rA = getResWeight(a); const rB = getResWeight(b);
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
