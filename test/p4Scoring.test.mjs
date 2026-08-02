/**
 * P4 · scoring model corrections (#60).
 *
 * Every item here intentionally moves rankings, per the plan -- these tests
 * pin the corrected math directly rather than relying on end-to-end fixtures,
 * so the specific behavior change is unambiguous.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBaseScore, scoreBreakdown, resolveProfile, Z_MODE, PROFILES } from '../lib/streamRanker.js';
import { computeCredibility, computeSizePlausibility, computeLanguageRelevance, MATCH_ELIGIBILITY_THRESHOLD } from '../lib/streamFeatures.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { prunePriority } from '../lib/streamEngine.js';
import { SOURCE, RESOLUTION, CODEC } from '../lib/releaseParser.js';
import { quantize, clip } from '../lib/versions.js';

function oldFormula(features, profile) {
  const w = profile.weights;
  const z = profile.zMode === Z_MODE.TAP ? features.Zt : features.Zq;
  const linear =
    w.F * features.F + w.T * features.T + w.X * features.X + w.V * features.V +
    w.D * features.D + w.A * features.A + w.H * features.H + w.Z * z +
    w.M * features.M + w.L * features.L;
  return quantize(clip(features.C * linear, 0, 100));
}

test('P4-A: a low-credibility release with strong observed evidence scores higher than the old formula', () => {
  const profile = resolveProfile('everything');
  const features = {
    F: 1, T: 1, X: 1, D: 1, L: 1, // observed: all excellent
    V: 1, H: 1, A: 1, M: 1, Zt: 1, Zq: 1, // claimed: all excellent
    C: 0.5, // one release-text contradiction
  };
  const newScore = computeBaseScore(features, profile);
  const legacyScore = oldFormula(features, profile);
  assert.ok(
    newScore > legacyScore,
    `credibility must no longer discount observed evidence: new=${newScore} must exceed old=${legacyScore}`,
  );
});

test('P4-A: with perfect credibility (C=1) the two formulas agree', () => {
  const profile = resolveProfile('friends_light');
  const features = {
    F: 0.8, T: 0.7, X: 0.9, D: 0.6, L: 0.5,
    V: 0.7, H: 0.4, A: 0.6, M: 0.5, Zt: 0.8, Zq: 0.8,
    C: 1,
  };
  assert.equal(computeBaseScore(features, profile), oldFormula(features, profile));
});

test('P4-A: scoreBreakdown parts sum to the same total as computeBaseScore', () => {
  const profile = resolveProfile('everything');
  const features = {
    F: 0.9, T: 0.6, X: 0.8, D: 0.7, L: 0.4,
    V: 0.6, H: 0.5, A: 0.3, M: 0.6, Zt: 0.5, Zq: 0.5,
    C: 0.6,
  };
  const total = computeBaseScore(features, profile);
  const parts = scoreBreakdown(features, profile);
  const summed = quantize(Object.values(parts).reduce((a, b) => a + b, 0));
  assert.equal(summed, total);
});

test('P4-B: a single contradiction is unaffected by the min->product change', () => {
  const { value } = computeCredibility({ contradictions: [{ code: 'hdr_on_8bit_codec', severity: 'low' }] });
  assert.equal(value, 0.40);
});

test('P4-B: repeated contradictions compound instead of matching the single worst one', () => {
  const single = computeCredibility({ contradictions: [{ code: 'upscale_declared', severity: 'medium' }] });
  const double = computeCredibility({
    contradictions: [
      { code: 'upscale_declared', severity: 'medium' },
      { code: 'upscale_declared', severity: 'medium' },
    ],
  });
  assert.equal(single.value, 0.55);
  assert.ok(double.value < single.value, 'two contradictions must score worse than one, not identically');
  assert.equal(double.value, 0.55 * 0.55, 'must be the product, not the min');
});

test('P4-B: three independent contradictions compound below the floor and clip there', () => {
  const { value } = computeCredibility({
    contradictions: [
      { code: 'upscale_declared', severity: 'medium' },
      { code: 'lower_resolution_source', severity: 'medium' },
      { code: 'remux_source_conflict', severity: 'medium' },
    ],
  });
  assert.equal(value, 0.25);
});

function bytesFor(bitrateMbps, runtimeMinutes) {
  return (bitrateMbps * runtimeMinutes * 60 * 1_000_000) / 8;
}

test('P4-C: efficient codecs are not double-penalised against the H.264-centric bitrate table', () => {
  // Reproduces the plan's own worked example: 1080p WEB-DL (expected 7 Mbps
  // at eta=1.0), three codecs at roughly equal *perceptual* quality per their
  // own compression efficiency.
  const runtimeMinutes = 120;
  const base = { source: { value: SOURCE.WEBDL }, resolution: { value: RESOLUTION.R1080 }, isSeasonPack: false };

  const h264 = computeSizePlausibility(
    { ...base, codec: { value: CODEC.H264 }, size: { bytes: bytesFor(7.0, runtimeMinutes) } }, runtimeMinutes,
  );
  const h265 = computeSizePlausibility(
    { ...base, codec: { value: CODEC.H265 }, size: { bytes: bytesFor(4.2, runtimeMinutes) } }, runtimeMinutes,
  );
  const av1 = computeSizePlausibility(
    { ...base, codec: { value: CODEC.AV1 }, size: { bytes: bytesFor(3.2, runtimeMinutes) } }, runtimeMinutes,
  );

  assert.ok(h264.quality > 0.95, `h264 at exactly-expected bitrate should score near 1.0, got ${h264.quality}`);
  assert.ok(h265.quality > 0.90, `h265 at equal perceptual quality must no longer read as starved, got ${h265.quality}`);
  assert.ok(av1.quality > 0.85, `av1 at equal perceptual quality must no longer read as starved, got ${av1.quality}`);
});

test('P4-C: an unusually low bitrate for the codec is still flagged, not laundered by efficiency', () => {
  const runtimeMinutes = 120;
  // Genuinely starved av1 (well below even its own efficient centre).
  const starvedAv1 = computeSizePlausibility(
    {
      source: { value: SOURCE.WEBDL }, resolution: { value: RESOLUTION.R1080 }, isSeasonPack: false,
      codec: { value: CODEC.AV1 }, size: { bytes: bytesFor(0.8, runtimeMinutes) },
    },
    runtimeMinutes,
  );
  assert.ok(starvedAv1.quality < 0.5, `a genuinely starved encode must still score low, got ${starvedAv1.quality}`);
});

test('P4-D: no profile\'s reservations exceed 60% of its target (the module already asserts this at load)', () => {
  for (const [name, p] of Object.entries(PROFILES)) {
    const reserved = (p.reservations || []).reduce((s, r) => s + r.min, 0);
    assert.ok(
      reserved <= Math.ceil(p.target * 0.6),
      `profile ${name}: reservations (${reserved}) must leave room for marginal-gain fill (target ${p.target})`,
    );
  }
});

test('P4-D: friends_light (the default profile) no longer reserves its entire target', () => {
  const p = PROFILES.friends_light;
  const reserved = p.reservations.reduce((s, r) => s + r.min, 0);
  assert.ok(reserved < p.target, `friends_light reserved ${reserved} of target ${p.target} -- must leave room to fill by marginal gain`);
});

test('P4-D: family no longer declares unsatisfiable minimums', () => {
  const p = PROFILES.family;
  const reserved = p.reservations.reduce((s, r) => s + r.min, 0);
  assert.ok(reserved <= p.target, `family reserved ${reserved} but target is only ${p.target}`);
});

test('P4-E: admission pruning is profile-neutral -- availability now outweighs raw visual quality', () => {
  const highVisualLowAvailability = {
    stream: {},
    features: { V: 1.0, F: 0.1, X: 0.5, D: 0.5, hasHttpLocator: false },
  };
  const modestVisualHighAvailability = {
    stream: {},
    features: { V: 0.4, F: 1.0, X: 0.5, D: 0.5, hasHttpLocator: true },
  };
  // Old formula (10*V + 3*F + 2*X) scored these 11.3 vs 8.0 -- pristine but
  // unavailable would have won the admission prune. The rebalanced formula
  // must invert that for availability-weighted profiles like friends_light
  // (V weight 14/100, F weight 26/100).
  assert.ok(
    prunePriority(modestVisualHighAvailability) > prunePriority(highVisualLowAvailability),
    'a cached, available, moderate-quality stream must now outrank a pristine but unavailable one in the admission prune',
  );
});

test('P4-F.1: match eligibility threshold no longer exactly equals NO_EVIDENCE (zero-margin fragility)', () => {
  assert.equal(MATCH_ELIGIBILITY_THRESHOLD, 0.65);
  const NO_EVIDENCE = 0.70;
  assert.notEqual(MATCH_ELIGIBILITY_THRESHOLD, NO_EVIDENCE, 'no-evidence confidence must clear the threshold with real margin');
  assert.ok(NO_EVIDENCE > MATCH_ELIGIBILITY_THRESHOLD, 'no-evidence rows (2-char titles etc.) must remain eligible');
});

test('P4-F.2: Hebrew-tag language relevance is no longer a dead branch', () => {
  const strong = computeLanguageRelevance(
    { languages: { values: ['he'] }, hasHebrewScript: false },
    { matchLevel: 'strong', originalLanguage: 'en' },
  );
  const weak = computeLanguageRelevance(
    { languages: { values: ['he'] }, hasHebrewScript: false },
    { matchLevel: 'partial', originalLanguage: 'en' },
  );
  assert.notEqual(strong.value, weak.value, 'strongMatch must no longer be inert for a bare Hebrew tag');
  assert.equal(strong.value, 0.90);
  assert.equal(weak.value, 0.80);
});

test('P4-F.3: compareForSelection no longer spreads objects per comparison (allocation churn)', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/streamSelector.js'), 'utf8');
  assert.match(source, /function compareForSelection\(a, gainA, b, gainB\)/);
  assert.doesNotMatch(source, /compareForSelection\(\s*\{\s*\.\.\./s, 'no call site should spread a candidate just to attach gain');
});
