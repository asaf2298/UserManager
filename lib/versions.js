/**
 * Pinned pipeline versions.
 *
 * Ranking output must be a pure function of
 * (raw candidates, profile, parserVersion, capabilityVersion, trustSnapshotVersion, modelVersion).
 * Bump the relevant constant whenever parsing, capability data, or scoring
 * semantics change, so telemetry rows and trust snapshots stay attributable to
 * the exact logic that produced them.
 */

export const MODEL_VERSION = 'rank-v2.0';
// v2 -> v3: MinHash seed derivation fixed (#56) -- dedup output changes above
// LSH_THRESHOLD candidates, so telemetry rows stamped with the old version must
// not be compared against rows produced under the new one.
export const PARSER_VERSION = 'release-v3';
export const CAPABILITY_VERSION = 'providers-v1';

/** Score/feature comparison granularity. Values are quantized before any compare. */
export const QUANTUM = 1e-6;

/**
 * Quantize to QUANTUM so float noise can never reorder two otherwise-equal rows.
 *
 * The `toFixed` round-trip matters: `Math.round(0.8 / 1e-6) * 1e-6` yields
 * 0.7999999999999999, which would defeat the exact equality comparisons that make
 * ranking deterministic.
 */
export function quantize(value) {
  if (!Number.isFinite(value)) return 0;
  return Number((Math.round(value / QUANTUM) * QUANTUM).toFixed(6));
}

export function clip(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

export function versionBundle(trustSnapshotVersion = null) {
  return {
    modelVersion: MODEL_VERSION,
    parserVersion: PARSER_VERSION,
    capabilityVersion: CAPABILITY_VERSION,
    trustSnapshotVersion: trustSnapshotVersion || 'static-priors',
  };
}
