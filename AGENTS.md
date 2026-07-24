# AGENTS.md

## Cursor Cloud specific instructions

### What this is
Vecret ("Esay") is a **Vercel serverless proxy/aggregator for Stremio & Kodi addons**. Pure JavaScript (ES modules, `"type": "module"`), Node.js runtime, single runtime dependency (`node-fetch`). Each file under `api/*.js` is a serverless handler with the Vercel Node signature `export default async function handler(req, res)`. Shared logic lives in `lib/`. There is **no database** (in-memory caches only) and **no build step**.

### Lint / test / build
There are **none**. `package.json` has no `scripts`, and the repo contains no test files, linter config, or build config. Do not invent these unless asked.

### Running the app locally
The intended dev command is `vercel dev`, but it requires an **interactive Vercel login + linked project**, which is not available in a headless cloud environment (`vercel dev` blocks on device auth).

Instead, use the committed local harness, which runs the real `api/*.js` handlers unchanged and reproduces the `vercel.json` rewrites:

```
node --env-file=.env.local dev-server.mjs   # serves on http://localhost:3000
```

- Stremio routes: `http://localhost:3000/<USER_KEY>/manifest.json`, `/<USER_KEY>/catalog/<type>/<id>.json`, `/<USER_KEY>/meta/<type>/<id>.json`, `/<USER_KEY>/stream/<type>/<id>.json`, `/<USER_KEY>/subtitles/...`
- Kodi routes: `/api/kodi?imdb_id=tt...&type=movie` and `/api/kodi-catalog?...`
- No hot reload: `dev-server.mjs` caches imported handler modules, so **restart the node process** after editing `api/` or `lib/` code.

### Configuration (`.env.local`, not committed)
All config comes from env vars (see `README.md` for full semantics). Minimal example that makes manifest/catalog/meta work end-to-end:

```
USER_CONFIGS={"testkey":{"profile":"everything","name":"Test"}}
ADDON_URLS=https://torrentio.strem.fun
SUBTITLE_URLS=https://opensubtitles-v3.strem.io
```

`USER_CONFIGS` is a JSON object keyed by the URL path segment (`<USER_KEY>`); `profile` / `name` configure ranking quotas and display. Catalog/meta for IMDb ids use public Cinemeta; Kan-Box Board rows are Channel 12 + Kan 11 Digital only. `TV_ADDON_URL`, `TMDB_API_KEY` are optional. Put Yastream in `ADDON_URLS` for `tt` streams and `kisskh:` / `idrama:` / `onetouchtv:` provider ids.

### Important gotcha: upstream addon egress
The product's job is to fan out to upstream Stremio addons. **Torrentio and many public stream addons sit behind Cloudflare and return HTTP 403 from datacenter/cloud IPs**, so `stream`/`api/kodi` endpoints will return empty `{ "streams": [] }` / `{ "results": [] }` here even though the handlers run correctly — this is an egress limitation, not a bug. **Cinemeta** (`https://v3-cinemeta.strem.io`) is used for IMDb meta and is a reliable check for meta end-to-end.
