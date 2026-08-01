#!/usr/bin/env node
/**
 * Media worker: TorBox audits, trust snapshots, and subtitle alignment.
 *
 * Runs as a second service beside the Telegram→Stremio addon on a 1 CPU / 1 GB
 * droplet. The scheduling rules follow from that constraint:
 *
 *   - One heavy subtitle job at a time, never two.
 *   - While the Telegram lease is held, no heavy work starts, and an in-flight job
 *     aborts and requeues so a viewer's stream keeps the RAM.
 *   - Light Supabase/TorBox calls are paced by interval, not by load.
 *
 * Usage: node worker/media-intelligence/index.mjs
 */
import { assertConfigured, torboxConfigured, LIMITS, WORKER_ID, log } from './config.mjs';
import { isHostBusy, watchHostBusy } from './hostBusy.mjs';
import { runAuditBatch } from './auditRunner.mjs';
import { publishTrustSnapshot, countObservationsSince, checkTrustSnapshotStaleness } from './trustAggregator.mjs';
import { claimSubtitleJob, processSubtitleJob, requeueJob } from './subtitleWorker.mjs';
import { runCleanup } from './cleanup.mjs';

const state = {
  running: true,
  lastAuditAt: 0,
  lastSnapshotAt: 0,
  lastCleanupAt: 0,
  lastStalenessCheckAt: 0,
  lastObservationCheck: new Date().toISOString(),
  jobsProcessed: 0,
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run one subtitle job under lease supervision.
 *
 * The abort path terminates the exact child PID this job spawned. Killing by
 * process name would be unsafe on a shared host — it could take down ffmpeg
 * belonging to the Telegram addon.
 */
async function runOneSubtitleJob() {
  const job = await claimSubtitleJob();
  if (!job) return false;

  let aborted = false;
  const children = new Set();
  const control = {
    isAborted: () => aborted,
    registerChild: (child) => {
      children.add(child);
      child.on('close', () => children.delete(child));
    },
  };

  const stopWatching = watchHostBusy(() => {
    aborted = true;
    for (const child of children) {
      try {
        child.kill('SIGTERM');
        const pid = child.pid;
        setTimeout(() => {
          try {
            if (pid && !child.killed) process.kill(pid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }, 5000);
      } catch {
        // Child already exited.
      }
    }
  }, LIMITS.busyCheckIntervalMs);

  const guard = setTimeout(() => {
    aborted = true;
    for (const child of children) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }, LIMITS.jobTotalTimeoutMs);

  try {
    const result = await processSubtitleJob(job, control);
    state.jobsProcessed++;
    return result.ok || result.reason !== 'busy_aborted';
  } catch (err) {
    log('subtitle', `unexpected job error: ${err.message}`);
    await requeueJob(job.id).catch(() => {});
    return false;
  } finally {
    clearTimeout(guard);
    stopWatching();
  }
}

/** Light maintenance that is safe to run even while Telegram streams. */
async function runLightTasks(now) {
  if (torboxConfigured() && now - state.lastAuditAt >= LIMITS.auditBatchIntervalMs) {
    state.lastAuditAt = now;
    await runAuditBatch().catch(err => log('audit', `batch error: ${err.message}`));
  }

  if (now - state.lastSnapshotAt >= LIMITS.snapshotIntervalMs) {
    state.lastSnapshotAt = now;
    await publishTrustSnapshot().catch(err => log('trust', `snapshot error: ${err.message}`));
  } else if (now - state.lastSnapshotAt >= LIMITS.auditBatchIntervalMs * 5) {
    // Publish early when enough new evidence has accumulated to matter.
    const fresh = await countObservationsSince(state.lastObservationCheck).catch(() => 0);
    if (fresh >= LIMITS.snapshotObservationThreshold) {
      state.lastObservationCheck = new Date().toISOString();
      state.lastSnapshotAt = now;
      await publishTrustSnapshot().catch(err => log('trust', `snapshot error: ${err.message}`));
    }
  }

  if (now - state.lastCleanupAt >= LIMITS.cleanupIntervalMs) {
    state.lastCleanupAt = now;
    await runCleanup().catch(err => log('cleanup', `error: ${err.message}`));
  }

  // A stalled learning loop (#54) has no other symptom -- ranking silently
  // falls back to static priors with nothing erroring anywhere. Piggyback on
  // the cleanup cadence: cheap, and frequent enough to catch a stall promptly.
  if (now - state.lastStalenessCheckAt >= LIMITS.cleanupIntervalMs) {
    state.lastStalenessCheckAt = now;
    await checkTrustSnapshotStaleness(LIMITS.snapshotStaleAfterMs).catch(err => log('trust', `staleness check error: ${err.message}`));
  }
}

async function main() {
  assertConfigured();
  log('boot', `starting ${WORKER_ID}`, {
    torbox: torboxConfigured() ? 'enabled' : 'disabled (no TORBOX_API_TOKEN)',
    subtitleConcurrency: LIMITS.subtitleConcurrency,
  });

  const shutdown = (signal) => {
    log('boot', `received ${signal}, finishing current work`);
    state.running = false;
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  while (state.running) {
    const now = Date.now();
    try {
      await runLightTasks(now);

      const busy = await isHostBusy();
      if (busy.busy) {
        log('loop', `host busy (${busy.reason}) — skipping heavy work`, { activeStreams: busy.activeStreams });
        await sleep(LIMITS.busyBackoffMs);
        continue;
      }

      const didWork = await runOneSubtitleJob();
      if (!didWork) await sleep(LIMITS.idlePollMs);
    } catch (err) {
      log('loop', `iteration error: ${err.message}`);
      await sleep(LIMITS.idlePollMs);
    }
  }

  log('boot', `stopped after ${state.jobsProcessed} job(s)`);
}

main().catch((err) => {
  console.error(`[media-worker] fatal: ${err.message}`);
  process.exit(1);
});
