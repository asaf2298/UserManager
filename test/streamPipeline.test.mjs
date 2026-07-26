/**
 * End-to-end ranking pipeline: determinism under shuffle and performance gates
 * from master plan §14.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rankAndSelect } from '../lib/streamEngine.js';
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
