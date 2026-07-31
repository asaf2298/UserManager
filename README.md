# UserManager-Stremio (Personal Proxy)

**Personal** (formerly Vecret, formerly Esay) is a serverless proxy and aggregator for **Stremio and Kodi** addons, built for **Vercel Serverless Functions**. It fans out to multiple upstream addons in parallel, then runs a deterministic **retrieve → parse → feature → exact dedup → profile score → constrained select** pipeline for streams, plus mathematical subtitle ranking and optional embedded-only auto-sync.

Stremio install name: **`Personal - {name}`** (from `USER_CONFIGS`).

Current manifest version: **2.12.0**.

---

## Key Features

### Deterministic stream ranking (`rank-v2.0`)
* Latency-bounded retrieval with provenance stamps (provider, query mode, latency). Parallel completion order never affects rank.
* Collection cutoffs: **7000ms** for `everything` / `friends_heavy` / Kodi; **5500ms** for `friends_light` / `family`. At least **1500ms** reserved for ranking and serialization. No count-only early stop.
* Provider capability registry owns cache markers, VIP rules, and trust priors. Generic title text cannot mint cache or VIP status.
* Canonical release parser emits typed fields with `parsed` / `unknown` / `conflict` states. Missing metadata is uncertainty; contradictions reduce credibility.
* Exact Jaccard dedup is authoritative; MinHash/LSH only proposes pairs above **250** candidates.
* One weighted score per profile (`BaseScore = C * Σ wᵢ·fᵢ`, weights sum to 100). Features: availability `F`, trust `T`, match `X`, visual `V`, device `D`, audio `A`, HDR `H`, size plausibility `Z`, metadata `M`, language `L`.
* Constrained diverse selection with soft diversity penalties and hard caps. **VIP ≤ 2**, always first, never relaxed.
* TorBox is audit evidence only (worker `checkcached`). Missing clicks are not failures. Request-time ranking reads immutable trust snapshots or static priors.

### Availability wording (Hebrew tags)
* `זמין לצפייה` — confirmed ready (direct-owner URL, cache-positive debrid, or `F >= 0.90`)
* `נגן חיצוני` — external player URL
* `תלוי במהירות הרשת` — pure P2P (uncached torrent, seeder-dependent)
* `דורש המתנה ואולי כניסה חוזרת` — queued debrid / other not-yet-ready state
* `(לנגן תומך)` — appended when `notWebReady` (HEVC / advanced codecs)

### Notice / fake-stream filter
Non-playable “notice” rows from upstreams are dropped (Yuki `[YS INFO]` / `[YS NOTICE]`, Pengu donate/sign-in, Comet sync/metadata errors, Einthusan-style “no results”, etc.).

### Smart subtitles + embedded auto-sync
* Continuous subtitle score: release Jaccard, source/group/resolution/duration compatibility, within-request provider percentile.
* Language ordering remains Hebrew → English → Russian. Auto-generated tracks stay visible but sort after human tracks and are excluded as sync bases.
* Up to four immediate `סנכרון כתוביות` tracks (2 Hebrew bases × official / English reference slots). Selection starts work; pending returns a one-cue wait SRT; ready returns the full alass-aligned SRT at the same URL.
* Embedded text references only (no audio / Whisper / `ffsubsync` / `offsetMs`). Worker yields on Telegram `personal_host_busy`; TorBox playback does not block sync.

### Israeli catalogs (Kan-Box)
Kan-Box VOD / podcast / Dragon Ball catalogs (prefixed `IL - ` when needed) are advertised in the Personal manifest and included in unified search. The LiveTV catalog (`Live_TV_Channels`) is intentionally excluded from both — Kan-Box's own addon already advertises it directly. `TV_ADDON_URL` still proxies `meta`/`stream` for `il_*` ids that are already linked from elsewhere.

**Board vs Discover:** Stremio Board only loads catalogs with no *required* extras. Dragon Ball (`dbz_movies_catalog`, `dbz_series_catalog`) keep a required `genre` extra so they appear in **Discover** but not on the **Board**. Everything else remains on both.

### Unified search
Wall-clock budgets (discovery + fan-out) stay under Vercel Hobby’s ~10s limit; fetch + JSON share one timeout so stalled bodies cannot hang the request.

