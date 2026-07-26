/**
 * Stage 1: latency-bounded retrieval, plus the deterministic ranking pipeline.
 *
 * Retrieval maximizes recall inside a fixed collection cutoff; it does not rank.
 * Two properties matter more than raw speed here:
 *
 *   1. Determinism. Results are sorted by provider/query-mode/locator before
 *      scoring, so whichever upstream happens to answer first cannot change the
 *      output. The old count-based early stop is gone for the same reason: a full
 *      list is not proof the better providers replied.
 *   2. Provenance. Every row records which query produced it, which is what lets
 *      match confidence distinguish "canonical ID hit" from "fuzzy text hit".
 */
import fetch from 'node-fetch';
import crypto from 'node:crypto';
import { getContentMeta, buildSearchTitles, isDubbedQuery } from './search.js';
import { isNoticeStream, getTextForAnalysis } from './utils.js';
import { debugLog } from './debugLog.js';
import {
  getExtraStreamIds,
  planExtraStreamFanout,
  planAliasFanoutPhases,
  isIdResolveShadow,
  logShadowResolve,
} from './idResolve.js';
import { titleTokens } from './titleMatch.js';
import {
  resolveProvider, providerSupportsTextSearch, QUERY_MODE, QUERY_MODE_PRIORITY,
} from './providerCapabilities.js';
import { loadTrustSnapshot, currentSnapshot } from './providerTrust.js';
import { extractFeatures } from './streamFeatures.js';
import { deduplicateCandidates } from './streamDedup.js';
import { resolveProfile, scoreCandidates, scoreBreakdown } from './streamRanker.js';
import { selectStreams } from './streamSelector.js';
import { versionBundle } from './versions.js';

/** Concurrency ceilings: protect upstreams and keep the tail latency bounded. */
const GLOBAL_INFLIGHT_CAP = 24;
const PER_PROVIDER_INFLIGHT_CAP = 2;

/** Hard per-upstream deadline, independent of the overall cutoff. */
const PER_REQUEST_DEADLINE_MS = 4000;

/** Budget reserved for parsing, scoring, selection, and serialization. */
const RANKING_RESERVE_MS = 1500;

/** Ranker input ceiling. Above this, prune by cheap score with per-provider fairness. */
const MAX_RANKER_CANDIDATES = 500;
const MIN_PER_PROVIDER_KEEP = 5;

/**
 * Backwards-compatible size ceiling helper.
 * Kept exported because the Kodi path and tests still reason in these terms.
 */
export function resolveSizeLimitGB(type, isEpisode, profileMaxSizeGB) {
  if (!Number.isFinite(profileMaxSizeGB)) return Infinity;
  const isShow = isEpisode || type === 'series' || type === 'anime';
  return Math.min(profileMaxSizeGB, isShow ? 10 : 30);
}

function addonHost(url) {
  try {
    return new URL(String(url).replace(/\/manifest\.json$/i, '').replace(/\/$/, '')).hostname;
  } catch {
    return String(url).slice(0, 40);
  }
}

function queryHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 10);
}

/**
 * Bounded task runner honoring a global cap, a per-provider cap, and a wall-clock
 * cutoff. Tasks that cannot start before the cutoff are dropped rather than
 * queued, so a slow provider cannot push the response past the Vercel ceiling.
 */
class RetrievalScheduler {
  constructor({ deadlineAt }) {
    this.deadlineAt = deadlineAt;
    this.globalActive = 0;
    this.perProvider = new Map();
    this.queue = [];
    this.pending = [];
    this.dropped = 0;
  }

  remainingMs() {
    return this.deadlineAt - Date.now();
  }

  submit(providerKey, taskFactory) {
    const settled = new Promise((resolve) => {
      this.queue.push({ providerKey, taskFactory, resolve });
    });
    this.pending.push(settled);
    this.#drain();
    return settled;
  }

