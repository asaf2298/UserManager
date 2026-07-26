/**
 * Host-busy lease consumer.
 *
 * The Telegram→Stremio addon holds a lease while it is streaming bytes from this
 * host. We read it and stay out of the way for the whole playback, because RAM
 * contention on a 1 GB box would stutter someone's movie.
 *
 * Contract with the Telegram repo:
 *   busy ↑    first active byte-stream (refcount 0→1)
 *   busy ↓    last stream generator finishes / disconnects / errors
 *   heartbeat busy_until refreshed roughly every 30s while streaming
 *
 * Only a live lease counts: an expired `busy_until` means the writer crashed, so
 * we treat it as free rather than deadlocking forever.
 *
 * TorBox/CDN playback never touches this host, so it does not set the lease and
 * intentionally does not pause sync.
 */
import { selectRows } from '../../lib/supabaseServer.js';
import { HOST_BUSY_ID, log } from './config.mjs';

const TABLE = 'personal_host_busy';
const READ_TIMEOUT_MS = 800;

/**
 * @returns {Promise<{ busy:boolean, reason:string, activeStreams:number|null }>}
 */
export async function isHostBusy() {
  const params = new URLSearchParams({
    select: 'busy,busy_until,active_streams,source,updated_at',
    id: `eq.${HOST_BUSY_ID}`,
    limit: '1',
  });

  const rows = await selectRows(TABLE, params, READ_TIMEOUT_MS);
  if (rows === null) {
    // Supabase unreachable. Proceeding is the safer failure mode: the alternative
    // is a worker that never runs whenever the database hiccups.
    return { busy: false, reason: 'lease_unreadable', activeStreams: null };
  }
  if (!rows.length) return { busy: false, reason: 'no_lease_row', activeStreams: null };

  const row = rows[0];
  if (!row.busy) return { busy: false, reason: 'not_busy', activeStreams: row.active_streams ?? null };

  const until = row.busy_until ? Date.parse(row.busy_until) : NaN;
  if (!Number.isFinite(until)) {
    return { busy: false, reason: 'no_lease_expiry', activeStreams: row.active_streams ?? null };
  }
  if (until <= Date.now()) {
    return { busy: false, reason: 'lease_expired', activeStreams: row.active_streams ?? null };
  }

  return {
    busy: true,
    reason: `telegram_streaming:${row.source || 'unknown'}`,
    activeStreams: row.active_streams ?? null,
    until,
  };
}

/**
 * Watch the lease while a heavy job runs and invoke `onBusy` the moment Telegram
 * starts streaming, so the job can abort and requeue.
 * @returns {() => void} stop function
 */
export function watchHostBusy(onBusy, intervalMs) {
  let stopped = false;
  const timer = setInterval(async () => {
    if (stopped) return;
    try {
      const state = await isHostBusy();
      if (state.busy && !stopped) {
        stopped = true;
        clearInterval(timer);
        log('busy', `lease acquired by ${state.reason} — yielding`);
        onBusy(state);
      }
    } catch {
      // A failed check must not kill an in-flight job.
    }
  }, intervalMs);

  if (typeof timer.unref === 'function') timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
