# Plan and instructions for agent

Complete implementation brief from the 2026-08 architectural audit of the Kodi/Stremio ecosystem.
Covers **all six repositories** and **all phases P0–P5**. Findings tracked under epic **#62**.

Every `file:line` reference was verified against `main` at time of writing. Every claim marked **verified** was reproduced by executing the real module or querying the live database — not inferred by reading.

---

# 0. READ THIS FIRST — the audit contained errors

The audit that produced this plan made four mistakes, all the same kind: **asserting absence from an incomplete check**. They are corrected throughout this document, but assume more exist and verify before trusting anything here.

| Original claim | Reality |
|---|---|
| "`generate_epg.js` is fabricated, it does not exist" | It exists at `Stremio-KanBoxRepos/scripts/generate_epg.js` and does exactly what the README described. It is **orphaned** — its Actions step was removed, `output/epg.json` is not committed, nothing reads it. See §11.1. |
| "The `integrity` metric is never emitted — go build it" | PR **#44** already built it. It is **starved** by the sightings write failure, not missing. WP-2 alone should restore it. |
| "`It` / `Us` / `Up` streams are hard-dropped" | They are not. `getTitleConflictLevel` filters expected titles to `length >= 3` and returns `null` early. Only numeric titles of 3+ chars are dropped. |
| "Hebrew *and* Russian fallback dropped 100% of the time" | The plan emits **4** queries per provider, not 6 (`original` dedups into `en`; `mapped_id` is anime-only). 2 waves, not 3 — Hebrew survives in the common case, only Russian drops. #59 downgraded HIGH → MEDIUM. |

**Confirmed accurate**, re-verified by executing the real modules: the MinHash 7/128 seed collision, the subtitle language misclassification, the Hebrew 2-char overlap false positives, the `sub-proxy` SSRF, the credibility contamination maths, and the reservation over-allocation.

---

# 1. Ecosystem map

| Repo | Role | Stack |
|---|---|---|
| **UserManager** | The aggregator. Central hub; fans out to upstream addons, then runs the deterministic `rank-v2.0` pipeline. Serves both Stremio and the Kodi client. | Node ESM / Vercel |
| **Stremio-KanBoxAddon** | Israeli live TV, VOD, podcasts. Also exposes `/bingecat`, a Live-TV-only manifest. | Node / Vercel |
| **Stremio-KanBoxRepos** | The scraper feeding KanBoxAddon (Supabase primary, GitHub ZIPs fallback). | Node / GitHub Actions |
| **Kodi-repo** | `plugin.video.personal` + build packaging. Its entire backend is UserManager's `api/kodi.js` / `api/kodi-catalog.js`. | Python / PowerShell |
| **stremio-telegram-debrid** | Streams media from private Telegram channels. Heavily extended from an upstream project. | Python / Docker |
| **Einthusan-Stremio-Addon** | South Asian cinema scraping/extraction. | Node CommonJS |

Data flow for a stream request:

```
Stremio / Kodi
   -> UserManager  api/stream.js | api/kodi.js
        -> retrieve (RetrievalScheduler, bounded, latency-capped)
        -> applyEligibility        lib/streamFeatures.js   feature vector in [0,1]
        -> pruneEligibleCandidates cap at MAX_RANKER_CANDIDATES = 500
        -> scoreCandidates         lib/streamRanker.js     weighted sum per profile
        -> deduplicateCandidates   lib/streamDedup.js      exact Jaccard; MinHash/LSH proposes only
        -> selectStreams           lib/streamSelector.js   VIP prefix, reservations, marginal gain
   upstreams: Torrentio, Comet, MediaFusion, Debridio, Knaben, Yastream,
              Kan-Box (VIP), AnimeIL (VIP), Personal Telegram (VIP)
```

Two invariants to respect:

