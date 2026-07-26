/**
 * Audit runner: turns queued claims into falsifiable observations.
 *
 * The only claim we can actually check is "this TorBox hash is cached", so that is
 * the only claim we grade. Everything else stays unobserved:
 *
 *   y=1  provider said cache_positive and TorBox confirms the hash is cached
 *   y=0  provider said cache_positive and a fresh check shows it is not
 *   y=1  provider said queued and the hash is indeed not cached (honest label)
 *   none request failed, identity insufficient, or the claim is not TorBox-shaped
 *
 * A cache miss on a *queued* claim is a provider being truthful, not a failure —
 * conflating the two would punish addons for labelling uncached files correctly.
 */
import { selectRows, insertRows, updateRows } from '../../lib/supabaseServer.js';
import { checkCached } from './torbox.mjs';
import { LIMITS, log, torboxConfigured } from './config.mjs';

const QUEUE_TABLE = 'personal_ranking_audit_queue';
const OBSERVATIONS_TABLE = 'personal_provider_observations';

/**
 * Grade one queued claim against the TorBox cache snapshot.
 * @returns {{ outcome:boolean|null, metric:string }}
 */
export function gradeClaim(claimClass, isCachedNow) {
  if (isCachedNow === null || isCachedNow === undefined) return { outcome: null, metric: 'cache_claim' };
  if (claimClass === 'cache_positive') return { outcome: isCachedNow === true, metric: 'cache_claim' };
  if (claimClass === 'queued') return { outcome: isCachedNow === false, metric: 'cache_claim' };
  return { outcome: null, metric: 'cache_claim' };
}

/** Claim a batch of queued audits. */
async function claimBatch(size) {
  const params = new URLSearchParams({
    select: 'id,provider_id,provider_family,stratum,info_hash,claim_class,inclusion_probability,model_version,attempts',
    status: 'eq.queued',
    order: 'created_at.asc',
    limit: String(size),
  });
  const rows = await selectRows(QUEUE_TABLE, params, 1500);
  if (!Array.isArray(rows) || !rows.length) return [];

  const ids = rows.map(r => r.id);
  await updateRows(
    QUEUE_TABLE,
    new URLSearchParams({ id: `in.(${ids.join(',')})` }),
    { status: 'claimed', updated_at: new Date().toISOString() },
    2000,
  );
  return rows;
}

/**
 * Run one audit batch. Rate limiting is enforced by the caller
 * (LIMITS.auditBatchIntervalMs) so TorBox is never hit more than once a minute.
 */
export async function runAuditBatch() {
  if (!torboxConfigured()) return { ran: false, reason: 'no_torbox_token' };

  const batch = await claimBatch(LIMITS.auditBatchSize);
  if (!batch.length) return { ran: false, reason: 'queue_empty' };

  const hashes = batch.map(row => String(row.info_hash || '').toLowerCase()).filter(Boolean);
  const { ok, cached, error } = await checkCached(hashes);

  if (!ok) {
    // No evidence: return the rows to the queue so a transient TorBox failure does
    // not silently discard audit coverage.
    await updateRows(
      QUEUE_TABLE,
      new URLSearchParams({ id: `in.(${batch.map(r => r.id).join(',')})` }),
      { status: 'queued', attempts: undefined, last_error: String(error).slice(0, 200), updated_at: new Date().toISOString() },
      2000,
    );
    return { ran: true, observations: 0, reason: 'torbox_unavailable' };
  }

  const observations = [];
  const nowIso = new Date().toISOString();
  const doneIds = [];
  const skippedIds = [];

  for (const row of batch) {
    const hash = String(row.info_hash || '').toLowerCase();
    const isCachedNow = cached.has(hash);
    const { outcome, metric } = gradeClaim(row.claim_class, isCachedNow);

    if (outcome === null) {
      skippedIds.push(row.id);
      continue;
    }

    observations.push({
      provider_id: row.provider_id,
      provider_family: row.provider_family,
      stratum: row.stratum,
      metric,
      outcome,
      inclusion_probability: Number(row.inclusion_probability) || 1,
      source: 'torbox_checkcached',
      candidate_key: `${hash}|${row.claim_class}`,
      model_version: row.model_version,
      observed_at: nowIso,
    });
    doneIds.push(row.id);
  }

  if (observations.length) {
    await insertRows(OBSERVATIONS_TABLE, observations, {
      onConflict: 'provider_id,metric,candidate_key,source',
      ignoreDuplicates: true,
      timeoutMs: 3000,
    });
  }
  if (doneIds.length) {
    await updateRows(
      QUEUE_TABLE,
      new URLSearchParams({ id: `in.(${doneIds.join(',')})` }),
      { status: 'done', updated_at: nowIso },
      2000,
    );
  }
  if (skippedIds.length) {
    await updateRows(
      QUEUE_TABLE,
      new URLSearchParams({ id: `in.(${skippedIds.join(',')})` }),
      { status: 'skipped', updated_at: nowIso },
      2000,
    );
  }

  log('audit', `graded ${observations.length}/${batch.length} claims`, {
    cachedHits: cached.size,
    skipped: skippedIds.length,
  });
  return { ran: true, observations: observations.length, reason: null };
}
