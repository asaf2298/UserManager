# Media worker

Second service for the existing 1 CPU / 1 GB droplet that already runs the
Telegram→Stremio addon. Three jobs, in priority order of cost:

| Task | Cadence | Cost |
| --- | --- | --- |
| Subtitle alignment (`ffprobe` + `ffmpeg` + `alass`) — also feeds `integrity` trust evidence | on demand, **one at a time** | heavy |
| TorBox cache audits (`checkcached`) | at most 1 batch/min, ≤100 hashes | light |
| Trust snapshot publication + TTL sweep | daily / hourly | light |

## Host-busy contract

The worker never competes with playback. The Telegram addon owns a lease row in
`personal_host_busy`:

| Signal | Owner | When |
| --- | --- | --- |
| busy ↑ | Telegram addon | first active byte-stream (refcount 0→1) |
| busy ↓ | Telegram addon | last stream generator finishes / disconnects / errors |
| heartbeat | Telegram addon | refresh `busy_until` ~every 30s while streaming |
| consume | this worker | skip claiming, and abort + requeue mid-job |

Busy means `busy = true AND busy_until > now()`. A missing row or an expired
lease counts as free, so a crashed writer cannot deadlock the worker forever.

A busy abort does **not** consume a retry attempt — yielding is not a failure.

**TorBox/CDN playback does not set the lease** and therefore does not pause
alignment. Those bytes never traverse this host, so there is no contention to
avoid. This is intentional.

## Environment

```
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=…      # required: worker tables are service-role only
TORBOX_API_TOKEN=…               # required for subtitle probe + optional audits
TMDB_API_KEY=…                   # official-language reference slot
WORKER_ID=media-worker-1         # optional label used when claiming jobs
HOST_BUSY_ID=default             # optional: lease row id
```

`TORBOX_API_TOKEN` must exist **only** here. It is never sent to a client and
never stored in telemetry.

**Subtitle sync probe:** Torrentio/Comet resolve URLs are Cloudflare-blocked from
datacenter IPs, so `ffprobe` against the offered playable URL fails with HTTP 403.
With `TORBOX_API_TOKEN`, the worker resolves a TorBox CDN locator via
`createtorrent` (`add_only_if_cached`) + `requestdl` and probes that instead.
Without the token (or when the hash is not cached on TorBox), sync jobs fail
with `probe_failed`.

## Run

```bash
# Docker (recommended: caps RAM so the Telegram addon always has headroom)
docker build -f worker/media-intelligence/Dockerfile -t media-worker .
docker run -d --name media-worker \
  --memory 640m --cpus 0.8 \
  --env-file /etc/media-worker.env \
  --restart unless-stopped \
  media-worker

# Bare metal (needs ffmpeg + alass on PATH)
node worker/media-intelligence/index.mjs
```

Verify the toolchain before first run:

```bash
ffprobe -version | head -1
alass --help | head -1
```

## Alignment behavior

- **Embedded text subtitles only.** No audio, Whisper, or `ffsubsync`.
- Only the opening window (`WORKER_PROBE_WINDOW_SECONDS`, default 900s) is
  downloaded, which is enough to establish offset and drift.
- No text track is discarded. Forced, SDH, commentary, and signs tracks rank
  lower but stay eligible — a forced track is still valid timing evidence when it
  is the only match for the target language.
- Bitmap subtitles (PGS/VobSub) are the single hard exclusion: `alass` needs text.
- Reference slots are `official` (the production language from TMDB) and
  `english`. If the slot language is missing but another labeled language
  exists, the viewer sees `try another sync subtitle` instead of a file-level
  no-embeds failure.
- Output is a rewritten SRT, not a global offset, so non-linear drift is corrected.

## What TorBox is and is not used for

TorBox has no "user clicked and playback succeeded" endpoint. Beyond subtitle
probe CDN resolution (above), TorBox is also used as **audit evidence** for a
falsifiable cache claim:

`mylist` is account state and `requestdl` only proves a link can be issued —
never that a viewer played anything:

| Observation | Meaning |
| --- | --- |
| provider said `cache_positive`, hash is cached | success |
| provider said `cache_positive`, fresh check disagrees | failure |
| provider said `queued`, hash is not cached | success (honest label) |
| request failed / identity insufficient / non-TorBox claim | **no observation** |

Missing clicks, URL-only streams, and absent audits never lower a provider's
trust. Absence of evidence is not evidence of failure.

## Integrity evidence from the subtitle-sync probe

`cache_claim` (above) grades whether a provider's "instantly cached" tag is
truthful. It says nothing about whether the claimed file is actually real,
playable content — a wrong or corrupt release never lowered any provider's
score, because nothing inspected the actual bytes.

The subtitle-sync probe already does that inspection for free: every sync job
resolves a TorBox CDN locator and runs `ffprobe` against the real file
(above). Whether that succeeds or fails is graded as `integrity` evidence and
written to `personal_provider_observations` with `source: controlled_probe`,
using the same falsifiable-claim philosophy as cache-claim audits:

| Observation | Meaning |
| --- | --- |
| `ffprobe` opens the file and returns real stream data | success — regardless of what happens after (no text tracks, extraction/alass failure are irrelevant to integrity) |
| `ffprobe` fails against the TorBox-resolved (`torbox_cdn`) URL | failure — TorBox itself vouched the file is reachable, so a real parse failure means the release is fake/corrupt/mislabeled |
| `ffprobe` fails against the raw offered URL, or no reachable source at all | **no observation** — a Cloudflare/geo block looks identical to a genuine parse failure, so it is not held against the provider |

Sampling here is demand-driven (whatever the viewer happens to be watching),
not the uniform sampling `personal_ranking_audit_queue` uses for cache-claim
audits. Inverse-propensity weighting (`lib/providerTrust.js`) corrects the
*magnitude* of that but not the underlying selection bias — an accepted
approximation, not a silent one.

No new TorBox calls, no new CPU cost, and no changes needed in
`trustAggregator.mjs` / `lib/providerTrust.js`: both already handled the
`integrity` metric generically since the original media-intelligence
migration — they just had nothing writing to it until now.
