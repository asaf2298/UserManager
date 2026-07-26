/**
 * Subtitle sync state machine and embedded-reference ranking (§11).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pickHebrewSyncBases,
  buildSyncTrackDescriptors,
  rankEmbeddedTracks,
  trackNormality,
  SYNC_MESSAGES,
  SYNC_TRACK_LABEL,
  REFERENCE_SLOT,
  MAX_SYNC_BASES,
  buildOneCueSrt,
  computeSubFingerprint,
} from '../lib/subtitleSync.js';

test('Hebrew sync bases skip auto-translated tracks and cap at two', () => {
  const ranked = [
    { lang: 'heb', _classifiedLang: 'heb', sourceUrl: 'https://subs.example/a.srt', _isAuto: false },
    { lang: 'heb', _classifiedLang: 'heb', sourceUrl: 'https://subs.example/b.srt', _isAuto: true },
    { lang: 'heb', _classifiedLang: 'heb', sourceUrl: 'https://subs.example/c.srt', _isAuto: false },
    { lang: 'heb', _classifiedLang: 'heb', sourceUrl: 'https://subs.example/d.srt', _isAuto: false },
    { lang: 'eng', _classifiedLang: 'eng', sourceUrl: 'https://subs.example/e.srt', _isAuto: false },
  ];
  const bases = pickHebrewSyncBases(ranked);
  assert.equal(bases.length, MAX_SYNC_BASES);
  assert.deepEqual(bases.map(b => b.sourceUrl), [
    'https://subs.example/a.srt',
    'https://subs.example/c.srt',
  ]);
});

test('Hebrew sync bases prefer OpenSubtitles over ktuvit', () => {
  const ranked = [
    { lang: 'heb', _classifiedLang: 'heb', sourceUrl: 'https://ktuvit.example/a.srt', _providerName: 'Ktuvit', _isAuto: false },
    { lang: 'heb', _classifiedLang: 'heb', sourceUrl: 'https://opensubtitles.example/b.srt', _providerName: 'OpenSubtitles', _isAuto: false },
    { lang: 'heb', _classifiedLang: 'heb', sourceUrl: 'https://other.example/c.srt', _providerName: 'Other', _isAuto: false },
  ];
  const bases = pickHebrewSyncBases(ranked);
  assert.deepEqual(bases.map(b => b.sourceUrl), [
    'https://opensubtitles.example/b.srt',
    'https://other.example/c.srt',
  ]);
});

test('sync track injection advertises up to four stable URLs immediately', () => {
  const bases = [
    { sourceUrl: 'https://subs.example/a.srt' },
    { sourceUrl: 'https://subs.example/c.srt' },
  ];
  const tracks = buildSyncTrackDescriptors({
    bases,
    videoKey: 'vid_abc',
    contentType: 'movie',
    contentId: 'tt15239678',
    publicBaseUrl: 'https://personal.example',
    filename: 'Movie.Name.2024.mkv',
    videoSize: 1234567890,
  });
  assert.equal(tracks.length, 4);
  assert.ok(tracks.every(t => t.lang === SYNC_TRACK_LABEL), 'sync uses custom lang like Submaker');
  assert.ok(tracks.every(t => t.title.includes(SYNC_TRACK_LABEL)));
  assert.ok(tracks.every(t => t.url.includes('/api/sub-sync?')));
  assert.ok(tracks.every(t => t.url.includes('videoKey=vid_abc')));
  assert.ok(tracks.every(t => t.url.includes('filename=Movie.Name.2024.mkv')));
  assert.ok(tracks.every(t => t.url.includes('videoSize=1234567890')));
  assert.equal(tracks.filter(t => t._syncSlot === REFERENCE_SLOT.OFFICIAL).length, 2);
  assert.equal(tracks.filter(t => t._syncSlot === REFERENCE_SLOT.ENGLISH).length, 2);
});

test('viewer-facing sync messages are exact and stable', () => {
  assert.equal(SYNC_MESSAGES.PENDING, 'please wait one minute and reselect to sync');
  assert.equal(SYNC_MESSAGES.NO_EMBEDS, 'no available embedded subtitles');
  assert.equal(SYNC_MESSAGES.FAILED, 'sorry couldnt sync');
  const pending = buildOneCueSrt(SYNC_MESSAGES.PENDING);
  assert.match(pending, /please wait one minute and reselect to sync/);
  assert.match(pending, /-->/);
  // Mid-film visibility: status cues must repeat past the opening minutes.
  assert.match(pending, /01:00:00,000 -->/);
  assert.ok((pending.match(/please wait one minute and reselect to sync/g) || []).length > 10);
});

test('proxy-wrapped and bare subtitle URLs share a fingerprint', () => {
  const bare = computeSubFingerprint('https://subs.example/a.srt');
  const proxied = computeSubFingerprint('https://personal.example/api/sub-proxy?url=https%3A%2F%2Fsubs.example%2Fa.srt');
  assert.equal(bare, proxied);
});

test('embedded track ranking prefers language match, then coverage, then normality', () => {
  const tracks = [
    { index: 0, isText: true, language: 'en', cueCount: 40, isForced: true },
    { index: 1, isText: true, language: 'en', cueCount: 900 },
    { index: 2, isText: true, language: 'ja', cueCount: 950 },
    { index: 3, isText: true, language: 'en', cueCount: 800, isCommentary: true },
    { index: 4, isText: false, language: 'en', cueCount: 0 }, // bitmap — excluded
  ];
  const ranked = rankEmbeddedTracks(tracks, {
    slot: REFERENCE_SLOT.ENGLISH,
    officialLanguage: 'ja',
    runtimeMinutes: 100,
  });
  assert.equal(ranked.length, 4, 'bitmap tracks are the only hard exclusion');
  assert.equal(ranked[0].index, 1, 'full English dialogue wins the English slot');
  assert.ok(ranked.every(t => t.isText));
});

test('track normality matches the locked ladder', () => {
  assert.equal(trackNormality({}), 1);
  assert.equal(trackNormality({ isForced: true }), 0.8);
  assert.equal(trackNormality({ isSdh: true }), 0.75);
  assert.equal(trackNormality({ isHearingImpaired: true }), 0.75);
  assert.equal(trackNormality({ isCommentary: true }), 0.6);
  assert.equal(trackNormality({ isSigns: true }), 0.6);
});

test('official slot prefers the official language over English', () => {
  const tracks = [
    { index: 0, isText: true, language: 'en', cueCount: 900 },
    { index: 1, isText: true, language: 'ja', cueCount: 850 },
  ];
  const ranked = rankEmbeddedTracks(tracks, {
    slot: REFERENCE_SLOT.OFFICIAL,
    officialLanguage: 'ja',
    runtimeMinutes: 100,
  });
  assert.equal(ranked[0].index, 1);
});
