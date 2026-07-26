# Subtitle auto-sync — embedded reference alignment

Status: **implemented**. Always on; no feature flag.

Goal: retime an existing Hebrew subtitle to the exact cut being played, using the
movie's **own embedded subtitles** as the timing reference.

## Why embedded, not audio

The file's embedded subtitles are already aligned to this specific cut, so they
are a stronger anchor than audio analysis and dramatically cheaper — no Whisper,
no `ffsubsync`, no GPU. On a 1 GB droplet that difference decides whether the
feature is viable at all.

If a file has no extractable **text** subtitle track, sync fails honestly rather
than guessing. Bitmap subtitles (PGS/VobSub) are the one hard exclusion, because
`alass` needs text.

## Product flow

1. **First subtitle list** already contains up to four `סנכרן כתבויות` tracks:
   the top two non-auto Hebrew subtitles × two reference slots (`official`,
   `english`). Listing them costs nothing.
2. **Selecting one starts the work.** Nothing heavy runs on a list request.
3. **While pending**, the same URL serves a one-cue subtitle reading
   `please wait one minute and reselect to sync`, so the player shows status
   instead of an error.
4. **After the job finishes**, that same URL serves the aligned SRT. The viewer
   toggles the track off/on (or reselects it) to pick up the result.

Terminal messages are exact:

| State | On-screen text |
| --- | --- |
| pending / running | `please wait one minute and reselect to sync` |
| no usable text track | `no available embedded subtitles` |
| other terminal failure | `sorry couldnt sync` |

`/api/sub-sync` responds `Cache-Control: no-store`, otherwise a player could cache
the wait cue over the finished subtitle.

## Identifying the playing file

Stremio never tells an addon which stream was clicked, and subtitle requests do
not carry the playback URL. So the stream handler records what it just offered:

```
stream list → personal_stream_sightings (2h TTL, HTTP locators only)
subtitle request extras → match a sighting → playable URL for the worker
```

Match order is strongest evidence first: `videoHash`, then `filename + videoSize`,
then `filename`, then `videoSize`. An ambiguous weak match is reported as a miss —
syncing the wrong file is worse than not offering sync.

Machine-translated tracks stay visible as normal options but are never used as
alignment **bases**: perfectly timing a bad translation just produces well-timed
nonsense.

## Reference track selection

All text tracks are ranked; none are discarded. Forced, SDH/HI, commentary, signs,
and song tracks rank lower but remain eligible, because a forced track is still
valid timing evidence when it is the only match for the target language.

```
score = 0.65 × languageMatch + 0.25 × cueCoverage + 0.10 × normality
cueCoverage = clip(cueCount / (runtimeMinutes × 8), 0, 1)
normality   = dialogue 1.00 | forced 0.80 | SDH/HI 0.75 | commentary/signs/songs 0.60
```

- `official` slot targets the TMDB production language (`original_language`).
- `english` slot targets English, falling back to the best remaining track.
- Cue counts come from actually extracting shortlisted candidates, because
  `ffprobe` cannot distinguish a 40-cue forced track from a full dialogue track.
- One usable track means the second slot reports `no available embedded subtitles`.

`alass` runs subtitle-to-subtitle and the **rewritten SRT** is stored, not a single
global offset, so non-linear drift is corrected too.

## Architecture

| Piece | Role |
| --- | --- |
| `api/subtitles.js` | ranks addon subtitles; injects up to 4 sync tracks |
| `api/sub-sync.js` | state read + at most one enqueue; serves wait/ready/failure |
| `lib/subtitleSync.js` | state machine, cache/job lookups, track ranking |
| `lib/streamSighting.js` | records offered files; matches subtitle extras back |
| `worker/media-intelligence/` | `ffprobe` → extract → `alass` → store |
| `api/sub-proxy.js` | unchanged: UTF-8 re-encoding only, no `offsetMs` |

Supabase tables: `personal_subtitle_sync_jobs`, `personal_subtitle_sync`,
`personal_stream_sightings` (all service-role only).

## Worker limits

Shares a 1 CPU / 1 GB droplet with the Telegram→Stremio addon, so playback always
wins:

- subtitle concurrency **1**; container capped at 640 MiB / 0.8 CPU
- timeouts: `ffprobe` 30s, extraction 90s, `alass` 120s, total job 240s
- only the opening ~900s of video is downloaded
- max 3 real attempts with 60s / 5m / 30m backoff; job TTL 24h
- while `personal_host_busy` is leased, no job starts; an in-flight job aborts,
  requeues, and **does not** consume an attempt
- aborts terminate the exact child PID this job spawned, never by process name
- TorBox/CDN playback does not set the lease and does not pause sync, by design

## Explicit non-goals

Audio sync; in-player tap-to-sync; TTS or audio generators; GPU; attaching an
external SRT to TorBox (their API cannot); blocking sync during TorBox playback;
feeding sync outcomes back into stream ranking.

## Reference tools

- [alass](https://github.com/kaegi/alass) — subtitle-to-subtitle alignment, handles drift
- [TorBox API](https://api-docs.torbox.app/) — file access only; cannot attach subtitles
