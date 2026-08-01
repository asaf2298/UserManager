/**
 * Trust aggregation and snapshot publication.
 *
 * Observations are collapsed into a Beta pseudo-posterior per
 * (provider, stratum, metric), then published as an immutable, versioned snapshot.
 * The request path only ever reads a published snapshot, which keeps ranking
 * deterministic: the same request cannot score differently because an audit landed
 * mid-flight.
 *
 * Two guards against misleading numbers:
 *   - Observations are weighted by recency decay and capped inverse propensity, so
 *     a rare audited cell cannot swamp a common one.
 *   - Strata are never pooled. A provider serving easy cached movies must not be
 *     compared against one serving hard uncached episodes (Simpson's paradox).
 */
import { selectRows, insertRows } from '../../lib/supabaseServer.js';
import {
  observationWeight, posterior, wilsonLowerBound, METRIC,
} from '../../lib/providerTrust.js';
import { resolveProvider, integrityPrior, cacheClaimPrior } from '../../lib/providerCapabilities.js';
import { MODEL_VERSION } from '../../lib/versions.js';
import { log } from './config.mjs';

const OBSERVATIONS_TABLE = 'personal_provider_observations';
const SNAPSHOTS_TABLE = 'personal_provider_trust_snapshots';

/** Observations older than four half-lives contribute ~6% and are not worth fetching. */
const LOOKBACK_DAYS = 120;
const MAX_OBSERVATIONS = 5000;

/** Rebuild the prior for a provider id recorded as `family:instanceKey`. */
export function priorFor(providerId, metric) {
  // instanceKey already carries the real hostname (canonicalizeSourceBase never
  // hashes it, only config-looking path segments) — reuse it instead of
  // reconstructing a fake `${family}.invalid` URL, which cannot match any
  // exactHost/hostSubstring/hostLabel registry entry and silently falls back
  // to GENERIC_KNOWN for hosts like kan_box / personal_telegram.
  const colonIdx = String(providerId || '').indexOf(':');
  const instanceKey = colonIdx >= 0 ? providerId.slice(colonIdx + 1) : '';
  const provider = resolveProvider(`https://${instanceKey}`, { configured: true });
  const prior = metric === METRIC.CACHE_CLAIM ? cacheClaimPrior(provider) : integrityPrior(provider);
  return prior || { mu0: 0.5, kappa0: 4 };
}

/** Aggregate weighted observations into posterior cells. */
export function aggregateObservations(rows, now = Date.now()) {
  const cells = new Map();
  for (const row of rows || []) {
    const key = `${row.provider_id}||${row.stratum}||${row.metric}`;
    const cell = cells.get(key) || {
      providerId: row.provider_id,
      stratum: row.stratum,
      metric: row.metric,
      successWeight: 0,
      failureWeight: 0,
      count: 0,
    };
    const observedAt = Date.parse(row.observed_at);
    const ageDays = Number.isFinite(observedAt) ? (now - observedAt) / 86_400_000 : 0;
    const weight = observationWeight(ageDays, Number(row.inclusion_probability) || 1);
    if (row.outcome) cell.successWeight += weight;
    else cell.failureWeight += weight;
    cell.count++;
    cells.set(key, cell);
  }
  return [...cells.values()];
}

/**
 * Recompute and publish a trust snapshot.
 * @returns {Promise<{ published:number, version:string|null }>}
 */
