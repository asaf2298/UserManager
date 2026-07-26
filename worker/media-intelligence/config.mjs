/**
 * Media worker configuration.
 *
 * Every limit here exists because this process shares a 1 CPU / 1 GB droplet with
 * the Telegram→Stremio addon. Streaming a movie to a viewer always outranks
 * aligning a subtitle, so the worker is deliberately small, single-tracked, and
 * quick to yield.
 */

export const SUPABASE_URL = process.env.SUPABASE_URL || '';
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

/** TorBox token lives only on the worker; it must never reach a client. */
export const TORBOX_API_TOKEN = process.env.TORBOX_API_TOKEN || '';
export const TORBOX_API_BASE = process.env.TORBOX_API_BASE || 'https://api.torbox.app';
export const TORBOX_API_VERSION = process.env.TORBOX_API_VERSION || 'v1';

/** Identifies this worker instance when claiming jobs. */
export const WORKER_ID = process.env.WORKER_ID || `media-worker-${process.pid}`;

/** Host-busy lease row shared with the Telegram addon. */
export const HOST_BUSY_ID = process.env.HOST_BUSY_ID || 'default';

export const LIMITS = {
  /** Exactly one heavy subtitle job at a time. Not configurable by design. */
  subtitleConcurrency: 1,

  /** Poll cadence for the job queue when idle. */
  idlePollMs: Number(process.env.WORKER_IDLE_POLL_MS) || 15_000,

  /** Sleep length when the Telegram lease is active. */
  busyBackoffMs: Number(process.env.WORKER_BUSY_BACKOFF_MS) || 20_000,

  /** Re-check the lease this often while a heavy job runs. */
  busyCheckIntervalMs: 5_000,

  /** TorBox batch pacing: at most one checkcached batch per minute, 100 hashes. */
  auditBatchIntervalMs: 60_000,
  auditBatchSize: 100,

  /** mylist is account state, not playback proof; poll it sparingly. */
  mylistIntervalMs: 10 * 60_000,

  /** Trust recomputation cadence and the observation delta that forces one. */
  snapshotIntervalMs: 24 * 60 * 60_000,
  snapshotObservationThreshold: 100,

  /** TTL sweep cadence. */
  cleanupIntervalMs: 60 * 60_000,

  /** Per-step timeouts for the alignment pipeline. */
  ffprobeTimeoutMs: 30_000,
  extractTimeoutMs: 90_000,
  alassTimeoutMs: 120_000,
  jobTotalTimeoutMs: 240_000,

  /** Retry policy. Busy aborts are free and never consume an attempt. */
  maxAttempts: 3,
  backoffMs: [60_000, 5 * 60_000, 30 * 60_000],

  /** Audit-queue rows that keep failing (e.g. TorBox outage) stop looping after this many tries. */
  maxQueueAttempts: 5,

  /** Temp disk ceiling for one job. */
  tempBudgetBytes: 512 * 1024 * 1024,

  /** Only probe the opening window: enough cues to align, a fraction of the bytes. */
  probeWindowSeconds: Number(process.env.WORKER_PROBE_WINDOW_SECONDS) || 900,
};

export function assertConfigured() {
  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) {
    throw new Error(`media-worker requires ${missing.join(', ')}`);
  }
}

export function torboxConfigured() {
  return !!TORBOX_API_TOKEN;
}

export function log(scope, message, extra = null) {
  const suffix = extra ? ` ${JSON.stringify(extra)}` : '';
  console.log(`[media-worker][${scope}] ${message}${suffix}`);
}
