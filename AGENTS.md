# AGENTS.md

## Cursor Cloud specific instructions

### What this is
**Personal** (formerly Vecret, formerly Esay) is a **Vercel serverless proxy/aggregator for Stremio & Kodi addons**. Pure JavaScript (ES modules, `"type": "module"`), Node.js runtime, single runtime dependency (`node-fetch`). Each file under `api/*.js` is a serverless handler with the Vercel Node signature `export default async function handler(req, res)`. Shared logic lives in `lib/`. Stream ranking is the deterministic `rank-v2.0` pipeline (provider capabilities, release parser, exact Jaccard dedup, constrained VIP≤2 selection). Stream-time ID mapping and media-intelligence tables use optional **Supabase** (`personal_*`); when disabled, ranking falls back to static trust priors and sync/sightings no-op. There is **no build step**.

### ID mapping (Phase 0+1, opt-in)
Supabase project tables: `personal_titles`, `personal_episode_map`, `personal_akas`, `personal_show_rules`, `personal_ingest_meta`, `personal_resolve_cache`. Do **not** modify existing `media_mappings` / `media_workflows`.

```
SUPABASE_URL=https://gihkgnadwxpopvspeskb.supabase.co
SUPABASE_SERVICE_ROLE_KEY=…          # ingest + Vercel writes (sightings/audit/sync); never expose to clients
SUPABASE_ANON_KEY=…                    # optional read-only resolver key
ID_RESOLVE_ENABLED=false             # true to query Supabase on stream
ID_RESOLVE_SHADOW=true               # log [ID-RESOLVE][SHADOW] plans
ID_RESOLVE_QUERY=false               # Phase 2: additive mal:/kitsu: fan-out (never replaces tt)
ID_RESOLVE_EPISODE=false             # Phase 3: apply AniBridge episode remap to extras
ID_RESOLVE_ALIAS=false               # Phase 4: conservative synonym text search on anime addons
ID_RESOLVE_TIMEOUT_MS=400
ID_RESOLVE_MAX_EXTRA_FETCHES=7       # cap mal/kitsu addon requests per stream
ID_RESOLVE_MAX_ALIAS_SEARCHES=1      # 1=immediate only; 2=+1 deferred when thin after 5.5s
ID_RESOLVE_CACHE_TTL_MS=300000       # in-memory resolve cache (5 min)
```

Fribb ingest (offline): `node --env-file=.env.local scripts/ingest-fribb.mjs` — imdb + MAL-only (~28k rows)  
Manami alias ingest: `node scripts/generate-manami-batches.mjs` then `node scripts/ingest-manami-aliases.mjs`  
AniBridge episode ingest: `node --env-file=.env.local scripts/ingest-anibridge.mjs` (compact ranges, ~52k rows)  
Batch generator (no service role): `node scripts/generate-anibridge-batches.mjs` → load via `personal_ingest_episode_rows` RPC

Media-intelligence migration (audit queue, trust snapshots, sightings, subtitle sync): `supabase/migrations/20260726000000_media_intelligence.sql`. Apply only with explicit approval — it enables RLS on `personal_titles` (SELECT-only for anon/authenticated) and `personal_host_busy` (service-role only).

### Lint / test / build
No linter or build step. Contract tests use Node’s built-in runner:

```
node --test 'test/*.test.mjs'
```

Fixtures under `test/fixtures/` are sanitized upstream shapes. They do **not** exercise live Cloudflare-blocked addon egress.

### Media-intelligence worker
Shared Docker host service under `worker/media-intelligence/`: TorBox cache audits, Wilson trust snapshot publication, subtitle alass jobs (concurrency 1), TTL cleanup. Yields on Telegram `personal_host_busy`; TorBox playback never sets busy.

Worker-only env (never put on Vercel):

```
TORBOX_API_TOKEN=…                   # audits + subtitle sync CDN probe (not on Vercel)
TMDB_API_KEY=…                       # official-language sync slot
SUPABASE_URL=…
SUPABASE_SERVICE_ROLE_KEY=…
```

See `worker/media-intelligence/README.md` for deploy limits and busy-lease contract.

### Running the app locally
The intended dev command is `vercel dev`, but it requires an **interactive Vercel login + linked project**, which is not available in a headless cloud environment (`vercel dev` blocks on device auth).

Instead, use the committed local harness, which runs the real `api/*.js` handlers unchanged and reproduces the `vercel.json` rewrites:

```
node --env-file=.env.local dev-server.mjs   # serves on http://localhost:3000
```

- Stremio routes: `http://localhost:3000/<USER_KEY>/manifest.json`, `/<USER_KEY>/catalog/<type>/<id>.json`, `/<USER_KEY>/meta/<type>/<id>.json`, `/<USER_KEY>/stream/<type>/<id>.json`, `/<USER_KEY>/subtitles/...`
- Sync: `/api/sub-sync?...` (no-store; selection-triggered)
- Kodi routes: `/api/kodi?imdb_id=tt...&type=movie` and `/api/kodi-catalog?...`
- No hot reload: `dev-server.mjs` caches imported handler modules, so **restart the node process** after editing `api/` or `lib/` code.

### Configuration (`.env.local`, not committed)
All config comes from env vars (see `README.md` for full semantics). Minimal example that makes manifest/catalog/meta work end-to-end:

```
USER_CONFIGS={"testkey":{"profile":"everything","name":"Test"}}
ADDON_URLS=https://torrentio.strem.fun
SUBTITLE_URLS=https://opensubtitles-v3.strem.io
```

`USER_CONFIGS` is a JSON object keyed by the URL path segment (`<USER_KEY>`); `profile` / `name` configure ranking weights, caps, and display. Catalog/meta for IMDb ids use public Cinemeta; Kan-Box catalogs (live + IL VOD) appear in Discovery/Board. `TV_ADDON_URL`, `TMDB_API_KEY` are optional. Put Yastream in `ADDON_URLS` for `tt` streams and `kisskh:` / `idrama:` / `onetouchtv:` provider ids.

### Important gotcha: upstream addon egress
The product's job is to fan out to upstream Stremio addons. **Torrentio and many public stream addons sit behind Cloudflare and return HTTP 403 from datacenter/cloud IPs**, so `stream`/`api/kodi` endpoints will return empty `{ "streams": [] }` / `{ "results": [] }` here even though the handlers run correctly — this is an egress limitation, not a bug. **Cinemeta** (`https://v3-cinemeta.strem.io`) is used for IMDb meta and is a reliable check for meta end-to-end. Local fixture tests cover ranking/dedup/selector/sync without needing live addon egress.
