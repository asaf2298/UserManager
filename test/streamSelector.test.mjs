/**
 * Constrained selector contracts from the master plan §9.
 *
 * VIP is a business override capped at two and always first. Everything else is
 * earned through marginal gain under hard caps and soft diversity penalties.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFeatures } from '../lib/streamFeatures.js';
import { resolveProvider } from '../lib/providerCapabilities.js';
import { computeBaseScore, locatorHash, resolveProfile, scoreCandidates } from '../lib/streamRanker.js';
import { deduplicateCandidates } from '../lib/streamDedup.js';
import { selectStreams } from '../lib/streamSelector.js';
import * as fx from './fixtures/streams.mjs';

function featureContext(overrides = {}) {
  return {
    expectedTitles: fx.DUNE_TITLES,
    requestedTitleTokens: ['dune', 'part', 'two'],
    runtimeMinutes: 166,
    isEpisode: false,
    clientClass: 'generic',
    originalLanguage: 'en',
    trustSnapshot: { version: 'static-priors', byKey: new Map() },
    isNotice: false,
    ...overrides,
  };
}

function scoredPool(streams, profileName = 'everything') {
  const profile = resolveProfile(profileName);
  const candidates = streams.map(stream => ({
    stream,
    features: extractFeatures(stream, {
      provider: resolveProvider(stream._sourceBaseUrl, { configured: true }),
      ...featureContext({ clientClass: profile.clientClass }),
    }),
  }));
  const { scored } = scoreCandidates(candidates, profile, false);
  const { representatives } = deduplicateCandidates(scored);
  return { profile, representatives };
}

test('VIP rows occupy the first positions and never exceed two', () => {
  const extraVip = fx.withSource({
    name: 'Kan-Box Alt',
    title: 'דיון חלק שני alt',
    url: 'https://kan-box-addon.vercel.app/play/il_99999.m3u8',
  }, fx.KANBOX);
  // Force a second VIP family so the pool can offer more than two VIP rows.
  const thirdVip = fx.withSource({
    name: 'AnimeIL',
    title: 'Dune Part Two',
    url: 'https://animeil-addon.vercel.app/play/123.m3u8',
  }, 'https://animeil-addon.vercel.app');

  const { profile, representatives } = scoredPool([
    fx.cachedRemux4k,
    fx.uncachedHealthyP2P,
    fx.vipKanBox,
    fx.vipTelegram,
    extraVip,
    thirdVip,
    fx.hebrewRelease,
  ]);

  const vipEligible = representatives.filter(r => r.features.isVip);
  assert.ok(vipEligible.length >= 2, 'fixture pool must offer at least two VIP clusters');

  const { selected, stats } = selectStreams(representatives, profile);
  assert.ok(stats.vip <= 2);
  assert.ok(selected.length >= 2);
  assert.equal(selected[0].features.isVip, true);
  assert.equal(selected[1].features.isVip, true);
  assert.equal(selected.filter(r => r.features.isVip).length, stats.vip);
  assert.ok(
    selected.slice(2).every(row => !row.features.isVip),
    'VIP beyond the prefix must not re-enter ordinary selection',
  );
  assert.ok(stats.vip <= 2, 'VIP hard cap is never relaxed');
});

test('output length respects the profile target', () => {
  const streams = [];
  for (let i = 0; i < 40; i++) {
    streams.push(fx.withSource({
      name: `Knaben 1080p`,
      title: `Dune.Part.Two.2024.1080p.WEB-DL.x264-GRP${i}\n👤 ${20 + i} 💾 ${(5 + i / 10).toFixed(1)} GB`,
      infoHash: `${String(i).padStart(4, '0')}bbbbccccddddeeeeffffaaaa0000111122`.slice(0, 40),
      url: `https://cdn.example.net/dl/pool/${i}.mkv`,
    }, fx.KNABEN));
  }
  const { profile, representatives } = scoredPool(streams, 'friends_light');
  const { selected } = selectStreams(representatives, profile);
  assert.ok(selected.length <= profile.target);
});

test('same-provider hard cap holds under the everything profile', () => {
  const streams = [];
  for (let i = 0; i < 20; i++) {
    streams.push(fx.withSource({
      name: '[TB+] Torrentio 1080p',
      title: `Dune.Part.Two.2024.1080p.WEB-DL.x264-TGRP${i}\n👤 ${30 + i} 💾 ${(6 + i / 20).toFixed(1)} GB`,
      infoHash: `${String(i).padStart(4, '0')}ccccddddeeeeffffaaaa11112222333344`.slice(0, 40),
      url: `https://cdn.example.net/dl/t/${i}.mkv`,
    }, fx.TORRENTIO));
  }
  const { profile, representatives } = scoredPool(streams, 'everything');
  const { selected, stats } = selectStreams(representatives, profile);
  const byProvider = new Map();
  for (const row of selected) {
    const id = row.features.providerId;
    byProvider.set(id, (byProvider.get(id) || 0) + 1);
  }
  const maxSame = Math.max(...byProvider.values());
  // Strict cap is 8; a single relaxation pass may double to 16 if needed.
  assert.ok(maxSame <= profile.caps.provider * (stats.relaxed ? 2 : 1));
});

test('relaxation never reintroduces a duplicate locator', () => {
  const streams = [];
  for (let i = 0; i < 25; i++) {
    streams.push(fx.withSource({
      name: 'Knaben 720p',
      title: `Dune.Part.Two.2024.720p.WEBRip.x264-FILL${i}\n👤 ${5 + i} 💾 ${(3 + i / 30).toFixed(1)} GB`,
      infoHash: `${String(i).padStart(4, '0')}ddddeeeeffffaaaa111122223333444455`.slice(0, 40),
      url: `https://cdn.example.net/dl/relax/${i}.mkv`,
    }, fx.KNABEN));
  }
  const { profile, representatives } = scoredPool(streams, 'family');
  const { selected } = selectStreams(representatives, profile);
  const hashes = selected.map(r => r.locatorHash);
  assert.equal(new Set(hashes).size, hashes.length);
});

test('family rejects CAM even when the list is short', () => {
  const { profile, representatives } = scoredPool([fx.camRip, fx.vipKanBox], 'family');
  const { selected } = selectStreams(representatives, profile);
  assert.ok(selected.every(row => !row.features.isCam));
});
