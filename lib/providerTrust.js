/**
 * Provider integrity trust and cache-claim confidence.
 *
 * Two separate posteriors, deliberately not merged:
 *   - integrity  : does this provider return a row that really is the requested
 *                  content, with a usable locator?
 *   - cache_claim: when this provider says "cached", is that true?
 *
 * Both are conservative Wilson lower bounds so a provider with three lucky
 * successes cannot outrank one with a long, solid record. Cold providers get the
 * capability-map prior rather than zero, because absence of evidence is not
 * evidence of failure.
 *
 * Request path reads immutable snapshots only. Aggregation happens in the worker.
 */
import { clip } from './versions.js';
import { integrityPrior, cacheClaimPrior } from './providerCapabilities.js';
import { selectRows, canRead } from './supabaseServer.js';

export const METRIC = { INTEGRITY: 'integrity', CACHE_CLAIM: 'cache_claim' };

/** Effective weight at which a provider stops being "unproven". */
export const PROVEN_WEIGHT = 10;

/** Weight at which sampling drops from exploration (20%) to monitoring (5%). */
export const SAMPLING_SWITCH_WEIGHT = 20;

/** 90% one-sided normal quantile: conservative without being punitive. */
const Z_90 = 1.2816;

const SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const SNAPSHOT_TIMEOUT_MS = 400;

/** Observation half-life in days: older evidence fades but never flips sign. */
export const HALF_LIFE_DAYS = 30;

/** Inverse-propensity weights are capped so one rare audit cannot dominate. */
export const MAX_IPW = 10;

/**
 * Decayed, propensity-corrected weight of a single observation.
 * @param {number} ageDays age of the observation
 * @param {number} inclusionProbability probability this candidate was audited
 */
export function observationWeight(ageDays, inclusionProbability) {
  const decay = Math.pow(2, -Math.max(0, Number(ageDays) || 0) / HALF_LIFE_DAYS);
  const p = Number(inclusionProbability);
  const ipw = Number.isFinite(p) && p > 0 ? Math.min(MAX_IPW, 1 / p) : 1;
  return decay * ipw;
}

/**
 * Wilson score lower bound for a Beta(alpha, beta) pseudo-posterior.
 * Returns the conservative estimate used directly as the T feature.
 */
export function wilsonLowerBound(alpha, beta) {
  const n = alpha + beta;
  if (!Number.isFinite(n) || n <= 0) return 0.05;
  const p = alpha / n;
  const z2 = Z_90 * Z_90;
  const numerator = p + z2 / (2 * n) - Z_90 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const denominator = 1 + z2 / n;
  return clip(numerator / denominator, 0.05, 0.95);
}

/**
 * Posterior parameters from a prior plus weighted observations.
 * @param {{mu0:number, kappa0:number}} prior
 * @param {{successWeight:number, failureWeight:number}} observed
 */
export function posterior(prior, observed) {
  const mu0 = clip(prior?.mu0 ?? 0.5, 0.01, 0.99);
  const kappa0 = Math.max(0.5, prior?.kappa0 ?? 4);
  const alpha = kappa0 * mu0 + Math.max(0, observed?.successWeight || 0);
  const beta = kappa0 * (1 - mu0) + Math.max(0, observed?.failureWeight || 0);
  return { alpha, beta, effectiveWeight: (observed?.successWeight || 0) + (observed?.failureWeight || 0) };
}

/** Stratum key: trust must not be pooled across transports or media kinds. */
export function stratumKey(transportClass, isEpisode) {
  return `${transportClass || 'unknown'}|${isEpisode ? 'episode' : 'movie'}`;
}

function snapshotKey(providerId, stratum, metric) {
  return `${providerId}||${stratum}||${metric}`;
}

let snapshotCache = { loadedAt: 0, version: 'static-priors', byKey: new Map() };
let inflight = null;

/**
 * Load the newest immutable trust snapshot into a 5-minute in-memory cache.
 * Never throws; on any failure the static capability priors remain in effect.
 */
