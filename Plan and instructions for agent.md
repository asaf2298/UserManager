# Plan and instructions for agent

> Implementation brief produced by the 2026-08 architectural audit. Findings live in epic **#62**.
> Every file:line reference below was verified against `main` at the time of writing.
> **Four errors in the original audit have already been corrected in this document** — see *Known-bad claims* at the end before trusting anything not restated here.

You are working on `asaf2298/UserManager` — a Vercel serverless proxy/aggregator for Stremio & Kodi addons. Pure ESM JavaScript, Node runtime, single runtime dependency (`node-fetch`), **no build step**.

Your job is to implement **P0, P1 and P2 only**, then stop and report. Do not start P3/P4/P5 — those change timing and ranking behaviour and need the owner's sign-off first.

---

## Hard constraints — read before writing any code

1. **Vercel Hobby: 10 s hard function limit.** Every timeout must fit inside it, including JSON serialization.
2. **`main` auto-deploys to production.** Never commit to it. One branch + PR per phase: `audit/p0-security`, `audit/p1-learning-loop`, `audit/p2-correctness`.
3. **The invocation is frozen the moment the handler returns.** Un-awaited promises have their sockets torn down mid-flight. This is the root cause of all of P1.
4. **`CLAUDE.md` rule 3: ask before changing existing logic.** P0–P2 are defect repairs, so proceed — but if a fix turns out to require a behavioural change, stop and ask.
5. **`CLAUDE.md` rule 2: system-wide DRY.** Prefer extending existing helpers over adding parallel ones.

## Setup

```bash
npm install
node --test test/*.test.mjs      # 104 tests; must stay green
node dev-server.mjs              # local harness (vercel dev does NOT work headless)
```

Add a regression test for every fix. Run the full suite before opening each PR.

---

# P0 — Security · branch `audit/p0-security`

## WP-1 · `api/sub-proxy.js` is an unauthenticated open proxy (#53)

The only validation on the caller-supplied `url` param is `/^https?:\/\//i` (line 31). Anyone can call `/api/sub-proxy?url=http://127.0.0.1:9000/` or `?url=http://169.254.169.254/` and receive the body (SSRF), or use it as an open relay on your bandwidth and IP.

Compounding defects in the same file:
- **line 9** — `new https.Agent({ rejectUnauthorized: false })` is applied to **every** proxied request (line 39). In `api/subtitles.js:276` the same bypass is correctly scoped to one host; the proxy generalised it by accident.
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

`node-fetch` honours the `size` option natively and rejects during streaming, so the cap applies before the body is fully buffered.

**Verify**

- unsigned localhost target → `403`
- bogus `sig` → `403`
- a real subtitle still renders in Stremio → the signed path works end to end
- oversized file → `413`

`SUB_PROXY_SECRET` is optional. Note in the PR that rotating `SUPABASE_SERVICE_ROLE_KEY` invalidates already-issued signed URLs.

### Deferred hardening (do not do now)

DNS-resolved private-range blocking (`127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fc00::/7`) would also protect against a *compromised* legitimate provider redirecting inward. `redirect: 'manual'` already removes the main pivot; leave the rest for a follow-up.

---

# P1 — Restore the learning loop · branch `audit/p1-learning-loop`

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

**This work package is the whole fix.** Restore sightings and PR #44's machinery should start producing `integrity` observations on its own, with no new code.

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

While no `integrity` snapshot exists, `features.trustProven` is `false` fleet-wide, so `caps.unprovenProvider` — **1** on the default `friends_light` profile — caps every provider at one row in a ten-row list. That is an accident of the telemetry bug, not a design decision.

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

Both rows in `personal_subtitle_sync_jobs` are `status='failed'`, `comet` / `debrid|movie`, 2026-07-31 22:29–22:30. Two-for-two suggests something systematic rather than bad luck.

Check the worker log for that window: ffprobe failure, TorBox CDN locator not resolving, or job timeout. **Report findings; do not fix blind.** Once sightings flow, this failure mode scales with volume.

---

# P2 — Correctness defects · branch `audit/p2-correctness`

## WP-5 · Numeric titles are hard-dropped as "wrong show" (#55)

Verified by executing the real module:

```
titleTokens("1917") = []   titleTokens("300") = []   titleTokens("1984") = []

"1917 Sam Mendes War Drama"         vs "1917" -> hard  -> X=0.00 -> INELIGIBLE
"300 Rise of an Empire Zack Snyder" vs "300"  -> hard  -> X=0.00 -> INELIGIBLE
```

`titleTokens` drops pure numbers of ≤4 digits, so `expectedToks` is empty, so any release containing real words has zero overlap and is classified `'hard'` → `MATCH_CONFIDENCE.CONFLICT = 0.00` → below `MATCH_ELIGIBILITY_THRESHOLD` → every stream for that title is dropped.

