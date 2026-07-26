/**
 * Playable-URL torrent identity helpers used by sightings and sync jobs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTorrentIdentityFromUrl,
  parseFilenameFromPlaybackUrl,
  resolveTorrentIdentity,
  looksCloudflareProxiedPlayback,
  normalizeInfoHash,
} from '../lib/playbackLocator.js';
import { pickTorboxFileId } from '../worker/media-intelligence/torbox.mjs';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';

test('parses torrentio TorBox resolve URL hash and file index', () => {
  const url = `https://torrentio.strem.fun/resolve/torbox/TOKEN/${HASH}/Movie.Name.2024.mkv/2/Movie.Name.2024.mkv`;
  assert.deepEqual(parseTorrentIdentityFromUrl(url), { infoHash: HASH, fileIdx: 2 });
  assert.equal(parseFilenameFromPlaybackUrl(url), 'Movie.Name.2024.mkv');
});

test('parses Comet-style playback URLs', () => {
  const url = `https://comet.example/playback/${HASH}/0/file.mkv`;
  assert.deepEqual(parseTorrentIdentityFromUrl(url), { infoHash: HASH, fileIdx: 0 });
});

test('resolveTorrentIdentity prefers structured fields over URL', () => {
  const other = '1111111111111111111111111111111111111111';
  const resolved = resolveTorrentIdentity({
    infoHash: other,
    fileIdx: 7,
    playableUrl: `https://torrentio.strem.fun/resolve/torbox/t/${HASH}/n/2/n`,
  });
  assert.equal(resolved.infoHash, other);
  assert.equal(resolved.fileIdx, 7);
});

test('resolveTorrentIdentity falls back to URL when hash missing', () => {
  const resolved = resolveTorrentIdentity({
    playableUrl: `https://torrentio.strem.fun/resolve/torbox/t/${HASH}/Name%20Here/1/Name%20Here`,
  });
  assert.equal(resolved.infoHash, HASH);
  assert.equal(resolved.fileIdx, 1);
});

test('normalizeInfoHash rejects non-40-hex values', () => {
  assert.equal(normalizeInfoHash(HASH), HASH);
  assert.equal(normalizeInfoHash('short'), null);
  assert.equal(normalizeInfoHash(null), null);
});

test('looksCloudflareProxiedPlayback flags torrentio hosts', () => {
  assert.equal(looksCloudflareProxiedPlayback(`https://torrentio.strem.fun/resolve/torbox/t/${HASH}/n/0/n`), true);
  assert.equal(looksCloudflareProxiedPlayback('https://cdn.torbox.app/file/abc'), false);
});

test('pickTorboxFileId prefers file index, then filename, then largest', () => {
  const torrent = {
    files: [
      { id: 10, name: 'sample.mkv', size: 100 },
      { id: 20, name: 'Movie.Name.2024.mkv', size: 900 },
      { id: 30, name: 'extras.mkv', size: 50 },
    ],
  };
  assert.equal(pickTorboxFileId(torrent, { fileIdx: 20 }), 20);
  assert.equal(pickTorboxFileId(torrent, { fileIdx: 1 }), 20);
  assert.equal(pickTorboxFileId(torrent, { filename: 'Movie.Name.2024.mkv' }), 20);
  assert.equal(pickTorboxFileId(torrent, {}), 20);
});
