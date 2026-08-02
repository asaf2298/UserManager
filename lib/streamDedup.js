/**
 * Same-release deduplication.
 *
 * Two goals that pull in opposite directions: collapse the same encode offered
 * by five providers, and never merge two genuinely different files. The rules
 * below therefore gate every text-similarity merge behind hard technical
 * compatibility, and refuse transitive clustering — A≈B and B≈C does not make
 * A≈C, so connected components would silently over-merge.
 *
 * Exact Jaccard is authoritative. MinHash/LSH only proposes candidate pairs on
 * large lists; the exact rules still decide.
 */
import crypto from 'node:crypto';
import { PARSER_VERSION } from './versions.js';
import { FIELD, RESOLUTION, jaccard } from './releaseParser.js';

/** Above this candidate count, use LSH to propose pairs instead of full O(n²). */
export const LSH_THRESHOLD = 250;

/** MinHash configuration, seeded from parserVersion so results are reproducible. */
export const MINHASH_VALUES = 128;
export const LSH_BANDS = 32;
export const LSH_ROWS = 4;

const SIZE_RATIO = { GROUP: 1.08, LARGE_UNION: 1.15, MID_UNION: 1.08, TINY_UNION: 1.03 };
const JACCARD = { GROUP: 0.60, LARGE_UNION: 0.82, MID_UNION: 0.90 };

/** Query parameters that carry credentials or expiry, not file identity. */
const VOLATILE_PARAM = /^(?:token|api[_-]?key|key|sig|signature|expires?|exp|ip|client[_-]?ip|auth|secret|hash|t|ts|nonce|session)$/i;

function fnv1a(str, seed) {
  let hash = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Deterministic per-position seeds derived from the pinned parser version. */
const MINHASH_SEEDS = (() => {
  const seeds = new Array(MINHASH_VALUES);
  for (let i = 0; i < MINHASH_VALUES; i++) {
    // One digest per position: a single 32-byte sha256 digest cannot supply 128
    // independent 32-bit seeds -- the old `(i*4) % 28` wrapped after 7 distinct
    // offsets, collapsing all 32 LSH bands to 7 distinct patterns (#56).
    seeds[i] = crypto.createHash('sha256')
      .update(`minhash|${PARSER_VERSION}|${i}`)
      .digest()
      .readUInt32BE(0);
  }
  return seeds;
})();

/**
 * Canonical playback URL: identity without credentials.
 * Volatile params are dropped so the same file behind two signed URLs collapses,
 * while a genuinely different path stays distinct.
 */
export function canonicalPlaybackUrl(rawUrl) {
  const value = String(rawUrl || '');
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) return value.toLowerCase();
  try {
    const url = new URL(value);
    const kept = [];
    for (const [key, val] of url.searchParams.entries()) {
      if (!VOLATILE_PARAM.test(key)) kept.push(`${key.toLowerCase()}=${val.toLowerCase()}`);
    }
    kept.sort();
    const path = url.pathname.replace(/\/+$/, '').toLowerCase();
    return `${url.hostname.toLowerCase()}${path}${kept.length ? `?${kept.join('&')}` : ''}`;
  } catch {
    return value.toLowerCase();
  }
}

function normalizedHash(stream) {
  const hash = String(stream?.infoHash || '').trim().toLowerCase();
  return /^[0-9a-f]{32,40}$/.test(hash) ? hash : null;
}

function sizeRatio(a, b) {
  const sa = a.release.size.bytes;
  const sb = b.release.size.bytes;
  if (!Number.isFinite(sa) || !Number.isFinite(sb) || sa <= 0 || sb <= 0) return null;
  return Math.max(sa, sb) / Math.min(sa, sb);
}

function sizeRatioWithin(a, b, limit) {
  const ratio = sizeRatio(a, b);
  return ratio === null ? true : ratio <= limit;
}

/**
 * Hard compatibility gate. Any conflicting *known* technical field forbids a
 * text-similarity merge, because those fields define a distinct encode.
 */