| Catalog | Soft / wall budget | Scope |
| --- | --- | --- |
| `חיפוש משולב` (movie) | ~**3s** | Movie-type search catalogs; **no** VIP hosts |
| `חיפוש משולב` (series) | ~**3s** | Series-type search catalogs; **no** VIP hosts |
| `חיפוש משולב - complete` | ~**3s** | Non-movie/series types + **VIP** (Kan-Box / AnimeIL / Personal Telegram) |
| `חיפוש משולב - full` | ~**8s** | All searchable types + **VIP**; excludes meta ids already returned by the fast three for the same query |

### Yastream Asian providers
Put Yastream in `ADDON_URLS` (no separate env required):

* Normal `tt` / `tt:S:E` streams fan out like any other stream addon.
* Provider ids `kisskh:` / `idrama:` / `onetouchtv:` are accepted in the manifest; **meta** and **stream** for those ids are proxied only to Yastream.
* Mixed-search hits that expose an IMDb id in artwork/fields are rewritten to `tt…` so Cinemeta + the normal fan-out apply.

Optional override: `YASTREAM_URL` if you need an explicit base outside `ADDON_URLS`.

---

## Environment Variables (Vercel)

| Variable | Role | Example |
| --- | --- | --- |
| `ADDON_URLS` | Stream addon bases, separated by `\|\|\|` | `https://torrentio.strem.fun/...\|\|\|https://yastream...` |
| `SUBTITLE_URLS` | Subtitle addon bases, separated by `\|\|\|` | `https://opensubtitles-v3.strem.io\|\|\|https://...` |
| `TV_ADDON_URL` | Israeli live / Kan-Box addon base | `https://kan-box-addon.vercel.app` |
| `TMDB_API_KEY` | TMDB v3 API key (titles, year, runtime) | `KEY...` |
| `USER_CONFIGS` | JSON map of user keys → profile / name | *(see below)* |
| `YASTREAM_URL` | Optional explicit Yastream base | *(usually omit; use `ADDON_URLS`)* |
| `SUPABASE_URL` | Supabase project URL (ID resolve + ranking/sync tables) | — |
| `SUPABASE_ANON_KEY` | Read-only resolver key (`personal_titles` SELECT) | — |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server-only**: ingest, sightings, audit queue, sync jobs | — |

`TORBOX_API_TOKEN` belongs on the **media-intelligence worker only** — never on Vercel and never in client URLs. The worker uses it for cache audits and to resolve a TorBox CDN locator for subtitle sync probing (Torrentio resolve URLs return Cloudflare 403 from the droplet).

### ID mapping (opt-in, Supabase)

Cross-provider ID resolution for anime (and later K-drama/soap). **Disabled by default** — when off, stream behavior is unchanged.

| Variable | Role | Default |
| --- | --- | --- |
| `ID_RESOLVE_ENABLED` | Query Supabase on stream requests | `false` |
| `ID_RESOLVE_SHADOW` | Log `[ID-RESOLVE][SHADOW]` plans without changing queries | `false` |
| `ID_RESOLVE_QUERY` | Phase 2: additive `mal:` / `kitsu:` fan-out (never replaces `tt`) | `false` |
| `ID_RESOLVE_EPISODE` | Phase 3: apply AniBridge episode remap to extras | `false` |
| `ID_RESOLVE_ALIAS` | Phase 4: conservative synonym text search on anime-capable addons | `false` |
| `ID_RESOLVE_TIMEOUT_MS` | Supabase lookup timeout | `400` |
| `ID_RESOLVE_MAX_EXTRA_FETCHES` | Cap total extra addon requests per stream | `7` |
| `ID_RESOLVE_MAX_ALIAS_SEARCHES` | Cap alias text searches per stream (`1` = immediate only; `2` = +1 deferred when thin after 5.5s) | `1` |
| `ID_RESOLVE_ANIME_ADDON_PATTERNS` | Comma-separated host substrings for mal/kitsu fan-out | `torrentio,comet,mediafusion,…` |
| `ID_RESOLVE_CACHE_TTL_MS` | In-memory resolve cache TTL | `300000` (5 min) |

