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
export const PARSER_VERSION = 'release-v2';
export const CAPABILITY_VERSION = 'providers-v1';

/** Score/feature comparison granularity. Values are quantized before any compare. */
export const QUANTUM = 1e-6;

/** Quantize to QUANTUM so float noise can never reorder two otherwise-equal rows. */
export function quantize(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value / QUANTUM) * QUANTUM;
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