**The single highest-value line.** In `getTitleConflictLevel`, before the overlap test:

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

Verified: they are **not** dropped. `getTitleConflictLevel` filters expected titles to `length >= 3` on its first line, so a 2-char title leaves `titles` empty and the function returns `null` early. They instead sit at `X = 0.70`, exactly on `MATCH_ELIGIBILITY_THRESHOLD = 0.70` — a zero-margin fragility tracked separately in #60 part F. Leave that alone in this phase.

**Verify:** new `test/titleMatch.test.mjs` — `1917 / 300 / 1984 / 2012 / 1408` × realistic release names must never be `'hard'`. Regression: `Utena` on a `Re:Zero` request must still be `'hard'`.

## WP-6 · Hebrew title overlap fires on 2-character chunks (#55)

Verified by executing the real module — genuinely different shows score `{level:"strong"}`:

```
"שובר שורות" vs "שובר קווים" -> {"level":"strong","reason":"hebrew_overlap"}   FALSE POSITIVE
"בית הקלפים" vs "בית ספר"    -> {"level":"strong","reason":"hebrew_overlap"}   FALSE POSITIVE
"פאודה"      vs "פאודה"      -> {"level":"strong","reason":"fingerprint"}      correct
```

A false `strong` gives a **wrong show** `X = 0.85` and `L = 1.00` (`hebrew_release_confirmed`). This lands squarely on the Israeli catalogue, the core of the product.

In `lib/titleMatch.js`:

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

and tighten the bare-chunk fallback inside `hebrewTitleOverlap`. **Leave the joined-string and 4-char-prefix checks above it untouched** — they carry the real true-positive load:

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

**Verify:** the three pairs above — first two `false`, `פאודה/פאודה` `true`.

## WP-7 · MinHash uses 7 distinct seeds instead of 128 (#56)

`lib/streamDedup.js:45` — `digest.readUInt32BE((i * 4) % (digest.length - 4))`. A sha256 digest is 32 bytes, so `digest.length - 4 === 28` and `(i*4) % 28` cycles only **7** offsets.

Verified with the real `PARSER_VERSION = "release-v2"`: **7 distinct seeds out of 128, period 7** (`seeds[i] === seeds[i+7]`). The 32 LSH bands collapse to 7 structurally distinct patterns, violating the independent-band assumption. Recall at the `JACCARD.GROUP = 0.60` merge threshold falls **98.8% → 62.2%**, so real duplicates survive as separate rows once a list exceeds `LSH_THRESHOLD = 250`.

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

Cost is 128 hashes at module load only, never in the request path.

**Impact analysis (CLAUDE.md rule 1):** this changes dedup output above 250 candidates. Bump `PARSER_VERSION` in `lib/versions.js` so telemetry rows stamped `parser_version` are not compared across the boundary — `buildAuditRows` records it and the trust aggregator would otherwise mix pre- and post-fix clustering.

**Verify:** `assert.equal(new Set(MINHASH_SEEDS).size, 128)` (is 7 today); existing `test/streamDedup.test.mjs` stays green.

## WP-8 · The subtitle duration probe reads the wrong end of the file (#57)

`api/subtitles.js:380` requests `bytes=0-65535` — the **first** 64 KB — but `parseSubtitleDurationMinutes` returns the **maximum timestamp found**. For any SRT larger than 64 KB that is the last cue within the first 64 KB, roughly 46 minutes in, not the runtime.

```
runtime  SRT size  reported   Gaussian sync term
  45min     62KB   45.0 min   1.00      (works)
  90min    124KB   46.6 min   5.8e-21
 120min    165KB   46.6 min   2.9e-33
 180min    247KB   46.6 min   1.8e-48
```

The `0.15`-weighted `durationCompat` term is therefore a constant penalty carrying no information for **every feature-length title**, and `sync✓` can never display. Only short-form content (≤~45 min) works — which is why this went unnoticed on an episodic Israeli catalogue.

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

Servers that ignore suffix ranges answer `200` with the whole body — still correct, just larger, hence the `slice`. Note in review that `detectSubtitleScriptLang` samples `slice(0, 12000)`, which is now the file's tail; equally valid for script detection (dialogue either way).

## WP-9 · Subtitle language misclassification (#57)

Verified by executing the real module:

```
belarusian -> rus     bengali    -> eng
prussian   -> rus     slovengish -> eng
```

Bengali subtitles are served to the client labelled **English**. This partly defeats the module's own stated principle ("Honest empty > fake Hebrew").

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

**Verify:** new `test/subtitleLang.test.mjs` — the four false positives return `null`; `hebrew` / `russian` / `english` still map correctly; `chinese` / `french` / `arabic` stay `null`.

## WP-10 · Mislabel verification covers a nondeterministic subset (#57)

