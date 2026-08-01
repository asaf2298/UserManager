/**
 * Worker-side contracts: TorBox claim grading and Telegram busy-lease evaluation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeClaim } from '../worker/media-intelligence/auditRunner.mjs';
import { evaluateHostBusyRow } from '../worker/media-intelligence/hostBusy.mjs';
import { priorFor, evaluateSnapshotFreshness } from '../worker/media-intelligence/trustAggregator.mjs';
import { METRIC } from '../lib/providerTrust.js';
import { isCollectionThin } from '../lib/streamEngine.js';

test('gradeClaim rewards truthful TorBox cache labels only', () => {
  assert.deepEqual(gradeClaim('cache_positive', true), { outcome: true, metric: 'cache_claim' });
  assert.deepEqual(gradeClaim('cache_positive', false), { outcome: false, metric: 'cache_claim' });
  assert.deepEqual(gradeClaim('queued', false), { outcome: true, metric: 'cache_claim' });
  assert.deepEqual(gradeClaim('queued', true), { outcome: false, metric: 'cache_claim' });
});

test('gradeClaim treats missing checks and non-TorBox claims as no-observation', () => {
  assert.equal(gradeClaim('cache_positive', null).outcome, null);
  assert.equal(gradeClaim('cache_positive', undefined).outcome, null);
  assert.equal(gradeClaim('direct_owner', true).outcome, null);
  assert.equal(gradeClaim('unknown', false).outcome, null);
});

// #54 -- a stalled learning loop must be a loud worker-log warning, not silence.
test('evaluateSnapshotFreshness: a read failure is not reported as staleness (avoid double-reporting)', () => {
  const result = evaluateSnapshotFreshness(null, 1000, Date.now());
  assert.equal(result.stale, false);
  assert.equal(result.reason, null);
});

test('evaluateSnapshotFreshness: no snapshot ever published is stale', () => {
  const result = evaluateSnapshotFreshness([], 1000, Date.now());
  assert.equal(result.stale, true);
  assert.equal(result.reason, 'never_published');
});

test('evaluateSnapshotFreshness: a recent snapshot is fresh', () => {
  const now = Date.parse('2026-08-01T12:00:00Z');
  const rows = [{ computed_at: '2026-08-01T11:00:00Z', snapshot_version: 'snap-2026-08-01T11-00-00-000Z' }];
  const result = evaluateSnapshotFreshness(rows, 3 * 24 * 60 * 60_000, now);
  assert.equal(result.stale, false);
  assert.equal(result.ageMs, 60 * 60_000);
});

test('evaluateSnapshotFreshness: a snapshot older than the threshold is stale', () => {
  const now = Date.parse('2026-08-04T12:00:01Z');
  const rows = [{ computed_at: '2026-08-01T12:00:00Z', snapshot_version: 'snap-2026-08-01T12-00-00-000Z' }];
  const result = evaluateSnapshotFreshness(rows, 3 * 24 * 60 * 60_000, now);
  assert.equal(result.stale, true);
  assert.equal(result.reason, 'too_old');
});

test('host busy lease requires a live unexpired row', () => {
  const now = Date.parse('2026-07-26T01:00:00.000Z');
  assert.equal(evaluateHostBusyRow(null, now).busy, false);
  assert.equal(evaluateHostBusyRow({ busy: false, active_streams: 0 }, now).busy, false);
  assert.equal(evaluateHostBusyRow({
    busy: true,
    busy_until: '2026-07-26T00:59:00.000Z',
    active_streams: 1,
    source: 'telegram',
  }, now).reason, 'lease_expired');
  assert.equal(evaluateHostBusyRow({
    busy: true,
    busy_until: null,
    active_streams: 1,
  }, now).reason, 'no_lease_expiry');

  const live = evaluateHostBusyRow({
    busy: true,
    busy_until: '2026-07-26T01:00:30.000Z',
    active_streams: 2,
    source: 'stream_file',
  }, now);
  assert.equal(live.busy, true);
  assert.equal(live.activeStreams, 2);
  assert.match(live.reason, /telegram_streaming:stream_file/);
});

test('deferred alias fan-out only fires when the collection is still thin', () => {
  assert.equal(isCollectionThin(0), true);
  assert.equal(isCollectionThin(5), true);
  assert.equal(isCollectionThin(6), false);
  assert.equal(isCollectionThin(40), false);
  assert.equal(isCollectionThin(2, 10), true);
  assert.equal(isCollectionThin(10, 10), false);
});

test('priorFor resolves first-party hosts to their tuned prior, not the generic fallback', () => {
  // providerId is always persisted as `family:instanceKey` (see providerCapabilities.js
  // resolveProvider). instanceKey carries the real hostname — priorFor must use it
  // rather than reconstructing a `${family}.invalid` URL, which cannot match any
  // exactHost registry entry and silently degrades to generic_known.
  const kanBox = priorFor('kan_box:kan-box-addon.vercel.app', METRIC.INTEGRITY);
  assert.deepEqual(kanBox, { mu0: 0.85, kappa0: 8 });

  const telegram = priorFor(
    'personal_telegram:advantage-shot-petition-crucial.trycloudflare.com/as123456',
    METRIC.INTEGRITY,
  );
  assert.deepEqual(telegram, { mu0: 0.82, kappa0: 8 });

  const animeIl = priorFor('animeil:animeil.tv', METRIC.INTEGRITY);
  assert.deepEqual(animeIl, { mu0: 0.82, kappa0: 8 });

  // An actually-unrecognized host still correctly falls back to generic_known.
  const stranger = priorFor('some_random_family:totally-unknown-host.example', METRIC.INTEGRITY);
  assert.deepEqual(stranger, { mu0: 0.60, kappa0: 4 });
});