**Rollout:** enable `ID_RESOLVE_ENABLED` + `ID_RESOLVE_SHADOW` first and inspect logs (shadow is fire-and-forget — does not delay fan-out). Then set `ID_RESOLVE_QUERY=true` for additive anime fan-out; resolve overlaps with meta so base `tt` + text queries still start on the same schedule. Run `scripts/ingest-anibridge.mjs`, verify shadow shows `mappedExtras` for multi-cour titles, then set `ID_RESOLVE_EPISODE=true`. Finally run Fribb + Manami ingest and set `ID_RESOLVE_ALIAS=true` for synonym text search (prefers origin-country titles: Japanese / Korean / Chinese). With `ID_RESOLVE_MAX_ALIAS_SEARCHES=2`, the top synonym fires in Phase 1; the 2nd-ranked synonym fires only after the 5.5s burst when the finalized list is still thin. Episode coords still use Stremio S/E for the primary `tt` query.

Fribb ingest (offline): `node --env-file=.env.local scripts/ingest-fribb.mjs` (imdb + MAL-only pool)  
Manami aliases: `node scripts/generate-manami-batches.mjs` → `node scripts/ingest-manami-aliases.mjs`  
AniBridge episode ingest: `node --env-file=.env.local scripts/ingest-anibridge.mjs`

Media-intelligence schema: `supabase/migrations/20260726000000_media_intelligence.sql` (audit queue, observations, trust snapshots, stream sightings, subtitle sync jobs/cache, RLS). Apply only after approving the `personal_titles` SELECT policy + `personal_host_busy` RLS enablement.

> Do **not** append `/manifest.json` to addon URLs in env vars.

### `USER_CONFIGS` shape

```json
{
  "my_secret_master_key": {
    "profile": "everything",
    "name": "Master"
  },
  "friend_key_1": {
    "profile": "friends_heavy",
    "name": "Friend"
  },
  "kids_room_key": {
    "profile": "family"
  }
}
```

User keys are taken from the **URL path** (`/<USER_KEY>/manifest.json`, `/<USER_KEY>/stream/...`). Kodi catalog uses query `userKey` only for live channels / optional labeling; VOD catalogs use public Cinemeta.

---

## User Profiles

| Profile | target | Size hard-cap | Collection cutoff | Emphasis |
| --- | --- | --- | --- | --- |
| `everything` | 30 | ∞ | **7000ms** | Technical quality (`V`/`A`/`H`) |
| `friends_heavy` | 30 | ∞ | **7000ms** | Quality with mild readiness floor |
| `friends_light` | 10 | **30GB movies / 10GB episodes** | **5500ms** | Immediate compatible playback |
| `family` | 10 | **30GB movies / 10GB episodes** | **5500ms** | Ready + compatible; CAM banned |
| Kodi | 100 | ∞ | **7000ms** | `friends_heavy` weights, capable client |

VIP hosts (host-authoritative in the provider registry): **Kan-Box**, **AnimeIL**, and **Personal Telegram** (`https://advantage-shot-petition-crucial.trycloudflare.com/As123456` — put the same base in `ADDON_URLS`). VIP output is **always ≤ 2** and listed first on every profile. Unknown size is never hard-dropped by the size cap.

Capable clients (User-Agent containing `nuvio`, `kodi`, or `libmpv`) use the Kodi presentation path.

---

## Local development

```bash
node --env-file=.env.local dev-server.mjs   # http://localhost:3000
node --test 'test/*.test.mjs'               # ranking / dedup / selector / sync contracts
```

No hot reload — restart after editing `api/` or `lib/`. See `AGENTS.md` for cloud/egress notes (many public stream addons return 403 from datacenter IPs) and the media-intelligence worker.

---

## Install

### Stremio
1. Deploy to Vercel and set the env vars above.
2. Install: `https://<YOUR-VERCEL-DOMAIN>/<USER_KEY>/manifest.json`

### Kodi
Thin JSON APIs (same stream engine):

```http
GET /api/kodi?imdb_id=tt0111161&type=movie
GET /api/kodi?imdb_id=tt0944947&type=series&season=1&episode=1
GET /api/kodi-catalog?userKey=my_secret_master_key&list=catalogs
```

---

## Diagnostics

Watch Vercel **Logs** for tags such as:
`[PERSONAL STREAM]`, `[PERSONAL SEARCH]`, `[ID-RESOLVE]`, `[PERSONAL SUBTITLES]`, `[PERSONAL SUB-SYNC]`, `[PERSONAL SUB-PROXY]`, `[META HELPER]`.

---

*Built for seamless, buffer-free playback on Stremio, Nuvio, and Kodi.*
