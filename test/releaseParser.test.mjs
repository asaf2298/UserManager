/**
 * Release parser: field detection, contradiction detection, and token building.
 *
 * The critical invariant tested here is the three-state model — parsed, unknown,
 * conflict. Collapsing unknown into conflict is what caused the old engine to
 * punish sparse-but-honest releases.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRelease, jaccard, FIELD, RESOLUTION, SOURCE, SOURCE_FAMILY, CODEC, HDR, AUDIO,
} from '../lib/releaseParser.js';
import * as fx from './fixtures/streams.mjs';

test('parses resolution, source, codec, HDR, and audio from a remux title', () => {
  const release = parseRelease(fx.cachedRemux4k, {});
  assert.equal(release.resolution.value, RESOLUTION.R2160);
  assert.equal(release.resolution.state, FIELD.PARSED);
  assert.equal(release.source.value, SOURCE.REMUX);
  assert.equal(release.source.family, SOURCE_FAMILY.DISC);
  assert.equal(release.codec.value, CODEC.H265);
  assert.equal(release.hdr.value, HDR.DV);
  assert.equal(release.audio.value, AUDIO.TRUEHD_ATMOS);
  assert.equal(release.releaseGroup, 'framestor');
});

test('prefers the trusted structured size field over the text estimate', () => {
  const release = parseRelease(fx.cachedRemux4k, {});
  assert.equal(release.size.source, 'behaviorHints.videoSize');
  assert.equal(release.size.bytes, 76455165952);
});

test('falls back to parsing size from title text', () => {
  const release = parseRelease(fx.uncachedHealthyP2P, {});
  assert.equal(release.size.state, FIELD.PARSED);
  assert.ok(Math.abs(release.size.bytes / 1024 ** 3 - 12.4) < 0.01);
});

test('flags HDR claimed on an 8-bit codec as a contradiction', () => {
  const release = parseRelease(fx.fake4k, {});
  const codes = release.contradictions.map(c => c.code);
  assert.ok(codes.includes('hdr_on_8bit_codec'), `expected hdr contradiction, got ${codes}`);
});

test('flags a self-declared upscale', () => {
  const release = parseRelease(fx.upscaled, {});
  assert.ok(release.contradictions.some(c => c.code === 'upscale_declared'));
});

test('records no contradiction for a genuine high-end release', () => {
  const release = parseRelease(fx.cachedRemux4k, {});
  assert.deepEqual(release.contradictions, []);
});

test('unknown fields are unknown, never conflicts', () => {
  const release = parseRelease(fx.garbled, {});
  assert.equal(release.resolution.state, FIELD.UNKNOWN);
  assert.equal(release.source.state, FIELD.UNKNOWN);
  assert.equal(release.codec.state, FIELD.UNKNOWN);
  assert.deepEqual(release.contradictions, []);
});

test('detects an explicit lower-resolution source claim', () => {
  const release = parseRelease(
    { title: 'Movie.2024.2160p.upscaled.from.1080p.source.WEB-DL.x265', name: '' },
    {},
  );
  assert.equal(release.resolution.value, RESOLUTION.R2160);
  assert.equal(release.resolution.lowerSourceClaim, RESOLUTION.R1080);
  assert.ok(release.contradictions.some(c => c.code === 'lower_resolution_source'));
});

test('bare dual resolution tags do not fabricate a contradiction', () => {
  const release = parseRelease({ title: 'Show.S01E01.1080p.720p.WEB-DL.x264-GRP', name: '' }, {});
  assert.equal(release.resolution.state, FIELD.CONFLICT);
  assert.equal(release.resolution.lowerSourceClaim, null);
  assert.ok(!release.contradictions.some(c => c.code === 'lower_resolution_source'));
});

test('parses episode coordinates and distinguishes packs', () => {
  const episode = parseRelease(fx.singleEpisode, {});
  assert.equal(episode.episode.state, FIELD.PARSED);
  assert.equal(episode.episode.season, 3);
  assert.equal(episode.episode.episode, 5);
  assert.equal(episode.isSeasonPack, false);

  const pack = parseRelease(fx.seasonPack, {});
  assert.equal(pack.isSeasonPack, true);
  assert.equal(pack.episode.state, FIELD.UNKNOWN);
});

test('detects Hebrew script and language tags', () => {
  const release = parseRelease(fx.hebrewRelease, {});
  assert.equal(release.hasHebrewScript, true);
  assert.ok(release.languages.values.includes('he'));
});

test('detects CAM sources', () => {
  const release = parseRelease(fx.camRip, {});
  assert.equal(release.source.value, SOURCE.CAM);
  assert.equal(release.source.family, SOURCE_FAMILY.CAM);
});

test('file fingerprint separates files inside one torrent', () => {
  const a = parseRelease(fx.singleEpisode, {});
  const b = parseRelease(fx.otherEpisodeSameHash, {});
  assert.notEqual(a.fileFingerprint, b.fileFingerprint);
});

test('canonical tokens exclude the requested title and provider noise', () => {
  const release = parseRelease(fx.cachedRemux4k, { requestedTitleTokens: ['dune', 'part', 'two'] });
  const tokens = [...release.canonicalTokens];
  assert.ok(!tokens.includes('w:dune'), 'requested title token must be subtracted');
  assert.ok(!tokens.includes('w:torrentio'), 'provider name must not be a release token');
  assert.ok(tokens.includes('res:2160p'));
  assert.ok(tokens.includes('src:remux'));
  assert.ok(tokens.includes('group:framestor'));
});

test('jaccard is 1 for identical sets and 0 for disjoint sets', () => {
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
  assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0);
  assert.equal(jaccard(new Set(), new Set(['a'])), 0);
});

test('the same encode from two providers yields near-identical token sets', () => {
  const a = parseRelease(fx.cachedRemux4k, { requestedTitleTokens: ['dune', 'part', 'two'] });
  const b = parseRelease(fx.cachedRemux4kDuplicate, { requestedTitleTokens: ['dune', 'part', 'two'] });
  assert.ok(
    jaccard(a.canonicalTokens, b.canonicalTokens) >= 0.82,
    `cross-provider duplicate similarity too low: ${jaccard(a.canonicalTokens, b.canonicalTokens)}`,
  );
});
