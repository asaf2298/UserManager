/**
 * Regression coverage for the Kodi catalog adapter's live-TV detection.
 * The previous isLiveChannel() implementation looked correct but could never
 * match the real Kan-Box catalog id ("Live_TV_Channels") due to a
 * case-sensitive substring check against lowercase "live". This had zero
 * test coverage, which is how it went unnoticed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isLiveChannel, mapMetaToKodiItem } from '../api/kodi-catalog.js';

test('isLiveChannel matches the real Kan-Box live catalog id and only that', () => {
  assert.equal(isLiveChannel('Live_TV_Channels'), true);
  assert.equal(isLiveChannel('live_tv_channels'), false);
  assert.equal(isLiveChannel('dbz_movies_catalog'), false);
  assert.equal(isLiveChannel('dailymotion_videos'), false);
  assert.equal(isLiveChannel(''), false);
  assert.equal(isLiveChannel(null), false);
  assert.equal(isLiveChannel(undefined), false);
});

test('mapMetaToKodiItem extracts imdb_id from tt-prefixed meta.id when imdb_id is absent', () => {
  const item = mapMetaToKodiItem({ id: 'tt0111161:1:2', name: 'Test', type: 'series' });
  assert.equal(item.imdb_id, 'tt0111161');
});

test('mapMetaToKodiItem prefers an explicit imdb_id field over the meta id', () => {
  const item = mapMetaToKodiItem({ id: 'some:other:id', imdb_id: 'tt9999999', name: 'Test' });
  assert.equal(item.imdb_id, 'tt9999999');
});
