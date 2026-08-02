/**
 * P2 · lib/titleMatch.js (#55).
 *
 * WP-6: numeric/short titles ("1917", "300") must never hard-drop a release for
 * having zero token overlap with an all-numeric expected title -- absence of
 * tokens is absence of evidence, not a detected conflict.
 *
 * WP-7: Hebrew title matching must not treat a two-character chunk shared by
 * two otherwise-unrelated titles as strong evidence of a match.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getTitleConflictLevel, titleMatchEvidence } from '../lib/titleMatch.js';

test('WP-6: purely numeric expected titles are never hard-dropped', () => {
  assert.equal(getTitleConflictLevel({ title: '1917 Sam Mendes War Drama' }, ['1917']), null);
  assert.equal(getTitleConflictLevel({ title: '300 Rise of an Empire Zack Snyder' }, ['300']), null);
  assert.equal(getTitleConflictLevel({ title: '1984.1080p.BluRay.x264' }, ['1984']), null);
  assert.equal(getTitleConflictLevel({ title: '2012.2009.Roland.Emmerich.1080p' }, ['2012']), null);
  assert.equal(getTitleConflictLevel({ title: '1408 Stephen King 1080p' }, ['1408']), null);
});

test('WP-6 regression: a genuinely wrong show is still a hard conflict', () => {
  assert.equal(
    getTitleConflictLevel(
      { title: 'Shoujo Kakumei Utena 1080p BluRay' },
      ['Re:Zero kara Hajimeru Isekai Seikatsu'],
    ),
    'hard',
  );
});

test('WP-7: a shared 2-char Hebrew chunk alone is no longer "strong" hebrew_overlap evidence', () => {
  // 'בית' (house/home) is a stopword-filtered function word; once it's removed
  // from both sides, "different school" vs "different card house" no longer
  // collide on a leading shared-prefix or bare-chunk match.
  const result = titleMatchEvidence({ title: 'בית ספר' }, ['בית הקלפים']);
  assert.notEqual(result.reason, 'hebrew_overlap');
});

test('WP-7: a real fingerprint match is still strong', () => {
  const result = titleMatchEvidence({ title: 'פאודה' }, ['פאודה']);
  assert.equal(result.level, 'strong');
});

// KNOWN LIMITATION (verified against the fix as specified, not silently patched):
// the plan's own hebrew_overlap fix leaves the 4-char shared-prefix check
// untouched ("carries the true-positive load"). "שובר שורות" ("Breaking Bad")
// vs "שובר קווים" both start with the real word "שובר" ("breaker"), which is
// not a stopword and is not covered by the bare-chunk fix -- so this specific
// pair still resolves 'strong'/'hebrew_overlap'. Documented rather than fixed:
// touching the prefix-check was explicitly out of scope without owner sign-off.
test('WP-7 known limitation: a shared real (non-stopword) leading word still collides via the untouched prefix check', () => {
  const result = titleMatchEvidence({ title: 'שובר קווים' }, ['שובר שורות']);
  assert.deepEqual(result, { level: 'strong', reason: 'hebrew_overlap' });
});
