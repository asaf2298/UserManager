/**
 * Ranking audit-queue row construction.
 *
 * Regression: buildAuditRows only read candidate.stream.infoHash directly,
 * so Comet/MediaFusion-style candidates that bury the hash in the resolved
 * playback URL (and omit the stream.infoHash field) were silently dropped
 * before ever reaching TorBox verification -- starving the trust-learning
 * loop of most debrid providers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAuditRows, samplingKey, shouldSample } from '../lib/rankingTelemetry.js';
import { CACHE_CLAIM } from '../lib/providerCapabilities.js';
import { MODEL_VERSION } from '../lib/versions.js';

const HASH = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555';

/** Find a candidate shape that the deterministic sampler actually includes. */
function findSampledCandidate(buildStream) {
  for (let i = 0; i < 2000; i++) {
    const stream = buildStream(i);
    const candidate = {
      stream,
      features: {
        providerId: `comet:instance-${i}`,
        providerFamily: 'comet',
        stratum: 'default',
        cacheClaim: { claim: CACHE_CLAIM.POSITIVE, marker: 'comet_tag' },
        trustEffectiveWeight: 0,
        release: { fileFingerprint: 'fp', size: { bytes: 123 } },
        F: 0.8,
      },
    };
    const key = samplingKey(candidate);
    if (shouldSample(key, 0.20, MODEL_VERSION)) return candidate;
  }
  throw new Error('no sampled candidate found in range -- sampler may be broken');
}

test('buildAuditRows recovers infoHash from a Comet-style playback URL when the field is missing', () => {
  const candidate = findSampledCandidate((i) => ({
    url: `https://comet.example.net/cfg/playback/${HASH}/0/n/n/n?media_id=tt${i}`,
    // infoHash deliberately absent, matching real Comet-resolved streams.
  }));

  const rows = buildAuditRows([candidate], { contentId: 'tt0000000' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].info_hash, HASH);
});

test('buildAuditRows still skips candidates with no recoverable infoHash at all', () => {
  const candidate = findSampledCandidate((i) => ({
    url: `https://comet.example.net/cfg/nomatch/${i}`,
  }));

  const rows = buildAuditRows([candidate], { contentId: 'tt0000000' });
  assert.equal(rows.length, 0);
});