`api/subtitles.js:407` — `needPeek` follows `withMeta`, which follows `gatheredSubs`, which is **provider arrival order**. Which 12 subtitles get body-verified therefore changes between runs, so a mislabelled "Hebrew" track at position 13 is shown unverified while an identical run might catch it.

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

## WP-11 · Subtitle scores are invisible in Stremio (#58) — CONFIRM WITH OWNER FIRST

User-visible change, so ask before shipping — but it is one line with **no trade-off**.

Verified against Stremio's own source. `stremio-core/src/types/resource/subtitles.rs`:

```rust
pub struct Subtitles {
    pub id: String,
    pub lang: String,
    pub url: Url,
    pub label: Option<String>,      // <-- the display field
    pub fonts: Vec<Url>,
}
```

`stremio-web/src/routes/Player/SubtitlesMenu/SubtitleVariant/SubtitleVariant.tsx`:

```tsx
const hasValidLabel = (label?: string) => label && label.length > 0 && !label.startsWith('http');
const variantLabel = hasValidLabel(track.label) ? track.label : languages.label(track.lang);
<div className={styles['variant-label']}>{variantLabel}</div>
<div className={styles['variant-origin']}>{t(track.origin)}</div>
```

There is **no `title` field** — it is dropped on deserialization. So the `[provider] ★87 sync✓94%` string built at `api/subtitles.js:474` is never displayed, and every subtitle collapses into one identical row per language.

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

`hasValidLabel` rejects labels starting with `http` — never fall back to a URL as the label.

**Do NOT decorate `lang`.** An earlier draft of this plan suggested that; it is wrong and would break Stremio's preferred-subtitle-language auto-select.

### Ordering is already preserved

`SubtitlesMenu.js` calls `sortByValues(tracks, ORIGIN_PRIORITIES)`, whose comparator is:

```js
const sortByValues = (items, values) => items.sort((a, b) => {
    const left = values.indexOf(a);      // `a` is a track OBJECT
    const right = values.indexOf(b);     // `values` holds STRINGS
    if (left === -1 && right === -1) return 0;
    ...
});
```

`indexOf(trackObject)` against an array of strings is always `-1`, so the comparator returns `0` for every pair and JS's stable sort preserves insertion order. Our `cleanedSubs.sort()` therefore survives — and would still survive if Stremio fixed the comparator, since all our tracks share one `origin` and would tie.

Caveat: the **language list itself** is sorted alphabetically then by user/interface language priority (`SubtitlesMenu.js:51-52`). We control ordering *within* Hebrew / English / Russian, not the order of the languages.

### Follow-up (not now)

`lib/subtitleSync.js:141` abuses `lang` to force a separate row for sync tracks — it predates the `label` field and creates a bogus language entry. Once `label` is in use, set `lang: 'heb'` and move the descriptor into `label`.

---

# Deliverable

Three PRs — `audit/p0-security`, `audit/p1-learning-loop`, `audit/p2-correctness` — each with:

- the fix, a regression test, and `node --test test/*.test.mjs` green
- a PR body stating what was verified and how
- explicit impact analysis where behaviour changes (WP-7's `PARSER_VERSION` bump especially)

Then **stop** and report:

1. Did `personal_stream_sightings` go above 0 after WP-2 deployed? (the P1 gate)
2. What did WP-4 find about the two failed sync jobs?
3. Anything in this document that turned out to be wrong when you touched the code.

**Do not start** P3 (#59, #63 — latency and search budgets), P4 (#60 — scoring model) or P5 (#61 — provider registry). Those need the owner's sign-off.

---

# Known-bad claims from the original audit — already corrected above

The audit that produced these issues made four errors, all of the same kind: **asserting absence from an incomplete check**. They are fixed in this document, but assume more exist and verify before trusting any claim here.

| Original claim | Reality |
|---|---|
| "`generate_epg.js` is fabricated, it does not exist" | It exists at `Stremio-KanBoxRepos/scripts/generate_epg.js` and does exactly what the README said. It is **orphaned** — its GitHub Actions step was removed, `output/epg.json` is not committed, nothing reads it. |
| "The `integrity` metric is never emitted — go build it" | PR **#44** already built it. It is starved by the sightings write failure, not missing. WP-2 alone should restore it. |
| "`It` / `Us` / `Up` streams are hard-dropped" | They are not. `getTitleConflictLevel` filters expected titles to `length >= 3` and returns `null` early. Only numeric titles of 3+ chars are dropped. |
| "Hebrew *and* Russian search fallback dropped 100% of the time" | The plan emits **4** queries per provider, not 6 (`original` dedups into `en`; `mapped_id` is anime-only). That is 2 waves, not 3 — Hebrew survives in the common case, only Russian drops. Issue #59 downgraded HIGH → MEDIUM. |

**Confirmed accurate** (re-verified by executing the real modules, not by inspection): the MinHash 7/128 seed collision, the subtitle language misclassification, the Hebrew 2-char overlap false positives, and the `sub-proxy` SSRF.
