/**
 * End-to-end ranking pipeline: determinism under shuffle and performance gates
 * from master plan §14.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rankAndSelect,
  applyEligibility,
  pruneEligibleCandidates,
  prunePriority,
  MAX_RANKER_CANDIDATES,
  MIN_PER_PROVIDER_KEEP,
} from '../lib/streamEngine.js';
import { resolveProfile } from '../lib/streamRanker.js';
import { extractFeatures } from '../lib/streamFeatures.js';
import { deduplicateCandidates } from '../lib/streamDedup.js';
import { selectStreams } from '../lib/streamSelector.js';
import { resolveProvider } from '../lib/providerCapabilities.js';
import { scoreCandidates } from '../lib/streamRanker.js';
import * as fx from './fixtures/streams.mjs';

function pipelineContext(profileName = 'everything') {
  return {
    profile: resolveProfile(profileName),
    expectedTitles: fx.DUNE_TITLES,
    requestedTitleTokens: ['dune', 'part', 'two'],
    runtimeMinutes: 166,
    isEpisode: false,
    originalLanguage: 'en',
    trustSnapshot: { version: 'static-priors', byKey: new Map() },
  };
}

function shuffle(arr, seed) {
  const out = [...arr];
  let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function syntheticCandidates(count) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const res = i % 3 === 0 ? '2160p' : i % 3 === 1 ? '1080p' : '720p';
    const source = i % 4 === 0 ? 'BluRay.REMUX' : i % 4 === 1 ? 'WEB-DL' : i % 4 === 2 ? 'WEBRip' : 'BluRay';
    const codec = i % 2 === 0 ? 'HEVC' : 'x264';
    rows.push(fx.withSource({
      name: `Provider ${i % 7} ${res}`,
      title: `Dune.Part.Two.2024.${res}.${source}.${codec}-GRP${i % 40}\n👤 ${1 + (i % 120)} 💾 ${(2 + (i % 50) / 2).toFixed(1)} GB`,
      infoHash: `${String(i).padStart(8, '0')}aaaabbbbccccddddeeeeffff`.slice(0, 40),
      url: `https://cdn.example.net/dl/synth/${i}.mkv`,
    }, [fx.TORRENTIO, fx.COMET, fx.KNABEN, fx.YASTREAM, fx.MEDIAFUSION, fx.UNKNOWN_HOST, fx.KANBOX][i % 7]));
  }
  return rows;
}

test('shuffled arrival order cannot change the selected locator sequence', () => {
  const base = [...fx.MOVIE_SET, ...syntheticCandidates(40)];
  const ctx = pipelineContext('everything');
  const forward = rankAndSelect(base, ctx);
  const shuffled = rankAndSelect(shuffle(base, 42), ctx);
  assert.deepEqual(
    forward.selected.map(r => r.locatorHash),
    shuffled.selected.map(r => r.locatorHash),
  );
});

test('performance gates hold on 500 synthetic candidates', () => {
  const rows = syntheticCandidates(500);
  const profile = resolveProfile('everything');
  const ctx = {
    expectedTitles: fx.DUNE_TITLES,
    requestedTitleTokens: ['dune', 'part', 'two'],
    runtimeMinutes: 166,
    isEpisode: false,
    clientClass: profile.clientClass,
    originalLanguage: 'en',
    trustSnapshot: { version: 'static-priors', byKey: new Map() },
    isNotice: false,
  };

  const featureStart = process.hrtime.bigint();
  const candidates = rows.map(stream => ({
    stream,
    features: extractFeatures(stream, {
      provider: resolveProvider(stream._sourceBaseUrl, { configured: true }),
      ...ctx,
    }),
  }));
  const { scored } = scoreCandidates(candidates, profile, false);
  const featureMs = Number(process.hrtime.bigint() - featureStart) / 1e6;

  const dedupStart = process.hrtime.bigint();
  const { representatives } = deduplicateCandidates(scored);
  const dedupMs = Number(process.hrtime.bigint() - dedupStart) / 1e6;

  const selectStart = process.hrtime.bigint();
  selectStreams(representatives, profile);
  const selectMs = Number(process.hrtime.bigint() - selectStart) / 1e6;

  const totalMs = featureMs + dedupMs + selectMs;
  assert.ok(featureMs < 100, `feature+rank ${featureMs.toFixed(1)}ms exceeds 100ms`);
  assert.ok(dedupMs < 150, `dedup ${dedupMs.toFixed(1)}ms exceeds 150ms`);
  assert.ok(selectMs < 20, `select ${selectMs.toFixed(1)}ms exceeds 20ms`);
  assert.ok(totalMs < 300, `total non-network ${totalMs.toFixed(1)}ms exceeds 300ms`);
});

test('pipeline output length stays within the profile target', () => {
  const result = rankAndSelect(syntheticCandidates(80), pipelineContext('friends_light'));
  assert.ok(result.selected.length <= resolveProfile('friends_light').target);
  assert.ok(result.selected.every(row => Number.isFinite(row.baseScore)));
});

test('prunePriority prefers visual/availability features over weaker encodes', () => {
  const ctx = pipelineContext('everything');
  const { eligible } = applyEligibility(
    [fx.cachedRemux4k, fx.uncachedDeadP2P, fx.fake4k],
    ctx,
  );
  const byTitle = Object.fromEntries(
    eligible.map(c => [String(c.stream.title || c.stream.name).slice(0, 24), prunePriority(c)]),
  );
  const remux = eligible.find(c => c.stream === fx.cachedRemux4k);
  const dead = eligible.find(c => c.stream === fx.uncachedDeadP2P);
  assert.ok(remux && dead, 'fixtures should remain eligible');
  assert.ok(prunePriority(remux) > prunePriority(dead), byTitle);
});

test('feature prune bounds overload without changing survivor ranking math', () => {
  const ctx = pipelineContext('everything');
  const rows = [fx.cachedRemux4k, ...syntheticCandidates(MAX_RANKER_CANDIDATES + 80)];
  const { eligible } = applyEligibility(rows, ctx);
  assert.ok(eligible.length > MAX_RANKER_CANDIDATES);

  const { candidates: bounded, pruned } = pruneEligibleCandidates(eligible);
  assert.equal(bounded.length, MAX_RANKER_CANDIDATES);
  assert.equal(pruned, eligible.length - MAX_RANKER_CANDIDATES);
  assert.ok(bounded.some(c => c.stream === fx.cachedRemux4k), 'strong remux must survive admission');

  // Per-provider fairness floor still holds under overload.
  const counts = new Map();
  for (const candidate of bounded) {
    const key = candidate.features.providerId || 'unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const [providerId, count] of counts) {
    assert.ok(count >= MIN_PER_PROVIDER_KEEP, `${providerId} kept ${count}`);
  }

  // Final selected order among survivors is still baseScore→dedup→select, not prunePriority.
  const result = rankAndSelect(rows, ctx);
  assert.ok(result.diagnostics.prunedCandidates > 0);
  const shuffled = rankAndSelect(shuffle(rows, 99), ctx);
  assert.deepEqual(
    result.selected.map(r => r.locatorHash),
    shuffled.selected.map(r => r.locatorHash),
  );
});