  #drain() {
    while (this.globalActive < GLOBAL_INFLIGHT_CAP) {
      const index = this.queue.findIndex(item =>
        (this.perProvider.get(item.providerKey) || 0) < PER_PROVIDER_INFLIGHT_CAP
      );
      if (index === -1) break;
      const [item] = this.queue.splice(index, 1);

      if (this.remainingMs() <= 0) {
        this.dropped++;
        item.resolve([]);
        continue;
      }

      this.globalActive++;
      this.perProvider.set(item.providerKey, (this.perProvider.get(item.providerKey) || 0) + 1);

      Promise.resolve()
        .then(item.taskFactory)
        .catch(() => [])
        .then((result) => {
          this.globalActive--;
          this.perProvider.set(item.providerKey, (this.perProvider.get(item.providerKey) || 1) - 1);
          item.resolve(Array.isArray(result) ? result : []);
          this.#drain();
        });
    }
  }

  /** Wait for all submitted work, or the cutoff, whichever comes first. */
  async settle() {
    const remaining = Math.max(0, this.remainingMs());
    await Promise.race([
      Promise.allSettled(this.pending),
      new Promise(resolve => setTimeout(resolve, remaining)),
    ]);
  }
}

/**
 * Build the retrieval plan. Query modes are only scheduled for providers whose
 * capability entry declares support, so we stop paying for requests that a
 * provider structurally cannot answer.
 */
export function buildRetrievalPlan({ addons, idWithExt, type, contentMeta, resolvedCtx, queryHint }) {
  const providers = addons.map(url => ({ url, provider: resolveProvider(url, { configured: true }) }));
  const plan = [];

  for (const { url, provider } of providers) {
    plan.push({
      url,
      provider,
      queryMode: QUERY_MODE.CANONICAL_ID,
      idWithExt,
      phase: 'immediate',
    });
  }

  // A mapped anime ID is only fully trustworthy when the episode coordinate was
  // also translated (multi-cour shows renumber episodes). Movies need no episode
  // mapping, so their mapped ID counts as verified on its own.
  const isEpisodeRequest = idWithExt.replace(/\.json$/i, '').split(':').length >= 3;
  const episodeMappingVerified = !isEpisodeRequest
    || Object.keys(resolvedCtx?.episodeMaps || {}).length > 0;

  const extraIds = getExtraStreamIds(resolvedCtx);
  for (const entry of planExtraStreamFanout(addons, extraIds)) {
    plan.push({
      url: entry.url,
      provider: resolveProvider(entry.url, { configured: true }),
      queryMode: QUERY_MODE.MAPPED_ID,
      idWithExt: entry.extraId,
      episodeMappingVerified,
      phase: 'immediate',
    });
  }

  const titles = contentMeta ? buildSearchTitles(contentMeta, queryHint) : [];
  const primaryTitle = titles[0] || null;
  if (primaryTitle) {
    for (const { url, provider } of providers) {
      if (!providerSupportsTextSearch(provider)) continue;
      plan.push({
        url,
        provider,
        queryMode: QUERY_MODE.PRIMARY_TITLE,
        idWithExt: `search=${encodeURIComponent(primaryTitle)}.json`,
        searchTitle: primaryTitle,
        phase: 'immediate',
      });
    }
  }

  const { immediate: aliasImmediate, deferred: aliasDeferred } =
    planAliasFanoutPhases(addons, resolvedCtx, titles);
  for (const entry of aliasImmediate) {
    plan.push({
      url: entry.url,
      provider: resolveProvider(entry.url, { configured: true }),
      queryMode: QUERY_MODE.ALIAS_TITLE,
      idWithExt: `search=${encodeURIComponent(entry.searchTitle)}.json`,
      searchTitle: entry.searchTitle,
      phase: 'immediate',
    });
  }
  for (const entry of aliasDeferred) {
    plan.push({
      url: entry.url,
      provider: resolveProvider(entry.url, { configured: true }),
      queryMode: QUERY_MODE.ALIAS_TITLE,
      idWithExt: `search=${encodeURIComponent(entry.searchTitle)}.json`,
      searchTitle: entry.searchTitle,
      phase: 'deferred',
    });
  }

  for (const title of titles.slice(1)) {
    for (const { url, provider } of providers) {
      if (!providerSupportsTextSearch(provider)) continue;
      plan.push({
        url,
        provider,
        queryMode: QUERY_MODE.EXTRA_LANGUAGE,
        idWithExt: `search=${encodeURIComponent(title)}.json`,
        searchTitle: title,
        phase: 'deferred',
      });
    }
  }

  return { plan, titles, primaryTitle };
}

