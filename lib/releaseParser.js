/**
 * Canonical release parser (parserVersion = release-v2).
 *
 * One pass over normalized text plus trusted structured fields produces a
 * typed release descriptor. Every field records whether it was parsed, unknown,
 * or contradicted, because the ranking model treats unknown as uncertainty and
 * contradiction as negative evidence — they must never collapse into the same
 * value.
 *
 * This module is shared by stream ranking, dedup, and subtitle matching so all
 * three agree on what a release *is*.
 */
import { PARSER_VERSION } from './versions.js';

/** Field states used by metadata confidence and dedup compatibility. */
export const FIELD = { PARSED: 'parsed', UNKNOWN: 'unknown', CONFLICT: 'conflict' };

export const RESOLUTION = { R2160: '2160p', R1440: '1440p', R1080: '1080p', R720: '720p', SD: 'sd', R360: '360p', UNKNOWN: 'unknown' };
export const SOURCE = { REMUX: 'remux', DISC: 'disc_encode', WEBDL: 'webdl', WEBRIP: 'webrip', HDTV: 'hdtv', DVD: 'dvd', CAM: 'cam', UNKNOWN: 'unknown' };
export const SOURCE_FAMILY = { DISC: 'disc', WEB: 'web', BROADCAST: 'broadcast', DVD: 'dvd', CAM: 'cam', UNKNOWN: 'unknown' };
export const CODEC = { H264: 'h264', H265: 'h265', VP9: 'vp9', AV1: 'av1', MPEG2: 'mpeg2', UNKNOWN: 'unknown' };
export const CONTAINER = { MP4: 'mp4', MKV: 'mkv', TS: 'ts', AVI: 'avi', UNKNOWN: 'unknown' };
export const HDR = { DV: 'dv', HDR10PLUS: 'hdr10plus', HDR10: 'hdr10', HLG: 'hlg', SDR: 'sdr', UNKNOWN: 'unknown' };
export const AUDIO = {
  TRUEHD_ATMOS: 'truehd_atmos', DTSX: 'dtsx', TRUEHD: 'truehd', DTSHD: 'dtshd',
  EAC3_ATMOS: 'eac3_atmos', EAC3: 'eac3', AC3: 'ac3', AAC: 'aac', MP3: 'mp3',
  FLAC: 'flac', OPUS: 'opus', UNKNOWN: 'unknown',
};

const SOURCE_TO_FAMILY = {
  [SOURCE.REMUX]: SOURCE_FAMILY.DISC,
  [SOURCE.DISC]: SOURCE_FAMILY.DISC,
  [SOURCE.WEBDL]: SOURCE_FAMILY.WEB,
  [SOURCE.WEBRIP]: SOURCE_FAMILY.WEB,
  [SOURCE.HDTV]: SOURCE_FAMILY.BROADCAST,
  [SOURCE.DVD]: SOURCE_FAMILY.DVD,
  [SOURCE.CAM]: SOURCE_FAMILY.CAM,
  [SOURCE.UNKNOWN]: SOURCE_FAMILY.UNKNOWN,
};

/** Bitmap subtitle / image formats can never drive text alignment. */
export const BITMAP_SUBTITLE_CODECS = new Set(['hdmv_pgs_subtitle', 'pgssub', 'dvd_subtitle', 'dvdsub', 'xsub']);

const RESOLUTION_PATTERNS = [
  { value: RESOLUTION.R2160, re: /(?:^|[\s.\-_[\]()])(?:4k|2160p?|uhd)(?=[\s.\-_[\]()]|$)/i },
  { value: RESOLUTION.R1440, re: /(?:^|[\s.\-_[\]()])(?:1440p|2k|qhd)(?=[\s.\-_[\]()]|$)/i },
  { value: RESOLUTION.R1080, re: /(?:^|[\s.\-_[\]()])(?:1080[pi]?|fhd)(?=[\s.\-_[\]()]|$)/i },
  { value: RESOLUTION.R720, re: /(?:^|[\s.\-_[\]()])(?:720p?|hd ?rip|hdrip)(?=[\s.\-_[\]()]|$)/i },
  { value: RESOLUTION.SD, re: /(?:^|[\s.\-_[\]()])(?:480[pi]|576[pi]|sd|dvdrip|ntsc|pal)(?=[\s.\-_[\]()]|$)/i },
  { value: RESOLUTION.R360, re: /(?:^|[\s.\-_[\]()])(?:360p|240p)(?=[\s.\-_[\]()]|$)/i },
];

