import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeIntegrityProbe } from '../worker/media-intelligence/subtitleWorker.mjs';

test('gradeIntegrityProbe: success is always integrity-true regardless of source', () => {
  assert.deepEqual(gradeIntegrityProbe({ probeSucceeded: true, sourceKind: 'torbox_cdn' }), { outcome: true, metric: 'integrity' });
  assert.deepEqual(gradeIntegrityProbe({ probeSucceeded: true, sourceKind: 'offered' }), { outcome: true, metric: 'integrity' });
});

test('gradeIntegrityProbe: failure only counts against torbox_cdn-resolved sources', () => {
  assert.deepEqual(gradeIntegrityProbe({ probeSucceeded: false, sourceKind: 'torbox_cdn' }), { outcome: false, metric: 'integrity' });
});

test('gradeIntegrityProbe: ambiguous/offered/blocked failures yield no evidence', () => {
  assert.equal(gradeIntegrityProbe({ probeSucceeded: false, sourceKind: 'offered' }).outcome, null);
  assert.equal(gradeIntegrityProbe({ probeSucceeded: false, sourceKind: 'blocked' }).outcome, null);
  assert.equal(gradeIntegrityProbe({ probeSucceeded: false, sourceKind: undefined }).outcome, null);
});
