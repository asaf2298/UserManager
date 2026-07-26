/**
 * Feature extraction and scoring equations.
 *
 * These tests pin the exact numbers in the specification. They also encode the
 * properties that must hold no matter how weights are tuned later: unknown data is
 * neutral, raw size never buys rank, and cache/VIP status cannot be minted by text.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFeatures, seederBand, classifyTransport, MATCH_CONFIDENCE } from '../lib/streamFeatures.js';
import { resolveProvider, TRANSPORT, CACHE_CLAIM, parseCacheClaim, evaluateVip } from '../lib/providerCapabilities.js';
import { PROFILES, computeBaseScore, profileEligible, resolveProfile } from '../lib/streamRanker.js';
import * as fx from './fixtures/streams.mjs';

const BASE_CONTEXT = {
  expectedTitles: fx.DUNE_TITLES,
  requestedTitleTokens: ['dune', 'part', 'two'],
  runtimeMinutes: 166,
  isEpisode: false,
  clientClass: 'generic',
  originalLanguage: 'en',
  trustSnapshot: { version: 'static-priors', byKey: new Map() },
  isNotice: false,
};

function featuresFor(stream, overrides = {}) {
  return extractFeatures(stream, {
    ...BASE_CONTEXT,
    ...overrides,
    provider: resolveProvider(stream._sourceBaseUrl, { configured: true }),
  });
}

test('seeder bands match the specified thresholds', () => {
  const cases = [[0, 0.00], [1, 0.15], [2, 0.15], [3, 0.30], [5, 0.30], [6, 0.45],
    [10, 0.45], [11, 0.62], [25, 0.62], [26, 0.76], [50, 0.76], [51, 0.88],
    [100, 0.88], [101, 1.00], [5000, 1.00]];
  for (const [seeders, expected] of cases) {
    assert.equal(seederBand(seeders, true), expected, `seeders=${seeders}`);
  }
  assert.equal(seederBand(null, true), 0.35, 'unknown seeders are neutral');
  assert.equal(seederBand(80, false), 0.35, 'untrusted seeder fields are neutral');
});

test('all features stay within [0,1]', () => {
  for (const stream of fx.MOVIE_SET) {
    const f = featuresFor(stream);
    for (const key of ['F', 'T', 'X', 'V', 'D', 'A', 'H', 'Zt', 'Zq', 'M', 'L', 'C']) {
      assert.ok(f[key] >= 0 && f[key] <= 1, `${key}=${f[key]} out of range`);
    }
  }
});

test('cache-positive debrid beats queued debrid on availability', () => {
  const cached = featuresFor(fx.cachedRemux4k);
  const queued = featuresFor(fx.queuedDebrid);
  assert.ok(cached.F >= 0.80, `cache-positive should be >= 0.80, got ${cached.F}`);
  assert.ok(queued.F < 0.75, `queued should be well below cached, got ${queued.F}`);
});

test('a bare [TB] tag is queued, not cached', () => {
  const provider = resolveProvider(fx.YASTREAM, { configured: true });
  const claim = parseCacheClaim(provider, fx.queuedDebrid.title);
  assert.equal(claim.claim, CACHE_CLAIM.QUEUED);
});

test('healthy swarm outranks a dead swarm on availability alone', () => {
  const healthy = featuresFor(fx.uncachedHealthyP2P);
  const dead = featuresFor(fx.uncachedDeadP2P);
  assert.equal(healthy.transport, TRANSPORT.P2P);
  assert.ok(healthy.F > dead.F, `${healthy.F} should exceed ${dead.F}`);
  assert.ok(Math.abs(dead.F - 0.10) < 1e-6, `dead swarm F should be 0.10, got ${dead.F}`);
});

test('VIP comes from provider rules, never from title text', () => {
  assert.equal(featuresFor(fx.vipKanBox).isVip, true, 'Kan-Box host is authoritative VIP');
  assert.equal(featuresFor(fx.vipTelegram).isVip, true, 'MediaFusion telegram_bot is VIP');
  assert.equal(
    featuresFor(fx.fakeVipUnknownHost).isVip, false,
    'the same text from an unknown host must not create VIP',
  );
});

test('IP-locked links are ineligible', () => {
  const f = featuresFor(fx.ipLocked);
  assert.equal(f.eligible, false);
  assert.ok(f.ineligibleReasons.includes('ip_locked_url'));
});

test('rows with no locator are ineligible', () => {
  const f = featuresFor(fx.noLocator);
  assert.equal(f.eligible, false);
  assert.ok(f.ineligibleReasons.includes('no_playable_locator'));
});

test('a wrong-show row is dropped on content conflict', () => {
  const f = featuresFor(fx.wrongShow);
  assert.equal(f.X, MATCH_CONFIDENCE.CONFLICT);
  assert.equal(f.eligible, false);
  assert.ok(f.ineligibleReasons.includes('content_conflict'));
});

test('match confidence follows query provenance', () => {
  const canonical = featuresFor(fx.cachedRemux4k);
  assert.equal(canonical.X, MATCH_CONFIDENCE.CANONICAL);

  const viaTitle = featuresFor(fx.withSource(
    { ...fx.uncachedHealthyP2P, _sourceBaseUrl: undefined }, fx.KNABEN, 'primary_title',
  ));
  assert.equal(viaTitle.X, MATCH_CONFIDENCE.PRIMARY_TITLE);

  const viaAlias = featuresFor(fx.withSource(
    { ...fx.uncachedHealthyP2P, _sourceBaseUrl: undefined }, fx.KNABEN, 'alias_title',
  ));
  assert.equal(viaAlias.X, MATCH_CONFIDENCE.ALIAS_TITLE);
});

test('no title evidence on a text search scores at the floor, not as a conflict', () => {
  // A canonical-ID hit is trusted outright, so provenance must be a text search for
  // "no evidence" to be the operative case.
  const viaSearch = fx.withSource({ ...fx.garbled, _sourceBaseUrl: undefined }, fx.UNKNOWN_HOST, 'primary_title');
  const f = featuresFor(viaSearch, { expectedTitles: [] });
  assert.equal(f.X, MATCH_CONFIDENCE.NO_EVIDENCE);
  assert.ok(f.X >= 0.70, 'must remain eligible');

  // The same row reached by canonical ID is fully trusted.
  const canonical = featuresFor(fx.garbled, { expectedTitles: [] });
  assert.equal(canonical.X, MATCH_CONFIDENCE.CANONICAL);
});

test('contradictions reduce credibility, unknown metadata does not', () => {
  assert.equal(featuresFor(fx.cachedRemux4k).C, 1);
  assert.equal(featuresFor(fx.garbled).C, 1, 'unknown must not be punished');
  assert.ok(featuresFor(fx.fake4k).C <= 0.40, 'HDR on 8-bit codec');
  assert.ok(featuresFor(fx.upscaled).C <= 0.55, 'declared upscale');
});

test('joint visual score grades resolution and source together', () => {
  const remux = featuresFor(fx.cachedRemux4k);
  assert.ok(Math.abs(remux.V - 1.0) < 1e-6, `2160p remux should cap at 1.0, got ${remux.V}`);
  const cam = featuresFor(fx.camRip);
  assert.ok(cam.V <= 0.15, `CAM must be capped at 0.15, got ${cam.V}`);
});

test('size plausibility peaks near the expected bitrate and never rewards bulk', () => {
  const honest = featuresFor(fx.cachedRemux4k);
  assert.ok(honest.Zq > 0.5, `71GB 4K remux is plausible, got ${honest.Zq}`);

  // Same claims, absurd size: plausibility must fall, not rise.
  const bloated = featuresFor(fx.withSource({
    ...fx.cachedRemux4k,
    behaviorHints: { videoSize: 76455165952 * 8 },
  }, fx.TORRENTIO));
  assert.ok(bloated.Zq < honest.Zq, 'a bloated encode must not score higher');
});

test('season packs get neutral size plausibility instead of a fabricated estimate', () => {
  const pack = featuresFor(fx.seasonPack, { isEpisode: true, expectedTitles: fx.BREAKING_BAD_TITLES, runtimeMinutes: 47 });
  assert.equal(pack.Zq, 0.5);
  assert.equal(pack.Zt, 0.5);
});

test('device compatibility is a bottleneck and improves for capable clients', () => {
  const generic = featuresFor(fx.cachedRemux4k, { clientClass: 'generic' });
  const capable = featuresFor(fx.cachedRemux4k, { clientClass: 'capable' });
  assert.ok(capable.D > generic.D, 'capable clients decode DV/HEVC/TrueHD comfortably');
});

test('Hebrew releases score highest on language relevance', () => {
  const hebrew = featuresFor(fx.hebrewRelease);
  const neutral = featuresFor(fx.cachedRemux4k);
  assert.equal(hebrew.L, 1.0);
  assert.equal(neutral.L, 0.55, 'original-language content is neutral, not penalized');
});

test('profile weights sum to 100', () => {
  for (const [name, profile] of Object.entries(PROFILES)) {
    const total = Object.values(profile.weights).reduce((a, b) => a + b, 0);
    assert.equal(total, 100, `${name} weights sum to ${total}`);
  }
});

test('base score stays inside [0,100]', () => {
  for (const profile of Object.values(PROFILES)) {
    for (const stream of fx.MOVIE_SET) {
      const score = computeBaseScore(featuresFor(stream), profile);
      assert.ok(score >= 0 && score <= 100, `score ${score} out of range`);
    }
  }
});

test('quality profiles prefer the remux; tap profiles prefer the ready stream', () => {
  const remux = featuresFor(fx.cachedRemux4k);
  const readyWeb = featuresFor(fx.hebrewRelease);

  const everything = resolveProfile('everything');
  assert.ok(
    computeBaseScore(remux, everything) > computeBaseScore(readyWeb, everything),
    'everything should favour the 4K remux',
  );

  const family = resolveProfile('family');
  assert.ok(
    computeBaseScore(readyWeb, family) > computeBaseScore(fake4kScore(), family),
    'family should not favour an implausible 4K claim',
  );

  function fake4kScore() {
    return featuresFor(fx.fake4k);
  }
});

test('family and light profiles reject CAM; everything allows it', () => {
  const cam = featuresFor(fx.camRip);
  assert.equal(profileEligible(cam, resolveProfile('family'), false).eligible, false);
  assert.equal(profileEligible(cam, resolveProfile('friends_light'), false).eligible, false);
  assert.equal(profileEligible(cam, resolveProfile('everything'), false).eligible, true);
});

test('unknown size is never rejected by the size cap', () => {
  const external = featuresFor(fx.externalOnly);
  const gate = profileEligible(external, resolveProfile('family'), false);
  assert.ok(!gate.reasons.includes('above_size_cap'));
});

test('a known oversize file is rejected on capped profiles only', () => {
  const huge = featuresFor(fx.cachedRemux4k);
  assert.equal(profileEligible(huge, resolveProfile('friends_light'), false).eligible, false);
  assert.equal(profileEligible(huge, resolveProfile('everything'), false).eligible, true);
});

test('transport classification distinguishes owner, debrid, p2p and external', () => {
  const owner = resolveProvider(fx.KANBOX, { configured: true });
  assert.equal(
    classifyTransport(fx.vipKanBox, owner, { claim: CACHE_CLAIM.NONE, marker: null }),
    TRANSPORT.DIRECT_OWNER,
  );

  const knaben = resolveProvider(fx.KNABEN, { configured: true });
  assert.equal(
    classifyTransport(fx.uncachedHealthyP2P, knaben, { claim: CACHE_CLAIM.NONE, marker: null }),
    TRANSPORT.P2P,
  );

  const unknown = resolveProvider(fx.UNKNOWN_HOST, { configured: true });
  assert.equal(
    classifyTransport(fx.externalOnly, unknown, { claim: CACHE_CLAIM.NONE, marker: null }),
    TRANSPORT.EXTERNAL,
  );
});

test('providers with no cache vocabulary cannot emit a claim', () => {
  const knaben = resolveProvider(fx.KNABEN, { configured: true });
  const claim = parseCacheClaim(knaben, '[TB+] totally cached instant');
  assert.equal(claim.claim, CACHE_CLAIM.NONE);
});

test('unknown origins get the lowest trust prior and no VIP', () => {
  const unknown = resolveProvider(fx.UNKNOWN_HOST, { configured: false });
  assert.equal(unknown.family, 'unknown');
  assert.equal(evaluateVip(unknown, { text: 'telegram_bot', isSingleHopHttp: true, isIpLocked: false }), false);
});
