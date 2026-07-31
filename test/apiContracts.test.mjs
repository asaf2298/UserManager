/**
 * Golden API contract tests (master plan Phase 1).
 *
 * These pin the public Stremio/Kodi/subtitle response shapes and the locked
 * subtitle scoring equation without requiring live upstream addons.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatForStremio, availabilityLabel } from '../api/stream.js';
import { formatKodiResults } from '../api/kodi.js';
import { calculateSubtitleScore, classifySubtitleLang } from '../api/subtitles.js';
import subProxyHandler from '../api/sub-proxy.js';
import { rankAndSelect, applyEligibility, buildRetrievalPlan, requestStartBucket } from '../lib/streamEngine.js';
import { resolveProfile } from '../lib/streamRanker.js';
import { parseRelease, FIELD } from '../lib/releaseParser.js';
import { TRANSPORT, CACHE_CLAIM, QUERY_MODE } from '../lib/providerCapabilities.js';
import { MODEL_VERSION, PARSER_VERSION, CAPABILITY_VERSION } from '../lib/versions.js';
import { SYNC_MESSAGES } from '../lib/subtitleSync.js';
import * as fx from './fixtures/streams.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    end(body) { this.body = body; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = JSON.stringify(payload); return this; },
  };
}

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

test('api/stream formatForStremio strips internals and keeps playback hints', () => {
  const ranked = rankAndSelect([fx.cachedRemux4k, fx.vipKanBox], pipelineContext('everything'));
  assert.ok(ranked.selected.length >= 1);

  const formatted = formatForStremio(ranked.selected);
  for (const stream of formatted) {
    assert.equal(stream._features, undefined);
    assert.equal(stream._score, undefined);
    assert.equal(stream._provenance, undefined);
    assert.equal(stream._sourceBaseUrl, undefined);
    assert.equal(stream.description, undefined);
    assert.match(stream.name, /^\[#\d+\] /);
    assert.ok(stream.url || stream.infoHash || stream.externalUrl);
  }

  // At least one row must carry a locked Hebrew availability label.
  assert.ok(formatted.some(s =>
    /זמין לצפייה|נגן חיצוני|תלוי במהירות הרשת|דורש המתנה/.test(s.name)
  ), 'missing locked availability wording');
});

test('api/stream availabilityLabel matches locked transport wording', () => {
  assert.equal(
    availabilityLabel({ transport: TRANSPORT.DIRECT_OWNER, F: 1, cacheClaim: { claim: CACHE_CLAIM.NONE } }),
    'זמין לצפייה',
  );
  assert.equal(
    availabilityLabel({ transport: TRANSPORT.EXTERNAL, F: 0.65, cacheClaim: { claim: CACHE_CLAIM.NONE } }),
    'נגן חיצוני',
  );
  assert.equal(
    availabilityLabel({ transport: TRANSPORT.P2P, F: 0.4, cacheClaim: { claim: CACHE_CLAIM.NONE } }),
    'תלוי במהירות הרשת',
  );
  assert.equal(
    availabilityLabel({ transport: TRANSPORT.DEBRID, F: 0.4, cacheClaim: { claim: CACHE_CLAIM.QUEUED } }),
    'דורש המתנה ואולי כניסה חוזרת',
  );
});

test('api/kodi formatKodiResults preserves the thin-client JSON shape', () => {
  const ranked = rankAndSelect(
    [fx.cachedRemux4k, fx.uncachedHealthyP2P],
    pipelineContext('kodi'),
  );
  const playable = ranked.selected.filter(c => c.stream.url);
  const results = formatKodiResults(playable);

  assert.ok(Array.isArray(results));
  for (const row of results) {
    assert.deepEqual(Object.keys(row).sort(), ['quality', 'sizeGB', 'title', 'url'].sort());
    assert.equal(typeof row.title, 'string');
    assert.equal(typeof row.url, 'string');
    assert.match(row.quality, /^(4K|1080p|720p|SD)$/);
    assert.ok(row.sizeGB === null || typeof row.sizeGB === 'number');
  }
});

test('api/subtitles scoring equation matches the locked weights', () => {
  const video = parseRelease({
    name: 'Torrentio',
    title: 'Dune.Part.Two.2024.1080p.BluRay.x264-SPARKS',
  });
  const matching = parseRelease({
    name: 'OpenSubtitles',
    title: 'Dune.Part.Two.2024.1080p.BluRay.x264-SPARKS.heb.srt',
  });
  const conflicting = parseRelease({
    name: 'OpenSubtitles',
    title: 'Other.Show.2020.720p.WEBRip.x264-OTHER.eng.srt',
  });

  const good = calculateSubtitleScore({
    videoRelease: video,
    subRelease: matching,
    subDurationMin: 166,
    videoRuntimeMin: 166,
    providerPercentile: 1,
  });
  const bad = calculateSubtitleScore({
    videoRelease: video,
    subRelease: conflicting,
    subDurationMin: 40,
    videoRuntimeMin: 166,
    providerPercentile: 0,
  });

  assert.ok(good > bad);
  assert.ok(good >= 70 && good <= 100);
  assert.ok(bad >= 0 && bad < good);
  assert.equal(classifySubtitleLang('hebrew'), 'heb');
  assert.equal(classifySubtitleLang('en'), 'eng');
  assert.equal(classifySubtitleLang('ru'), 'rus');
  assert.equal(classifySubtitleLang('de'), null);
  void FIELD;
});

test('api/sub-proxy is encoding-only: no offsetMs and rejects bad urls', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../api/sub-proxy.js'), 'utf8');
  assert.equal(source.includes('offsetMs'), false, 'sub-proxy must not implement offsetMs');

  const res = mockRes();
  await subProxyHandler({
    method: 'GET',
    url: '/api/sub-proxy?url=not-a-url',
    headers: {},
  }, res);
  assert.equal(res.statusCode, 400);
  assert.match(String(res.body), /Missing or invalid url/);
});

test('subtitle sync messages stay exactly as locked', () => {
  assert.equal(SYNC_MESSAGES.PENDING, 'אנא המתן דקה ובחר שוב כדי לסנכרן');
  assert.equal(SYNC_MESSAGES.NO_EMBEDS, 'אין כתוביות מוטבעות זמינות');
  assert.equal(SYNC_MESSAGES.TRY_OTHER, 'נסה כתובית סנכרון אחרת');
  assert.equal(SYNC_MESSAGES.FAILED, 'מצטערים, הסנכרון נכשל');
});

test('streamEngine exports the plan §3 surface and stamps provenance versions', () => {
  assert.equal(typeof applyEligibility, 'function');
  assert.equal(typeof buildRetrievalPlan, 'function');
  assert.equal(typeof requestStartBucket, 'function');
  assert.equal(requestStartBucket(120000), 2);

  const { eligible, rejected } = applyEligibility(
    [fx.cachedRemux4k, fx.noLocator, fx.ipLocked],
    pipelineContext('everything'),
  );
  assert.ok(eligible.length >= 1);
  assert.ok(rejected.length >= 1);

  const plan = buildRetrievalPlan({
    addons: [fx.TORRENTIO],
    idWithExt: 'tt15239678.json',
    type: 'movie',
    contentMeta: { original: 'Dune Part Two', he: 'חולית', runtimeMin: 166 },
    resolvedCtx: null,
    queryHint: '',
  });
  assert.ok(plan.plan.some(e => e.queryMode === QUERY_MODE.CANONICAL_ID && e.phase === 't0'));
  assert.ok(plan.plan.some(e => e.queryMode === QUERY_MODE.PRIMARY_TITLE && e.phase === 'immediate'));
  assert.ok(plan.plan.every(e => e.phase === 't0' || e.phase === 'immediate' || e.phase === 'deferred'));

  assert.equal(MODEL_VERSION, 'rank-v2.0');
  assert.equal(PARSER_VERSION, 'release-v2');
  assert.equal(CAPABILITY_VERSION, 'providers-v1');
});