export function releasesCompatible(a, b) {
  const ra = a.release;
  const rb = b.release;

  if (ra.episode.state === FIELD.PARSED && rb.episode.state === FIELD.PARSED) {
    if (ra.episode.season !== rb.episode.season || ra.episode.episode !== rb.episode.episode) return false;
  }
  if (ra.isSeasonPack !== rb.isSeasonPack) return false;

  if (ra.edition && rb.edition && ra.edition !== rb.edition) return false;

  // A self-contradictory resolution label (e.g. a row claiming both 2160p and
  // 1080p) means we cannot establish what the release actually is, so it never
  // merges on text similarity. Exact infoHash and canonical-URL matches are decided
  // earlier and are unaffected. Showing one extra row is far cheaper than hiding a
  // distinct release behind a mislabelled one.
  if (ra.resolution.state === FIELD.CONFLICT || rb.resolution.state === FIELD.CONFLICT) return false;
  if (ra.resolution.state === FIELD.PARSED && rb.resolution.state === FIELD.PARSED) {
    if (ra.resolution.value !== rb.resolution.value) return false;
  }

  // WEB-DL and WEBRip are the same broad web family; remux and disc encode are not.
  if (ra.source.state === FIELD.PARSED && rb.source.state === FIELD.PARSED) {
    if (ra.source.family !== rb.source.family) return false;
    const discPair = new Set([ra.source.value, rb.source.value]);
    if (discPair.size > 1 && discPair.has('remux')) return false;
  }

  if (ra.codec.state === FIELD.PARSED && rb.codec.state === FIELD.PARSED) {
    if (ra.codec.value !== rb.codec.value) return false;
  }

  if (ra.hdr.state === FIELD.PARSED && rb.hdr.state === FIELD.PARSED) {
    if (ra.hdr.value !== rb.hdr.value) return false;
  }

  const la = new Set(ra.languages.values);
  const lb = new Set(rb.languages.values);
  if (la.size && lb.size && !ra.languages.multi && !rb.languages.multi) {
    let shared = false;
    for (const lang of la) {
      if (lb.has(lang)) { shared = true; break; }
    }
    if (!shared) return false;
  }

  return true;
}

/**
 * Decide whether two scored candidates are the same release.
 * @returns {{ duplicate:boolean, rule:string, similarity:number }}
 */
export function duplicateVerdict(a, b) {
  const hashA = normalizedHash(a.stream);
  const hashB = normalizedHash(b.stream);
  if (hashA && hashB && hashA === hashB) {
    const fileA = a.features.release.fileFingerprint;
    const fileB = b.features.release.fileFingerprint;
    // 'whole' means the provider told us nothing about which file it points at.
    // Unknown is not a conflict: only two *known, different* files inside the same
    // torrent are genuinely different videos (e.g. S03E05 vs S03E06).
    const bothKnown = fileA !== 'whole' && fileB !== 'whole';
    if (bothKnown && fileA !== fileB) {
      return { duplicate: false, rule: 'infohash_different_file', similarity: 0 };
    }
    return { duplicate: true, rule: 'infohash_and_file', similarity: 1 };
  }

  const urlA = canonicalPlaybackUrl(a.stream.url);
  const urlB = canonicalPlaybackUrl(b.stream.url);
  if (urlA && urlB && urlA === urlB) {
    return { duplicate: true, rule: 'canonical_url', similarity: 1 };
  }

  if (!releasesCompatible(a.features, b.features)) {
    return { duplicate: false, rule: 'incompatible_fields', similarity: 0 };
  }

  const tokensA = a.features.release.canonicalTokens;
  const tokensB = b.features.release.canonicalTokens;
  const similarity = jaccard(tokensA, tokensB);

  const groupA = a.features.release.releaseGroup;
  const groupB = b.features.release.releaseGroup;
  if (groupA && groupB && groupA === groupB
    && similarity >= JACCARD.GROUP
    && sizeRatioWithin(a.features, b.features, SIZE_RATIO.GROUP)) {
    return { duplicate: true, rule: 'release_group', similarity };
  }

  const unionSize = new Set([...tokensA, ...tokensB]).size;
  if (unionSize >= 6) {
    if (similarity >= JACCARD.LARGE_UNION && sizeRatioWithin(a.features, b.features, SIZE_RATIO.LARGE_UNION)) {
      return { duplicate: true, rule: 'jaccard_large_union', similarity };
    }
  } else if (unionSize >= 3) {
    if (similarity >= JACCARD.MID_UNION && sizeRatioWithin(a.features, b.features, SIZE_RATIO.MID_UNION)) {
      return { duplicate: true, rule: 'jaccard_mid_union', similarity };
    }
  } else if (unionSize > 0) {
    const sigA = [...tokensA].sort().join('|');
    const sigB = [...tokensB].sort().join('|');
    if (sigA === sigB && sizeRatioWithin(a.features, b.features, SIZE_RATIO.TINY_UNION)) {
      return { duplicate: true, rule: 'exact_signature', similarity };
    }
  }

  return { duplicate: false, rule: 'below_threshold', similarity };
}

function minhashSignature(tokens) {
  const signature = new Array(MINHASH_VALUES).fill(0xffffffff);
  for (const token of tokens) {
    for (let i = 0; i < MINHASH_VALUES; i++) {
      const value = fnv1a(token, MINHASH_SEEDS[i]);
      if (value < signature[i]) signature[i] = value;
    }
  }
  return signature;
}

/**
 * Propose candidate pairs via banded LSH. Exact hash/URL and shared
 * release-group pairs are always proposed so cheap certainties never depend on
 * the approximation.
 */