export async function loadTrustSnapshot() {
  const now = Date.now();
  if (now - snapshotCache.loadedAt < SNAPSHOT_TTL_MS && snapshotCache.byKey.size >= 0 && snapshotCache.loadedAt > 0) {
    return snapshotCache;
  }
  if (inflight) return inflight;
  if (!canRead()) {
    snapshotCache = { loadedAt: now, version: 'static-priors', byKey: new Map() };
    return snapshotCache;
  }

  inflight = (async () => {
    const params = new URLSearchParams({
      select: 'provider_id,stratum,metric,alpha,beta,effective_weight,trust_lower_bound,snapshot_version',
      order: 'computed_at.desc',
      limit: '2000',
    });
    const rows = await selectRows('personal_provider_trust_snapshots', params, SNAPSHOT_TIMEOUT_MS);
    const byKey = new Map();
    let version = 'static-priors';
    if (Array.isArray(rows) && rows.length) {
      version = rows[0].snapshot_version || 'unversioned';
      for (const row of rows) {
        if (row.snapshot_version !== version) continue;
        byKey.set(snapshotKey(row.provider_id, row.stratum, row.metric), {
          alpha: Number(row.alpha) || 0,
          beta: Number(row.beta) || 0,
          effectiveWeight: Number(row.effective_weight) || 0,
          trust: Number(row.trust_lower_bound),
        });
      }
    }
    snapshotCache = { loadedAt: Date.now(), version, byKey };
    inflight = null;
    return snapshotCache;
  })().catch(() => {
    snapshotCache = { loadedAt: Date.now(), version: 'static-priors', byKey: new Map() };
    inflight = null;
    return snapshotCache;
  });

  return inflight;
}

/** Currently cached snapshot without triggering a fetch (safe inside scoring). */
export function currentSnapshot() {
  return snapshotCache;
}

/**
 * True when the snapshot carries at least one observation for `metric`.
 * Owns the `byKey` composite-key format (`providerId||stratum||metric`) so
 * callers never need to know its shape -- see snapshotKey().
 */
export function snapshotHasMetric(snapshot, metric) {
  if (!snapshot?.byKey?.size) return false;
  const suffix = `||${metric}`;
  for (const key of snapshot.byKey.keys()) {
    if (key.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * Integrity trust `T` for a provider in a stratum.
 * @returns {{ trust:number, effectiveWeight:number, proven:boolean, source:string }}
 */
export function integrityTrust(provider, transportClass, isEpisode, snapshot = snapshotCache) {
  const stratum = stratumKey(transportClass, isEpisode);
  const entry = snapshot?.byKey?.get(snapshotKey(provider.providerId, stratum, METRIC.INTEGRITY));
  if (entry && Number.isFinite(entry.trust)) {
    return {
      trust: clip(entry.trust, 0.05, 0.95),
      effectiveWeight: entry.effectiveWeight,
      proven: entry.effectiveWeight >= PROVEN_WEIGHT,
      source: 'snapshot',
    };
  }
  const prior = integrityPrior(provider);
  const post = posterior(prior, { successWeight: 0, failureWeight: 0 });
  return {
    trust: clip(wilsonLowerBound(post.alpha, post.beta), 0.05, 0.95),
    effectiveWeight: 0,
    proven: false,
    source: 'prior',
  };
}

/**
 * Confidence `e` that a provider's cache marker is truthful.
 * Providers with no cache vocabulary return null so availability falls through
 * to transport-based reasoning instead of inventing a claim.
 */
export function cacheClaimConfidence(provider, transportClass, isEpisode, snapshot = snapshotCache) {
  const prior = cacheClaimPrior(provider);
  if (!prior) return null;
  const stratum = stratumKey(transportClass, isEpisode);
  const entry = snapshot?.byKey?.get(snapshotKey(provider.providerId, stratum, METRIC.CACHE_CLAIM));
  if (entry && Number.isFinite(entry.trust)) {
    return { confidence: clip(entry.trust, 0.05, 0.95), effectiveWeight: entry.effectiveWeight, source: 'snapshot' };
  }
  const post = posterior(prior, { successWeight: 0, failureWeight: 0 });
  return {
    confidence: clip(wilsonLowerBound(post.alpha, post.beta), 0.05, 0.95),
    effectiveWeight: 0,
    source: 'prior',
  };
}

/**
 * Audit inclusion probability: explore unproven cells harder, then monitor.
 * Sampling affects future learning only — never the current ranking.
 */
export function auditInclusionProbability(effectiveWeight) {
  return (Number(effectiveWeight) || 0) < SAMPLING_SWITCH_WEIGHT ? 0.20 : 0.05;
}
