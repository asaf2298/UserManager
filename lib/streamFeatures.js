/**
 * Feature extraction (modelVersion = rank-v2.0).
 *
 * Converts a raw upstream stream row into an orthogonal, normalized feature
 * vector in [0,1]. The design rules that make the later scoring defensible:
 *
 *   - Each piece of evidence is counted exactly once. Resolution and source
 *     share one visual score; seed health lives only inside availability.
 *   - Raw file size never earns a bonus; only plausibility of bitrate does.
 *   - Unknown data is neutral. Only self-contradiction is punished.
 *   - "Cached" and "VIP" come from provider capability rules, never free text.
 */
import { clip, quantize, MODEL_VERSION } from './versions.js';
import {
  TRANSPORT, CACHE_CLAIM, QUERY_MODE,
  parseCacheClaim, evaluateVip,
} from './providerCapabilities.js';
import {
  parseRelease, FIELD, RESOLUTION, SOURCE, SOURCE_FAMILY, CODEC, CONTAINER, HDR, AUDIO,
} from './releaseParser.js';
import { integrityTrust, cacheClaimConfidence, stratumKey } from './providerTrust.js';
import { titleMatchEvidence } from './titleMatch.js';

/** Reason codes surfaced in explanations and diagnostics. */
export const INELIGIBLE = {
  NO_LOCATOR: 'no_playable_locator',
  NOTICE: 'notice_row',
  IP_LOCKED: 'ip_locked_url',
  TITLE_CONFLICT: 'content_conflict',
  BAD_URL: 'malformed_locator',
  UNSUPPORTED_FORMAT: 'client_unsupported_format',
};

/** ElfHosted/ElfCache links bind to the first requesting IP — unplayable via a proxy. */
const IP_LOCK_RE = /\/elfmagic\//i;
const USENET_RE = /\busenet\b|\bnzb\b/i;

const RESOLUTION_BASE = {
  [RESOLUTION.R2160]: 1.00,
  [RESOLUTION.R1440]: 0.82,
  [RESOLUTION.R1080]: 0.68,
  [RESOLUTION.R720]: 0.48,
  [RESOLUTION.SD]: 0.28,
  [RESOLUTION.R360]: 0.12,
  [RESOLUTION.UNKNOWN]: 0.35,
};

const SOURCE_ADJUST = {
  [SOURCE.REMUX]: { delta: +0.08, cap: 1.00 },
  [SOURCE.DISC]: { delta: +0.05, cap: 1.00 },
  [SOURCE.WEBDL]: { delta: +0.03, cap: 0.96 },
  [SOURCE.WEBRIP]: { delta: 0.00, cap: 0.90 },
  [SOURCE.HDTV]: { delta: -0.08, cap: 0.72 },
  [SOURCE.DVD]: { delta: -0.10, cap: 0.42 },
  [SOURCE.CAM]: { delta: -0.55, cap: 0.15 },
  [SOURCE.UNKNOWN]: { delta: -0.05, cap: 0.75 },
};

const HDR_SCORE = {
  [HDR.DV]: 1.00, [HDR.HDR10PLUS]: 0.90, [HDR.HDR10]: 0.78,
  [HDR.HLG]: 0.60, [HDR.SDR]: 0.35, [HDR.UNKNOWN]: 0.30,
};

const AUDIO_SCORE = {
  [AUDIO.TRUEHD_ATMOS]: 1.00, [AUDIO.DTSX]: 0.95, [AUDIO.TRUEHD]: 0.88,
  [AUDIO.DTSHD]: 0.88, [AUDIO.FLAC]: 0.88, [AUDIO.EAC3_ATMOS]: 0.80,
  [AUDIO.EAC3]: 0.62, [AUDIO.AC3]: 0.62, [AUDIO.OPUS]: 0.45,
  [AUDIO.AAC]: 0.45, [AUDIO.MP3]: 0.25, [AUDIO.UNKNOWN]: 0.35,
};