/** Execute one planned request and stamp immutable provenance on each row. */
async function executePlanEntry(entry, { type, clientUA, clientIp, deadlineAt }) {
  const cleanBaseUrl = entry.url.replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
  const targetUrl = `${cleanBaseUrl}/stream/${type}/${entry.idWithExt}`;
  const budget = Math.min(PER_REQUEST_DEADLINE_MS, Math.max(0, deadlineAt - Date.now()));
  if (budget <= 0) return [];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), budget);
  const started = Date.now();
  try {
    const response = await fetch(targetUrl, {
      signal: controller.signal,
      // Forward the viewer's real IP so debrid services mint links bound to the
      // device that will actually play them.
      headers: { 'User-Agent': clientUA, 'X-Forwarded-For': clientIp },
    });
    if (!response.ok) {
      debugLog('H1', 'lib/streamEngine.js:executePlanEntry', 'addon non-ok', {
        host: cleanBaseUrl, mode: entry.queryMode, status: response.status, ms: Date.now() - started,
      });
      return [];
    }
    const data = await response.json();
    if (!data || !Array.isArray(data.streams)) return [];

    const latency = Date.now() - started;
    const rows = [];
    let noticeCount = 0;
    for (const stream of data.streams) {
      if (!stream || typeof stream !== 'object') continue;
      if (isNoticeStream(stream)) {
        noticeCount++;
        continue;
      }
      stream._sourceBaseUrl = entry.url;
      stream._provenance = Object.freeze({
        providerId: entry.provider.providerId,
        providerFamily: entry.provider.family,
        queryMode: entry.queryMode,
        queryHash: queryHash(entry.idWithExt),
        episodeMappingVerified: !!entry.episodeMappingVerified,
        responseStatus: response.status,
        latencyMs: latency,
      });
      rows.push(stream);
    }
    debugLog('H1', 'lib/streamEngine.js:executePlanEntry', 'addon ok', {
      host: cleanBaseUrl, mode: entry.queryMode, count: rows.length, noticeDropped: noticeCount, ms: latency,
    });
    if (noticeCount > 0) {
      console.log(`[ESAY STREAM] 🧹 סוננו ${noticeCount} שורות הודעה/פרסום (לא תוכן) ממקור: ${cleanBaseUrl}`);
    }
    return rows;
  } catch (err) {
    debugLog('H1', 'lib/streamEngine.js:executePlanEntry', 'addon error/abort', {
      host: cleanBaseUrl, mode: entry.queryMode, err: String(err?.name || err), ms: Date.now() - started,
    });
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Deterministic ordering of raw rows. Applied before any scoring so parallel
 * completion order is discarded entirely.
 */
function sortRawDeterministically(rows) {
  return rows
    .map((stream, index) => ({ stream, index }))
    .sort((a, b) => {
      const pa = a.stream._provenance || {};
      const pb = b.stream._provenance || {};
      if (pa.providerId !== pb.providerId) return (pa.providerId || '') < (pb.providerId || '') ? -1 : 1;
      const qa = QUERY_MODE_PRIORITY[pa.queryMode] ?? 9;
      const qb = QUERY_MODE_PRIORITY[pb.queryMode] ?? 9;
      if (qa !== qb) return qa - qb;
      const la = a.stream.url || a.stream.infoHash || a.stream.externalUrl || '';
      const lb = b.stream.url || b.stream.infoHash || b.stream.externalUrl || '';
      if (la !== lb) return la < lb ? -1 : 1;
      const ta = String(a.stream.title || a.stream.name || '');
      const tb = String(b.stream.title || b.stream.name || '');
      if (ta !== tb) return ta < tb ? -1 : 1;
      return a.index - b.index;
    })
    .map(entry => entry.stream);
}

/**
 * Cheap pre-rank score used only to bound the ranker input on very large lists.
 * Intentionally crude: it decides who gets fully evaluated, not final order.
 */
function cheapScore(stream) {
  const text = getTextForAnalysis(stream);
  let score = 0;
  if (stream.url) score += 3;
  if (stream.infoHash) score += 1;
  if (/2160p|4k|uhd/.test(text)) score += 3;
  else if (/1080p|fhd/.test(text)) score += 2;
  else if (/720p/.test(text)) score += 1;
  if (/remux|bluray/.test(text)) score += 2;
  if (/web[\s._-]?dl/.test(text)) score += 1;
  const provenance = stream._provenance || {};
  if (provenance.queryMode === QUERY_MODE.CANONICAL_ID) score += 2;
  return score;
}

/**
 * Bound ranker input while guaranteeing every provider keeps representation, so
 * a single chatty upstream cannot crowd out a small high-quality one.
 */
function pruneCandidates(rows) {
  if (rows.length <= MAX_RANKER_CANDIDATES) return { rows, pruned: 0 };

  const byProvider = new Map();
  for (const stream of rows) {
    const key = stream._provenance?.providerId || 'unknown';
    const list = byProvider.get(key) || [];
    list.push(stream);
    byProvider.set(key, list);
  }

  const kept = [];
  const overflow = [];
  for (const key of [...byProvider.keys()].sort()) {
    const list = byProvider.get(key)
      .map(stream => ({ stream, score: cheapScore(stream) }))
      .sort((a, b) => b.score - a.score);
    list.slice(0, MIN_PER_PROVIDER_KEEP).forEach(entry => kept.push(entry.stream));
    list.slice(MIN_PER_PROVIDER_KEEP).forEach(entry => overflow.push(entry));
  }

  overflow.sort((a, b) => b.score - a.score);
  for (const entry of overflow) {
    if (kept.length >= MAX_RANKER_CANDIDATES) break;
    kept.push(entry.stream);
  }
  return { rows: sortRawDeterministically(kept), pruned: rows.length - kept.length };
}

/**
 * Feature extraction + scoring + dedup + selection.
 * Pure and synchronous: given the same rows and context it always produces the
 * same list, which is what makes the pipeline testable and auditable.
 */
export function rankAndSelect(rawRows, context) {
  const profile = context.profile;
  const started = Date.now();

  const ordered = sortRawDeterministically(rawRows);
  const candidates = ordered.map(stream => ({
    stream,
    features: extractFeatures(stream, {
      provider: resolveProvider(stream._sourceBaseUrl, { configured: true }),
      expectedTitles: context.expectedTitles,
      requestedTitleTokens: context.requestedTitleTokens,
      runtimeMinutes: context.runtimeMinutes,
      isEpisode: context.isEpisode,
      clientClass: profile.clientClass,
      originalLanguage: context.originalLanguage,
      trustSnapshot: context.trustSnapshot,
      isNotice: false,
    }),
  }));

  const featureMs = Date.now() - started;
  const { scored, rejected } = scoreCandidates(candidates, profile, context.isEpisode);

  const dedupStart = Date.now();
  const { representatives, clusters, stats: dedupStats } = deduplicateCandidates(scored);
  const dedupMs = Date.now() - dedupStart;

  const selectStart = Date.now();
  const { selected, stats: selectStats } = selectStreams(representatives, profile);
  const selectMs = Date.now() - selectStart;

  return {
    selected,
    representatives,
    clusters,
    rejected,
    diagnostics: {
      ...versionBundle(context.trustSnapshot?.version),
      profile: profile.name,
      rawCount: rawRows.length,
      candidateCount: candidates.length,
      eligibleCount: scored.length,
      rejectedCount: rejected.length,
      dedup: dedupStats,
      selection: selectStats,
      timings: { featureMs, dedupMs, selectMs, totalMs: Date.now() - started },
    },
  };
}

/**
 * Full stream pipeline: retrieve, then rank and select.
 *
 * @returns {{ selected:Array, diagnostics:object, context:object }}
 */
export async function retrieveRankAndSelect(type, idWithExt, context) {
  const {
    addons, clientUA, clientIp, queryHint = '',
    profileName = 'friends_light',
    idResolveContext = null,
    idResolvePromise = null,
  } = context;

  const profile = context.profile || resolveProfile(profileName);
  const id = idWithExt.replace(/\.json$/i, '');
  const isEpisode = id.split(':').length >= 3;
  const startedAt = Date.now();
  const cutoff = Math.min(
    profile.collectionCutoffMs,
    Math.max(1000, profile.timeoutMs - RANKING_RESERVE_MS),
  );
  const deadlineAt = startedAt + cutoff;

  // Metadata, ID resolution, and the trust snapshot all run alongside the base
  // canonical-ID fan-out; none of them may delay it.
  const metaPromise = (id.startsWith('tt') || id.startsWith('tmdb:'))
    ? getContentMeta(type, id).catch(() => null)
    : Promise.resolve(null);
  const trustPromise = loadTrustSnapshot().catch(() => currentSnapshot());
  const resolvePromise = idResolveContext
    ? Promise.resolve(idResolveContext)
    : (idResolvePromise || Promise.resolve(null));

  const scheduler = new RetrievalScheduler({ deadlineAt });
  const collected = [];
  const pushRows = (rows) => {
    if (Array.isArray(rows) && rows.length) collected.push(...rows);
  };

  const providers = addons.map(url => ({ url, provider: resolveProvider(url, { configured: true }) }));
  for (const { url, provider } of providers) {
    scheduler
      .submit(provider.providerId, () => executePlanEntry(
        { url, provider, queryMode: QUERY_MODE.CANONICAL_ID, idWithExt },
        { type, clientUA, clientIp, deadlineAt },
      ))
      .then(pushRows);
  }

  const [contentMeta, resolvedCtx] = await Promise.all([
    metaPromise,
    resolvePromise.catch(() => null),
  ]);
  if (resolvedCtx && isIdResolveShadow()) logShadowResolve(resolvedCtx);

  const { plan, titles } = buildRetrievalPlan({
    addons, idWithExt, type, contentMeta, resolvedCtx, queryHint,
  });

  for (const entry of plan) {
    if (entry.queryMode === QUERY_MODE.CANONICAL_ID) continue;
    scheduler
      .submit(entry.provider.providerId, () => executePlanEntry(entry, { type, clientUA, clientIp, deadlineAt }))
      .then(pushRows);
  }

  await scheduler.settle();
  const trustSnapshot = await Promise.race([
    trustPromise,
    new Promise(resolve => setTimeout(() => resolve(currentSnapshot()), 50)),
  ]).catch(() => currentSnapshot());

  const expectedTitles = [...new Set([
    ...titles,
    contentMeta?.original,
    contentMeta?.he,
    ...(resolvedCtx?.aliasSearchTitles || []),
    resolvedCtx?.row?.primary_title,
  ].filter(Boolean))];

  const requestedTitleTokens = new Set();
  for (const title of expectedTitles) {
    for (const token of titleTokens(title)) requestedTitleTokens.add(token);
  }

  const { rows, pruned } = pruneCandidates(collected);
  console.log(
    `[ESAY STREAM] ⏱️ cutoff=${cutoff}ms elapsed=${Date.now() - startedAt}ms` +
    ` raw=${collected.length} ranked=${rows.length} pruned=${pruned}` +
    ` dropped=${scheduler.dropped} profile=${profile.name}`
  );

  const result = rankAndSelect(rows, {
    profile,
    expectedTitles,
    requestedTitleTokens: [...requestedTitleTokens],
    runtimeMinutes: contentMeta?.runtimeMin || null,
    originalLanguage: contentMeta?.originalLanguage || null,
    isEpisode,
    trustSnapshot,
  });

  result.diagnostics.retrieval = {
    cutoffMs: cutoff,
    elapsedMs: Date.now() - startedAt,
    plannedRequests: plan.length,
    droppedRequests: scheduler.dropped,
    prunedCandidates: pruned,
  };
  result.context = {
    isEpisode, contentMeta, expectedTitles, profile,
    trustSnapshotVersion: trustSnapshot?.version || 'static-priors',
  };
  return result;
}

/**
 * Legacy-shaped entry point.
 *
 * Returns a plain array of selected streams so existing callers keep working;
 * `retrieveRankAndSelect` is preferred when diagnostics or cluster data is needed.
 */
export async function fetchAndSortStreams(type, idWithExt, context) {
  const profile = context.profile || resolveProfile(context.profileName || 'friends_light');
  const result = await retrieveRankAndSelect(type, idWithExt, { ...context, profile });
  for (const candidate of result.selected) {
    candidate.stream._score = candidate.baseScore;
    candidate.stream._features = candidate.features;
    candidate.stream._scoreBreakdown = scoreBreakdown(candidate.features, profile);
  }
  return result.selected.map(candidate => candidate.stream);
}

export { RetrievalScheduler, sortRawDeterministically, pruneCandidates, cheapScore };