const RESOLUTION_RANK = {
  [RESOLUTION.R2160]: 5, [RESOLUTION.R1440]: 4, [RESOLUTION.R1080]: 3,
  [RESOLUTION.R720]: 2, [RESOLUTION.SD]: 1, [RESOLUTION.R360]: 0, [RESOLUTION.UNKNOWN]: -1,
};

/** "1080p source", "upscaled from 720p", "source: 1080" — an admitted lower master. */
const LOWER_SOURCE_CONTEXT = /\b(?:source|src|from|upscal\w*|mastered)\b/i;
const UPSCALE_DECLARED = /\bai[\s._-]?upscal(?:e|ed|ing)?\b|\bupscal(?:e|ed|ing)?\b|\btopaz\b|\bremaster(?:ed)?[\s._-]?ai\b/i;

const SOURCE_PATTERNS = [
  { value: SOURCE.REMUX, re: /\bremux\b|\bbdremux\b/i },
  { value: SOURCE.DISC, re: /\b(?:blu[\s._-]?ray|bluray|bdrip|brrip|bd[\s._-]?25|bd[\s._-]?50|uhd[\s._-]?bd)\b/i },
  { value: SOURCE.WEBDL, re: /\bweb[\s._-]?dl\b|\bwebdl\b|\b(?:amzn|nf|dsnp|hmax|atvp|hulu|pcok|stan|itunes)\b/i },
  { value: SOURCE.WEBRIP, re: /\bweb[\s._-]?rip\b|\bwebrip\b|\bweb\b/i },
  { value: SOURCE.HDTV, re: /\bhd[\s._-]?tv\b|\bhdtv\b|\btvrip\b|\bpdtv\b|\bsdtv\b|\bdvb\b/i },
  { value: SOURCE.DVD, re: /\bdvd(?:rip|scr|r)?\b|\bntsc\b|\bpal\b/i },
  { value: SOURCE.CAM, re: /\bcam(?:rip)?\b|\bhd[\s._-]?cam\b|\bts[\s._-]?rip\b|\btelesync\b|\btelecine\b|\bhdts\b|\bhdtc\b/i },
];

const CODEC_PATTERNS = [
  { value: CODEC.AV1, re: /\bav1\b/i },
  { value: CODEC.H265, re: /\b(?:hevc|x265|h[\s._-]?265|h265)\b/i },
  { value: CODEC.H264, re: /\b(?:avc|x264|h[\s._-]?264|h264)\b/i },
  { value: CODEC.VP9, re: /\bvp9\b/i },
  { value: CODEC.MPEG2, re: /\bmpeg[\s._-]?2\b/i },
];

const CONTAINER_PATTERNS = [
  { value: CONTAINER.MKV, re: /\.mkv\b|\bmatroska\b/i },
  { value: CONTAINER.MP4, re: /\.mp4\b|\bm4v\b/i },
  { value: CONTAINER.TS, re: /\.m2ts\b|\.ts\b|\bmpegts\b/i },
  { value: CONTAINER.AVI, re: /\.avi\b/i },
];

const HDR_PATTERNS = [
  { value: HDR.DV, re: /\bdolby[\s._-]?vision\b|\bdo?vi\b|\bdv\b(?![\s._-]?d)/i },
  { value: HDR.HDR10PLUS, re: /\bhdr10\+|\bhdr10plus\b|\bhdr\+\b/i },
  { value: HDR.HDR10, re: /\bhdr10\b|\bpq10\b|\bhdr\b/i },
  { value: HDR.HLG, re: /\bhlg\b/i },
  { value: HDR.SDR, re: /\bsdr\b/i },
];

