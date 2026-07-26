/**
 * Ranking telemetry: deterministic audit sampling.
 *
 * Two rules keep the learning loop honest:
 *
 *   1. Sampling is a keyed hash of the candidate identity, not random and not
 *      rank-dependent. Auditing only what we already ranked first would teach the
 *      model that its current preferences are correct.
 *   2. Writing is strictly fire-and-forget with a hard budget. A telemetry
 *      failure must never alter or delay the stream response.
 *
 * Only explicit, checkable claims are queued. A stream with no verifiable
 * assertion produces no audit row, because "no evidence" is not "failure".
 */
import crypto from 'node:crypto';
import { CACHE_CLAIM } from './providerCapabilities.js';
import { auditInclusionProbability } from './providerTrust.js';
import { insertRows, canWrite, writeWithBudget } from './supabaseServer.js';
import { MODEL_VERSION, PARSER_VERSION, CAPABILITY_VERSION } from './versions.js';

/** Hard ceiling for the telemetry write, per the spec's latency contract. */
const WRITE_BUDGET_MS = 150;

/** Never queue more than this many rows from one request. */
const MAX_ROWS_PER_REQUEST = 8;

const AUDIT_TABLE = 'personal_ranking_audit_queue';

/**
 * Stable sampling key. Uses candidate identity only — never position, score, or
 * time — so inclusion is independent of the ranking being evaluated.
 */
function samplingKey(candidate) {
  const features = candidate.features;
  return [
    features.providerId,
    features.stratum,
    candidate.stream?.infoHash || candidate.locatorHash,
    features.cacheClaim?.claim || 'none',
  ].join('|');
}

/**
 * Deterministic inclusion decision at probability `p`.
 * Uniform in [0,1) from a keyed digest, so the same candidate is always sampled
 * or always skipped for a given salt.
 */
export function shouldSample(key, probability, salt = MODEL_VERSION) {
  if (!(probability > 0)) return false;
  if (probability >= 1) return true;
  const digest = crypto.createHash('sha256').update(`${salt}|${key}`).digest();
  const value = digest.readUInt32BE(0) / 0x1_0000_0000;
  return value < probability;
}

/**
 * Build audit rows for candidates carrying a checkable TorBox cache claim.
 * A TorBox hash claim is falsifiable via `checkcached`; a bare HTTP link is not,
 * so only the former is queued.
 */
export function buildAuditRows(candidates, context) {
  const rows = [];
  for (const candidate of candidates) {
    if (rows.length >= MAX_ROWS_PER_REQUEST) break;
    const features = candidate.features;
    const claim = features.cacheClaim?.claim;
    const infoHash = String(candidate.stream?.infoHash || '').toLowerCase();

    // Falsifiable only when we have a torrent hash to check against TorBox.
    if (!infoHash || !/^[0-9a-f]{32,40}$/.test(infoHash)) continue;
    if (claim !== CACHE_CLAIM.POSITIVE && claim !== CACHE_CLAIM.QUEUED) continue;

    const probability = auditInclusionProbability(features.trustEffectiveWeight);
    const key = samplingKey(candidate);
    if (!shouldSample(key, probability)) continue;

    rows.push({
      provider_id: features.providerId,
      provider_family: features.providerFamily,
      stratum: features.stratum,
      info_hash: infoHash,
      claim_class: claim,
      claim_marker: features.cacheClaim?.marker || null,
      evidence: {
        contentId: context.contentId,
        queryMode: candidate.stream?._provenance?.queryMode || null,
        fileFingerprint: features.release.fileFingerprint,
        sizeBytes: features.release.size.bytes,
        availability: features.F,
      },
      inclusion_probability: probability,
      model_version: MODEL_VERSION,
      parser_version: PARSER_VERSION,
      capability_version: CAPABILITY_VERSION,
      status: 'queued',
      attempts: 0,
    });
  }
  return rows;
}

/**
 * Queue audit rows without blocking the response.
 * Returns a promise for tests; production callers deliberately do not await it.
 */
export function recordRankingAudits(candidates, context) {
  if (!canWrite()) return Promise.resolve(false);
  const rows = buildAuditRows(candidates, context);
  if (!rows.length) return Promise.resolve(false);

  return writeWithBudget(
    () => insertRows(AUDIT_TABLE, rows, {
      onConflict: 'provider_id,info_hash,claim_class,model_version',
      ignoreDuplicates: true,
      timeoutMs: WRITE_BUDGET_MS,
    }),
    WRITE_BUDGET_MS,
  );
}

export { AUDIT_TABLE, samplingKey, WRITE_BUDGET_MS };
