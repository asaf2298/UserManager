/**
 * Deduplication.
 *
 * The two failure modes are opposite and both bad: leaving five copies of one
 * encode in the list, or merging two genuinely different files. These tests pin the
 * compatibility gate that prevents the second, which is the more damaging one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deduplicateCandidates, duplicateVerdict, releasesCompatible, canonicalPlaybackUrl, LSH_THRESHOLD,
  MINHASH_SEEDS, MINHASH_VALUES,
} from '../lib/streamDedup.js';
import { extractFeatures } from '../lib/streamFeatures.js';
import { resolveProvider } from '../lib/providerCapabilities.js';
import { computeBaseScore, locatorHash, resolveProfile } from '../lib/streamRanker.js';
import * as fx from './fixtures/streams.mjs';

const PROFILE = resolveProfile('everything');

function scoredCandidate(stream, overrides = {}) {
  const features = extractFeatures(stream, {
    provider: resolveProvider(stream._sourceBaseUrl, { configured: true }),
    expectedTitles: fx.DUNE_TITLES,
    requestedTitleTokens: ['dune', 'part', 'two'],
    runtimeMinutes: 166,
    isEpisode: false,
    clientClass: 'generic',
    originalLanguage: 'en',
    trustSnapshot: { version: 'static-priors', byKey: new Map() },
    isNotice: false,
    ...overrides,
  });
  return { stream, features, baseScore: computeBaseScore(features, PROFILE), locatorHash: locatorHash(stream) };
}

test('canonical playback URL drops credentials but keeps file identity', () => {
  const a = canonicalPlaybackUrl('https://cdn.example.net/dl/file.mkv?token=abc123&ip=1.2.3.4');
  const b = canonicalPlaybackUrl('https://cdn.example.net/dl/file.mkv?token=zzz999&ip=9.9.9.9');
  assert.equal(a, b, 'the same file behind two signed URLs is one file');

  const other = canonicalPlaybackUrl('https://cdn.example.net/dl/other.mkv?token=abc123');
  assert.notEqual(a, other, 'different paths remain distinct');
});

test('the same encode from two providers merges into one cluster', () => {
  const a = scoredCandidate(fx.cachedRemux4k);
  const b = scoredCandidate(fx.cachedRemux4kDuplicate);
  const verdict = duplicateVerdict(a, b);
  assert.equal(verdict.duplicate, true, `expected merge, rule=${verdict.rule}`);

  const { representatives } = deduplicateCandidates([a, b]);
  assert.equal(representatives.length, 1);
});

test('same infoHash but different files are never merged', () => {
  const a = scoredCandidate(fx.singleEpisode, { isEpisode: true, expectedTitles: fx.BREAKING_BAD_TITLES });
  const b = scoredCandidate(fx.otherEpisodeSameHash, { isEpisode: true, expectedTitles: fx.BREAKING_BAD_TITLES });
  const verdict = duplicateVerdict(a, b);
  assert.equal(verdict.duplicate, false, 'S03E05 and S03E06 are different videos');
  assert.equal(verdict.rule, 'infohash_different_file');
});

test('a season pack never merges with a single episode', () => {
  const pack = scoredCandidate(fx.seasonPack, { isEpisode: true, expectedTitles: fx.BREAKING_BAD_TITLES });
  const episode = scoredCandidate(fx.singleEpisode, { isEpisode: true, expectedTitles: fx.BREAKING_BAD_TITLES });
  assert.equal(releasesCompatible(pack.features, episode.features), false);
});

test('different resolutions, codecs, HDR, and editions block merging', () => {
  const base = scoredCandidate(fx.cachedRemux4k);
  const cases = [
    ['resolution', 'Dune.Part.Two.2024.1080p.BluRay.REMUX.DV.HDR10.HEVC.TrueHD.Atmos.7.1-FraMeSToR'],
    ['codec', 'Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.DV.HDR10.x264.TrueHD.Atmos.7.1-FraMeSToR'],
    ['hdr', 'Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.SDR.HEVC.TrueHD.Atmos.7.1-FraMeSToR'],
  ];
  for (const [label, title] of cases) {
    const variant = scoredCandidate(fx.withSource({
      name: 'Comet',
      title,
      url: 'https://cdn.example.net/dl/variant/dune.mkv',
      infoHash: 'ffff0000eeee1111dddd2222cccc3333bbbb4444',
    }, fx.COMET));
    assert.equal(
      releasesCompatible(base.features, variant.features), false,
      `${label} difference must block a merge`,
    );
  }

  // Edition conflicts require both sides to declare a known edition (§8.2).
  // Unknown vs EXTENDED is not a hard conflict; EXTENDED vs theatrical is.
  const extended = scoredCandidate(fx.withSource({
    name: 'Comet',
    title: 'Dune.Part.Two.2024.2160p.EXTENDED.UHD.BluRay.REMUX.DV.HDR10.HEVC.TrueHD.Atmos.7.1-FraMeSToR',
    url: 'https://cdn.example.net/dl/extended/dune.mkv',
    infoHash: 'ffff0000eeee1111dddd2222cccc3333bbbb4445',
  }, fx.COMET));
  const theatrical = scoredCandidate(fx.withSource({
    name: 'Comet',
    title: 'Dune.Part.Two.2024.2160p.THEATRICAL.UHD.BluRay.REMUX.DV.HDR10.HEVC.TrueHD.Atmos.7.1-FraMeSToR',
    url: 'https://cdn.example.net/dl/theatrical/dune.mkv',
    infoHash: 'ffff0000eeee1111dddd2222cccc3333bbbb4446',
  }, fx.COMET));
  assert.equal(releasesCompatible(extended.features, theatrical.features), false);
});

test('a self-contradictory resolution label never merges on text similarity', () => {
  const base = scoredCandidate(fx.cachedRemux4k);
  // Claims 2160p in the provider name but 1080p in the release title: we cannot
  // tell what it is, so it must not be folded into a confident cluster.
  const ambiguous = scoredCandidate(fx.withSource({
    name: 'Comet 2160p',
    title: 'Dune.Part.Two.2024.1080p.BluRay.REMUX.DV.HDR10.HEVC.TrueHD.Atmos.7.1-FraMeSToR',
    url: 'https://cdn.example.net/dl/ambiguous/dune.mkv',
    infoHash: 'eeee0000ffff1111aaaa2222bbbb3333cccc4444',
  }, fx.COMET));
  assert.equal(releasesCompatible(base.features, ambiguous.features), false);
});

test('different language variants do not merge', () => {
  const hebrew = scoredCandidate(fx.hebrewRelease);
  const spanish = scoredCandidate(fx.withSource({
    name: '[TB+] Torrentio 1080p',
    title: 'Dune.Part.Two.2024.1080p.WEB-DL.Spanish.Castellano.x264\n👤 18 💾 7.4 GB',
    url: 'https://cdn.example.net/dl/es1/dune.es.mkv',
    infoHash: 'cccc0000dddd1111eeee2222ffff3333aaaa4444',
  }, fx.TORRENTIO));
  assert.equal(releasesCompatible(hebrew.features, spanish.features), false);
});

test('unrelated releases stay separate', () => {
  const remux = scoredCandidate(fx.cachedRemux4k);
  const web = scoredCandidate(fx.uncachedHealthyP2P);
  assert.equal(duplicateVerdict(remux, web).duplicate, false);
});

test('the highest-scoring variant represents its cluster', () => {
  const strong = scoredCandidate(fx.cachedRemux4k);
  const weak = scoredCandidate(fx.cachedRemux4kDuplicate);
  const { representatives, clusters } = deduplicateCandidates([weak, strong]);
  assert.equal(representatives.length, 1);
  assert.equal(clusters[0].variants.length, 2);
  assert.ok(
    representatives[0].baseScore >= weak.baseScore,
    'the representative must be the best variant, not the first seen',
  );
});

test('clustering is independent of input order', () => {
  const candidates = fx.MOVIE_SET.map(s => scoredCandidate(s));
  const forward = deduplicateCandidates(candidates);
  const reversed = deduplicateCandidates([...candidates].reverse());
  assert.equal(forward.representatives.length, reversed.representatives.length);
  assert.deepEqual(
    forward.representatives.map(r => r.locatorHash).sort(),
    reversed.representatives.map(r => r.locatorHash).sort(),
  );
});

test('similarity is not treated as transitive', () => {
  // A↔B and B↔C may each pass while A↔C fails; anchor assignment must not chain
  // them into one cluster.
  const a = scoredCandidate(fx.cachedRemux4k);
  const b = scoredCandidate(fx.cachedRemux4kDuplicate);
  const c = scoredCandidate(fx.uncachedHealthyP2P);
  const { clusters } = deduplicateCandidates([a, b, c]);
  const withC = clusters.find(cl => cl.variants.some(v => v.locatorHash === c.locatorHash));
  assert.equal(withC.variants.length, 1, 'the 1080p x264 release must stay alone');
});

test('LSH mode activates above the threshold and still merges exact duplicates', () => {
  const filler = [];
  for (let i = 0; i < LSH_THRESHOLD + 20; i++) {
    filler.push(scoredCandidate(fx.withSource({
      name: 'Knaben 1080p',
      title: `Dune.Part.Two.2024.1080p.WEB-DL.x264-GRP${i}\n👤 ${10 + i} 💾 ${(6 + i / 100).toFixed(1)} GB`,
      infoHash: `${String(i).padStart(4, '0')}aaaabbbbccccddddeeeeffff0000111122`.slice(0, 40),
    }, fx.KNABEN)));
  }
  const withDupes = [...filler, scoredCandidate(fx.cachedRemux4k), scoredCandidate(fx.cachedRemux4kDuplicate)];
  const { representatives, stats } = deduplicateCandidates(withDupes);
  assert.equal(stats.mode, 'lsh');
  assert.ok(
    representatives.length <= withDupes.length - 1,
    'the known cross-provider duplicate must still collapse under LSH',
  );
});

// #56 -- a single 32-byte sha256 digest cannot supply 128 independent 32-bit
// seeds; `(i*4) % 28` used to wrap after 7 distinct offsets, collapsing all 32
// LSH bands to 7 distinct patterns and tanking recall above LSH_THRESHOLD.
test('MinHash seeds are 128 distinct values, not a 7-value repeating cycle', () => {
  assert.equal(MINHASH_SEEDS.length, MINHASH_VALUES);
  assert.equal(new Set(MINHASH_SEEDS).size, 128, 'all 128 seeds must be distinct');
  // The old bug's exact signature: seeds[i] === seeds[i+7] for every i.
  const oldBugPeriod7 = MINHASH_SEEDS.slice(0, 121).every((v, i) => v === MINHASH_SEEDS[i + 7]);
  assert.equal(oldBugPeriod7, false, 'must not still repeat with period 7');
});