const AUDIO_PATTERNS = [
  { value: AUDIO.TRUEHD_ATMOS, re: /\btrue[\s._-]?hd\b[^|]{0,20}\batmos\b|\batmos\b[^|]{0,20}\btrue[\s._-]?hd\b/i },
  { value: AUDIO.DTSX, re: /\bdts[\s._-]?x\b/i },
  { value: AUDIO.TRUEHD, re: /\btrue[\s._-]?hd\b/i },
  { value: AUDIO.DTSHD, re: /\bdts[\s._-]?hd\b|\bdts[\s._-]?ma\b/i },
  { value: AUDIO.FLAC, re: /\bflac\b/i },
  { value: AUDIO.EAC3_ATMOS, re: /\b(?:e[\s._-]?ac3|eac3|ddp?\+?|dd\+)\b[^|]{0,20}\batmos\b|\batmos\b/i },
  { value: AUDIO.EAC3, re: /\b(?:e[\s._-]?ac3|eac3|ddp\d?|dd\+)\b/i },
  { value: AUDIO.AC3, re: /\b(?:ac3|dd5[\s._-]?1|dd2[\s._-]?0|dolby[\s._-]?digital)\b/i },
  { value: AUDIO.DTS, re: /\bdts\b/i, mapTo: AUDIO.DTSHD },
  { value: AUDIO.OPUS, re: /\bopus\b/i },
  { value: AUDIO.AAC, re: /\baac(?:2[\s._-]?0|5[\s._-]?1)?\b/i },
  { value: AUDIO.MP3, re: /\bmp3\b/i },
];

const EDITION_PATTERNS = [
  { value: 'extended', re: /\bextended\b/i },
  { value: 'directors_cut', re: /\bdirector'?s?[\s._-]?cut\b|\bdc\b(?=[\s._-])/i },
  { value: 'theatrical', re: /\btheatrical\b/i },
  { value: 'unrated', re: /\bunrated\b/i },
  { value: 'imax', re: /\bimax\b/i },
  { value: 'uncut', re: /\buncut\b/i },
  { value: 'remastered', re: /\bremaster(?:ed)?\b/i },
  { value: 'final_cut', re: /\bfinal[\s._-]?cut\b/i },
];

const HEBREW_SCRIPT = /[\u0590-\u05ff]/;
const HEBREW_TAG = /\bheb(?:rew)?\b|עברית|\bhe[\s._-]?(?:sub|dub)\b|\bhebsub\b|\bmevutal\b|\bמדובב\b|\bמתורגם\b/i;
const ENGLISH_TAG = /\beng(?:lish)?\b|\ben[\s._-]?sub\b/i;
const RUSSIAN_TAG = /\brus(?:sian)?\b|[\u0400-\u04ff]/;
const MULTI_TAG = /\bmulti\b|\bdual[\s._-]?audio\b|\bmultisub\b|\bdubbed\b/i;
const OTHER_LANGUAGE_TAGS = [
  { lang: 'hi', re: /\bhindi\b/i }, { lang: 'ta', re: /\btamil\b/i },
  { lang: 'te', re: /\btelugu\b/i }, { lang: 'ko', re: /\bkorean\b/i },
  { lang: 'ja', re: /\bjapanese\b/i }, { lang: 'zh', re: /\bchinese\b|\bmandarin\b|\bcantonese\b/i },
  { lang: 'es', re: /\bspanish\b|\bcastellano\b|\blatino\b/i }, { lang: 'fr', re: /\bfrench\b|\btruefrench\b/i },
  { lang: 'de', re: /\bgerman\b/i }, { lang: 'it', re: /\bitalian\b/i },
  { lang: 'pt', re: /\bportuguese\b|\bdublado\b/i }, { lang: 'tr', re: /\bturkish\b/i },
  { lang: 'ar', re: /\barabic\b/i }, { lang: 'pl', re: /\bpolish\b|\blektor\b/i },
];

const SEASON_PACK = /\b(?:season|complete|s\d{1,2}\s*-\s*s?\d{1,2}|packs?|collection|trilogy|duology|all\s*episodes)\b/i;
const EPISODE_MARKER = /\bs(\d{1,2})[\s._-]?e(\d{1,4})\b|\b(\d{1,2})x(\d{1,3})\b/i;
const SIZE_RE = /(\d+(?:[.,]\d+)?)\s*(TB|GB|MB)\b/i;
const SEEDERS_RE = /(?:👤|seeders?\s*:?|👥)\s*(\d+)/i;
/**
 * Scene convention puts the group last, after a hyphen: "…Atmos 7.1-FraMeSToR".
 * The hyphen may follow any character, so this cannot require a leading separator.
 */
const RELEASE_GROUP_RE = /-\s*([A-Za-z0-9][A-Za-z0-9._]{1,24})\s*(?:\.[a-z0-9]{2,4})?\s*$/;
const BRACKET_GROUP_RE = /\[([A-Za-z0-9][A-Za-z0-9._\- ]{1,24})\]\s*(?:\.[a-z0-9]{2,4})?\s*$/;

/**
 * Technical suffixes that also sit after a hyphen ("WEB-DL", "Blu-Ray") and would
 * otherwise be mistaken for a release group — which would then let dedup merge two
 * unrelated releases on a shared fake "group".
 */
const NOT_A_GROUP = new Set([
  'dl', 'rip', 'ray', 'hd', 'uhd', 'fhd', 'sub', 'subs', 'dub', 'dubbed', 'cut', 'ita', 'eng',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'av1', 'aac', 'ac3', 'eac3', 'ddp', 'dts',
  'atmos', 'truehd', 'flac', 'opus', 'hdr', 'hdr10', 'sdr', 'dv', 'bit', '10bit', '8bit',
  'remux', 'bluray', 'webdl', 'webrip', 'hdtv', 'dvd', 'cam', 'proper', 'repack', 'internal',
  'multi', 'complete', 'season', 'episode', 'final',
]);
const YEAR_RE = /(?:^|[\s.\-_[(])((?:19|20)\d{2})(?=[\s.\-_)\]]|$)/g;
const BIT_DEPTH_RE = /\b(8|10|12)[\s._-]?bits?\b/i;
const PROPER_RE = /\bproper\b/i;
const REPACK_RE = /\brepack\b/i;

/** Decorations that describe delivery, not the release itself. */
const DECORATION_RE = /[([][^)\]]*\b(?:tb|rd|ad|pm|oc|ed|torbox|real[\s._-]?debrid|all[\s._-]?debrid|premiumize|debrid|cached|uncached|instant|elfhosted|elfcache|comet|telegram[\s._-]?bot|your[\s._-]?media|dl)\b[^)\]]*[)\]]/gi;
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}\u{2190}-\u{21FF}]/gu;
const URL_RE = /\b(?:https?:\/\/|magnet:\?)[^\s|]+/gi;
const HASH_RE = /\b[0-9a-f]{32,40}\b/gi;

