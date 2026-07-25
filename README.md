# UserManager-Stremio (Vecret / Personal Proxy)

Vecret (**Personal**, formerly Esay) is a serverless proxy and aggregator for **Stremio and Kodi** addons, built for **Vercel Serverless Functions**. It fans out to multiple upstream addons in parallel, then filters, pre-sorts, deduplicates, and quota-slices streams and subtitles into a fast, profile-aware response.

Stremio install name: **`Personal - {name}`** (from `USER_CONFIGS`).

Current manifest version: **2.10.5**.

---

## Key Features

### Smart two-phase stream timeout
* Fans out to all stream addons in parallel (IMDb/TMDB id + primary title `search=`).
* Waits an initial **5.5s** burst (`INITIAL_WAIT_MS`), then uses the remaining profile budget (up to **9.5s** on `everything` / `friends_heavy`, and for capable clients like Nuvio/Kodi).
* **Early-stop:** if the finalized list already fills `maxResults`, returns after the burst without waiting out the full timeout.
* **Multi-language text-search backup** (English / Hebrew / Russian / original title) runs **sequentially and only if** the primary fan-out is still thin or VIP hosts returned nothing.
* If the request hints at dubbed content (`דיבוב` / `מדובב`), Hebrew titles are preferred for text search.

### Pre-sort + bucket quotas (`drawWithOverflow`)
* Pre-sorts by resolution, source quality, size tier, visual (HDR family), and audio.
* Splits VIP sources (Kan-Box / AnimeIL / Telegram / Your Media) from standard streams.
* Buckets standard streams into `4K|1080p|720p|SD` × `Cached|Uncached`.
* **`drawWithOverflow`:** fill Cached quota first; missing Cached slots borrow from Uncached; leftover Cached can backfill Uncached shortage. Order: 4K → 1080p → 720p → SD.
* Enforces a **minimum of 2 items per resolution** when available.
* VIP capped at **3**, always listed first.
* Reserved slots after quotas:
  * `everything` / `friends_heavy`: up to **3** Uncached 4K, **3** Uncached 1080p, **3** Direct Web
  * `friends_light` / `family`: **1** of each
* Episode queries drop oversized **season-pack** rows when the non-pack list already fills `maxResults`.

### Dynamic Hebrew stream tags
* `זמין לצפייה` — Cached / Debrid-ready
* `דורש המתנה ואולי כניסה חוזרת` — Uncached torrent (needs download)
* `מרשת דפדפן` — Direct HTTP / VIP web
* `(לנגן תומך)` — appended when `notWebReady` (HEVC / advanced codecs)

### Uncached detection (MediaFusion & friends)
Streams are forced into the Uncached bucket when titles/ids contain signals such as:
`⏳` `⌛` `uncached` / `un-cached` / `not cached`, `⬇️` / `download` / `downloading`, `download to debrid`, `to debrid`, `instant=false`, `cached:no`, `[DL]`, etc. (spaces / hyphens / underscores optional).

Bracket debrid tags: `[TB+]` / `[RD⚡]` (and similar) mean **cached**; bare `[TB]` / `[RD]` mean **uncached**.

### Notice / fake-stream filter
Non-playable “notice” rows from upstreams are dropped (Yuki `[YS INFO]` / `[YS NOTICE]`, Pengu donate/sign-in, Comet sync/metadata errors, Einthusan-style “no results”, etc.).

### Fake HDR / upscale penalties
True HDR/DV/HLG tags still boost visual score. Self-declared AI/upscales and contradictory “fake quality” claims are penalized. Pre-**2015** titles with HDR tags get a mild caution nudge.

### Smart subtitles
* Dynamic race: at **6s**, cut early if ≥3 Hebrew subs; otherwise extend to **9s**.
* Language allowlist (he / en / ru); if none match, **any available format** is returned as fallback.
* **Duration matching (±5%):** compares subtitle duration to TMDB/Cinemeta runtime. Matches get a large bonus.
* Display titles include provider (`Personal Sub`), score (`★N`), and sync/duration hints.
* All subtitle URLs are routed through `/api/sub-proxy` as **UTF-8**.

### Israeli catalogs (Kan-Box)
All Kan-Box catalogs are advertised in the Personal manifest:

1. **ערוצים חיים** (`Live_TV_Channels`) — first
2. Unified search catalogs (`חיפוש משולב*`)
3. Remaining IL VOD / podcast / Dragon Ball rows (prefixed `IL - ` when needed)

**Board vs Discover:** Stremio Board only loads catalogs with no *required* extras. Dragon Ball (`dbz_movies_catalog`, `dbz_series_catalog`) keep a required `genre` extra so they appear in **Discover** but not on the **Board**. Everything else remains on both.

Catalog `search` extras on Kan-Box rows are stripped so Stremio search goes through Personal’s unified search instead.

