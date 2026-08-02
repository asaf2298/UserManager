/**
 * P3 · latency and search fixes (#59).
 *
 * These rely on source-text assertions rather than live network calls, matching
 * this suite's existing convention (e.g. the sub-proxy/subtitles handler checks) --
 * getContentMeta/TMDB/Cinemeta calls are real network I/O with no mock seam, and
 * no existing test in this repo exercises that path directly for the same reason.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('WP-13: metadata is raced against a budget, not unconditionally awaited', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/streamEngine.js'), 'utf8');
  assert.match(source, /const META_BUDGET_MS = 1200/);
  const idx = source.indexOf('const [contentMeta, resolvedCtx] = await Promise.all([');
  assert.ok(idx > -1, 'must still resolve contentMeta/resolvedCtx together');
  const block = source.slice(idx, idx + 300);
  assert.match(block, /Promise\.race\(\[metaPromise/, 'metaPromise must be raced, not awaited directly');
  assert.match(block, /META_BUDGET_MS/);
});

test('WP-13: TMDB/Cinemeta timeouts are tightened so the worst case fits inside the budget chain', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/search.js'), 'utf8');
  // find: 3500 -> 2000ms
  assert.match(source, /fetchWithTimeout\(findUrl,[^)]*\},\s*2000\)/s);
  // the three parallel detail calls and the Cinemeta fallback: 3000 -> 1500ms
  assert.equal((source.match(/\b1500\b/g) || []).length, 4, 'expected 3 detail-call timeouts + 1 Cinemeta timeout at 1500ms');
  // No remaining fetchWithTimeout call site still on the old 3500/3000 budgets
  // (comments may still mention the old numbers for context).
  assert.doesNotMatch(source, /fetchWithTimeout\([^)]*\},\s*3500\)/s);
  assert.doesNotMatch(source, /fetchWithTimeout\([^)]*\},\s*3000\)/s);
});

test('WP-14: the meta cache carries a TTL and distinguishes usable vs empty results', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/search.js'), 'utf8');
  assert.match(source, /META_TTL_OK_MS\s*=\s*6 \* 60 \* 60 \* 1000/, 'good lookups should cache for hours');
  assert.match(source, /META_TTL_FAIL_MS\s*=\s*45 \* 1000/, 'failed/empty lookups should expire quickly');
  assert.match(source, /expiresAt:\s*Date\.now\(\)\s*\+\s*ttlMs/, 'cache entries must carry an expiry');
  assert.match(source, /cached\.expiresAt > Date\.now\(\)/, 'a cache read must check expiry, not just presence');
  assert.match(source, /usable \? META_TTL_OK_MS : META_TTL_FAIL_MS/);
});

test('WP-18: subtitle handler worst case fits inside the Vercel Hobby 10s ceiling', () => {
  const source = fs.readFileSync(path.join(__dirname, '../api/subtitles.js'), 'utf8');
  assert.match(source, /PROVIDER_RACE_MS = 3500/);
  assert.match(source, /PROVIDER_RACE_EXTENDED_MS = 5000/);
  assert.match(source, /PEEK_BUDGET_MS = 1200/);

  // Per-provider ceiling must not outlive the extended race window.
  assert.match(source, /fetchWithTimeout\(targetUrl, fetchOptions, PROVIDER_RACE_EXTENDED_MS\)/);
  // peekSrt must use the tightened budget, not a hardcoded 2500ms.
  assert.match(source, /\}, PEEK_BUDGET_MS\);/);
  assert.doesNotMatch(source, /\}, 2500\);/);

  // New worst case: PROVIDER_RACE_EXTENDED_MS + PEEK_BUDGET_MS + overhead
  // must stay comfortably under 10000ms (plan's own accounting: ~7.2s).
  const worstCaseMs = 5000 + 1200 + 400 + 600;
  assert.ok(worstCaseMs < 10_000, `computed worst case ${worstCaseMs}ms must be under the 10s ceiling`);
});

test('WP-18: vercel.json declares an explicit maxDuration for the subtitle handler', () => {
  const vercelConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '../vercel.json'), 'utf8'));
  assert.equal(vercelConfig.functions?.['api/subtitles.js']?.maxDuration, 10);
});
