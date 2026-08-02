/**
 * P2 · subtitle duration probe reads the wrong end of the file (#57).
 *
 * parseSubtitleDurationMinutes() returns the MAXIMUM timestamp found in the
 * text it's given -- so which slice of the file api/subtitles.js's peekSrt()
 * fetches determines whether the real runtime is ever found. The old code
 * requested `bytes=0-65535` (the head); for anything longer than ~45 minutes,
 * the true last cue lives past that point and the probe silently underreports.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSubtitleDurationMinutes } from '../lib/subtitleUtils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Build a synthetic SRT of roughly `bytes` size whose last cue is at `minutes`. */
function buildSyntheticSrt(minutes, bytes) {
  const lines = [];
  let n = 1;
  // Padding cues spaced every 3s up to (minutes - 1) so the body is large
  // enough to actually exceed the old 64KB head-range, then one true final
  // cue at exactly `minutes`.
  for (let sec = 3; sec < (minutes - 1) * 60 && Buffer.byteLength(lines.join('\n'), 'utf8') < bytes; sec += 3) {
    const h = String(Math.floor(sec / 3600)).padStart(2, '0');
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    lines.push(`${n}\n${h}:${m}:${s},000 --> ${h}:${m}:${String(Number(s) + 2).padStart(2, '0')},000\nFiller subtitle line number ${n}.\n`);
    n++;
  }
  const totalSec = minutes * 60;
  const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  lines.push(`${n}\n${h}:${m}:${s},000 --> ${h}:${m}:${String(Number(s) + 2).padStart(2, '0')},000\nThe true final line of the film.\n`);
  return lines.join('\n');
}

test('a 90-minute file: the head 64KB alone underreports duration (reproduces the bug)', () => {
  const srt = buildSyntheticSrt(90, 130_000);
  assert.ok(Buffer.byteLength(srt, 'utf8') > 65536, 'fixture must exceed the old head-range size');
  const headOnly = srt.slice(0, 65536);
  const headDuration = parseSubtitleDurationMinutes(headOnly);
  assert.ok(headDuration < 60, `head-only read must miss the true 90min runtime, got ${headDuration}`);
});

test('a 90-minute file: reading the tail recovers the true duration (the fix)', () => {
  const srt = buildSyntheticSrt(90, 130_000);
  const tail = srt.slice(-200_000); // mirrors peekSrt()'s post-fetch bound
  const tailDuration = parseSubtitleDurationMinutes(tail);
  assert.ok(tailDuration >= 89 && tailDuration <= 91, `tail read must recover ~90min, got ${tailDuration}`);
});

test('a short (<45min) file works either way, matching the plan\'s own table', () => {
  const srt = buildSyntheticSrt(45, 62_000);
  const full = parseSubtitleDurationMinutes(srt);
  assert.ok(full >= 44 && full <= 45.5);
});

test('api/subtitles.js requests a suffix range so peekSrt reads the tail, not the head', () => {
  const source = fs.readFileSync(path.join(__dirname, '../api/subtitles.js'), 'utf8');
  assert.match(source, /'Range':\s*'bytes=-65536'/, 'peekSrt must request the tail of the file');
  assert.doesNotMatch(source, /'Range':\s*'bytes=0-65535'/, 'the old head-only range must be gone');
});