function normalizeText(raw) {
  return String(raw || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(URL_RE, ' ')
    .replace(HASH_RE, ' ')
    .replace(DECORATION_RE, ' ')
    .replace(EMOJI_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstMatch(patterns, text) {
  for (const pattern of patterns) {
    if (pattern.re.test(text)) return pattern.mapTo || pattern.value;
  }
  return null;
}

function detectResolution(text) {
  const found = [];
  for (const pattern of RESOLUTION_PATTERNS) {
    if (pattern.re.test(text)) found.push(pattern.value);
  }
  if (!found.length) {
    return { value: RESOLUTION.UNKNOWN, state: FIELD.UNKNOWN, candidates: [], lowerSourceClaim: null };
  }
  const sorted = [...new Set(found)].sort((a, b) => RESOLUTION_RANK[b] - RESOLUTION_RANK[a]);
  const claimed = sorted[0];
  const lower = sorted.length > 1 ? sorted[sorted.length - 1] : null;
  // A second, lower resolution claim only counts as an admitted lower master when
  // the text frames it as the source (or as an upscale). Bare dual tags are noise.
  const admittedLower = lower && LOWER_SOURCE_CONTEXT.test(text) ? lower : null;
  return {
    value: claimed,
    state: sorted.length > 1 ? FIELD.CONFLICT : FIELD.PARSED,
    candidates: sorted,
    lowerSourceClaim: admittedLower,
  };
}

function detectLanguages(text, hasHebrewScript) {
  const langs = new Set();
  if (hasHebrewScript || HEBREW_TAG.test(text)) langs.add('he');
  if (ENGLISH_TAG.test(text)) langs.add('en');
  if (RUSSIAN_TAG.test(text)) langs.add('ru');
  for (const entry of OTHER_LANGUAGE_TAGS) {
    if (entry.re.test(text)) langs.add(entry.lang);
  }
  const multi = MULTI_TAG.test(text);
  return {
    values: [...langs].sort(),
    multi,
    state: langs.size || multi ? FIELD.PARSED : FIELD.UNKNOWN,
  };
}

function detectEpisode(text) {
  const match = text.match(EPISODE_MARKER);
  if (!match) return { season: null, episode: null, state: FIELD.UNKNOWN };
  const season = match[1] ? parseInt(match[1], 10) : parseInt(match[3], 10);
  const episode = match[2] ? parseInt(match[2], 10) : parseInt(match[4], 10);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) {
    return { season: null, episode: null, state: FIELD.UNKNOWN };
  }
  return { season, episode, state: FIELD.PARSED };
}

function detectReleaseGroup(rawTitle) {
  const source = String(rawTitle || '').replace(DECORATION_RE, ' ').replace(EMOJI_RE, ' ').trim();
  const lines = source.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const bracket = line.match(BRACKET_GROUP_RE);
    if (bracket) {
      const candidate = bracket[1].toLowerCase().replace(/\s+/g, '');
      if (!NOT_A_GROUP.has(candidate)) return candidate;
    }
    const dashed = line.match(RELEASE_GROUP_RE);
    if (dashed) {
      const candidate = dashed[1].toLowerCase().replace(/\.$/, '');
      if (!NOT_A_GROUP.has(candidate)) return candidate;
    }
  }
  return null;
}

function detectSizeBytes(stream, text) {
  const hintSize = Number(stream?.behaviorHints?.videoSize);
  if (Number.isFinite(hintSize) && hintSize > 0) {
    return { bytes: hintSize, state: FIELD.PARSED, source: 'behaviorHints.videoSize' };
  }
  const rawSize = Number(stream?.size);
  if (Number.isFinite(rawSize) && rawSize > 0) {
    return { bytes: rawSize, state: FIELD.PARSED, source: 'stream.size' };
  }
  const match = text.match(SIZE_RE);
  if (match) {
    const value = parseFloat(match[1].replace(',', '.'));
    const unit = match[2].toUpperCase();
    const multiplier = unit === 'MB' ? 1024 ** 2 : unit === 'TB' ? 1024 ** 4 : 1024 ** 3;
    if (Number.isFinite(value) && value > 0) {
      return { bytes: value * multiplier, state: FIELD.PARSED, source: 'text' };
    }
  }
  return { bytes: null, state: FIELD.UNKNOWN, source: null };
}

/**
 * Seeder counts are read from the *raw* text because providers mark them with a
 * 👤 emoji, and normalization strips emoji before anything else runs.
 */
function detectSeeders(rawText, provider) {
  const trusted = !provider || provider.trustedFields?.includes('seeders');
  const match = String(rawText || '').match(SEEDERS_RE);
  if (!match) return { value: null, state: FIELD.UNKNOWN, trusted };
  const value = parseInt(match[1], 10);
  if (!Number.isFinite(value)) return { value: null, state: FIELD.UNKNOWN, trusted };
  return { value, state: FIELD.PARSED, trusted };
}

/**
 * Identity of the specific file inside a torrent/pack. Two rows sharing an
 * infoHash but pointing at different episodes are NOT duplicates, so dedup
 * needs this alongside the hash.
 */
function detectFileFingerprint(stream, episode) {
  const idx = stream?.fileIdx ?? stream?.fileIndex ?? stream?.behaviorHints?.fileIdx;
  if (Number.isFinite(Number(idx))) return `idx:${Number(idx)}`;
  const filename = stream?.behaviorHints?.filename;
  if (filename) return `name:${String(filename).toLowerCase().replace(/\s+/g, '')}`;
  if (episode.state === FIELD.PARSED) return `ep:s${episode.season}e${episode.episode}`;
  return 'whole';
}

function detectYears(text) {
  const years = new Set();
  let match;
  YEAR_RE.lastIndex = 0;
  while ((match = YEAR_RE.exec(text)) !== null) {
    const year = parseInt(match[1], 10);
    if (year >= 1888 && year <= 2100) years.add(year);
  }
  return [...years];
}

/**
 * Contradiction analysis. Only *explicit* internal inconsistency counts;
 * missing data is never a contradiction.
 */
function analyzeContradictions({ text, resolution, source, codec, hdr, bitDepth }) {
  const reasons = [];

  if (UPSCALE_DECLARED.test(text)) reasons.push({ code: 'upscale_declared', severity: 'high' });

  if (resolution.lowerSourceClaim && RESOLUTION_RANK[resolution.lowerSourceClaim] < RESOLUTION_RANK[resolution.value]) {
    reasons.push({ code: 'lower_resolution_source', severity: 'high' });
  }

  const claimsWideGamut = hdr.value === HDR.DV || hdr.value === HDR.HDR10 || hdr.value === HDR.HDR10PLUS;
  if (claimsWideGamut) {
    if (codec.value === CODEC.H264 || codec.value === CODEC.MPEG2) {
      reasons.push({ code: 'hdr_on_8bit_codec', severity: 'high' });
    }
    if (bitDepth === 8) {
      reasons.push({ code: 'hdr_on_8bit_depth', severity: 'high' });
    }
  }

  // A remux is a lossless container copy of a disc: it cannot also be a CAM or
  // a web rip. Claiming both means the label is unreliable.
  if (source.value === SOURCE.REMUX && /\bcam\b|\btelesync\b|\bwebrip\b/i.test(text)) {
    reasons.push({ code: 'remux_source_conflict', severity: 'high' });
  }

  return reasons;
}

/** Provider/delivery words that must not participate in release similarity. */
const PROVIDER_NOISE = new Set([
  'torrentio', 'comet', 'mediafusion', 'yastream', 'debridio', 'knaben', 'kanbox', 'animeil',
  'torbox', 'debrid', 'realdebrid', 'alldebrid', 'premiumize', 'elfhosted', 'elfcache',
  'cached', 'uncached', 'instant', 'download', 'stream', 'seeders', 'peers', 'size',
  'telegram', 'media', 'personal', 'unknown',
]);

const STRUCTURAL_STOP = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'to', 'for', 'from', 'with', 'season',
  'episode', 'series', 'movie', 'film', 'vol', 'part', 'complete', 'dual', 'audio', 'multi',
]);