- **Trust is read-only on the request path.** `lib/providerTrust.js` consumes immutable snapshots; aggregation happens in the worker. Never write trust from a handler.
- **Determinism is scoped to ordering, not membership.** `sortRawDeterministically` guarantees arrival order cannot change the *order* of collected rows. Which upstreams answered before `deadlineAt` still varies, so two identical requests can legitimately return different sets. The current comment overstates this (see #64).

---

# 2. Environment and access

- **Vercel** team `MALCHIOR7`. Projects: `user-manager`, `kan-box-addon`, `einthusan-stremio-addon`. **Hobby plan → 10 s hard function limit.** Node 24.x.
- **Supabase** `gihkgnadwxpopvspeskb` ("Streamio-telegram") holds all `personal_*` tables. `tkvcgydyflgvqremjftq` ("kanBox") holds the Israeli content — **not audited**.
- **`main` auto-deploys to production** on `user-manager`.

Live table state at audit time — the numbers that drive P1:

| table | rows | meaning |
|---|---|---|
| `personal_stream_sightings` | **0** | 46 write attempts in 24 h, zero landed |
| `personal_provider_observations` | 15 | **100% `cache_claim`, zero `integrity`** |
| `personal_ranking_audit_queue` | 15 | all `status='done'` — worker is healthy |
| `personal_provider_trust_snapshots` | 4 | only `comet` + `torrentio`, `cache_claim` only |
| `personal_subtitle_sync_jobs` | 2 | **both `failed`** |
| `personal_titles` / `episode_map` / `akas` | 28 651 / 49 921 / 24 412 | offline ingest healthy |

---

# 3. Hard constraints

1. **10 s function ceiling.** Every timeout must fit inside it including serialization.
2. **Never commit to `main`.** Branch + PR per phase.
3. **The invocation is frozen the moment the handler returns.** Un-awaited promises have their sockets torn down. Root cause of all of P1.
4. **CLAUDE.md rule 1 — impact analysis** before every change.
5. **CLAUDE.md rule 2 — system-wide DRY.** Extend existing helpers rather than adding parallel ones.
6. **CLAUDE.md rule 3 — ask before changing existing logic.** P0–P2 are defect repairs, so proceed. P3–P5 require sign-off.

## Setup

```bash
npm install
node --test test/*.test.mjs      # 104 tests; must stay green
node dev-server.mjs              # local harness (vercel dev does NOT work headless)
```

Add a regression test for every fix.

---

# 4. Execution model

| Phase | Branch | Gate |
|---|---|---|
| P0 security | `audit/p0-security` | none — ship |
| P1 learning loop | `audit/p1-learning-loop` | none — ship |
| P2 correctness | `audit/p2-correctness` | WP-11 only needs sign-off |
| P3 latency/search | `audit/p3-latency` | **STOP — owner sign-off** |
| P4 scoring model | `audit/p4-scoring` | **STOP — owner sign-off** |
| P5 provider expansion | `audit/p5-registry` | **STOP — owner sign-off** |

**Default instruction: implement P0 → P1 → P2, then stop and report.** Do not begin P3 without explicit approval.

Highest value per line changed, across the whole plan:

1. **WP-8** — `bytes=0-65535` → `bytes=-65536`. One parameter; restores the entire subtitle sync signal.
2. **WP-5** — `if (expectedToks.size === 0) return null;`. One line; stops whole titles being unplayable.
3. **WP-2** — wrap two calls in `waitUntil()`. Restores all adaptive ranking.
4. **WP-11** — add `label` to the subtitle object. One field; makes scoring visible.
5. **WP-7** — four lines of seed derivation.

---

# 5. P0 — Security · `audit/p0-security`

## WP-1 · `api/sub-proxy.js` is an unauthenticated open proxy (#53)

The only validation on the caller-supplied `url` param is `/^https?:\/\//i` (line 31). Anyone can call `/api/sub-proxy?url=http://127.0.0.1:9000/` or `?url=http://169.254.169.254/` and receive the body (SSRF), or use it as an open relay on your bandwidth and IP.

Compounding defects in the same file:

- **line 9** — `new https.Agent({ rejectUnauthorized: false })` applied to **every** proxied request (line 39). In `api/subtitles.js:276` the same bypass is correctly scoped to one host; the proxy generalised it by accident.
- **line 49** — `await response.arrayBuffer()` buffers an unbounded remote file.
- **line 54** — `Cache-Control: public` caches attacker-controlled bytes on your origin.

**Approach chosen by the owner: HMAC-sign the URL.** This preserves every subtitle currently served, because `buildProxyUrl` (`api/subtitles.js:479`) already wraps *every* returned subtitle regardless of host. An origin allowlist would break providers whose `.srt` lives on a different CDN than their addon.

### New file `lib/urlSigning.js`

```js
/**
 * Detached HMAC signatures for self-issued proxy URLs.
 *
 * The subtitle proxy must fetch arbitrary provider CDNs, so an origin allowlist
 * is not workable. Instead we only honour URLs this deployment itself minted.
 */
import crypto from 'node:crypto';

/**
 * Stable server-only signing key.
 * Prefers an explicit secret; otherwise derives one from the service-role key so
 * a deployment works without new configuration. The service key itself is never
 * exposed -- only an irreversible HMAC of a fixed label.
 */
function signingKey() {
  const explicit = process.env.SUB_PROXY_SECRET;
  if (explicit) return explicit;
  const derived = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (derived) {
    return crypto.createHmac('sha256', derived).update('sub-proxy-v1').digest('hex');
  }
  return null;
}

export function canSign() {
  return signingKey() !== null;
}

/** URL-safe base64 of HMAC-SHA256(key, value), truncated to 128 bits. */
export function signValue(value) {
  const key = signingKey();
  if (!key) return null;
  return crypto.createHmac('sha256', key).update(String(value)).digest('base64url').slice(0, 22);
}

/** Constant-time comparison so a signature cannot be recovered by timing. */
export function verifyValue(value, signature) {
  const expected = signValue(value);
  if (!expected || !signature) return false;
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
```

### `api/subtitles.js` — sign when minting (replaces `buildProxyUrl`, ~line 190)

```js
import { signValue } from '../lib/urlSigning.js';

function buildProxyUrl(req, originalUrl) {
  try {
    const base = publicBaseUrl(req);
    if (!base) return originalUrl;
    const sig = signValue(originalUrl);
    // Without a signing key the proxy refuses anyway, so hand the client the
    // upstream URL directly rather than a link that will 403.
    if (!sig) return originalUrl;
    return `${base}/api/sub-proxy?url=${encodeURIComponent(originalUrl)}&sig=${sig}`;
  } catch {
    return originalUrl;
  }
}
```

### `api/sub-proxy.js` — full replacement

```js
// api/sub-proxy.js
// Fetches a remote subtitle file and re-emits it as clean UTF-8 (SRT/VTT).
// Only URLs signed by this deployment are honoured -- see lib/urlSigning.js.
import fetch from 'node-fetch';
import http from 'http';
import https from 'https';
import { decodeSubtitleBuffer } from '../lib/subtitleUtils.js';
import { verifyValue, canSign } from '../lib/urlSigning.js';

/** Subtitle files are text; anything larger is not one. */
const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;

const httpAgent = new http.Agent();
const httpsAgent = new https.Agent();
/**
 * One provider serves a broken certificate chain. Scope the bypass to that host
 * only -- never apply it to arbitrary proxied origins.
 */
const insecureHttpsAgent = new https.Agent({ rejectUnauthorized: false });
const TLS_EXEMPT_HOSTS = new Set(['sub.scary.network']);

function agentFor(parsedUrl) {
  if (parsedUrl.protocol === 'http:') return httpAgent;
  return TLS_EXEMPT_HOSTS.has(parsedUrl.hostname) ? insecureHttpsAgent : httpsAgent;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function fail(res, status, error) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.end(JSON.stringify({ error }));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const urlObj = new URL(req.url, 'http://localhost');
    const target = urlObj.searchParams.get('url');
    const sig = urlObj.searchParams.get('sig');

    if (!target || !/^https?:\/\//i.test(target)) {
      return fail(res, 400, 'Missing or invalid url param');
    }
    if (!canSign()) {
      console.error('[PERSONAL SUB-PROXY] no signing key configured -- refusing to proxy');
      return fail(res, 503, 'Proxy not configured');
    }
    if (!verifyValue(target, sig)) {
      console.warn(`[PERSONAL SUB-PROXY] rejected unsigned target ${target.slice(0, 80)}`);
      return fail(res, 403, 'Unsigned or tampered url');
    }

    const parsed = new URL(target);
    const response = await fetchWithTimeout(target, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/plain,*/*' },
      agent: agentFor(parsed),
      // Redirects would escape the signature, so resolve nothing implicitly.
      redirect: 'manual',
      size: MAX_SUBTITLE_BYTES,
    }, 8000);

    if (response.status >= 300 && response.status < 400) {
      return fail(res, 502, 'Upstream redirect not followed');
    }
    if (!response.ok) {
      console.warn(`[PERSONAL SUB-PROXY] upstream HTTP ${response.status} for ${target.slice(0, 80)}`);
      return fail(res, 502, 'Upstream subtitle fetch failed');
    }

    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_SUBTITLE_BYTES) return fail(res, 413, 'Subtitle too large');

    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > MAX_SUBTITLE_BYTES) return fail(res, 413, 'Subtitle too large');

    const text = decodeSubtitleBuffer(buf);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    // Signed, per-viewer content -- never store in a shared cache.
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.end(text);
  } catch (e) {
    console.error(`[PERSONAL SUB-PROXY] 💥 ${e.message}`);
    return fail(res, 500, 'Subtitle proxy error');
  }
}
```

`node-fetch` honours `size` natively and rejects during streaming, so the cap applies before the body is fully buffered.

**Verify:** unsigned localhost target → `403` · bogus `sig` → `403` · a real subtitle still renders in Stremio · oversized file → `413`.

`SUB_PROXY_SECRET` is optional. Note in the PR that rotating `SUPABASE_SERVICE_ROLE_KEY` invalidates already-issued signed URLs.

**Deferred (not now):** DNS-resolved private-range blocking (`127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fc00::/7`) would also protect against a *compromised* legitimate provider redirecting inward. `redirect: 'manual'` removes the main pivot; leave the rest for a follow-up.

---

# 6. P1 — Restore the learning loop · `audit/p1-learning-loop`

## WP-2 · Telemetry writes never land (#54)

Production evidence, 24 h, 3 users:

```
[SUPABASE WRITE] personal_stream_sightings    failed: AbortError   count=46
[SUPABASE WRITE] personal_ranking_audit_queue failed: AbortError   count=8
routes=/api/stream, /api/kodi
```

`personal_stream_sightings` has **0 rows**.

Cause: `api/stream.js:305` and `api/kodi.js:128` call `recordRankingAudits(...).catch(() => {})` — **not awaited** — with a 150 ms budget (`lib/rankingTelemetry.js:23`, `lib/streamSighting.js:22`), and Vercel freezes the invocation on return.

### ⚠️ Do NOT rebuild the integrity feed

PR **#44** (merged 2026-07-31, *"Feed the integrity trust metric from the existing subtitle-sync probe"*) already built it. It is live — `personal_subtitle_sync_jobs` rows carry `provider_id` / `provider_family` / `stratum`. The metric is **starved, not missing**:

```
sightings not awaited -> 0 rows -> sync cannot identify the playing file
-> only 2 sync jobs ever enqueued, BOTH failed -> ffprobe never runs
-> no integrity observation -> integrityTrust() returns the static prior forever
-> every provider stays `unproven` -> caps.unprovenProvider throttles all of them
```

**This work package is the whole fix.**

```bash
npm i @vercel/functions
```

`api/stream.js:305` and `api/kodi.js:128`:

```js
import { waitUntil } from '@vercel/functions';

// Telemetry must outlive the response: Vercel freezes the invocation as soon as
// the handler returns, which was aborting every fire-and-forget write.
waitUntil(recordRankingAudits(result.selected, { contentId: idNoExt }));
```

`lib/rankingTelemetry.js:23` and `lib/streamSighting.js:22`:

```js
// No longer racing the response, so allow a realistic cross-region round trip.
const WRITE_BUDGET_MS = 1000;
```

**Pass/fail gate** — after deploying and playing one stream:

```sql
select count(*) from personal_stream_sightings;              -- must be > 0 (is 0 today)
select distinct metric from personal_provider_observations;  -- must eventually include 'integrity'
```

## WP-3 · Do not let a broken loop silently shrink the catalogue

While no `integrity` snapshot exists, `features.trustProven` is `false` fleet-wide, so `caps.unprovenProvider` — **1** on the default `friends_light` profile — caps every provider at one row in a ten-row list. An accident of the telemetry bug, not a design decision.

In `lib/streamSelector.js`, before the caps are used:

```js
// A missing/empty trust snapshot means nothing is *proven* yet -- that is an
// absence of evidence, not evidence of failure. Applying the unproven cap here
// silently throttles every provider (see #54).
const trustDegraded = !snapshotHasMetric(trustSnapshot, 'integrity');
const caps = { ...profile.caps };
if (trustDegraded) {
  caps.unprovenProvider = Infinity;
  console.warn('[PERSONAL TRUST] ⚠️ no integrity snapshot -- ranking on static priors, unproven cap disabled');
}
```

`snapshotHasMetric` **does not exist yet** — add it to `lib/providerTrust.js`, which owns snapshot shape (DRY).

## WP-4 · Investigate the two failed sync jobs

Both rows in `personal_subtitle_sync_jobs` are `status='failed'`, `comet` / `debrid|movie`, 2026-07-31 22:29–22:30. Two-for-two suggests something systematic.

Check the worker log for that window: ffprobe failure, TorBox CDN locator not resolving, or job timeout. **Report findings; do not fix blind.** Once sightings flow this failure mode scales with volume.

## WP-5 · Add a staleness alarm

A stalled learning loop is currently completely silent. Alarm on `personal_provider_trust_snapshots.computed_at` falling behind, and on `snapshot_version === 'static-priors'` persisting.

---

# 7. P2 — Correctness defects · `audit/p2-correctness`

## WP-6 · Numeric titles are hard-dropped as "wrong show" (#55)

**Verified by executing the real module:**

```
titleTokens("1917") = []   titleTokens("300") = []   titleTokens("1984") = []

"1917 Sam Mendes War Drama"         vs "1917" -> hard  -> X=0.00 -> INELIGIBLE
"300 Rise of an Empire Zack Snyder" vs "300"  -> hard  -> X=0.00 -> INELIGIBLE
```

`titleTokens` drops pure numbers of ≤4 digits, so `expectedToks` is empty, so any release containing real words has zero overlap → `'hard'` → `MATCH_CONFIDENCE.CONFLICT = 0.00` → below `MATCH_ELIGIBILITY_THRESHOLD` → every stream for that title is dropped.

In `getTitleConflictLevel`, before the overlap test:

```js
  const expectedToks = new Set(titles.flatMap(titleTokens));
  // A title made entirely of stopword-like tokens ("1917", "300", "1984") yields
  // no tokens at all. With nothing to compare against we have no evidence of a
  // mismatch -- never hard-drop on absence.
  if (expectedToks.size === 0) return null;
  const overlap = releaseToks.filter(t => expectedToks.has(t));
  if (overlap.length === 0) return 'hard';
  return 'soft';
```

### Do NOT use `It` / `Us` / `Up` as test cases here

**Verified:** they are not dropped. `getTitleConflictLevel` filters expected titles to `length >= 3` on its first line, so a 2-char title leaves `titles` empty and returns `null` early. They instead sit at `X = 0.70`, exactly on `MATCH_ELIGIBILITY_THRESHOLD = 0.70` — a zero-margin fragility handled in P4 (§9, part F).

**Verify:** new `test/titleMatch.test.mjs` — `1917 / 300 / 1984 / 2012 / 1408` × realistic release names never `'hard'`. Regression: `Utena` on a `Re:Zero` request must still be `'hard'`.

## WP-7 · Hebrew title overlap fires on 2-character chunks (#55)

**Verified by executing the real module** — genuinely different shows score `{level:"strong"}`:

```
"שובר שורות" vs "שובר קווים" -> {"level":"strong","reason":"hebrew_overlap"}   FALSE POSITIVE
"בית הקלפים" vs "בית ספר"    -> {"level":"strong","reason":"hebrew_overlap"}   FALSE POSITIVE
"פאודה"      vs "פאודה"      -> {"level":"strong","reason":"fingerprint"}      correct
```

A false `strong` gives a **wrong show** `X = 0.85` and `L = 1.00`. This lands on the Israeli catalogue, the core of the product.

```js
/**
 * Hebrew function words carry no title identity -- matching on them makes any
 * two Hebrew titles look related.
 */
const HE_STOP = new Set([
  'של', 'את', 'על', 'לא', 'אל', 'הוא', 'היא', 'זה', 'זאת', 'אני', 'אנחנו',
  'עם', 'כל', 'גם', 'רק', 'אם', 'כי', 'מה', 'מי', 'יש', 'אין', 'בית',
]);

function hebrewChunks(text) {
  return (String(text || '').match(/[֐-׿]{2,}/g) || [])
    .map(chunk => chunk.replace(NIQQUD_RE, ''))
    .filter(chunk => chunk.length >= 2 && !HE_STOP.has(chunk));
}
```

and tighten the bare-chunk fallback inside `hebrewTitleOverlap`. **Leave the joined-string and 4-char-prefix checks above it untouched** — they carry the true-positive load:

```js
    // Require a genuinely distinctive shared chunk, or two independent ones.
    let sharedChunks = 0;
    for (const rc of relChunks) {
      for (const ec of expChunks) {
        if (rc.length < 4 || ec.length < 4) continue;
        if (rc.includes(ec) || ec.includes(rc)) {
          if (Math.min(rc.length, ec.length) >= 5) return true;
          sharedChunks++;
        }
      }
    }
    if (sharedChunks >= 2) return true;
```

## WP-8 · MinHash uses 7 distinct seeds instead of 128 (#56)

`lib/streamDedup.js:45` — `digest.readUInt32BE((i * 4) % (digest.length - 4))`. A sha256 digest is 32 bytes, so `digest.length - 4 === 28` and `(i*4) % 28` cycles only **7** offsets.

**Verified with the real `PARSER_VERSION = "release-v2"`: 7 distinct seeds out of 128, period 7** (`seeds[i] === seeds[i+7]`). The 32 LSH bands collapse to 7 distinct patterns, violating the independent-band assumption. Recall at the `JACCARD.GROUP = 0.60` merge threshold falls **98.8% → 62.2%**, so real duplicates survive as separate rows once a list exceeds `LSH_THRESHOLD = 250`.

```js
/** Deterministic per-position seeds derived from the pinned parser version. */
const MINHASH_SEEDS = (() => {
  const seeds = new Array(MINHASH_VALUES);
  for (let i = 0; i < MINHASH_VALUES; i++) {
    // One digest per position: a single 32-byte digest cannot supply 128
    // independent 32-bit seeds (the old `(i*4) % 28` wrapped after 7).
    seeds[i] = crypto.createHash('sha256')
      .update(`minhash|${PARSER_VERSION}|${i}`)
      .digest()
      .readUInt32BE(0);
  }
  return seeds;
})();
```

**Impact analysis:** changes dedup output above 250 candidates. Bump `PARSER_VERSION` in `lib/versions.js` so telemetry rows stamped `parser_version` are not compared across the boundary.

**Verify:** `assert.equal(new Set(MINHASH_SEEDS).size, 128)` (is 7 today).

### Secondary — allocation churn in the same file

`deduplicateCandidates` (line 315) scans **all** anchors per candidate and rebuilds a `"${i}|${j}"` string per check even when LSH already excluded the pair — ~200 000 string allocations at n=500, inside the 1500 ms `RANKING_RESERVE_MS`. Have `proposePairsViaLsh` return `Map<index, Set<index>>` and iterate real partners only. Pure performance.

## WP-9 · The subtitle duration probe reads the wrong end of the file (#57)

`api/subtitles.js:380` requests `bytes=0-65535` — the **first** 64 KB — but `parseSubtitleDurationMinutes` returns the **maximum timestamp found**. For any SRT larger than 64 KB that is ~46 minutes in, not the runtime.

```
runtime  SRT size  reported   Gaussian sync term
  45min     62KB   45.0 min   1.00      (works)
  90min    124KB   46.6 min   5.8e-21
 120min    165KB   46.6 min   2.9e-33
 180min    247KB   46.6 min   1.8e-48
```

The `0.15`-weighted `durationCompat` term is a constant penalty carrying no information for **every feature-length title**, and `sync✓` can never display. Only short-form content (≤~45 min) works — which is why this went unnoticed on an episodic Israeli catalogue.

```js
        const resp = await fetchWithTimeout(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'Accept': 'text/plain,*/*',
            // Duration is the LAST cue, so read the tail. A leading range only
            // ever saw ~46 minutes of a feature and made every long subtitle
            // look wildly out of sync.
            'Range': 'bytes=-65536',
          },
          agent: dynamicAgent,
        }, 2500);
        if (!resp.ok) return { durationMin: null, scriptLang: null };
        const text = (await resp.text()).slice(-200_000);
```

Servers ignoring suffix ranges answer `200` with the whole body — still correct, hence the `slice`. Note that `detectSubtitleScriptLang` samples `slice(0, 12000)`, now the file's tail; equally valid for script detection.

## WP-10 · Subtitle language misclassification (#57)

**Verified by executing the real module:**

```
belarusian -> rus     bengali    -> eng
prussian   -> rus     slovengish -> eng
```

Bengali subtitles are served labelled **English**. This partly defeats the module's own principle ("Honest empty > fake Hebrew").

Replace `classifySubtitleLang` (`api/subtitles.js:153`):

```js
const LANG_MAP = new Map([
  ...['he', 'heb', 'hebrew', 'iw', 'he-il', 'עברית'].map(k => [k, 'heb']),
  ...['ru', 'rus', 'russian', 'ru-ru'].map(k => [k, 'rus']),
  ...['en', 'eng', 'english', 'en-us', 'en-gb'].map(k => [k, 'eng']),
]);

/**
 * Map provider lang -> heb|eng|rus. Returns null for unknown/other.
 * Exact codes plus word-boundary names only: substring matching classified
 * "belarusian" as Russian and "bengali" as English.
 */
function classifySubtitleLang(rawLang) {
  if (!rawLang) return null;
  const l = String(rawLang).toLowerCase().trim();

  const direct = LANG_MAP.get(l);
  if (direct) return direct;

  // Provider-specific Hebrew markers (Submaker et al.) stay substring-based.
  if (/\bheb(rew)?\b/.test(l) || l.includes('עברית')
      || l.includes('make hebrew') || l.includes('submaker')) return 'heb';
  if (/\brus(sian)?\b/.test(l)) return 'rus';
  if (/\beng(lish)?\b/.test(l)) return 'eng';
  return null;
}
```

## WP-11 · Mislabel verification covers a nondeterministic subset (#57)

`api/subtitles.js:407` — `needPeek` follows provider **arrival order**, so which 12 subtitles get body-verified changes between runs.

```js
const needPeek = withMeta
  .filter(x => (videoRuntimeMin && !x.subDur) || x.sub._classifiedLang === 'heb')
  // Verify Hebrew first and order deterministically: which subtitles got
  // body-checked previously depended on which provider answered first.
  .sort((a, b) => {
    const ha = a.sub._classifiedLang === 'heb' ? 0 : 1;
    const hb = b.sub._classifiedLang === 'heb' ? 0 : 1;
    if (ha !== hb) return ha - hb;
    const sa = Number(a.sub.score || a.sub.SubRating || a.sub.rating || 0);
    const sb = Number(b.sub.score || b.sub.SubRating || b.sub.rating || 0);
    if (sa !== sb) return sb - sa;
    return String(a.sub.url) < String(b.sub.url) ? -1 : 1;
  })
  .slice(0, 12);
```

## WP-12 · Subtitle scores are invisible in Stremio (#58) — CONFIRM WITH OWNER FIRST

User-visible, so ask before shipping — but it is one line with **no trade-off**.

**Verified against Stremio's own source.** `stremio-core/src/types/resource/subtitles.rs`:

```rust
pub struct Subtitles {
    pub id: String,
    pub lang: String,
    pub url: Url,
    pub label: Option<String>,      // <-- the display field
    pub fonts: Vec<Url>,
}
```

`stremio-web/.../SubtitleVariant.tsx`:

```tsx
const hasValidLabel = (label?: string) => label && label.length > 0 && !label.startsWith('http');
const variantLabel = hasValidLabel(track.label) ? track.label : languages.label(track.lang);
<div className={styles['variant-label']}>{variantLabel}</div>
<div className={styles['variant-origin']}>{t(track.origin)}</div>
```

There is **no `title` field** — it is dropped on deserialization. So `[provider] ★87 sync✓94%` built at `api/subtitles.js:474` is never displayed, and every subtitle collapses into one identical row per language.

```js
      cleanedSubs.push({
        id: `personal_${index}_${safeId}`,
        url: buildProxyUrl(req, String(sub.url)),
        lang,
        // Stremio renders `label` (SubtitleVariant.tsx) and ignores `title`.
        // Keep `lang` a clean ISO code so language grouping and the user's
        // preferred-subtitle-language auto-select keep working.
        label: finalTitle,
        title: finalTitle,   // retained for any non-Stremio consumer
        ...
      });
```

`hasValidLabel` rejects labels starting with `http` — never fall back to a URL.

**Do NOT decorate `lang`.** An earlier draft suggested that; it is wrong and would break auto-select.

**Ordering is already preserved.** `SubtitlesMenu.js` calls `sortByValues(tracks, ORIGIN_PRIORITIES)`, whose comparator does `values.indexOf(a)` with `a` a track object against an array of strings — always `-1`, always returns `0`, so JS's stable sort keeps insertion order. Would still hold if Stremio fixed it, since all our tracks share one `origin`. Caveat: the *language list* is sorted alphabetically then by user-language priority, so we control order only *within* Hebrew / English / Russian.

**Follow-up:** `lib/subtitleSync.js:141` abuses `lang` to force a separate row for sync tracks — it predates `label` and creates a bogus language entry. Once `label` is in use, set `lang: 'heb'` and move the descriptor into `label`.

---

# 8. P3 — Latency and search · `audit/p3-latency` · **SIGN-OFF REQUIRED**

## WP-13 · Metadata resolution blocks the entire immediate phase (#59) — the strongest item here

`lib/streamEngine.js:575` awaits `metaPromise` before building the immediate plan. Worst case in `lib/search.js`:

```
find (3500) + Promise.all[he, ru, en] (3000)  = 6500 ms
+ Cinemeta fallback (3000)                    = 9500 ms
```

**6500–9500 ms against a 5500 ms cutoff.** Every `immediate` entry is then submitted past the deadline and dropped by `remainingMs() <= 0`. On a slow-TMDB request the system silently collapses to canonical-ID only — no text search, no language fallback at all, Hebrew included.

```js
/** Metadata is an enrichment, never a gate: proceed with whatever resolved. */
const META_BUDGET_MS = 1200;

const [contentMeta, resolvedCtx] = await Promise.all([
  Promise.race([metaPromise, new Promise(r => setTimeout(() => r(null), META_BUDGET_MS))]),
  resolvePromise.catch(() => null),
]);
```

Also tighten `lib/search.js`: `find` 3500 → 2000 ms, the three detail calls 3000 → 1500 ms, Cinemeta fallback → 1500 ms.

## WP-14 · Negative metadata cached forever (#59)

`lib/search.js:187` — `meta = meta || emptyMeta(); cacheSet(baseId, meta);`

One TMDB timeout caches an **all-null** meta **permanently** for that warm instance (only FIFO eviction at 500 entries frees it). Every later request for that title then gets no titles and `runtimeMin = null`, pinning `Z` at 0.50 and disabling the subtitle duration match.

```js
const META_TTL_OK_MS = 6 * 60 * 60 * 1000;
const META_TTL_FAIL_MS = 45 * 1000;

function cacheSet(key, value, ttlMs) {
  if (metaCache.size >= MAX_CACHE_SIZE) metaCache.delete(metaCache.keys().next().value);
  metaCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

const cached = metaCache.get(baseId);
if (cached && cached.expiresAt > Date.now()) return cached.value;

const usable = !!(meta && (meta.en || meta.original || meta.he));
cacheSet(baseId, meta || emptyMeta(), usable ? META_TTL_OK_MS : META_TTL_FAIL_MS);
```

## WP-15 · Russian fallback is unreliable (#59) — severity corrected

**Corrected:** the plan emits **4** queries per provider, not 6 — `buildSearchTitles` dedups `original` into `en`, and `mapped_id` exists only for anime with resolved IDs. Verified:

```
titles = ["Breaking Bad","שובר שורות","Во все тяжкие"]
plan   = 8 entries / 2 providers = 4 per provider
byMode = {canonical_id:2, primary_title:2, extra_language:4}
```

With `PER_PROVIDER_INFLIGHT_CAP = 2` that is **2 waves, not 3**:

```
meta     L        he        ru
 900ms   1500ms   runs      runs
 900ms   2000ms   runs      DROPPED
 900ms   2800ms   DROPPED   DROPPED
3500ms   1500ms   runs      DROPPED
```

**Hebrew survives in the common case; Russian is the casualty.** Real but narrower than first filed.

```js
const PER_PROVIDER_INFLIGHT_CAP = 3;   // was 2
const PER_REQUEST_DEADLINE_MS = 2800;  // was 4000
```

and make `RetrievalScheduler.#drain` priority-ordered rather than FIFO, so Hebrew is guaranteed rather than latency-dependent:

```js
/** he-first ordering within a query mode: this audience is Hebrew-first. */
const LANG_RANK = { he: 0, en: 1, original: 2, ru: 3 };

function entryPriority(item) {
  return (QUERY_MODE_PRIORITY[item.queryMode] ?? 9) * 10 + (LANG_RANK[item.langKey] ?? 5);
}
```

`buildRetrievalPlan` must stamp `langKey` on each `PRIMARY_TITLE` / `EXTRA_LANGUAGE` entry.

## WP-16 · Manifest discovery can consume the whole search budget (#59)

`api/catalog.js`: `getCachedManifest` uses a **7500 ms** timeout while the fast trio's `hardBudgetMs` is **3000 ms**. On a cold cache discovery alone overruns, leaving `softMs = max(400, 3000 − 7500) = 400 ms` for the fan-out — ≈7.9 s for a search advertised as ~3 s. `_manifestCache` TTL is 60 s while `getTvCatalogIds` uses 1 h for the same class of data.

```js
const MANIFEST_TTL_MS = 30 * 60 * 1000;   // was 60_000; manifests change rarely
const discoveryMs = Math.min(1200, Math.floor(hardBudgetMs / 3));
```

## WP-17 · Cross-request search dedup is racy — delete it (#59)

`api/catalog.js:75` `_fastSearchIdCache` lets `full` exclude ids already returned by the fast trio. But Stremio requests all catalog rows **in parallel** and Vercel spreads them across instances, so the cache is usually empty at read time → duplicates; when instances are shared → dedup. **Nondeterministic UI.**

`excludeTypes` already partitions `full` deterministically. Remove `_fastSearchIdCache`, `rememberFastSearchIds`, `collectFastSearchIds` and the `excludeIds` plumbing.

## WP-18 · Subtitle handler exceeds the 10 s ceiling (#57)

```
dynamic race        <= 9000 ms   (6 s check, +3 s extension when hebCount < 3)
+ peekSrt x12       <= 2500 ms   (runs AFTER the race, not inside it)
+ hasKnownNoEmbeds  ~  200 ms
                    = ~11 700 ms  > 10 000 ms
```

The worst path is precisely the "not enough Hebrew, extend" branch the logic deliberately takes — so the slowest, most-wanted requests are the ones killed.

`vercel.json`:

```json
{ "functions": { "api/subtitles.js": { "maxDuration": 10 } } }
```

`api/subtitles.js`:

```js
/** Hobby ceiling is 10s; leave room for peek + Supabase + serialisation. */
const PROVIDER_RACE_MS = 3500;
const PROVIDER_RACE_EXTENDED_MS = 5000;
const PEEK_BUDGET_MS = 1200;

const dynamicTimeout = new Promise((resolve) => {
  setTimeout(() => {
    const hebCount = gatheredSubs.filter(s => classifySubtitleLang(s.lang) === 'heb').length;
    if (hebCount >= 3) return resolve('TIMEOUT_FAST');
    setTimeout(() => resolve('TIMEOUT_EXTENDED'), PROVIDER_RACE_EXTENDED_MS - PROVIDER_RACE_MS);
  }, PROVIDER_RACE_MS);
});
```

New worst case ≈ 5000 + 1200 + 400 + 600 ≈ **7.2 s**. Also drop each provider's own timeout from 9000 (line 281) to `PROVIDER_RACE_EXTENDED_MS`, and put the fan-out behind `RetrievalScheduler` — today it fires `addons × 3` uncapped sockets, unlike the stream path.

## WP-19 · The catalog searchbar has NO multi-language fallback (#63)

`api/catalog.js:310-316` forwards the user's raw query verbatim to every addon. `buildSearchTitles` is imported only by `lib/streamEngine.js` and `api/subtitles.js` — **unreachable from `api/catalog.js`**.

```
grep -rn "buildSearchTitles" api/ lib/
  lib/streamEngine.js:16   api/subtitles.js:4   api/search.js:5 (re-export)   lib/search.js:196 (def)
```

So searching `שובר שורות` never reaches providers indexing English release names, and `Breaking Bad` never surfaces the Israeli rows. Distinct from WP-15, where the fallback exists but is starved.

**Design:** detect script with the existing `detectTitleLanguage()` (`lib/titleLanguage.js`); resolve alternates from `personal_akas` (24 412 rows, offline) falling back to one TMDB `search/multi` call; fire alternates as a **second wave only when wave 1 is thin and budget remains**:

```js
const ALT_QUERY_THIN_THRESHOLD = 5;
const ALT_QUERY_MIN_BUDGET_MS  = 900;

if (combinedMetas.length < ALT_QUERY_THIN_THRESHOLD
    && (hardBudgetMs - (Date.now() - handlerStarted)) > ALT_QUERY_MIN_BUDGET_MS) {
  const alternates = await resolveAlternateQueries(queryKey);   // <= 2 titles
  // reuse the same fetchJsonWithTimeout + awaitSoftDeadline + mergeMetas path
}
```

`mergeMetas` already dedups by id. Apply to `MIXED_SEARCH_PREFIX` catalogs only — Live TV is deliberately excluded (`LIVE_TV_CATALOG_ID` filter, line 194) and must stay excluded. **Depends on WP-16/WP-17** for the headroom.

---

# 9. P4 — Scoring model · `audit/p4-scoring` · **SIGN-OFF REQUIRED**

Every item here intentionally moves rankings.

## A · Credibility contaminates unrelated evidence (#60)

`lib/streamRanker.js:162` — `return quantize(clip(features.C * linear, 0, 100));`

`C` derives **purely** from release-text self-contradiction, yet scales all ten features including `F` (availability), `T` (trust), `X` (match), `D` (compatibility), `L` (language). A cached, high-trust stream with one mislabelled HDR tag loses 60% of its *availability* score. This violates the module's own rule: *"Each piece of evidence is counted exactly once."*

| C | current `C·Σ` | claim-features only | over-penalty |
|---|---|---|---|
| 0.55 | 46.8 | 62.1 | **15.3 pts** |
| 0.45 | 38.3 | 57.0 | **18.7 pts** |
| 0.40 | 34.0 | 54.5 | **20.4 pts** |
| 0.25 | 21.3 | 46.8 | **25.5 pts** |

```js
/**
 * Features asserted by the release text (a lie here is a lie about these) vs
 * features observed independently (transport, trust snapshot, URL, client).
 * Credibility may only discount what the text actually claimed.
 */
const CLAIM_FEATURES = ['V', 'H', 'A', 'Z', 'M'];
const OBSERVED_FEATURES = ['F', 'T', 'X', 'D', 'L'];

export function computeBaseScore(features, profile) {
  const w = profile.weights;
  const z = profile.zMode === Z_MODE.TAP ? features.Zt : features.Zq;
  const value = (k) => (k === 'Z' ? z : features[k]);

  let observed = 0;
  for (const k of OBSERVED_FEATURES) observed += w[k] * value(k);
  let claimed = 0;
  for (const k of CLAIM_FEATURES) claimed += w[k] * value(k);

  return quantize(clip(observed + features.C * claimed, 0, 100));
}
```

`scoreBreakdown` must mirror this so diagnostics stay truthful.

## B · Credibility is non-monotonic in evidence (#60)

`computeCredibility` takes `min(penalties)`, so three contradictions score identically to the worst single one.

```js
  let value = 1.00;
  for (const reason of reasons) {
    const penalty = CREDIBILITY_PENALTY[reason.code];
    // Independent contradictions compound; `min` treated three lies as one.
    if (penalty !== undefined) value *= penalty;
  }
  return { value: clip(value, 0.25, 1.00), reasons: reasons.map(r => r.code) };
```

## C · Codec-blind bitrate table double-penalises HEVC/AV1 (#60)

`EXPECTED_BITRATE` keys only on `(source, resolution)`, but `computeCompatibility` already discounts modern codecs (`h265 0.80`, `av1 0.55`). Penalised twice through two supposedly orthogonal features:

```
1080p WEB-DL, equal perceptual quality:
h264  7.0 Mbps  Zq=1.000  D=1.00  ->  9.00
h265  4.2 Mbps  Zq=0.715  D=0.80  ->  6.78
av1   3.2 Mbps  Zq=0.455  D=0.55  ->  4.48    <- 4.52 pts below h264
```

```js
/**
 * Compression efficiency relative to H.264 at equal perceptual quality.
 * Without this the expected-bitrate curve reads an efficient encode as starved,
 * double-charging codecs that `D` already discounts.
 */
const CODEC_EFFICIENCY = {
  [CODEC.H264]: 1.00, [CODEC.H265]: 0.62, [CODEC.VP9]: 0.68,
  [CODEC.AV1]: 0.50, [CODEC.MPEG2]: 1.60, [CODEC.UNKNOWN]: 0.85,
};

const eta = CODEC_EFFICIENCY[release.codec.value] ?? CODEC_EFFICIENCY[CODEC.UNKNOWN];
const x = Math.log2(bitrateMbps / (expected * eta));
```

## D · Reservations consume 100% of the default profile's target (#60)

```
friends_light (DEFAULT):  ready_now 4 + compatible 6 = 10  =  target 10
family:                   ready_now 5 + compatible 7 = 12  >  target 10
```

Step 3 of `selectStreams` — the marginal-gain diversity fill — **can never execute** for the default profile when candidates are plentiful, and `family` declares unsatisfiable minimums. The tuned 10-feature model is reduced to "4 by availability, then 6 by compatibility".

```js
// friends_light
reservations: [
  { key: 'ready_now',  min: 3, test: f => f.F >= 0.90 },
  { key: 'compatible', min: 3, test: f => f.D >= 0.80 },
],
// family
reservations: [
  { key: 'ready_now',  min: 3, test: f => f.F >= 0.90 },
  { key: 'compatible', min: 4, test: f => f.D >= 0.85 },
],
```

Assert at module load:

```js
for (const [name, p] of Object.entries(PROFILES)) {
  const reserved = (p.reservations || []).reduce((s, r) => s + r.min, 0);
  if (reserved > Math.ceil(p.target * 0.6)) {
    throw new Error(`profile ${name}: reservations (${reserved}) exceed 60% of target (${p.target})`);
  }
}
```

## E · Admission pruning misaligned with the profile it feeds (#60)

`prunePriority` (`lib/streamEngine.js:336`) is `10·V + 3·F + 2·X` — **67% visual** — while `friends_light` weights `V` at 14/100 and `F` at 26/100. Above 500 candidates the prune discards exactly the cached-720p rows that profile ranks highest.

```js
export function prunePriority(candidate) {
  const { stream, features } = candidate;
  // Profile-neutral: the old 10·V made this a 4K filter, which is the opposite
  // of what the availability-weighted profiles want to keep.
  return (features.V * 3) + (features.F * 3) + (features.X * 2) + (features.D * 1)
    + (features.hasHttpLocator ? 0.5 : 0) + (stream.infoHash ? 0.1 : 0);
}
```

## F · Small, safe corrections (#60)

1. **Zero-margin eligibility.** `MATCH_CONFIDENCE.NO_EVIDENCE = 0.70` is *exactly* `MATCH_ELIGIBILITY_THRESHOLD = 0.70`. Set the threshold to `0.65`. This is where 2-char titles (`It`, `Us`, `Up`) live — see WP-6.
2. **Dead branch.** `computeLanguageRelevance` returns `0.85` from both the `strongMatch` and fallback branches, so `strongMatch` is inert unless `hasHebrewScript`. Differentiate (0.90 / 0.80) or drop it.
3. **Allocation churn.** `selectStreams.takeOne` spreads two candidate objects per comparison — ~100 000 allocations per `kodi` request. Change `compareForSelection` to accept `(candidate, gain)` pairs.
4. **Dedup ↔ cap interaction.** When `capViolation` blocks a cluster representative, let `takeOne` substitute a `clusterVariants` member from an uncapped provider rather than discarding the cluster.

**Verify:** snapshot the top-10 for a fixed fixture before and after, and review the diff deliberately rather than asserting it is unchanged.

---

# 10. P5 — Provider expansion · `audit/p5-registry` · **SIGN-OFF REQUIRED**

## A · The capability registry is code, not data (#61)

`lib/providerCapabilities.js` `REGISTRY` entries carry **live JS functions** (`markerParser`, `vipRule`), so the registry can never be DB-backed, hot-reloaded, or edited without a deploy.

Note the asymmetry: `Stremio-KanBoxRepos`'s `SCRAPER_CONFIG` **is** declarative data, which is why adding a scraper there is cheap. Bring the aggregator to that standard.

```jsonc
{
  "family": "newprovider",
  "matchers": [{ "kind": "hostLabel", "value": "newprovider", "score": 300 }],
  "idSchemes": ["tt", "tmdb"],
  "transports": ["debrid", "p2p"],
  "trustedFields": ["infoHash", "behaviorHints.videoSize"],
  "cacheRules": [
    { "pattern": "un[\\s._-]?cached|not[\\s._-]?cached", "claim": "queued",         "marker": "explicit_uncached" },
    { "pattern": "\\[tb\\s*[+⚡]\\]",                     "claim": "cache_positive", "marker": "tb_plus" },
    { "pattern": "\\[tb\\]",                             "claim": "queued",         "marker": "tb_bare" }
  ],
  "vip": false,
  "integrityPrior":  { "mu0": 0.60, "kappa0": 4 },
  "cacheClaimPrior": null
}
```

One shared interpreter replaces every bespoke `*MarkerParser`:

```js
/**
 * Ordered first-match rule evaluation. Replaces per-family parser functions so
 * the registry can live in a table instead of a module.
 */
function evaluateCacheRules(rules, text) {
  for (const rule of rules || []) {
    let re = COMPILED.get(rule.pattern);
    if (!re) { re = new RegExp(rule.pattern, 'i'); COMPILED.set(rule.pattern, re); }
    if (re.test(text)) return { claim: rule.claim || null, marker: rule.marker || null };
  }
  return { claim: CACHE_CLAIM.NONE, marker: null };
}
```

Rule order carries the precedence currently expressed in code (`EXPLICIT_UNCACHED` must precede the cached-suffix test). Seed with the existing families so behaviour is identical on day one, then move the table to Supabase behind the same 5-minute snapshot pattern used for trust. **New provider = one row, no deploy.**

## B · Unanchored substring matchers will collide (#61)

```js
    else if (matcher.kind === 'hostLabel') hit = hostLabels.includes(matcher.value);
    else if (matcher.kind === 'hostSubstring') {
      // Require a distinctive needle: short substrings collide as the registry grows.
      hit = matcher.value.length >= 5 && hostname.includes(matcher.value);
    }
```

## C · Fan-out does not scale past ~4 providers (#61)

Requests ≈ `providers × 4–5` against `GLOBAL_INFLIGHT_CAP = 24`. Beyond ~5 providers the language tail breaks first, so a new provider silently makes Russian search worse. **Do WP-15 before onboarding anyone new.** `GENERIC_KNOWN` also sets `supportsTextSearch: true`, so every unrecognised provider immediately costs extra title queries — consider ID-only until it has observations.

## D · VIP slots do not scale with provider count (#61)

`caps.vip = 2`, one row per VIP provider, and **every** unselected VIP candidate is permanently `blockedExtraVip` — even in the 100-row `kodi` list. A third curated provider makes this strictly worse.

```js
// Cap the VIP *prefix*, but let surplus VIP rows compete normally afterwards
// rather than being discarded outright.
const vipPrefix = Math.min(caps.vip, vipProviders.size || caps.vip, profile.target);
```

and drop `blockedExtraVip` from the `takeOne` skip condition.

## E · Cold-start handicap (#61) — blocked on P1

```
new provider   T = wilson(0.60·4,  0.40·4)  = 0.305
torrentio      T = wilson(0.78·10, 0.22·10) = 0.539
Δ = 0.234 × w.T (12–16) ≈ 2.8–3.7 pts
```

A new provider needs `effectiveWeight ≥ PROVEN_WEIGHT (10)` to shed the `unprovenProvider` cap. Because `integrity` observations never land today, that never happens for anyone. **P1 is a prerequisite for this section to mean anything.** Once observations flow, consider a grace period exempting brand-new providers for their first N requests.

---

# 11. Other repositories

## 11.1 Stremio-KanBoxRepos — orphaned EPG script

`scripts/generate_epg.js` **exists** and works: it fetches XMLTV from three community sources with failover (`deepspace221/xmltv-israel`, `davidmuma/EPG_Israel`, `itay2205/EPG_Israel`), regex-parses it, and writes the next 24 h to `output/epg.json`.

**But nothing runs it.** `.github/workflows/main.yml` line 52 records that its step was deliberately removed:

```
# הבלוק הישן של generate_epg.js נמחק מכאן בהצלחה
```

`output/epg.json` is not committed, and no code in either repo reads such a file. The live EPG path is `classes/LiveTV.js` → `fishenzon-epg/EPG` zip → Supabase `epg_data` → `Stremio-KanBoxAddon/addon.js:954` reads the table.

**Decision needed:** delete the orphaned script, or re-wire it as a fallback for when the fishenzon feed is unavailable. Both READMEs now document the situation.

## 11.2 stremio-telegram-debrid — tunnel hostname fragility

The aggregator matches this addon by **exact hostname** — `advantage-shot-petition-crucial.trycloudflare.com`. Quick tunnels rotate on restart. When the URL changes, `providerCapabilities.js` silently demotes it from VIP `personal_telegram` to `generic_known`, dropping its integrity prior 0.82 → 0.60, with no error anywhere.

**Fix:** use the stable-hostname Caddy stack already present at `deployment/vps/docker-compose.caddy.yml`, or update `providerCapabilities.js` on every rotation.

Context: this repo has diverged substantially from its upstream (`SunilRoy-dev/stremio-telegram-debrid`) — 44 files vs 23, 21 unique here, none unique upstream, ~100 KB of original code (TorBox, admin/bot workflow, TMDB, metadata store, host-busy lease, a real pytest suite). Upstream is a historical starting point, not a live dependency.

## 11.3 Einthusan-Stremio-Addon — two divergent entry points

`addon.js` (~23 KB) and `api/index.js` (~26 KB) are **separate implementations**, not a re-export pair — verified: `api/index.js` never requires `addon.js`, has its own `loginToEinthusan`, its own builder, and its own handler at line 655. It deliberately avoids Puppeteer ("won't work well on Vercel serverless") and uses direct extraction instead.

`vercel.json` rewrites everything to `/api`, so **production runs `api/index.js`**. A fix applied to only one entry point will appear to work locally and fail in production, or vice versa. Consolidating onto a shared module removes a whole class of bug.

It also has **no capability entry** in `providerCapabilities.js`, so it resolves to `GENERIC_KNOWN`: no VIP, the lowest integrity prior (0.60), while still paying the full text-search fan-out. If it is meant to be first-class, give it a `REGISTRY` entry — or wait for §10A to make that a table row.

## 11.4 Kodi-repo

No defects found. Its `claude.md` and README match the code. The server-side profile it receives is documented there (`target: 100`, `clientClass: 'capable'`, `caps.vip` still 2, no reservations).

---

# 12. Supabase and infrastructure (#52, #64)

**Deferred by owner decision — key rotation handled separately.**

Four `SECURITY DEFINER` functions are executable by the `anon` role via the public REST API: `personal_ingest_title_rows`, `personal_ingest_aka_rows`, `personal_ingest_episode_rows`, `personal_set_origin_countries`. Anyone with the anon key can write to `personal_titles` / `akas` / `episode_map`, which feed ID resolution and alias search.

This is **deliberate** — `scripts/ingest-fribb.mjs:28`, `generate-manami-batches.mjs:35` and `generate-anibridge-batches.mjs:176` all fall back to `SUPABASE_ANON_KEY`, and `AGENTS.md` documents the no-service-role workflow. Revoking without a replacement path breaks it. Options: revoke and require the service role; add a dedicated low-privilege ingest role; or accept.

Also: `public.personal_set_updated_at` has a mutable `search_path` (lint `0011`), and 12 `personal_*` tables have RLS enabled with no policies (deny-all, correct but indistinguishable from an oversight — add a `COMMENT ON TABLE`).

---

# 13. Not audited

- **`worker/media-intelligence/*`** — the host was unreachable. WP-4's answer probably lives here. This is the consumer of the audit queue and the producer of trust snapshots.
- `lib/idResolve.js`, `lib/releaseParser.js` internals, `api/stream.js` / `api/kodi.js` / `api/kodi-catalog.js` handlers.
- The `kanBox` Supabase project (`tkvcgydyflgvqremjftq`).
- Internals of `stremio-telegram-debrid` (`addon.py`, 98 KB) and `Einthusan-Stremio-Addon`.

---

# 14. Issue index

| Issue | Phase | Title |
|---|---|---|
| **#62** | — | **EPIC — master tracker** |
| #53 | P0 | `sub-proxy.js` unauthenticated open proxy |
| #54 | P1 | Trust-learning loop dead |
| #55 | P2 | Numeric titles hard-dropped; Hebrew overlap false positives |
| #56 | P2 | MinHash 7 seeds instead of 128 |
| #57 | P2/P3 | Subtitles: duration probe, language, determinism, budget |
| #58 | P2 | Subtitle scores invisible — use `label` |
| #59 | P3 | Russian fallback, metadata blocking, negative meta cache |
| #63 | P3 | Catalog searchbar has no multi-language fallback |
| #60 | P4 | Scoring model corrections |
| #61 | P5 | Provider registry is code not data |
| #52 | — | Supabase anon `SECURITY DEFINER` RPCs (deferred) |
| #64 | — | Minor leftovers |

---

# 15. Deliverable

Per phase: one branch, one PR, with the fix, a regression test, `node --test test/*.test.mjs` green, a PR body stating what was verified and how, and explicit impact analysis where behaviour changes.

After P2, **stop** and report:

1. Did `personal_stream_sightings` go above 0 after WP-2 deployed? (the P1 gate)
2. What did WP-4 find about the two failed sync jobs?
3. Anything in this document that turned out to be wrong when you touched the code — see §0; assume more errors exist.
