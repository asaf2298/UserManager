/**
 * Profile scoring (modelVersion = rank-v2.0).
 *
 * One weighted sum per profile, so every trade-off is explicit and tunable
 * instead of hidden in comparator ordering. Weights sum to 100 and all features
 * are in [0,1], so a base score is directly interpretable: "this stream lost 6
 * points because it is not confirmed cached".
 *
 * Profiles differ only in the weight vector, size-plausibility mode, eligibility
 * floor, and presentation constraints — never in a different algorithm.
 */
import crypto from 'node:crypto';
import { quantize, clip } from './versions.js';
import { SOURCE } from './releaseParser.js';
import { TRANSPORT } from './providerCapabilities.js';
import { FIELD } from './releaseParser.js';

/** Which size-plausibility curve a profile uses. */
export const Z_MODE = { TAP: 'tap', QUALITY: 'quality' };

/**
 * Locked profile table.
 *
 * `weights` sum to 100. `diversity` penalties are subtracted per already-selected
 * peer sharing that attribute. `caps` are hard presentation limits; `reservations`
 * are minimums applied only when enough eligible candidates exist.
 */
export const PROFILES = {
  everything: {
    name: 'everything',
    target: 30,
    clientClass: 'generic',
    zMode: Z_MODE.QUALITY,
    weights: { F: 12, T: 10, X: 8, V: 32, D: 4, A: 12, H: 10, Z: 5, M: 3, L: 4 },
    eligibility: { minF: 0, minC: 0, allowCam: true, maxSizeGB: Infinity },
    diversity: { provider: 2.00, resolution: 0.50, source: 0.50, codec: 0.25, language: 0.25 },
    caps: { vip: 2, provider: 8, unprovenProvider: 3, releaseGroup: 4, unknownResolution: 3, pureP2P: 12, cam: 1 },
    reservations: [
      { key: 'high_visual', min: 8, test: f => f.V >= 0.73 },
      { key: 'ready_now', min: 4, test: f => f.F >= 0.90 },
      { key: 'premium_audio', min: 2, test: f => f.A >= 0.78 },
    ],
    timeoutMs: 9500,
    collectionCutoffMs: 7000,
  },
  friends_heavy: {
    name: 'friends_heavy',
    target: 30,
    clientClass: 'generic',
    zMode: Z_MODE.QUALITY,
    weights: { F: 14, T: 12, X: 10, V: 30, D: 6, A: 10, H: 8, Z: 4, M: 2, L: 4 },
    eligibility: { minF: 0.15, minC: 0.25, allowCam: true, maxSizeGB: Infinity },
    diversity: { provider: 2.50, resolution: 0.75, source: 0.75, codec: 0.25, language: 0.50 },
    caps: { vip: 2, provider: 6, unprovenProvider: 2, releaseGroup: 3, unknownResolution: 3, pureP2P: 10, cam: 1 },
    reservations: [
      { key: 'high_visual', min: 6, test: f => f.V >= 0.73 },
      { key: 'ready_now', min: 3, test: f => f.F >= 0.90 },
      { key: 'premium_audio', min: 2, test: f => f.A >= 0.78 },
    ],
    timeoutMs: 9500,
    collectionCutoffMs: 7000,
  },
  friends_light: {
    name: 'friends_light',
    target: 10,
    clientClass: 'generic',
    zMode: Z_MODE.TAP,
    weights: { F: 26, T: 16, X: 12, V: 14, D: 12, A: 4, H: 2, Z: 4, M: 2, L: 8 },
    eligibility: { minF: 0.25, minC: 0.35, allowCam: false, maxSizeGB: 30 },
    diversity: { provider: 4.00, resolution: 1.25, source: 1.00, codec: 0.50, language: 1.00 },
    caps: { vip: 2, provider: 3, unprovenProvider: 1, releaseGroup: 2, unknownResolution: 1, pureP2P: 3, cam: 0 },
    reservations: [
      { key: 'ready_now', min: 4, test: f => f.F >= 0.90 },
      { key: 'compatible', min: 6, test: f => f.D >= 0.80 },
    ],
    timeoutMs: 9000,
    collectionCutoffMs: 5500,
  },
  family: {
    name: 'family',
    target: 10,
    clientClass: 'generic',
    zMode: Z_MODE.TAP,
    weights: { F: 28, T: 16, X: 14, V: 10, D: 16, A: 3, H: 1, Z: 4, M: 2, L: 6 },
    eligibility: { minF: 0.30, minC: 0.55, allowCam: false, maxSizeGB: 30 },
    diversity: { provider: 4.50, resolution: 1.00, source: 1.00, codec: 0.50, language: 1.50 },
    caps: { vip: 2, provider: 3, unprovenProvider: 1, releaseGroup: 2, unknownResolution: 1, pureP2P: 2, cam: 0 },
    reservations: [
      { key: 'ready_now', min: 5, test: f => f.F >= 0.90 },
      { key: 'compatible', min: 7, test: f => f.D >= 0.85 },
    ],
    timeoutMs: 9000,
    collectionCutoffMs: 5500,
  },
  /** Kodi/thin clients: same math, capable device, long flat list. */
  kodi: {
    name: 'kodi',
    target: 100,
    clientClass: 'capable',
    zMode: Z_MODE.QUALITY,
    weights: { F: 14, T: 12, X: 10, V: 30, D: 6, A: 10, H: 8, Z: 4, M: 2, L: 4 },
    eligibility: { minF: 0.15, minC: 0.25, allowCam: true, maxSizeGB: Infinity },
    diversity: { provider: 1.00, resolution: 0.25, source: 0.25, codec: 0, language: 0 },
    caps: { vip: 2, provider: 20, unprovenProvider: 5, releaseGroup: 10, unknownResolution: 10, pureP2P: 30, cam: 3 },
    reservations: [],
    timeoutMs: 9500,
    collectionCutoffMs: 7000,
  },
};