/** Seeder bands: coarse on purpose, because raw counts are noisy and gameable. */
export function seederBand(seeders, trusted) {
  if (!trusted || seeders === null || seeders === undefined || !Number.isFinite(seeders)) return 0.35;
  if (seeders <= 0) return 0.00;
  if (seeders <= 2) return 0.15;
  if (seeders <= 5) return 0.30;
  if (seeders <= 10) return 0.45;
  if (seeders <= 25) return 0.62;
  if (seeders <= 50) return 0.76;
  if (seeders <= 100) return 0.88;
  return 1.00;
}

/** Server-side usenet retrieval does not depend on a P2P swarm. */
const USENET_FEASIBILITY = 0.70;

const CLIENT_COMPAT = {
  generic: {
    codec: { [CODEC.H264]: 1.00, [CODEC.H265]: 0.80, [CODEC.VP9]: 0.65, [CODEC.AV1]: 0.55, [CODEC.MPEG2]: 0.70, [CODEC.UNKNOWN]: 0.55 },
    container: { [CONTAINER.MP4]: 0.95, [CONTAINER.MKV]: 0.90, [CONTAINER.TS]: 0.75, [CONTAINER.AVI]: 0.70, [CONTAINER.UNKNOWN]: 0.60 },
    hdr: { [HDR.SDR]: 1.00, [HDR.HDR10]: 0.80, [HDR.HDR10PLUS]: 0.80, [HDR.HLG]: 0.75, [HDR.DV]: 0.50, [HDR.UNKNOWN]: 0.70 },
    audio: { [AUDIO.AAC]: 0.95, [AUDIO.AC3]: 0.95, [AUDIO.EAC3]: 0.95, [AUDIO.EAC3_ATMOS]: 0.95, [AUDIO.MP3]: 0.95, [AUDIO.OPUS]: 0.80, [AUDIO.DTSHD]: 0.70, [AUDIO.DTSX]: 0.70, [AUDIO.TRUEHD]: 0.55, [AUDIO.TRUEHD_ATMOS]: 0.55, [AUDIO.FLAC]: 0.55, [AUDIO.UNKNOWN]: 0.70 },
    dvHasFallback: 0.70,
  },
  capable: {
    codec: { [CODEC.H264]: 1.00, [CODEC.H265]: 1.00, [CODEC.VP9]: 1.00, [CODEC.AV1]: 0.90, [CODEC.MPEG2]: 1.00, [CODEC.UNKNOWN]: 0.70 },
    container: { [CONTAINER.MP4]: 1.00, [CONTAINER.MKV]: 1.00, [CONTAINER.TS]: 0.90, [CONTAINER.AVI]: 0.90, [CONTAINER.UNKNOWN]: 0.70 },
    hdr: { [HDR.SDR]: 1.00, [HDR.HDR10]: 1.00, [HDR.HDR10PLUS]: 1.00, [HDR.HLG]: 1.00, [HDR.DV]: 0.90, [HDR.UNKNOWN]: 0.80 },
    audio: { [AUDIO.AAC]: 0.95, [AUDIO.AC3]: 0.95, [AUDIO.EAC3]: 0.95, [AUDIO.EAC3_ATMOS]: 0.95, [AUDIO.MP3]: 0.95, [AUDIO.OPUS]: 0.95, [AUDIO.DTSHD]: 0.95, [AUDIO.DTSX]: 0.95, [AUDIO.TRUEHD]: 0.95, [AUDIO.TRUEHD_ATMOS]: 0.95, [AUDIO.FLAC]: 0.95, [AUDIO.UNKNOWN]: 0.80 },
    dvHasFallback: 0.90,
  },
};

