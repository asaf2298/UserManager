// api/sub-sync.js
//
// Serves an auto-synced Hebrew subtitle for the file currently playing.
//
// The same URL is stable across states, which is what makes the Submaker-style
// flow work: the first selection enqueues the job and shows a wait cue, and
// reselecting later returns the aligned SRT. Responses are `no-store` so the
// player cannot cache the wait cue over the finished result.
//
// Heavy work (ffprobe, extraction, alass) happens only on the media worker; this
// handler is a state read plus at most one enqueue.
import { resolveSyncResponse, SYNC_STATE, SYNC_MESSAGES } from '../lib/subtitleSync.js';
import { buildOneCueSrt } from '../lib/subtitleUtils.js';
import { resolvePlayableSighting } from '../lib/streamSighting.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Never cached: the whole point is that reselecting observes a state change.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');

  try {
    const url = new URL(req.url, 'http://localhost');
    const videoKey = url.searchParams.get('videoKey');
    const subFingerprint = url.searchParams.get('sub');
    const slot = url.searchParams.get('slot');
    const baseSubUrl = url.searchParams.get('url');
    const contentType = url.searchParams.get('type') || null;
    const contentId = url.searchParams.get('id') || null;

    if (!videoKey || !subFingerprint || !slot || !baseSubUrl) {
      console.warn('[ESAY SUB-SYNC] ⚠️ missing required params');
      res.statusCode = 200;
      return res.end(buildOneCueSrt(SYNC_MESSAGES.FAILED));
    }

    // Re-resolve the playable file each time: debrid links expire, and the job may
    // be enqueued minutes after the stream list was built.
    const sighting = contentId
      ? await resolvePlayableSighting({
        contentId,
        identity: {
          videoHash: videoKey.startsWith('vh:') ? videoKey.slice(3) : null,
          filename: url.searchParams.get('filename'),
          videoSize: url.searchParams.get('videoSize'),
        },
      })
      : { found: false, reason: 'no_content_id' };

    const result = await resolveSyncResponse({
      videoKey, subFingerprint, slot, baseSubUrl, contentType, contentId, sighting,
    });

    console.log(
      `[ESAY SUB-SYNC] ${result.state === SYNC_STATE.READY ? '✅' : '⏳'} state=${result.state}` +
      ` slot=${slot} videoKey=${videoKey.slice(0, 18)} sub=${subFingerprint}` +
      ` sighting=${sighting.found ? sighting.strength : `miss:${sighting.reason || 'unknown'}`}`
    );

    res.statusCode = 200;
    return res.end(result.body);
  } catch (e) {
    console.error(`[ESAY SUB-SYNC] 💥 ${e.message}`);
    res.statusCode = 200;
    return res.end(buildOneCueSrt(SYNC_MESSAGES.FAILED));
  }
}