### Unified search
Wall-clock budgets (discovery + fan-out) stay under Vercel Hobby’s ~10s limit; fetch + JSON share one timeout so stalled bodies cannot hang the request.

| Catalog | Soft / wall budget | Scope |
| --- | --- | --- |
| `חיפוש משולב` (movie) | ~**3s** | Movie-type search catalogs; **no** VIP hosts |
| `חיפוש משולב` (series) | ~**3s** | Series-type search catalogs; **no** VIP hosts |
| `חיפוש משולב - complete` | ~**3s** | Non-movie/series types + **VIP** (Kan-Box / AnimeIL) |
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

### ID mapping (opt-in, Supabase)

Cross-provider ID resolution for anime (and later K-drama/soap). **Disabled by default** — when off, stream behavior is unchanged.

| Variable | Role | Default |
| --- | --- | --- |
| `SUPABASE_URL` | Supabase project URL | — |
| `SUPABASE_ANON_KEY` | Read-only resolver key (`personal_titles` SELECT) | — |
| `SUPABASE_SERVICE_ROLE_KEY` | Ingest scripts only (`scripts/ingest-fribb.mjs`) | — |
| `ID_RESOLVE_ENABLED` | Query Supabase on stream requests | `false` |
| `ID_RESOLVE_SHADOW` | Log `[ID-RESOLVE][SHADOW]` plans without changing queries | `false` |
| `ID_RESOLVE_QUERY` | Phase 2: additive `mal:` / `kitsu:` fan-out (never replaces `tt`) | `false` |
| `ID_RESOLVE_EPISODE` | Phase 3: apply AniBridge episode remap to extras | `false` |
| `ID_RESOLVE_ALIAS` | Phase 4: conservative synonym text search on anime-capable addons | `false` |
| `ID_RESOLVE_TIMEOUT_MS` | Supabase lookup timeout | `400` |
| `ID_RESOLVE_MAX_EXTRA_FETCHES` | Cap total extra addon requests per stream | `4` |
| `ID_RESOLVE_MAX_ALIAS_SEARCHES` | Cap alias text searches per stream | `1` |
| `ID_RESOLVE_ANIME_ADDON_PATTERNS` | Comma-separated host substrings for mal/kitsu fan-out | `torrentio,comet,mediafusion,…` |
| `ID_RESOLVE_CACHE_TTL_MS` | In-memory resolve cache TTL | `300000` (5 min) |

**Rollout:** enable `ID_RESOLVE_ENABLED` + `ID_RESOLVE_SHADOW` first and inspect logs (shadow is fire-and-forget — does not delay fan-out). Then set `ID_RESOLVE_QUERY=true` for additive anime fan-out; resolve overlaps with meta so base `tt` + text queries still start on the same schedule. Run `scripts/ingest-anibridge.mjs`, verify shadow shows `mappedExtras` for multi-cour titles, then set `ID_RESOLVE_EPISODE=true`. Finally run Fribb + Manami ingest and set `ID_RESOLVE_ALIAS=true` for synonym text search (prefers origin-country titles, e.g. Japanese for anime). Episode coords still use Stremio S/E for the primary `tt` query.

Fribb ingest (offline): `node --env-file=.env.local scripts/ingest-fribb.mjs` (imdb + MAL-only pool)  
Manami aliases: `node scripts/generate-manami-batches.mjs` → `node scripts/ingest-manami-aliases.mjs`  
AniBridge episode ingest: `node --env-file=.env.local scripts/ingest-anibridge.mjs`

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

| Profile | maxResults | Size soft-cap | minSeeders (uncached) | timeoutMs | Quota set |
| --- | --- | --- | --- | --- | --- |
| `everything` | 30 | ∞ | 1 | **9500** | big (reserve 3/3/3) |
| `friends_heavy` | 30 | ∞ | 3 | **9500** | big |
| `friends_light` | 10 | **30GB movies / 10GB episodes** | 4 | 9000 | small (reserve 1/1/1) |
| `family` | 10 | **30GB movies / 10GB episodes** | 4 | 9000 | small |

If every stream exceeds the soft-cap, results are still returned (never leave the user with an empty list due to size alone).

Capable clients (User-Agent containing `nuvio`, `kodi`, or `libmpv`) are bumped to **9500ms** even on light profiles.

---

## Local development

```bash
node --env-file=.env.local dev-server.mjs   # http://localhost:3000
```

No hot reload — restart after editing `api/` or `lib/`. See `AGENTS.md` for cloud/egress notes (many public stream addons return 403 from datacenter IPs).

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
`[ESAY STREAM]`, `[ESAY SEARCH]`, `[ESAY QUOTA]`, `[ESAY SUBTITLES]`, `[ESAY SUB-PROXY]`, `[META HELPER]`, `[ESAY DIAGNOSTIC]`.

---

*Built for seamless, buffer-free playback on Stremio, Nuvio, and Kodi.*
