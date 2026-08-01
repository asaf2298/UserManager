/**
 * Stage 2: constrained, diverse presentation.
 *
 * Selection is greedy on marginal gain rather than a plain score sort, because a
 * list of ten near-identical rows from one provider is worse for the viewer than
 * nine slightly weaker but varied options. Diversity is a soft penalty; caps are
 * hard.
 *
 * VIP is the single business override: at most two VIP rows, always first. Every
 * other position is earned.
 */
import { diversityKeys } from './streamRanker.js';
import { quantize } from './versions.js';
import { METRIC, snapshotHasMetric } from './providerTrust.js';

/** Caps that may be doubled once if strict limits cannot fill the target. */
const RELAXABLE_CAPS = ['provider', 'unprovenProvider', 'releaseGroup', 'unknownResolution', 'pureP2P'];

function emptyCounters() {
  return {
    provider: new Map(),
    resolution: new Map(),
    source: new Map(),
    codec: new Map(),
    language: new Map(),
    releaseGroup: new Map(),
    pureP2P: 0,
    cam: 0,
    unknownResolution: 0,
    unprovenByProvider: new Map(),
  };
}

function countOf(map, key) {
  return map.get(key) || 0;
}

function bump(map, key) {
  if (key === null || key === undefined) return;
  map.set(key, (map.get(key) || 0) + 1);
}

/**
 * Marginal gain: base score minus a penalty for each attribute already
 * represented in the selected list.
 */
export function marginalGain(candidate, counters, profile) {
  const keys = candidate.keys;
  const d = profile.diversity;
  const penalty =
    d.provider * countOf(counters.provider, keys.provider) +
    d.resolution * countOf(counters.resolution, keys.resolution) +
    d.source * countOf(counters.source, keys.source) +
    d.codec * countOf(counters.codec, keys.codec) +
    d.language * countOf(counters.language, keys.language);
  return quantize(candidate.baseScore - penalty);
}

/** Hard caps. Returns the violated cap name, or null when the row may be used. */
function capViolation(candidate, counters, caps) {
  const keys = candidate.keys;
  if (countOf(counters.provider, keys.provider) >= caps.provider) return 'provider';
  if (keys.unproven && countOf(counters.unprovenByProvider, keys.provider) >= caps.unprovenProvider) {
    return 'unprovenProvider';
  }
  if (keys.releaseGroup && countOf(counters.releaseGroup, keys.releaseGroup) >= caps.releaseGroup) {
    return 'releaseGroup';
  }
  if (keys.unknownResolution && counters.unknownResolution >= caps.unknownResolution) return 'unknownResolution';
  if (keys.isPureP2P && counters.pureP2P >= caps.pureP2P) return 'pureP2P';
  if (keys.isCam && counters.cam >= caps.cam) return 'cam';
  return null;
}

function applySelection(candidate, counters) {
  const keys = candidate.keys;
  bump(counters.provider, keys.provider);
  bump(counters.resolution, keys.resolution);
  bump(counters.source, keys.source);
  bump(counters.codec, keys.codec);
  bump(counters.language, keys.language);
  if (keys.releaseGroup) bump(counters.releaseGroup, keys.releaseGroup);
  if (keys.unproven) bump(counters.unprovenByProvider, keys.provider);
  if (keys.isPureP2P) counters.pureP2P++;
  if (keys.isCam) counters.cam++;
  if (keys.unknownResolution) counters.unknownResolution++;
}

/**
 * Deterministic ordering when marginal gains tie.
 * Ends on the locator hash so two structurally identical rows still order
 * stably across runs and across shuffled arrival order.
 */
function compareForSelection(a, b) {
  if (b.gain !== a.gain) return b.gain - a.gain;
  if (b.baseScore !== a.baseScore) return b.baseScore - a.baseScore;
  if (b.features.T !== a.features.T) return b.features.T - a.features.T;
  if (b.features.F !== a.features.F) return b.features.F - a.features.F;
  if (b.features.M !== a.features.M) return b.features.M - a.features.M;
  if (a.features.providerId !== b.features.providerId) {
    return a.features.providerId < b.features.providerId ? -1 : 1;
  }
  return a.locatorHash < b.locatorHash ? -1 : a.locatorHash > b.locatorHash ? 1 : 0;
}

