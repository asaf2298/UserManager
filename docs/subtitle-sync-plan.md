# Subtitle auto-sync — deferred plan

Status: **saved for later** (not implemented).  
Goal: auto-sync external subs to the video **in the background**, and offer a synced track on the **next play** (never block first play).

## Product flow

1. **First play:** Personal returns the normal subtitle list (current behavior).
2. **Background job:** if video audio is reachable and a target subtitle is chosen → `ffmpeg` + `ffsubsync` / `alass` → compute `offsetMs`.
3. **Cache:** store `offsetMs` keyed by `videoHash` (or TorBox file id) + subtitle fingerprint.
4. **Next play:** add a track like `עברית (מסונכרן)` served via sub-proxy with that offset.

Show the synced option **only when the cache is ready**. Never block or fail the first subtitle list waiting on sync.

## Architecture

| Piece | Role |
| --- | --- |
| **Personal (Vercel)** | List subtitles; serve shifted SRT (`/api/sub-proxy?offsetMs=…`) |
| **Docker worker (1 GB OK if single-job, slow)** | Sync only — no local LLM/Whisper required for v1 |
| **Optional later** | Gemini API to pick the “first real dialogue” cue (text only) |
| **TorBox** | Video/audio **source** (`requestdl` / stream URL) — **cannot** attach/upload an SRT via API; stream API only selects **embedded** tracks |

```
First play → normal subs + enqueue sync job
                ↓
     Docker: ffmpeg → ffsubsync/alass → offsetMs
                ↓
     Cache (SQLite / Redis / files)
                ↓
Next play → Personal lists “synced” track → sub-proxy applies offset
```

## Explicit non-goals (for now)

- Instant one-click “press when you hear the word” inside Stremio
- Stable Audio / Qwen TTS / other **generators** used as sync tools
- Dedicated GPU server (overkill for ffsubsync)
- Paying for more than 1 GB RAM unless an MVP proves it is worth it

## Constraints and risks

1. **Biggest blocker:** getting **HTTP-accessible audio** for the file actually being played (Stremio subtitle requests do not include playback time or a reliable stream URL by default).
2. **1 GB RAM:** fragile/slow; one job at a time; cache aggressively; prefer opening minutes over full-file when possible.
3. **Wrong subtitle file** stays wrong after sync — the user still chooses the base track; sync only shifts timing.
4. Different cuts / frame rates / drift can still defeat a single global offset.
5. TorBox Pro stream APIs select embedded subs only — external synced SRTs stay on Personal/proxy.

## What TorBox can and cannot do

| Goal | TorBox API |
| --- | --- |
| Attach my external SRT to their stored file | No |
| Choose an embedded subtitle in their HLS stream | Yes (`chosen_subtitle_index`, Pro) |
| Download/stream their file for local sync | Yes (typical debrid / `requestdl` flow) |
| OpenSubtitles hash / size for matching | Available in stream metadata |

## v1 checklist

- [ ] Sub-proxy `offsetMs` SRT rewrite
- [ ] Worker: opener or full-file `ffsubsync` / `alass`
- [ ] Cache store (SQLite / Redis / files)
- [ ] Trigger after first play / when `videoHash` (or file id) is known
- [ ] “Synced” track in subtitle list on cache hit
- [ ] TorBox (or similar) download URL path tested
- [ ] Single-concurrency + timeout guards on 1 GB droplet

## Reference tools

- [subsyncarr](https://github.com/johnpc/subsyncarr) — library batch pattern (scan disk); idea to steal, not a drop-in for Stremio streams
- [ffsubsync](https://github.com/smacke/ffsubsync)
- [alass](https://github.com/kaegi/alass)
- [TorBox API docs](https://api-docs.torbox.app/) — file access, not subtitle attach

## Decision summary

**Best UX for this stack:** sync in the background, offer on next play.  
**Best v1 engines:** `ffmpeg` + `ffsubsync`/`alass` + cache.  
**Skip for sync:** audio generators (Stable Audio), TTS (Qwen VoiceDesign), “AI text alone = timestamp.”  
**Gemini (optional):** prepare search/dialogue-cue text only; timing still comes from audio alignment.
