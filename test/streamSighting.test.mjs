/**
 * Stream sighting identity and videoKey matching for subtitle sync.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVideoKey,
  sightingMatchesVideoKey,
  MATCH_STRENGTH,
} from '../lib/streamSighting.js';

test('buildVideoKey prefers videoHash, then filename+size, then filename', () => {
  assert.equal(buildVideoKey({ videoHash: '5553e4a4b9f7b1ea' }), 'vh:5553e4a4b9f7b1ea');
  const fsKey = buildVideoKey({
    filename: 'Movie.Name.2024.mkv',
    videoSize: 1234567890,
  });
  assert.match(fsKey, /^fs:[0-9a-f]{24}$/);
  const fnKey = buildVideoKey({ filename: 'Movie.Name.2024.mkv' });
  assert.match(fnKey, /^fn:[0-9a-f]{24}$/);
  assert.notEqual(fsKey, fnKey);
});

test('sightingMatchesVideoKey recovers fn/fs/vh keys without query extras', () => {
  const row = {
    video_hash: '5553e4a4b9f7b1ea',
    filename: 'the.lord.of.the.rings.the.fellowship.of.the.ring.2001.extended.uhd.bluray.2160p.truehd.atmos.7.1.dv.hevc.remux-framestor.mkv',
    video_size: 126023154932,
  };
  assert.equal(sightingMatchesVideoKey(row, 'vh:5553e4a4b9f7b1ea'), true);

  const fsKey = buildVideoKey({ filename: row.filename, videoSize: row.video_size });
  assert.equal(sightingMatchesVideoKey(row, fsKey), true);

  const fnKey = buildVideoKey({ filename: row.filename });
  assert.equal(sightingMatchesVideoKey({ ...row, video_hash: null, video_size: null }, fnKey), true);
  assert.equal(sightingMatchesVideoKey(row, 'fn:deadbeefdeadbeefdeadbeef'), false);
});

test('match strength includes video_key fallback', () => {
  assert.equal(MATCH_STRENGTH.VIDEO_KEY, 'video_key');
});