/**
 * Select the final presentation list from deduplicated cluster representatives.
 *
 * @param {Array} representatives scored cluster representatives
 * @param {object} profile locked profile definition
 * @param {object} [trustSnapshot] immutable trust snapshot for this request
 * @returns {{ selected:Array, stats:object }}
 */
export function selectStreams(representatives, profile, trustSnapshot) {
  const pool = representatives.map(candidate => ({
    ...candidate,
    keys: diversityKeys(candidate.features),
    selected: false,
  }));

  const counters = emptyCounters();
  const selected = [];
  const stats = { vip: 0, reservationsFilled: {}, relaxed: false, capBlocked: {} };
  const caps = { ...profile.caps };

  // A missing/empty integrity snapshot means nothing is *proven* yet -- that is
  // an absence of evidence, not evidence of failure. Applying the unproven cap
  // in that state silently throttles every provider fleet-wide (#54): every
  // candidate's features.trustProven is false, so this cap alone can reduce
  // a ten-row profile to "cap.unprovenProvider per provider" regardless of how
  // many good candidates are actually available.
  const trustDegraded = !snapshotHasMetric(trustSnapshot, METRIC.INTEGRITY);
  if (trustDegraded) {
    caps.unprovenProvider = Infinity;
    console.warn('[PERSONAL TRUST] ⚠️ no integrity snapshot -- ranking on static priors, unproven cap disabled');
  }

  // 1. VIP prefix: business precedence, hard-capped, never relaxed, one row per provider.
  const vipCandidates = pool
    .filter(c => c.features.isVip)
    .sort((a, b) => compareForSelection(
      { ...a, gain: a.baseScore },
      { ...b, gain: b.baseScore },
    ));
  const vipProviders = new Set();
  for (const candidate of vipCandidates) {
    if (selected.length >= Math.min(caps.vip, profile.target)) break;
    if (vipProviders.has(candidate.keys.provider)) continue;
    candidate.selected = true;
    vipProviders.add(candidate.keys.provider);
    applySelection(candidate, counters);
    selected.push(candidate);
    stats.vip++;
  }
  // Total VIP output is capped at two. Leftover VIP clusters must not re-enter
  // through reservations or marginal-gain fill — the plan treats them as unused,
  // not as ordinary competitors that happen to carry a VIP flag.
  for (const candidate of vipCandidates) {
    if (!candidate.selected) candidate.blockedExtraVip = true;
  }

  const takeOne = (predicate) => {
    let best = null;
    for (const candidate of pool) {
      if (candidate.selected || candidate.blockedExtraVip) continue;
      if (predicate && !predicate(candidate.features)) continue;
      const violation = capViolation(candidate, counters, caps);
      if (violation) {
        stats.capBlocked[violation] = (stats.capBlocked[violation] || 0) + 1;
        continue;
      }
      const scored = { candidate, gain: marginalGain(candidate, counters, profile) };
      if (!best || compareForSelection(
        { ...scored.candidate, gain: scored.gain },
        { ...best.candidate, gain: best.gain },
      ) < 0) {
        best = scored;
      }
    }
    if (!best) return false;
    best.candidate.selected = true;
    best.candidate.finalGain = best.gain;
    applySelection(best.candidate, counters);
    selected.push(best.candidate);
    return true;
  };

  // 2. Reservation minimums, in declared order, so a profile's promise holds
  //    (e.g. family always offers a few instantly-playable, compatible rows).
  for (const reservation of profile.reservations || []) {
    let have = selected.filter(c => reservation.test(c.features)).length;
    while (have < reservation.min && selected.length < profile.target) {
      if (!takeOne(reservation.test)) break;
      have++;
    }
    stats.reservationsFilled[reservation.key] = have;
  }

  // 3. Fill the rest by marginal gain.
  while (selected.length < profile.target) {
    if (!takeOne(null)) break;
  }

  // 4. Single relaxation pass: doubling soft caps is preferable to returning a
  //    short list, but eligibility, dedup, CAM bans, and the VIP cap never move.
  if (selected.length < profile.target) {
    const remaining = pool.some(c => !c.selected && !c.blockedExtraVip);
    if (remaining) {
      for (const key of RELAXABLE_CAPS) caps[key] = caps[key] * 2;
      stats.relaxed = true;
      while (selected.length < profile.target) {
        if (!takeOne(null)) break;
      }
    }
  }

  stats.selected = selected.length;
  stats.poolSize = pool.length;
  return { selected, stats };
}

export { compareForSelection, capViolation };
