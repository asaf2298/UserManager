import { appendFileSync } from 'node:fs';

// Lightweight debug logger for cloud-agent sessions. Safe no-op if ingest is down.
const DEBUG_INGEST = 'http://127.0.0.1:7780/ingest/6be6eb41-8d9a-4b5f-9c0c-1fbc6c2d14e2';
const DEBUG_LOG_PATH = '/opt/cursor/logs/debug.log';

export function debugLog(hypothesisId, location, message, data = {}) {
  // #region agent log
  const payload = {
    sessionId: '7f1bc5',
    runId: process.env.DEBUG_RUN_ID || 'pre-fix',
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now()
  };
  const line = JSON.stringify(payload);
  try { appendFileSync(DEBUG_LOG_PATH, line + '\n'); } catch (_) {}
  fetch(DEBUG_INGEST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '7f1bc5' },
    body: line
  }).catch(() => {});
  // #endregion
}