export const DEFAULT_PROFILE = 'friends_light';

/** Resolve a configured profile name to its locked definition. */
export function resolveProfile(name) {
  return PROFILES[name] || PROFILES[DEFAULT_PROFILE];
}

/** Episode-level size ceiling: shows are capped tighter than movies. */
export function effectiveSizeCapGB(profile, isEpisode) {
  const cap = profile.eligibility.maxSizeGB;
  if (!Number.isFinite(cap)) return Infinity;
  return Math.min(cap, isEpisode ? 10 : 30);
}

/**
 * Profile-specific eligibility, applied after features exist.
 * Unknown size is never a reason to drop: only a *known* oversize file is.
 */
export function profileEligible(features, profile, isEpisode) {
  const reasons = [];
  if (features.F < profile.eligibility.minF) reasons.push('below_min_availability');
  if (features.C < profile.eligibility.minC) reasons.push('below_min_credibility');
  if (!profile.eligibility.allowCam && features.release.source.value === SOURCE.CAM) reasons.push('cam_not_allowed');

  const capGB = effectiveSizeCapGB(profile, isEpisode);
  const bytes = features.release.size.bytes;
  const knownPerFileSize = Number.isFinite(bytes) && bytes > 0 && !features.release.isSeasonPack;
  if (knownPerFileSize && Number.isFinite(capGB) && bytes / 1024 ** 3 > capGB) {
    reasons.push('above_size_cap');
  }
  return { eligible: reasons.length === 0, reasons };
}

/**
 * Weighted base score in [0,100], scaled by the credibility multiplier so a
 * self-contradicting release cannot buy rank with impressive claims.
 */
export function computeBaseScore(features, profile) {
  const w = profile.weights;
  const z = profile.zMode === Z_MODE.TAP ? features.Zt : features.Zq;
  const linear =
    w.F * features.F +
    w.T * features.T +
    w.X * features.X +
    w.V * features.V +
    w.D * features.D +
    w.A * features.A +
    w.H * features.H +
    w.Z * z +
    w.M * features.M +
    w.L * features.L;
  return quantize(clip(features.C * linear, 0, 100));
}

/** Per-feature point contributions, for explainable diagnostics. */
export function scoreBreakdown(features, profile) {
  const w = profile.weights;
  const z = profile.zMode === Z_MODE.TAP ? features.Zt : features.Zq;
  const parts = {
    availability: w.F * features.F,
    trust: w.T * features.T,
    match: w.X * features.X,
    visual: w.V * features.V,
    compatibility: w.D * features.D,
    audio: w.A * features.A,
    hdr: w.H * features.H,
    sizePlausibility: w.Z * z,
    metadata: w.M * features.M,
    language: w.L * features.L,
  };
  const out = {};
  for (const [key, value] of Object.entries(parts)) out[key] = quantize(value * features.C);
  return out;
}

/** Stable identity of the playable target, used as the final tie-breaker. */
export function locatorHash(stream) {
  const locator = stream?.url
    || (stream?.infoHash ? `${stream.infoHash}:${stream.fileIdx ?? ''}` : '')
    || stream?.externalUrl
    || `${stream?.name || ''}|${stream?.title || ''}`;
  return crypto.createHash('sha256').update(String(locator)).digest('hex');
}

/**
 * Score a list of candidates for a profile.
 *
 * @param {Array<{stream:object, features:object}>} candidates
 * @param {object} profile locked profile definition
 * @param {boolean} isEpisode
 * @returns {{ scored:Array, rejected:Array }}
 */
export function scoreCandidates(candidates, profile, isEpisode) {
  const scored = [];
  const rejected = [];

  for (const candidate of candidates) {
    const { features, stream } = candidate;
    if (!features.eligible) {
      rejected.push({ stream, features, reasons: features.ineligibleReasons });
      continue;
    }
    const gate = profileEligible(features, profile, isEpisode);
    if (!gate.eligible) {
      rejected.push({ stream, features, reasons: gate.reasons });
      continue;
    }
    scored.push({
      stream,
      features,
      baseScore: computeBaseScore(features, profile),
      locatorHash: locatorHash(stream),
    });
  }

  return { scored, rejected };
}

/** Attribute keys used by the diversity penalty and presentation caps. */
export function diversityKeys(features) {
  const release = features.release;
  return {
    provider: features.providerId,
    resolution: release.resolution.state === FIELD.PARSED ? release.resolution.value : 'unknown',
    source: release.source.state === FIELD.PARSED ? release.source.family : 'unknown',
    codec: release.codec.state === FIELD.PARSED ? release.codec.value : 'unknown',
    language: release.languages.values.length ? release.languages.values.join('+') : 'unknown',
    releaseGroup: release.releaseGroup || null,
    isPureP2P: features.transport === TRANSPORT.P2P,
    isCam: release.source.value === SOURCE.CAM,
    unknownResolution: release.resolution.value === 'unknown' || release.resolution.state !== FIELD.PARSED,
    unproven: !features.trustProven,
  };
}