/**
 * Build the canonical token set used for same-release similarity.
 * Technical facts become typed tokens so "1080p" and "FHD" collapse, and the
 * requested title is subtracted because every candidate shares it.
 */
function buildCanonicalTokens(descriptor, text, requestedTitleTokens) {
  const tokens = new Set();
  const add = (token) => { if (token) tokens.add(token); };

  if (descriptor.resolution.value !== RESOLUTION.UNKNOWN) add(`res:${descriptor.resolution.value}`);
  if (descriptor.source.value !== SOURCE.UNKNOWN) add(`src:${descriptor.source.value}`);
  if (descriptor.codec.value !== CODEC.UNKNOWN) add(`codec:${descriptor.codec.value}`);
  if (descriptor.hdr.value !== HDR.UNKNOWN) add(`hdr:${descriptor.hdr.value}`);
  if (descriptor.audio.value !== AUDIO.UNKNOWN) add(`audio:${descriptor.audio.value}`);
  if (descriptor.edition) add(`edition:${descriptor.edition}`);
  if (descriptor.releaseGroup) add(`group:${descriptor.releaseGroup}`);
  if (descriptor.episode.state === FIELD.PARSED) {
    add(`ep:s${String(descriptor.episode.season).padStart(2, '0')}e${String(descriptor.episode.episode).padStart(2, '0')}`);
  }
  if (descriptor.isSeasonPack) add('flag:pack');
  if (descriptor.proper) add('flag:proper');
  if (descriptor.repack) add('flag:repack');
  if (descriptor.bitDepth) add(`depth:${descriptor.bitDepth}`);
  for (const year of descriptor.years) add(`year:${year}`);

  const requested = new Set(requestedTitleTokens || []);
  for (const word of text.split(/[^a-z0-9\u0590-\u05ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/)) {
    if (!word || word.length < 3) continue;
    if (STRUCTURAL_STOP.has(word) || PROVIDER_NOISE.has(word)) continue;
    if (requested.has(word)) continue;
    if (/^\d+$/.test(word)) continue;
    if (/^(?:19|20)\d{2}$/.test(word)) continue;
    add(`w:${word}`);
  }
  return tokens;
}

/**
 * Parse a Stremio stream row into a canonical release descriptor.
 *
 * @param {object} stream raw upstream stream object
 * @param {object} [context]
 * @param {object} [context.provider] resolved capability entry (controls trusted fields)
 * @param {string[]} [context.requestedTitleTokens] tokens shared by all candidates
 */
export function parseRelease(stream, context = {}) {
  const provider = context.provider || null;
  const rawParts = [stream?.name, stream?.title, stream?.description, stream?.behaviorHints?.filename]
    .filter(Boolean)
    .join(' \n ');
  const text = normalizeText(rawParts);
  const hasHebrewScript = HEBREW_SCRIPT.test(rawParts);

  const resolution = detectResolution(text);
  const sourceValue = firstMatch(SOURCE_PATTERNS, text);
  const source = sourceValue
    ? { value: sourceValue, state: FIELD.PARSED }
    : { value: SOURCE.UNKNOWN, state: FIELD.UNKNOWN };

  const codecValue = firstMatch(CODEC_PATTERNS, text);
  const codec = codecValue
    ? { value: codecValue, state: FIELD.PARSED }
    : { value: CODEC.UNKNOWN, state: FIELD.UNKNOWN };

  const containerValue = firstMatch(CONTAINER_PATTERNS, text);
  const container = containerValue
    ? { value: containerValue, state: FIELD.PARSED }
    : { value: CONTAINER.UNKNOWN, state: FIELD.UNKNOWN };

  const hdrValue = firstMatch(HDR_PATTERNS, text);
  const hdr = hdrValue
    ? { value: hdrValue, state: FIELD.PARSED }
    : { value: HDR.UNKNOWN, state: FIELD.UNKNOWN };

  const audioValue = firstMatch(AUDIO_PATTERNS, text);
  const audio = audioValue
    ? { value: audioValue, state: FIELD.PARSED }
    : { value: AUDIO.UNKNOWN, state: FIELD.UNKNOWN };

  const bitDepthMatch = text.match(BIT_DEPTH_RE);
  const bitDepth = bitDepthMatch ? parseInt(bitDepthMatch[1], 10) : null;

  const languages = detectLanguages(text, hasHebrewScript);
  const episode = detectEpisode(text);
  const size = detectSizeBytes(stream, text);
  const seeders = detectSeeders(rawParts, provider);
  const releaseGroup = detectReleaseGroup(stream?.title || stream?.name || '');
  const edition = firstMatch(EDITION_PATTERNS, text);
  const years = detectYears(text);
  const isSeasonPack = SEASON_PACK.test(text) && episode.state !== FIELD.PARSED;

  const descriptor = {
    parserVersion: PARSER_VERSION,
    text,
    resolution,
    source: { ...source, family: SOURCE_TO_FAMILY[source.value] },
    codec,
    container,
    hdr,
    audio,
    bitDepth,
    languages,
    episode,
    size,
    seeders,
    releaseGroup,
    edition,
    years,
    isSeasonPack,
    proper: PROPER_RE.test(text),
    repack: REPACK_RE.test(text),
    hasHebrewScript,
    fileFingerprint: detectFileFingerprint(stream, episode),
  };

  descriptor.contradictions = analyzeContradictions({
    text, resolution, source: descriptor.source, codec, hdr, bitDepth,
  });
  descriptor.canonicalTokens = buildCanonicalTokens(descriptor, text, context.requestedTitleTokens);
  return descriptor;
}

/** Jaccard similarity of two canonical token sets. Exact, not approximated. */
export function jaccard(setA, setB) {
  if (!setA?.size || !setB?.size) return 0;
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let intersection = 0;
  for (const token of small) {
    if (large.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

export { RESOLUTION_RANK, SOURCE_TO_FAMILY, normalizeText };