/** Expected Mbps per source family and resolution — the "honest encode" centre. */
const EXPECTED_BITRATE = {
  [SOURCE.REMUX]: { [RESOLUTION.R2160]: 55, [RESOLUTION.R1440]: 35, [RESOLUTION.R1080]: 28, [RESOLUTION.R720]: 14, [RESOLUTION.SD]: 6, [RESOLUTION.R360]: 3, [RESOLUTION.UNKNOWN]: 12 },
  [SOURCE.DISC]: { [RESOLUTION.R2160]: 22, [RESOLUTION.R1440]: 14, [RESOLUTION.R1080]: 9, [RESOLUTION.R720]: 4.5, [RESOLUTION.SD]: 2, [RESOLUTION.R360]: 1, [RESOLUTION.UNKNOWN]: 7 },
  [SOURCE.WEBDL]: { [RESOLUTION.R2160]: 16, [RESOLUTION.R1440]: 10, [RESOLUTION.R1080]: 7, [RESOLUTION.R720]: 3.5, [RESOLUTION.SD]: 1.5, [RESOLUTION.R360]: 0.8, [RESOLUTION.UNKNOWN]: 5 },
  [SOURCE.WEBRIP]: { [RESOLUTION.R2160]: 16, [RESOLUTION.R1440]: 10, [RESOLUTION.R1080]: 7, [RESOLUTION.R720]: 3.5, [RESOLUTION.SD]: 1.5, [RESOLUTION.R360]: 0.8, [RESOLUTION.UNKNOWN]: 5 },
  [SOURCE.HDTV]: { [RESOLUTION.R2160]: 12, [RESOLUTION.R1440]: 8, [RESOLUTION.R1080]: 5, [RESOLUTION.R720]: 3, [RESOLUTION.SD]: 1.2, [RESOLUTION.R360]: 0.6, [RESOLUTION.UNKNOWN]: 4 },
  [SOURCE.DVD]: { [RESOLUTION.R2160]: 12, [RESOLUTION.R1440]: 8, [RESOLUTION.R1080]: 5, [RESOLUTION.R720]: 3, [RESOLUTION.SD]: 1.2, [RESOLUTION.R360]: 0.6, [RESOLUTION.UNKNOWN]: 4 },
  [SOURCE.CAM]: { [RESOLUTION.R2160]: 5, [RESOLUTION.R1440]: 4, [RESOLUTION.R1080]: 3, [RESOLUTION.R720]: 2, [RESOLUTION.SD]: 1, [RESOLUTION.R360]: 0.5, [RESOLUTION.UNKNOWN]: 2 },
  [SOURCE.UNKNOWN]: { [RESOLUTION.R2160]: 5, [RESOLUTION.R1440]: 4, [RESOLUTION.R1080]: 3, [RESOLUTION.R720]: 2, [RESOLUTION.SD]: 1, [RESOLUTION.R360]: 0.5, [RESOLUTION.UNKNOWN]: 2 },
};

/**
 * Compression efficiency relative to H.264 at equal perceptual quality (#60).
 * EXPECTED_BITRATE alone reads an efficient modern encode as starved --
 * computeCompatibility already discounts h265/av1 for device support, so
 * without this a stream was double-charged for the same fact through two
 * supposedly orthogonal features.
 */
const CODEC_EFFICIENCY = {
  [CODEC.H264]: 1.00,
  [CODEC.H265]: 0.62,
  [CODEC.VP9]: 0.68,
  [CODEC.AV1]: 0.50,
  [CODEC.MPEG2]: 1.60,
  [CODEC.UNKNOWN]: 0.85,
};

const CREDIBILITY_PENALTY = {
  upscale_declared: 0.55,
  lower_resolution_source: 0.45,
  hdr_on_8bit_codec: 0.40,
  hdr_on_8bit_depth: 0.40,
  remux_source_conflict: 0.45,
};

const MATCH_CONFIDENCE = {
  CANONICAL: 1.00,
  MAPPED: 0.95,
  PRIMARY_TITLE: 0.85,
  ALIAS_TITLE: 0.80,
  PARTIAL: 0.72,
  NO_EVIDENCE: 0.70,
  CONFLICT: 0.00,
};

// #60: was 0.70, exactly equal to MATCH_CONFIDENCE.NO_EVIDENCE -- a zero-margin
// fragility that made "no evidence either way" (where 2-char titles like It/Us/Up
// live, see #55) a coin flip against floating-point/quantization noise instead
// of a clear pass.
export const MATCH_ELIGIBILITY_THRESHOLD = 0.65;

