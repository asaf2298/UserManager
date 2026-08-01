# CLAUDE.md

## Role

You are an elite system architect, polyglot developer (expert in Node.js, Rust, and Python), and an applied mathematician.

## System Overview

This repo is one part of a wide, interconnected media streaming and aggregation ecosystem. The architecture relies on advanced mathematical calculations for ranking, high-performance proxying, and seamless server orchestration.

The ecosystem consists of the following distinct but communicating sub-systems:

- **Personal (previously Vecret, previously Esay) — The Aggregator** (this repo): the central hub and deterministic ranking engine that fans out requests and mathematically scores/deduplicates streams (Node.js / Vercel).
- **Telegram Addon:** a dynamic, high-speed HTTP proxy for streaming large media files directly from private channels (Python / FastAPI).
- **KanBox Addon:** a live TV, EPG, and VOD provider handling Israeli content (Node.js) — has a separate scraper repo (`Stremio-KanBoxRepos`) and addon repo (`Stremio-KanBoxAddon`, which also exposes the same data as a dedicated `/bingecat` Stremio addon for Live TV only — this repo's `TV_ADDON_URL` proxies to that same backend).
- **Einthusan Addon:** an automated headless scraping and media extraction service for South Asian content (Node.js / Puppeteer).
- **Kodi client (`Kodi-repo`):** a separate repo/companion Kodi addon (`plugin.video.personal`, Python) that consumes this repo's `api/kodi.js` / `api/kodi-catalog.js` as its entire backend. Live TV there is 3 rows: Kan-Box (this repo's `TV_ADDON_URL` proxy), and Pluto TV / Roku US channels via deep links directly into the real, separately-installed SlyGuy addons (no reimplementation of their stream resolution here). Anime there is AnimeIL-only (`https://addon.animeil.qzz.io`), never Cinemeta (`genre=Animation` there mixes in non-anime Western animation).

## Strict Operating Rules

Adhere to these at all times. Do not break them under any circumstances.

1. **Impact analysis.** Always check and verify that changing something in one place will not break or negatively affect other parts of the code or the broader ecosystem, before making the change.
2. **System-wide DRY principle.** Actively avoid "double coding" (code duplication) and redundant variables across all systems. Strive for a single source of truth, shared logic where applicable, and highly optimized, reusable mathematical and algorithmic models.
3. **Ask before changing.** Never make assumptions. Always ask for confirmation or clarify the intended architecture before modifying existing logic or implementing changes.

## Commands

No build step, no linter. Single runtime dependency (`node-fetch`).

```bash
npm install
node --test test/*.test.mjs      # contract tests (Node built-in runner)
node dev-server.mjs              # local harness; runs the real api/*.js handlers
```

`vercel dev` needs interactive auth and does **not** work headless — use `dev-server.mjs`, which reproduces the `vercel.json` rewrites.

## Deployment constraints — read before touching any timeout

- **Vercel Hobby: 10 s hard function limit.** Every budget in `lib/streamRanker.js` (`timeoutMs`, `collectionCutoffMs`) and `api/subtitles.js` must fit inside it, including JSON serialization. `vercel.json` declares no `maxDuration`, so the 10 s default applies.
- **`main` auto-deploys to production.** Never commit directly to it. Branch, PR, review.
- **The invocation is frozen the moment the handler returns.** Any un-awaited promise has its socket torn down mid-flight. Fire-and-forget writes therefore **do not work** — they surface as `AbortError` in the Vercel logs and the row is never written. Anything that must outlive the response has to be wrapped in `waitUntil()` from `@vercel/functions`. This silently disabled the entire trust-learning loop; see the known-issues epic below.

## Ranking pipeline (`rank-v2.0`)

Order is locked and lives in `lib/streamEngine.js#rankAndSelect`:

```
retrieve (RetrievalScheduler, bounded)
  → applyEligibility        (lib/streamFeatures.js — feature vector in [0,1])
  → pruneEligibleCandidates (cap at MAX_RANKER_CANDIDATES = 500)
  → scoreCandidates         (lib/streamRanker.js — weighted sum per profile)
  → deduplicateCandidates   (lib/streamDedup.js — exact Jaccard; MinHash/LSH only proposes)
  → selectStreams           (lib/streamSelector.js — VIP prefix, reservations, marginal gain)
```

Two invariants worth knowing before editing:

- **Trust is read-only on the request path.** `lib/providerTrust.js` consumes immutable snapshots; aggregation happens in the worker. Never write trust from a handler.
- **Determinism is scoped to ordering, not membership.** `sortRawDeterministically` guarantees that arrival order cannot change the *order* of what was collected. Which upstreams answered before `deadlineAt` still varies between requests, so two identical requests can legitimately return different sets.

## Stremio protocol facts that are easy to get wrong

Verified against `Stremio/stremio-core`, `stremio-web` and `stremio-video`:

- **Subtitles are `{ id, lang, url, label, fonts }`.** There is no `title` field — it is dropped on deserialization. The player renders `label` (`SubtitleVariant.tsx`: `hasValidLabel(track.label) ? track.label : languages.label(track.lang)`), with `origin` on a second line. If a subtitle needs a human-readable name, set **`label`**; keep `lang` a clean ISO code so language grouping and the user's preferred-subtitle-language auto-select keep working.
- **`label` starting with `http` is rejected** by `hasValidLabel` — never fall back to a URL.
- **Variant order within a language is preserved.** `SubtitlesMenu.js` calls `sortByValues(tracks, ORIGIN_PRIORITIES)`, but that comparator does `values.indexOf(a)` where `a` is a track object and `values` holds strings, so it always returns 0 and the stable sort keeps insertion order. The addon's own ordering therefore survives — but the *language list* itself is sorted alphabetically then by user/interface language priority, so only within-language ordering is ours.
- **Live TV metas are never remapped to an IMDb id** (`type === 'tv'`), so the single-stream `il_*` path keeps working.

## Known issues

An architectural audit (2026-08) found a number of defects that are still open. **Read the epic before making changes in these areas** — several look like intentional design but are bugs:

- **Epic: asaf2298/UserManager#62** — full findings, reproductions and proposed fixes, P0–P5.

Highest-impact open items: the trust-learning loop writes nothing (#54, so every provider is permanently `unproven` and capped), numeric/short titles are hard-dropped as wrong-show (#55), the subtitle duration probe reads the wrong end of the file (#57), and `api/sub-proxy.js` is an unauthenticated open proxy (#53).
