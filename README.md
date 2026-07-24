# UserManager-Stremio (Vecret / Esay Proxy)

Vecret is a serverless proxy and aggregator for **Stremio and Kodi** addons, built for **Vercel Serverless Functions**. It fans out to multiple upstream addons in parallel, then filters, pre-sorts, deduplicates, and quota-slices streams and subtitles into a fast, profile-aware response.

---

## Key Features

### Smart two-phase stream timeout
* Fans out to all stream addons in parallel.
* Waits an initial **5.5s** burst (`INITIAL_WAIT_MS`), then uses the remaining profile budget (up to **9.5s** on `everything` / `friends_heavy`, and for capable clients like Nuvio/Kodi).
* **Multi-language text-search backup** (English / Hebrew / Russian / original title) runs **sequentially and only if** the primary IMDb/TMDB id fan-out returned fewer than 4 raw hits — preserving Vercel time.
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

### Dynamic Hebrew stream tags
* `זמין לצפייה` — Cached / Debrid-ready
* `דורש המתנה ואולי כניסה חוזרת` — Uncached torrent (needs download)
* `מרשת דפדפן` — Direct HTTP / VIP web
* `(לנגן תומך)` — appended when `notWebReady` (HEVC / advanced codecs)

### Uncached detection (MediaFusion & friends)
Streams are forced into the Uncached bucket when titles/ids contain signals such as:
`⏳` `⌛` `uncached` / `un-cached` / `not cached`, `⬇️` / `download` / `downloading`, `download to debrid`, `to debrid`, `instant=false`, `cached:no`, `[DL]`, etc. (spaces / hyphens / underscores optional).

### Fake HDR penalty (pre-2015)
True HDR/DV/HLG tags (`HDR`, `HDR10`, `HDR10+`, `HLG`, `Dolby Vision`, `DoVi`, `DV` with safe boundaries) still boost visual score. If the title’s release year is **before 2015** and it still carries those tags, a **significant scoring penalty** is applied so fake upscales do not outrank honest SDR remuxes/rips.

### Smart subtitles
* Dynamic race: at **6s**, cut early if ≥3 Hebrew subs; otherwise extend to **9s**.
* Language allowlist (he / en / ru); if none match, **any available format** is returned as fallback.
* **Duration matching (±5%):** compares subtitle duration (provider fields, title patterns, or a light SRT peek) to TMDB/Cinemeta runtime. Matches get a large bonus and rise to the top.
* Display titles include provider, score (`★N`), and sync/duration hints.
* All subtitle URLs are routed through `/api/sub-proxy`, which re-emits bodies as **UTF-8** (strips Windows-1255 / ISO-8859-8 legacy encodings).

### Israeli catalogs (Kan-Box)
Board/Discovery include Kan-Box catalogs (Dragon Ball hidden): **ערוצים חיים** first, then `חיפוש משולב*`, then the remaining IL VOD/podcast rows (Channel 12, Kan 11 Digital, etc.).

### Unified search
* `חיפוש משולב` (movie / series) — ~3s soft deadline; no VIP hosts (Kan-Box / AnimeIL).
* `חיפוש משולב - complete` — ~3s; VIP + anime/tv/channel types (excludes movie/series catalog types).
* `חיפוש משולב - full` — ~8s wall budget (discovery + fan-out), all types + VIP; drops metas already returned by the fast three for the same query.

### Yastream Asian providers
When Yastream is in `ADDON_URLS`, Esay accepts `kisskh:` / `idrama:` / `onetouchtv:` ids (meta + stream proxied to Yastream). Search hits that expose an IMDb id in artwork are rewritten to `tt…` so Cinemeta + the normal stream fan-out apply.

---

## Environment Variables (Vercel)

| Variable | Role | Example |
| --- | --- | --- |
| `ADDON_URLS` | Stream addon bases, separated by `\|\|\|` | `https://torrentio.strem.fun/sort=...\|\|\|https://...` |
| `SUBTITLE_URLS` | Subtitle addon bases, separated by `\|\|\|` | `https://opensubtitles-v3.strem.io\|\|\|https://sub.scary.network` |
| `TV_ADDON_URL` | Israeli live / Kan-Box addon base | `https://kan-box-addon.vercel.app` |
| `TMDB_API_KEY` | TMDB v3 API key (titles, year, runtime) | `KEY...` |
| `USER_CONFIGS` | JSON map of user keys → profile / name | *(see below)* |

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
`[ESAY STREAM]`, `[ESAY QUOTA]`, `[ESAY SUBTITLES]`, `[ESAY SUB-PROXY]`, `[META HELPER]`, `[ESAY DIAGNOSTIC]`.

---

*Built for seamless, buffer-free playback on Stremio, Nuvio, and Kodi.*