function proposePairsViaLsh(candidates) {
  const pairs = new Set();
  const addPair = (i, j) => pairs.add(i < j ? `${i}|${j}` : `${j}|${i}`);

  const signatures = candidates.map(c => minhashSignature(c.features.release.canonicalTokens));
  for (let band = 0; band < LSH_BANDS; band++) {
    const buckets = new Map();
    for (let i = 0; i < candidates.length; i++) {
      const slice = signatures[i].slice(band * LSH_ROWS, band * LSH_ROWS + LSH_ROWS).join(',');
      const key = `${band}:${slice}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(i);
      else buckets.set(key, [i]);
    }
    for (const bucket of buckets.values()) {
      if (bucket.length < 2 || bucket.length > 40) continue;
      for (let x = 0; x < bucket.length; x++) {
        for (let y = x + 1; y < bucket.length; y++) addPair(bucket[x], bucket[y]);
      }
    }
  }

  const byHash = new Map();
  const byUrl = new Map();
  const byGroup = new Map();
  for (let i = 0; i < candidates.length; i++) {
    const hash = normalizedHash(candidates[i].stream);
    if (hash) {
      const list = byHash.get(hash) || [];
      list.push(i);
      byHash.set(hash, list);
    }
    const url = canonicalPlaybackUrl(candidates[i].stream.url);
    if (url) {
      const list = byUrl.get(url) || [];
      list.push(i);
      byUrl.set(url, list);
    }
    const group = candidates[i].features.release.releaseGroup;
    if (group) {
      const list = byGroup.get(group) || [];
      list.push(i);
      byGroup.set(group, list);
    }
  }
  for (const map of [byHash, byUrl, byGroup]) {
    for (const list of map.values()) {
      if (list.length < 2 || list.length > 60) continue;
      for (let x = 0; x < list.length; x++) {
        for (let y = x + 1; y < list.length; y++) addPair(list[x], list[y]);
      }
    }
  }

  return pairs;
}

/**
 * Stable ordering for representative choice: score, then availability, then
 * trust, then provider, then a hash of the locator. Fully deterministic, so
 * arrival order can never change which variant is shown.
 */
function representativeOrder(a, b) {
  if (b.baseScore !== a.baseScore) return b.baseScore - a.baseScore;
  if (b.features.F !== a.features.F) return b.features.F - a.features.F;
  if (b.features.T !== a.features.T) return b.features.T - a.features.T;
  if (a.features.providerId !== b.features.providerId) {
    return a.features.providerId < b.features.providerId ? -1 : 1;
  }
  return a.locatorHash < b.locatorHash ? -1 : a.locatorHash > b.locatorHash ? 1 : 0;
}

/**
 * Cluster scored candidates into same-release groups and pick one
 * representative per cluster.
 *
 * @param {Array} scored candidates with `{ stream, features, baseScore, locatorHash }`
 * @returns {{ representatives:Array, clusters:Array, stats:object }}
 */
export function deduplicateCandidates(scored) {
  const ordered = [...scored].sort(representativeOrder);
  const n = ordered.length;
  const stats = { input: n, clusters: 0, merged: 0, mode: n > LSH_THRESHOLD ? 'lsh' : 'exact', rules: {} };
  if (n === 0) return { representatives: [], clusters: [], stats };

  const proposed = n > LSH_THRESHOLD ? proposePairsViaLsh(ordered) : null;
  const anchors = [];
  const assignment = new Array(n).fill(-1);

  for (let i = 0; i < n; i++) {
    let bestAnchor = -1;
    let bestSimilarity = -1;
    let bestRule = null;

    for (let a = 0; a < anchors.length; a++) {
      const anchorIndex = anchors[a].index;
      if (proposed) {
        const key = anchorIndex < i ? `${anchorIndex}|${i}` : `${i}|${anchorIndex}`;
        if (!proposed.has(key)) continue;
      }
      const verdict = duplicateVerdict(ordered[anchorIndex], ordered[i]);
      if (!verdict.duplicate) continue;
      if (verdict.similarity > bestSimilarity) {
        bestSimilarity = verdict.similarity;
        bestAnchor = a;
        bestRule = verdict.rule;
      }
    }

    if (bestAnchor >= 0) {
      anchors[bestAnchor].members.push(i);
      assignment[i] = bestAnchor;
      stats.merged++;
      stats.rules[bestRule] = (stats.rules[bestRule] || 0) + 1;
    } else {
      anchors.push({ index: i, members: [i] });
      assignment[i] = anchors.length - 1;
    }
  }

  stats.clusters = anchors.length;
  const clusters = anchors.map((anchor, id) => {
    const representative = ordered[anchor.index];
    const variants = anchor.members.map(m => ordered[m]);
    representative.clusterId = id;
    representative.clusterSize = variants.length;
    representative.clusterVariants = variants;
    return { id, representative, variants };
  });

  return { representatives: clusters.map(c => c.representative), clusters, stats };
}

export { minhashSignature, normalizedHash, sizeRatio, MINHASH_SEEDS };