export async function publishTrustSnapshot() {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const params = new URLSearchParams({
    select: 'provider_id,stratum,metric,outcome,inclusion_probability,observed_at',
    observed_at: `gte.${since}`,
    order: 'observed_at.desc',
    limit: String(MAX_OBSERVATIONS),
  });

  const rows = await selectRows(OBSERVATIONS_TABLE, params, 5000);
  if (rows === null) return { published: 0, version: null };
  if (!rows.length) {
    log('trust', 'no observations yet — static priors remain in effect');
    return { published: 0, version: null };
  }

  const cells = aggregateObservations(rows);
  const version = `snap-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const computedAt = new Date().toISOString();

  const snapshotRows = cells.map((cell) => {
    const prior = priorFor(cell.providerId, cell.metric);
    const post = posterior(prior, cell);
    return {
      provider_id: cell.providerId,
      stratum: cell.stratum,
      metric: cell.metric,
      snapshot_version: version,
      alpha: post.alpha,
      beta: post.beta,
      effective_weight: post.effectiveWeight,
      trust_lower_bound: wilsonLowerBound(post.alpha, post.beta),
      model_version: MODEL_VERSION,
      computed_at: computedAt,
    };
  });

  const result = await insertRows(SNAPSHOTS_TABLE, snapshotRows, {
    onConflict: 'provider_id,stratum,metric,snapshot_version',
    merge: true,
    timeoutMs: 8000,
  });
  if (!result.ok) {
    log('trust', `snapshot publish failed: ${result.error}`);
    return { published: 0, version: null };
  }

  log('trust', `published ${snapshotRows.length} trust cells as ${version}`, {
    observations: rows.length,
  });
  return { published: snapshotRows.length, version };
}

/** Count observations recorded since a timestamp, to decide on an early rebuild. */
export async function countObservationsSince(isoTimestamp) {
  const params = new URLSearchParams({
    select: 'id',
    observed_at: `gte.${isoTimestamp}`,
    limit: '500',
  });
  const rows = await selectRows(OBSERVATIONS_TABLE, params, 2000);
  return Array.isArray(rows) ? rows.length : 0;
}

/**
 * Pure decision logic for the staleness check, kept separate from the
 * Supabase read so it is testable without a live/mocked backend.
 *
 * @param {Array|null} rows newest-first snapshot rows (computed_at, snapshot_version), or null on read failure
 * @param {number} staleAfterMs age past which the newest snapshot counts as stale
 * @param {number} now current time in ms, injectable for tests
 * @returns {{ stale:boolean, reason:string|null, ageMs:number|null, version:string|null }}
 */
export function evaluateSnapshotFreshness(rows, staleAfterMs, now = Date.now()) {
  if (rows === null) {
    // Read failure (misconfigured/unreachable Supabase) is a distinct problem,
    // already surfaced wherever that read is attempted; don't double-report.
    return { stale: false, reason: null, ageMs: null, version: null };
  }
  if (!rows.length) {
    return { stale: true, reason: 'never_published', ageMs: null, version: null };
  }

  const computedAt = Date.parse(rows[0].computed_at);
  const ageMs = Number.isFinite(computedAt) ? now - computedAt : null;
  if (ageMs === null || ageMs > staleAfterMs) {
    return { stale: true, reason: 'too_old', ageMs, version: rows[0].snapshot_version };
  }

  return { stale: false, reason: null, ageMs, version: rows[0].snapshot_version };
}

/**
 * A stalled learning loop (#54's failure mode) is otherwise completely silent:
 * ranking quietly falls back to static priors forever and nothing errors.
 * Surface it in the worker log instead.
 *
 * @param {number} staleAfterMs age past which the newest snapshot counts as stale
 * @returns {Promise<{ stale:boolean, reason:string|null, ageMs:number|null, version:string|null }>}
 */
export async function checkTrustSnapshotStaleness(staleAfterMs) {
  const params = new URLSearchParams({
    select: 'computed_at,snapshot_version',
    order: 'computed_at.desc',
    limit: '1',
  });
  const rows = await selectRows(SNAPSHOTS_TABLE, params, 2000);
  const result = evaluateSnapshotFreshness(rows, staleAfterMs);

  if (result.reason === 'never_published') {
    log('trust', '⚠️ staleness check: no trust snapshot has ever been published — ranking is on static priors');
  } else if (result.reason === 'too_old') {
    log('trust', `⚠️ staleness check: newest snapshot (${result.version}) is ${
      result.ageMs === null ? 'of unknown age' : `${Math.round(result.ageMs / 3_600_000)}h old`
    } — learning loop may be stalled`);
  }

  return result;
}
