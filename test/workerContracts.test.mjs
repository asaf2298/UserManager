/**
 * Worker-side contracts: TorBox claim grading and Telegram busy-lease evaluation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeClaim } from '../worker/media-intelligence/auditRunner.mjs';
import { evaluateHostBusyRow } from '../worker/media-intelligence/hostBusy.mjs';
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