function hasValidHttpLocator(url) {
  const value = String(url || '');
  if (!/^https?:\/\//i.test(value) && !/^acestream:/i.test(value)) return false;
  if (/^magnet:/i.test(value) || /\.torrent$/i.test(value) || /\.nzb$/i.test(value)) return false;
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (!parsed.hostname) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Classify how playback would actually be delivered. This drives availability,
 * so it is deliberately based on row shape plus declared provider transports
 * rather than on marketing text.
 */
export function classifyTransport(stream, provider, cacheClaim) {
  const url = stream?.url || '';
  const hasHttp = hasValidHttpLocator(url);
  const isUsenet = USENET_RE.test(`${stream?.name || ''} ${stream?.title || ''}`);
  const supports = new Set(provider?.transports || []);

  if (!hasHttp && !stream?.infoHash && stream?.externalUrl) return TRANSPORT.EXTERNAL;
  if (isUsenet) return TRANSPORT.USENET;

  if (hasHttp && !stream?.infoHash && supports.has(TRANSPORT.DIRECT_OWNER) && cacheClaim.claim === CACHE_CLAIM.NONE) {
    return TRANSPORT.DIRECT_OWNER;
  }
  if (cacheClaim.claim !== CACHE_CLAIM.NONE && supports.has(TRANSPORT.DEBRID)) return TRANSPORT.DEBRID;
  if (hasHttp && supports.has(TRANSPORT.DEBRID) && stream?.infoHash) return TRANSPORT.DEBRID;
  // A torrent-backed row (infoHash present) from a provider that isn't a
  // recognized debrid family is real P2P even if the addon wraps it in an
  // http URL (e.g. a torrent-to-http gateway): an http locator alone does not
  // mean the file is actually cached/ready, only debrid-claim text does.
  if (stream?.infoHash && !supports.has(TRANSPORT.DEBRID)) return TRANSPORT.P2P;
  if (hasHttp) return TRANSPORT.GENERIC_HTTP;
  if (stream?.infoHash) return TRANSPORT.P2P;
  return TRANSPORT.EXTERNAL;
}

/**
 * Availability `F`: probability this row plays promptly.
 * Seed health is folded in here and nowhere else, so instant-play likelihood is
 * never double counted.
 */
function computeAvailability({ transport, cacheClaim, evidenceConfidence, band, hasHttp }) {
  switch (transport) {
    case TRANSPORT.DIRECT_OWNER:
      return { value: 1.00, reason: 'direct_owner_url' };
    case TRANSPORT.DEBRID:
      if (cacheClaim.claim === CACHE_CLAIM.POSITIVE) {
        const e = clip(evidenceConfidence ?? 0.5, 0, 1);
        return { value: clip(0.80 + 0.20 * e, 0, 1), reason: `cache_positive:${cacheClaim.marker}` };
      }
      if (cacheClaim.claim === CACHE_CLAIM.QUEUED) {
        return { value: clip(0.25 + 0.45 * band, 0, 1), reason: `queued:${cacheClaim.marker}` };
      }
      return hasHttp
        ? { value: 0.90, reason: 'debrid_direct_link' }
        : { value: clip(0.25 + 0.45 * band, 0, 1), reason: 'debrid_unclaimed' };
    case TRANSPORT.USENET:
      return hasHttp
        ? { value: 0.90, reason: 'usenet_direct_link' }
        : { value: clip(0.25 + 0.45 * USENET_FEASIBILITY, 0, 1), reason: 'usenet_queued' };
    case TRANSPORT.GENERIC_HTTP:
      return { value: 0.90, reason: 'generic_http_url' };
    case TRANSPORT.P2P:
      return { value: clip(0.10 + 0.75 * band, 0, 1), reason: 'pure_p2p_swarm' };
    case TRANSPORT.EXTERNAL:
    default:
      return { value: 0.65, reason: 'external_player_url' };
  }
}

/** Joint visual quality: resolution and source graded once, together. */
function computeVisual(release) {
  const base = RESOLUTION_BASE[release.resolution.value] ?? RESOLUTION_BASE[RESOLUTION.UNKNOWN];
  const adjust = SOURCE_ADJUST[release.source.value] ?? SOURCE_ADJUST[SOURCE.UNKNOWN];
  return clip(Math.min(clip(base + adjust.delta, 0, 1), adjust.cap), 0, 1);
}

/** Device compatibility is a bottleneck: the worst dimension decides. */
function computeCompatibility(release, clientClass) {
  const table = CLIENT_COMPAT[clientClass] || CLIENT_COMPAT.generic;
  const codec = table.codec[release.codec.value] ?? table.codec[CODEC.UNKNOWN];
  const container = table.container[release.container.value] ?? table.container[CONTAINER.UNKNOWN];
  let hdr = table.hdr[release.hdr.value] ?? table.hdr[HDR.UNKNOWN];
  // Dolby Vision with an HDR10 fallback layer degrades gracefully on more players.
  if (release.hdr.value === HDR.DV && /\bhdr10\b|\bfallback\b|\bdv[\s._-]?hdr\b/i.test(release.text)) {
    hdr = table.dvHasFallback;
  }
  const audio = table.audio[release.audio.value] ?? table.audio[AUDIO.UNKNOWN];
  return clip(Math.min(codec, container, hdr, audio), 0, 1);
}

/**
 * Size plausibility. Compares actual bitrate against the expected bitrate for
 * the claimed resolution/source. Both a starved and a bloated encode lose
 * points; nothing gains points for being merely large.
 */
function computeSizePlausibility(release, runtimeMinutes) {
  const bytes = release.size.bytes;
  const knownRuntime = Number.isFinite(runtimeMinutes) && runtimeMinutes > 0;
  // A pack's total size says nothing about the episode we would actually play.
  const perFileKnown = Number.isFinite(bytes) && bytes > 0 && !release.isSeasonPack;
  if (!knownRuntime || !perFileKnown) {
    return { tap: 0.50, quality: 0.50, bitrateMbps: null, known: false };
  }

  const bitrateMbps = (8 * bytes) / (runtimeMinutes * 60) / 1_000_000;
  const table = EXPECTED_BITRATE[release.source.value] || EXPECTED_BITRATE[SOURCE.UNKNOWN];
  const expected = table[release.resolution.value] ?? table[RESOLUTION.UNKNOWN];
  if (!(bitrateMbps > 0) || !(expected > 0)) {
    return { tap: 0.50, quality: 0.50, bitrateMbps: null, known: false };
  }

  // Scale the expected-bitrate centre by codec efficiency (#60) so an
  // efficient h265/av1 encode isn't read as starved for being smaller than
  // an h264 file of equal perceptual quality.
  const eta = CODEC_EFFICIENCY[release.codec.value] ?? CODEC_EFFICIENCY[CODEC.UNKNOWN];
  const x = Math.log2(bitrateMbps / (expected * eta));
  const tap = Math.exp(-0.5 * Math.pow((x + 0.35) / 0.75, 2));
  const quality = Math.exp(-0.5 * Math.pow(x / 0.90, 2));
  return { tap: clip(tap, 0, 1), quality: clip(quality, 0, 1), bitrateMbps, known: true };
}

/** Metadata completeness over trusted fields only; conflicts count as zero. */
function computeMetadataConfidence(release) {
  const flags = [
    release.resolution.state === FIELD.PARSED ? 1 : 0,
    release.source.state === FIELD.PARSED ? 1 : 0,
    release.codec.state === FIELD.PARSED ? 1 : 0,
    release.size.state === FIELD.PARSED ? 1 : 0,
    release.languages.state === FIELD.PARSED ? 1 : 0,
    release.releaseGroup ? 1 : 0,
  ];
  return flags.reduce((a, b) => a + b, 0) / flags.length;
}

/**
 * Language relevance for a Hebrew-first audience. Hebrew is a scored feature,
 * not a reserved slot, because VIP is the only hard prefix in the contract.
 */
function computeLanguageRelevance(release, { matchLevel, originalLanguage }) {
  const langs = new Set(release.languages.values);
  const strongMatch = matchLevel === 'strong';

  if (langs.has('he')) {
    if (release.hasHebrewScript && strongMatch) return { value: 1.00, reason: 'hebrew_release_confirmed' };
    // #60: both branches returned 0.85, so strongMatch was inert unless the
    // release text was also confirmed Hebrew script -- a Hebrew tag backed by
    // strong title evidence is more trustworthy than a bare tag and should
    // score accordingly.
    if (strongMatch) return { value: 0.90, reason: 'hebrew_tag_confirmed' };
    return { value: 0.80, reason: 'hebrew_tag' };
  }

  const acceptable = new Set(['en', originalLanguage].filter(Boolean));
  const foreignOnly = langs.size > 0
    && !release.languages.multi
    && [...langs].every(lang => !acceptable.has(lang));
  if (foreignOnly) return { value: 0.25, reason: 'unrelated_language_only' };

  return { value: 0.55, reason: 'neutral_or_original_language' };
}

/** Credibility multiplier from explicit self-contradiction only. */
function computeCredibility(release) {
  const reasons = release.contradictions || [];
  if (!reasons.length) return { value: 1.00, reasons: [] };
  let value = 1.00;
  for (const reason of reasons) {
    const penalty = CREDIBILITY_PENALTY[reason.code];
    // Independent contradictions compound (#60) -- taking the min scored three
    // lies identically to the worst single one, so a release that contradicts
    // itself in three different ways was no less credible than one that
    // contradicts itself in one.
    if (penalty !== undefined) value *= penalty;
  }
  const severe = reasons.filter(r => r.severity === 'high').length;
  if (severe >= 2) value = Math.min(value, 0.25);
  return { value: clip(value, 0.25, 1.00), reasons: reasons.map(r => r.code) };
}

/** Match confidence from query provenance plus title evidence. */
function computeMatchConfidence({ queryMode, evidence, episodeMappingVerified }) {
  if (evidence.level === 'conflict') return { value: MATCH_CONFIDENCE.CONFLICT, reason: `conflict:${evidence.reason}` };
  if (queryMode === QUERY_MODE.CANONICAL_ID) return { value: MATCH_CONFIDENCE.CANONICAL, reason: 'canonical_id' };
  if (queryMode === QUERY_MODE.MAPPED_ID) {
    return episodeMappingVerified
      ? { value: MATCH_CONFIDENCE.MAPPED, reason: 'mapped_id_verified' }
      : { value: MATCH_CONFIDENCE.PARTIAL, reason: 'mapped_id_unverified' };
  }
  if (evidence.level === 'strong') {
    return queryMode === QUERY_MODE.ALIAS_TITLE
      ? { value: MATCH_CONFIDENCE.ALIAS_TITLE, reason: 'alias_title_strong' }
      : { value: MATCH_CONFIDENCE.PRIMARY_TITLE, reason: 'primary_title_strong' };
  }
  if (evidence.level === 'partial') return { value: MATCH_CONFIDENCE.PARTIAL, reason: `partial:${evidence.reason}` };
  return { value: MATCH_CONFIDENCE.NO_EVIDENCE, reason: `no_evidence:${evidence.reason}` };
}

/**
 * Extract the full feature vector for one candidate.
 *
 * @param {object} stream raw upstream row (carries `_provenance` from retrieval)
 * @param {object} context
 * @param {object} context.provider resolved capability entry
 * @param {string[]} context.expectedTitles titles that confirm the right content
 * @param {string[]} context.requestedTitleTokens tokens common to all candidates
 * @param {number|null} context.runtimeMinutes runtime for bitrate plausibility
 * @param {boolean} context.isEpisode episode request (stratum + pack logic)
 * @param {'generic'|'capable'} context.clientClass device capability class
 * @param {string|null} context.originalLanguage ISO-639-1 production language
 * @param {object} context.trustSnapshot immutable trust snapshot
 * @param {boolean} context.isNotice pre-computed notice-row flag
 */
export function extractFeatures(stream, context) {
  const provider = context.provider;
  const provenance = stream._provenance || {};
  const queryMode = provenance.queryMode || QUERY_MODE.CANONICAL_ID;

  const release = parseRelease(stream, {
    provider,
    requestedTitleTokens: context.requestedTitleTokens,
  });

  const analysisText = `${stream.name || ''} ${stream.title || ''} ${stream.description || ''}`;
  const cacheClaim = parseCacheClaim(provider, analysisText);
  const transport = classifyTransport(stream, provider, cacheClaim);
  const isIpLocked = IP_LOCK_RE.test(String(stream.url || ''));
  const hasHttp = hasValidHttpLocator(stream.url);

  const band = seederBand(release.seeders.value, release.seeders.trusted);
  const claimConfidence = cacheClaimConfidence(provider, transport, context.isEpisode, context.trustSnapshot);
  const availability = computeAvailability({
    transport,
    cacheClaim,
    evidenceConfidence: claimConfidence?.confidence,
    band,
    hasHttp,
  });

  const trust = integrityTrust(provider, transport, context.isEpisode, context.trustSnapshot);
  const evidence = titleMatchEvidence(stream, context.expectedTitles);
  const match = computeMatchConfidence({
    queryMode,
    evidence,
    episodeMappingVerified: !!provenance.episodeMappingVerified,
  });

  const visual = computeVisual(release);
  const hdr = HDR_SCORE[release.hdr.value] ?? HDR_SCORE[HDR.UNKNOWN];
  const audio = AUDIO_SCORE[release.audio.value] ?? AUDIO_SCORE[AUDIO.UNKNOWN];
  const compatibility = computeCompatibility(release, context.clientClass);
  const size = computeSizePlausibility(release, context.runtimeMinutes);
  const metadata = computeMetadataConfidence(release);
  const language = computeLanguageRelevance(release, {
    matchLevel: evidence.level,
    originalLanguage: context.originalLanguage,
  });
  const credibility = computeCredibility(release);

  const isVip = evaluateVip(provider, {
    text: analysisText.toLowerCase(),
    isSingleHopHttp: hasHttp && !stream.infoHash,
    isIpLocked,
    stream,
  });

  const ineligible = [];
  if (context.isNotice) ineligible.push(INELIGIBLE.NOTICE);
  if (!stream.url && !stream.infoHash && !stream.externalUrl) ineligible.push(INELIGIBLE.NO_LOCATOR);
  if (stream.url && !hasHttp && !stream.infoHash && !stream.externalUrl) ineligible.push(INELIGIBLE.BAD_URL);
  if (isIpLocked) ineligible.push(INELIGIBLE.IP_LOCKED);
  if (match.value < MATCH_ELIGIBILITY_THRESHOLD) ineligible.push(INELIGIBLE.TITLE_CONFLICT);

  return {
    modelVersion: MODEL_VERSION,
    provider,
    providerId: provider.providerId,
    providerFamily: provider.family,
    release,
    transport,
    stratum: stratumKey(transport, context.isEpisode),
    cacheClaim,
    isVip: !!isVip,
    isIpLocked,
    hasHttpLocator: hasHttp,
    eligible: ineligible.length === 0,
    ineligibleReasons: ineligible,

    // Normalized features in [0,1].
    F: quantize(availability.value),
    T: quantize(trust.trust),
    X: quantize(match.value),
    V: quantize(visual),
    D: quantize(compatibility),
    A: quantize(audio),
    H: quantize(hdr),
    Zt: quantize(size.tap),
    Zq: quantize(size.quality),
    M: quantize(metadata),
    L: quantize(language.value),
    C: quantize(credibility.value),

    seederBand: band,
    trustProven: trust.proven,
    trustEffectiveWeight: trust.effectiveWeight,
    explanation: {
      availability: availability.reason,
      trustSource: trust.source,
      cacheEvidence: claimConfidence ? `${claimConfidence.source}:${claimConfidence.confidence.toFixed(3)}` : 'none',
      match: match.reason,
      language: language.reason,
      credibility: credibility.reasons,
      bitrateMbps: size.bitrateMbps,
      sizeKnown: size.known,
    },
  };
}

export {
  MATCH_CONFIDENCE, RESOLUTION_BASE, SOURCE_ADJUST, EXPECTED_BITRATE, hasValidHttpLocator,
  computeCredibility, computeSizePlausibility, CODEC_EFFICIENCY, computeLanguageRelevance,
};
