/**
 * P3 · WP-15 -- Russian fallback is unreliable because the scheduler drained
 * FIFO (#59). With PER_PROVIDER_INFLIGHT_CAP=2 (now 3) and 4 query entries per
 * provider, later waves only got a slot once earlier ones fully finished, so
 * which language actually got scheduled depended on provider answer latency
 * rather than the audience's language priority (Hebrew-first).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RetrievalScheduler, buildRetrievalPlan, entryPriority } from '../lib/streamEngine.js';
import { QUERY_MODE, QUERY_MODE_PRIORITY } from '../lib/providerCapabilities.js';
import * as fx from './fixtures/streams.mjs';

function deferredPromise() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('buildRetrievalPlan stamps langKey on title-search entries', () => {
  const contentMeta = { en: 'Breaking Bad', he: 'שובר שורות', ru: 'Во все тяжкие', original: 'Breaking Bad', year: 2008, runtimeMin: 45 };
  const { plan } = buildRetrievalPlan({
    addons: [fx.TORRENTIO],
    idWithExt: 'tt0903747.json',
    type: 'series',
    contentMeta,
    resolvedCtx: null,
    queryHint: '',
  });
  const byMode = plan.filter(e => e.queryMode === QUERY_MODE.PRIMARY_TITLE || e.queryMode === QUERY_MODE.EXTRA_LANGUAGE);
  assert.ok(byMode.length > 0, 'fixture must produce at least one title-search entry');
  for (const entry of byMode) {
    assert.ok(['he', 'en', 'ru', 'original'].includes(entry.langKey), `unexpected langKey ${entry.langKey}`);
  }
  const heEntry = byMode.find(e => e.searchTitle === 'שובר שורות');
  assert.equal(heEntry?.langKey, 'he');
  const ruEntry = byMode.find(e => e.searchTitle === 'Во все тяжкие');
  assert.equal(ruEntry?.langKey, 'ru');
});

test('entryPriority: query mode dominates, Hebrew ranks first within a mode', () => {
  const he = entryPriority({ queryMode: QUERY_MODE.EXTRA_LANGUAGE, langKey: 'he' });
  const en = entryPriority({ queryMode: QUERY_MODE.EXTRA_LANGUAGE, langKey: 'en' });
  const ru = entryPriority({ queryMode: QUERY_MODE.EXTRA_LANGUAGE, langKey: 'ru' });
  assert.ok(he < en && en < ru, 'within the same query mode: he < en < ru');

  const canonicalRu = entryPriority({ queryMode: QUERY_MODE.CANONICAL_ID, langKey: 'ru' });
  const extraHe = entryPriority({ queryMode: QUERY_MODE.EXTRA_LANGUAGE, langKey: 'he' });
  if (QUERY_MODE_PRIORITY[QUERY_MODE.CANONICAL_ID] < QUERY_MODE_PRIORITY[QUERY_MODE.EXTRA_LANGUAGE]) {
    assert.ok(canonicalRu < extraHe, 'query mode must dominate language within the priority number');
  }
});

test('RetrievalScheduler#drain picks the highest-priority waiting entry, not FIFO', async () => {
  const scheduler = new RetrievalScheduler({ deadlineAt: Date.now() + 10_000 });
  const holds = [deferredPromise(), deferredPromise(), deferredPromise()];

  // Saturate the per-provider cap (3) with low-urgency work so D/E must queue.
  for (let i = 0; i < 3; i++) {
    scheduler.submit('p', () => holds[i].promise.then(() => []), 50);
  }

  const started = [];
  // D (Russian-like, low priority number = drained last) queued BEFORE
  // E (Hebrew-like, high priority = drained first).
  scheduler.submit('p', () => { started.push('D'); return Promise.resolve([]); }, 30);
  scheduler.submit('p', () => { started.push('E'); return Promise.resolve([]); }, 0);

  holds[0].resolve();
  await new Promise((r) => setTimeout(r, 20));

  // `started` records invocation order, not resolution order -- both D and E
  // resolve near-instantly once given a slot, so both may run within the wait
  // window. The bug being tested is which one gets the slot FIRST.
  assert.ok(started.includes('E'), 'E must have been given a slot at all');
  assert.ok(
    started.indexOf('E') < started.indexOf('D'),
    `the higher-priority entry (E) must be invoked before the lower-priority one (D) queued earlier, got order ${JSON.stringify(started)}`,
  );
});
