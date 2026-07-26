/**
 * TTL sweeper.
 *
 * Sightings hold playable URLs, so expiring them promptly is a privacy and
 * correctness matter as much as a storage one: a stale debrid link is useless and
 * should not linger. Jobs and cached alignments expire on their own schedules.
 */
import { deleteRows } from '../../lib/supabaseServer.js';
import { log } from './config.mjs';

export async function runCleanup() {
  const nowIso = new Date().toISOString();
  const results = {};

  results.sightings = await deleteRows(
    'personal_stream_sightings',
    new URLSearchParams({ expires_at: `lt.${nowIso}` }),
    5000,
  );

  results.jobs = await deleteRows(
    'personal_subtitle_sync_jobs',
    new URLSearchParams({ expires_at: `lt.${nowIso}`, status: 'in.(done,failed)' }),
    5000,
  );

  results.cache = await deleteRows(
    'personal_subtitle_sync',
    new URLSearchParams({ expires_at: `lt.${nowIso}` }),
    5000,
  );

  // Audits are cheap rows but unbounded growth is still growth.
  const auditCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  results.audits = await deleteRows(
    'personal_ranking_audit_queue',
    new URLSearchParams({ created_at: `lt.${auditCutoff}`, status: 'in.(done,skipped,failed)' }),
    5000,
  );

  const failed = Object.entries(results).filter(([, r]) => r && r.ok === false).map(([k]) => k);
  log('cleanup', failed.length ? `swept with failures: ${failed.join(', ')}` : 'swept expired rows');
  return results;
}
