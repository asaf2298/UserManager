/**
 * Content ID resolver (Phase 0–4).
 *
 * Reads merged mapping rows from Supabase. When disabled or on any failure,
 * returns null so callers keep today's behavior unchanged.
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — required when enabled
 *   SUPABASE_ANON_KEY — optional read-only fallback (personal_* SELECT policies)
 *   ID_RESOLVE_ENABLED=true|false (default false)
 *   ID_RESOLVE_SHADOW=true|false (default false) — log only, no query changes
 *   ID_RESOLVE_QUERY=true|false (default false) — Phase 2: additive mal/kitsu fan-out
 *   ID_RESOLVE_EPISODE=true|false (default false) — Phase 3: AniBridge episode remap on extras
 *   ID_RESOLVE_ALIAS=true|false (default false) — Phase 4: conservative synonym text search
 *   ID_RESOLVE_TIMEOUT_MS (default 400)
 *   ID_RESOLVE_MAX_EXTRA_FETCHES (default 4) — cap total extra addon requests
 *   ID_RESOLVE_MAX_ALIAS_SEARCHES (default 1) — cap alias text searches per stream
 *   ID_RESOLVE_ANIME_ADDON_PATTERNS — comma host substrings (default torrentio,comet,…)
 *   ID_RESOLVE_CACHE_TTL_MS (default 300000) — in-memory resolve cache TTL
 */
import fetch from 'node-fetch';
import { mapEpisodeInStoredRange } from './episodeRanges.js';
import { resolveProvider, providerSupportsAnimeIds } from './providerCapabilities.js';
import {
  detectTitleLanguage,
  preferredAliasLanguages,
  isRomajiLike,
} from './titleLanguage.js';

const DEFAULT_TIMEOUT_MS = 400;
const DEFAULT_MAX_EXTRA_FETCHES = 4;
const DEFAULT_MAX_ALIAS_SEARCHES = 1;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
/** @type {Map<string, { at: number, context: object }>} */
const resolveCache = new Map();

function envFlag(name, defaultValue = false) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultValue;
  return v === 'true' || v === '1';
}

export function isIdResolveEnabled() {
  return envFlag('ID_RESOLVE_ENABLED', false);
}

export function isIdResolveShadow() {
  return envFlag('ID_RESOLVE_SHADOW', false);
}

/** Phase 2: additive mal/kitsu stream id fan-out (never replaces tt). */
export function isIdResolveQueryEnabled() {
  return envFlag('ID_RESOLVE_QUERY', false);
}

/** Phase 3: apply AniBridge episode remap to mal/kitsu extras (shadow always shows mapped). */
export function isIdResolveEpisodeEnabled() {
  return envFlag('ID_RESOLVE_EPISODE', false);
}

/** Phase 4: additive synonym text search on anime-capable addons (never replaces tt or primary title). */
export function isIdResolveAliasEnabled() {
  return envFlag('ID_RESOLVE_ALIAS', false);
}

function resolveTimeoutMs() {
  const n = Number(process.env.ID_RESOLVE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

function maxExtraFetches() {
  const n = Number(process.env.ID_RESOLVE_MAX_EXTRA_FETCHES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_EXTRA_FETCHES;
}

function maxAliasSearches() {
  const n = Number(process.env.ID_RESOLVE_MAX_ALIAS_SEARCHES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_ALIAS_SEARCHES;
}

/** Configured alias text-search cap (1 = immediate only; 2 = +1 deferred when thin). */
export function getMaxAliasSearches() {
  return maxAliasSearches();
}

function resolveCacheTtlMs() {
  const n = Number(process.env.ID_RESOLVE_CACHE_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CACHE_TTL_MS;
}

function animeAddonPatterns() {
  const raw = process.env.ID_RESOLVE_ANIME_ADDON_PATTERNS;
  if (raw && raw.trim()) {
    return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  }
  return null;
}

/**
 * Can this provider answer mal:/kitsu: stream ids?
 *
 * Authority is the provider capability registry, so anime support is declared
 * once per provider family instead of maintained as a hostname substring list in
 * several files. `ID_RESOLVE_ANIME_ADDON_PATTERNS` still works as an operational
 * override for testing an unlisted addon without a deploy.
 */
export function isAnimeCapableAddonUrl(url) {
  const override = animeAddonPatterns();
  if (override) {
    const u = (url || '').toLowerCase();
    return override.some(pattern => u.includes(pattern));
  }
  return providerSupportsAnimeIds(resolveProvider(url, { configured: true }));
}

function resolveCacheKey(parsed) {
  const s = parsed.season !== undefined ? parsed.season : '';
  const e = parsed.episode !== undefined ? parsed.episode : '';
  return `${parsed.imdbId}:${s}:${e}`;
}

function getCachedContext(parsed) {
  const key = resolveCacheKey(parsed);
  const hit = resolveCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > resolveCacheTtlMs()) {
    resolveCache.delete(key);
    return null;
  }
  return hit.context;
}

function setCachedContext(parsed, context) {
  if (!context) return;
  const key = resolveCacheKey(parsed);
  resolveCache.set(key, { at: Date.now(), context });
  if (resolveCache.size > 500) {
    const oldest = resolveCache.keys().next().value;
    if (oldest) resolveCache.delete(oldest);
  }
}

function supabaseConfig() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    '';
  if (!url || !key) return null;
  return { url, key };
}

/**
 * Parse Stremio stream/meta id: tt1234567, tt1234567:1:5, optional .json suffix.
 * Non-tt ids return null (Phase 0+1 is imdb-keyed only).
 */
export function parseStremioImdbId(rawIdWithExt) {
  if (!rawIdWithExt) return null;
  const clean = String(rawIdWithExt).replace(/\.json$/i, '');
  const parts = clean.split(':');
  const head = parts[0] || '';
  const m = head.match(/^(tt\d{5,})/i);
  if (!m) return null;
  const season = parts[1] !== undefined && parts[1] !== '' ? Number(parts[1]) : undefined;
  const episode = parts[2] !== undefined && parts[2] !== '' ? Number(parts[2]) : undefined;
  return {
    imdbId: m[1].toLowerCase(),
    season: Number.isFinite(season) ? season : undefined,
    episode: Number.isFinite(episode) ? episode : undefined,
    raw: clean,
  };
}

/**
 * Anime detection uses mapping data, not Stremio request type (series vs anime).
 */
export function isAnimeContent(row) {
  if (!row) return false;
  if (row.category === 'anime') return true;
  return Boolean(row.mal_id || row.kitsu_id || row.anilist_id || row.anidb_id);
}

function rowToIds(row) {
  if (!row) return {};
  const out = {};
  if (row.imdb_id) out.imdb = row.imdb_id;
  if (row.tmdb_id) out.tmdb = row.tmdb_id;
  if (row.tvdb_id) out.tvdb = row.tvdb_id;
  if (row.mal_id) out.mal = row.mal_id;
  if (row.kitsu_id) out.kitsu = row.kitsu_id;
  if (row.anilist_id) out.anilist = row.anilist_id;
  if (row.anidb_id) out.anidb = row.anidb_id;
  return out;
}

/**
 * Build mal:/kitsu: stream path strings.
 * @param {object} episodeMaps — { mal?: {to_provider_id,to_e}, kitsu?: {...} }
 * @param {boolean} useMapped — apply Phase 3 remap when rows exist
 */
export function buildAnimeExtraIds(parsed, row, episodeMaps = {}, useMapped = false) {
  if (!isAnimeContent(row)) return [];
  const ids = rowToIds(row);
  const ep = parsed.episode;
  const extras = [];

  const malMap = episodeMaps.mal;
  const kitsuMap = episodeMaps.kitsu;
  const malId = useMapped && malMap?.to_provider_id ? malMap.to_provider_id : ids.mal;
  const malEp = useMapped && malMap?.to_e != null ? malMap.to_e : ep;
  const kitsuId = useMapped && kitsuMap?.to_provider_id ? kitsuMap.to_provider_id : ids.kitsu;
  const kitsuEp = useMapped && kitsuMap?.to_e != null ? kitsuMap.to_e : ep;

  if (malId) {
    extras.push(malEp !== undefined ? `mal:${malId}:${malEp}` : `mal:${malId}`);
  }
  if (kitsuId) {
    extras.push(kitsuEp !== undefined ? `kitsu:${kitsuId}:${kitsuEp}` : `kitsu:${kitsuId}`);
  }
  return extras;
}

function buildShadowPlan(parsed, row, stremioType, episodeMaps = {}, aliasTitles = []) {
  const ids = rowToIds(row);
  const anime = isAnimeContent(row);
  const queries = [];
  const rawExtras = buildAnimeExtraIds(parsed, row, {}, false);
  const mappedExtras = buildAnimeExtraIds(parsed, row, episodeMaps, true);

  if (parsed.imdbId) {
    if (parsed.season !== undefined && parsed.episode !== undefined) {
      queries.push(`imdb:${parsed.imdbId}:${parsed.season}:${parsed.episode}`);
    } else {
      queries.push(`imdb:${parsed.imdbId}`);
    }
  }
  if (anime) {
    for (const id of mappedExtras) queries.push(id);
  }
  for (const title of aliasTitles) {
    queries.push(`search:${title}`);
  }

  const remapChanged = rawExtras.join('|') !== mappedExtras.join('|');

  return {
    stremioType,
    parsed,
    category: row?.category || 'unknown',
    isAnimeContent: anime,
    ids,
    primaryTitle: row?.primary_title || null,
    synonyms: Array.isArray(row?.titles?.synonyms) ? row.titles.synonyms.slice(0, 5) : [],
    aliasTitles,
    wouldQuery: queries,
    rawExtras,
    mappedExtras,
    episodeRemapChanged: remapChanged,
    episodeMaps,
    sources: row?.sources || [],
  };
}

async function supabaseGet(path, timeoutMs) {
  const cfg = supabaseConfig();
  if (!cfg) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[ID-RESOLVE] Supabase ${res.status} ${path.split('?')[0]}`);
      return null;
    }
    return res.json();
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'timeout' : e.message;
    console.warn(`[ID-RESOLVE] lookup failed (${path.split('?')[0]}): ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTitleByImdb(imdbId, timeoutMs) {
  const params = new URLSearchParams({
    select: 'imdb_id,tmdb_id,tvdb_id,mal_id,kitsu_id,anilist_id,anidb_id,media_type,category,origin_countries,primary_title,titles,sources,hints,is_date_based,is_absolute_ep',
    imdb_id: `eq.${imdbId}`,
    limit: '1',
  });
  const rows = await supabaseGet(`personal_titles?${params}`, timeoutMs);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/**
 * Episode remap rows for Stremio S/E → mal/kitsu provider id + episode.
 * Supports compact range rows (from_e..to_s → to_e offset) and legacy single-episode rows.
 * @returns {Promise<{ mal?: object, kitsu?: object }>}
 */
async function fetchEpisodeMaps(imdbId, season, episode, timeoutMs) {
  if (season === undefined || episode === undefined) return {};

  const params = new URLSearchParams({
    select: 'scheme_to,to_provider_id,to_e,from_e,to_s',
    imdb_id: `eq.${imdbId}`,
    from_s: `eq.${season}`,
    from_e: `lte.${episode}`,
    to_s: `gte.${episode}`,
    source: 'eq.anibridge',
  });
  const rows = await supabaseGet(`personal_episode_map?${params}`, timeoutMs);
  if (!Array.isArray(rows) || !rows.length) {
    const exactParams = new URLSearchParams({
      select: 'scheme_to,to_provider_id,to_e,from_e,to_s',
      imdb_id: `eq.${imdbId}`,
      from_s: `eq.${season}`,
      from_e: `eq.${episode}`,
      source: 'eq.anibridge',
    });
    const exactRows = await supabaseGet(`personal_episode_map?${exactParams}`, timeoutMs);
    if (!Array.isArray(exactRows) || !exactRows.length) return {};
    const maps = {};
    for (const row of exactRows) {
      if (row.scheme_to === 'mal' || row.scheme_to === 'kitsu') {
        maps[row.scheme_to] = row;
      }
    }
    return maps;
  }

  const maps = {};
  for (const row of rows) {
    if (row.scheme_to !== 'mal' && row.scheme_to !== 'kitsu') continue;
    const mappedEp = mapEpisodeInStoredRange(episode, row);
    if (mappedEp == null) continue;
    const existing = maps[row.scheme_to];
    const span = (row.to_s ?? row.from_e) - row.from_e;
    const existingSpan = existing ? (existing.to_s ?? existing.from_e) - existing.from_e : Infinity;
    if (!existing || span < existingSpan) {
      maps[row.scheme_to] = { ...row, to_e: mappedEp };
    }
  }
  return maps;
}

async function fetchAliasRows(imdbId, timeoutMs) {
  const params = new URLSearchParams({
    select: 'title,kind,weight,language',
    imdb_id: `eq.${imdbId}`,
    order: 'weight.desc,title.asc',
    limit: '24',
  });
  const rows = await supabaseGet(`personal_akas?${params}`, timeoutMs);
  return Array.isArray(rows) ? rows : [];
}

function normalizeSearchTitle(title) {
  return String(title || '').trim().toLowerCase();
}

/**
 * Score alias for torrent/addon search, biased to origin-country languages.
 * @param {object} row
 * @param {string[]} preferredLangs — e.g. ['ja'] for anime
 */
function aliasUsefulnessScore(row, preferredLangs = []) {
  const title = String(row.title || '').trim();
  const lang = row.language || detectTitleLanguage(title);
  let score = Number(row.weight) || 0;

  if (row.kind === 'display') score += 20;

  if (preferredLangs.length) {
    if (preferredLangs.includes(lang)) score += 80;
    else if (lang === 'latin' && preferredLangs.includes('ja') && isRomajiLike(title)) score += 55;
    else if (lang === 'latin' && preferredLangs.includes('ja')) score += 25;
    else if (lang === 'latin') score += 10;
    else score -= 50; // foreign translation relative to origin
  } else {
    const ascii = /^[\x20-\x7E]+$/.test(title);
    const latin = (title.match(/[A-Za-z0-9]/g) || []).length;
    const ratio = latin / Math.max(title.length, 1);
    if (ascii && ratio >= 0.55) score += 45;
    else if (ratio < 0.25) score -= 20;
  }

  // Prefer cleaner native titles: pure-script, no year suffixes, no arc subtitles
  if (lang === 'ja' || lang === 'ko' || lang === 'zh') {
    const nativeRe =
      lang === 'ko' ? /[\uac00-\ud7af]/g
        : lang === 'zh' ? /[\u3400-\u9fff]/g
          : /[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9d]/g;
    const nativeChars = (title.match(nativeRe) || []).length;
    if (nativeChars / Math.max(title.length, 1) >= 0.7) score += 20;
  }
  if (/\(\d{4}\)/.test(title)) score -= 25;
  if (/^\(\d{4}\)/.test(title)) score -= 25;
  if (title.includes('-') && (lang === 'ja' || lang === 'ko' || lang === 'zh')) score -= 10;
  if (title.length >= 4 && title.length <= 8 && !/\s/.test(title) && lang === 'latin') score -= 15;
  if (title.length >= 10 && title.length <= 40) score += 5;
  return score;
}

/**
 * Top alias titles for conservative text search.
 * Prefers origin-country languages (JP→ja/romaji for anime). Never falls through to
 * random EU/ME translations when a native/romaji candidate exists.
 *
 * @param {object[]} aliasRows — from personal_akas
 * @param {string[]} excludeTitles — titles to skip (e.g. TMDB primary)
 * @param {{ preferredLangs?: string[], category?: string, originCountries?: string[] }} [opts]
 */
export function pickAliasSearchTitles(aliasRows, excludeTitles = [], opts = {}) {
  if (!aliasRows?.length) return [];
  const exclude = new Set(excludeTitles.map(normalizeSearchTitle).filter(Boolean));
  const preferredLangs = opts.preferredLangs?.length
    ? opts.preferredLangs
    : preferredAliasLanguages({
      category: opts.category,
      origin_countries: opts.originCountries,
    });

  const candidates = [];
  const seen = new Set();

  for (const row of aliasRows) {
    const title = String(row.title || '').trim();
    const key = normalizeSearchTitle(title);
    if (!title || title.length < 2 || title.length > 120) continue;
    if (exclude.has(key) || seen.has(key)) continue;
    if (title.length < 6 && !/\s/.test(title) && detectTitleLanguage(title) === 'latin') continue;

    const lang = row.language || detectTitleLanguage(title);
    // When we know origin langs, drop unrelated foreign scripts entirely
    if (preferredLangs.length) {
      const ok =
        preferredLangs.includes(lang) ||
        lang === 'latin' ||
        (row.kind === 'display');
      if (!ok) continue;
    }

    seen.add(key);
    candidates.push({ title, lang, score: aliasUsefulnessScore({ ...row, language: lang }, preferredLangs) });
  }

  if (!candidates.length) return [];

  // If any origin-native (ja/ko/…) exists, prefer that pool over plain latin translations
  const native = candidates.filter(c => preferredLangs.includes(c.lang));
  const romaji = candidates.filter(c => c.lang === 'latin' && isRomajiLike(c.title));
  const displayLatin = candidates.filter(c => c.lang === 'latin');
  const pool = native.length
    ? [...native, ...romaji]
    : (romaji.length ? romaji : displayLatin);

  const finalPool = pool.length ? pool : candidates;
  finalPool.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return finalPool.slice(0, maxAliasSearches()).map(c => c.title);
}

function finalizeContext(parsed, row, episodeMaps, aliasRows, stremioType) {
  const rawExtraStreamIds = buildAnimeExtraIds(parsed, row, {}, false);
  const mappedExtraStreamIds = buildAnimeExtraIds(parsed, row, episodeMaps, true);
  const useEpisode = isIdResolveEpisodeEnabled();
  const extraStreamIds = useEpisode ? mappedExtraStreamIds : rawExtraStreamIds;
  const preferredLangs = preferredAliasLanguages(row);
  const aliasSearchTitles = pickAliasSearchTitles(aliasRows, [], {
    preferredLangs,
    category: row?.category,
    originCountries: row?.origin_countries,
  });

  return {
    parsed,
    row,
    episodeMaps,
    aliasRows,
    preferredLangs,
    isAnimeContent: isAnimeContent(row),
    ids: rowToIds(row),
    rawExtraStreamIds,
    mappedExtraStreamIds,
    extraStreamIds,
    aliasSearchTitles,
    shadow: buildShadowPlan(parsed, row, stremioType, episodeMaps, aliasSearchTitles),
  };
}

/**
 * Resolve mapping context for a stream/meta request.
 * Returns null when disabled, unconfigured, non-tt id, missing row, or on error.
 */
export async function resolveContentContext(stremioType, rawIdWithExt) {
  if (!isIdResolveEnabled()) return null;

  const parsed = parseStremioImdbId(rawIdWithExt);
  if (!parsed) return null;

  const cached = getCachedContext(parsed);
  if (cached) {
    return finalizeContext(
      parsed,
      cached.row,
      cached.episodeMaps || {},
      cached.aliasRows || [],
      stremioType
    );
  }

  const timeoutMs = resolveTimeoutMs();
  const needsEpisode =
    parsed.season !== undefined &&
    parsed.episode !== undefined;

  const [row, episodeMaps, aliasRows] = await Promise.all([
    fetchTitleByImdb(parsed.imdbId, timeoutMs),
    needsEpisode
      ? fetchEpisodeMaps(parsed.imdbId, parsed.season, parsed.episode, timeoutMs)
      : Promise.resolve({}),
    fetchAliasRows(parsed.imdbId, timeoutMs),
  ]);

  if (!row) return null;

  const stored = { row, episodeMaps: episodeMaps || {}, aliasRows: aliasRows || [] };
  setCachedContext(parsed, stored);

  return finalizeContext(parsed, row, episodeMaps || {}, aliasRows || [], stremioType);
}

/**
 * Extra Stremio stream paths for additive anime fan-out (mal:/kitsu:).
 * Empty when query flag off or not anime.
 */
export function getExtraStreamIds(context) {
  if (!isIdResolveQueryEnabled() || !context?.isAnimeContent) return [];
  return (context.extraStreamIds || []).slice(0, 2);
}

/**
 * Plan capped additive fan-out: anime-capable addons only, round-robin until max fetches.
 * @returns {{ url: string, extraId: string }[]}
 */
function aliasPickOpts(context) {
  return {
    preferredLangs: context.preferredLangs || preferredAliasLanguages(context.row),
    category: context.row?.category,
    originCountries: context.row?.origin_countries,
  };
}

function buildAliasFanoutPlan(addons, searchTitle) {
  if (!searchTitle) return [];
  const capable = addons.filter(isAnimeCapableAddonUrl);
  return capable.map(url => ({ url, searchTitle }));
}

/**
 * Pick alias titles once; return immediate (1st) and optional deferred (2nd) fan-out plans.
 * @returns {{ immediate: { url: string, searchTitle: string }[], deferred: { url: string, searchTitle: string }[] }}
 */
export function planAliasFanoutPhases(addons, context, excludeTitles = []) {
  if (!isIdResolveAliasEnabled() || !context?.isAnimeContent) {
    return { immediate: [], deferred: [] };
  }
  const ranked = pickAliasSearchTitles(context.aliasRows || [], excludeTitles, aliasPickOpts(context));
  return {
    immediate: buildAliasFanoutPlan(addons, ranked[0]),
    deferred: maxAliasSearches() >= 2 ? buildAliasFanoutPlan(addons, ranked[1]) : [],
  };
}

/**
 * Phase-1 alias text search: at most the top-ranked synonym, fired with ID + primary title.
 * @returns {{ url: string, searchTitle: string }[]}
 */
export function planAliasTextFanout(addons, context, excludeTitles = []) {
  return planAliasFanoutPhases(addons, context, excludeTitles).immediate;
}

/**
 * Deferred alias text search: 2nd-ranked synonym only when ID_RESOLVE_MAX_ALIAS_SEARCHES >= 2.
 * Caller should fire this after the initial burst when results are still thin.
 * @returns {{ url: string, searchTitle: string }[]}
 */
export function planDeferredAliasTextFanout(addons, context, excludeTitles = []) {
  return planAliasFanoutPhases(addons, context, excludeTitles).deferred;
}

export function planExtraStreamFanout(addons, extraStreamIds) {
  if (!extraStreamIds?.length || !addons?.length) return [];

  const capable = addons.filter(isAnimeCapableAddonUrl);
  if (!capable.length) return [];

  const max = maxExtraFetches();
  const plan = [];
  for (const url of capable) {
    for (const extraId of extraStreamIds) {
      if (plan.length >= max) return plan;
      plan.push({ url, extraId: `${extraId}.json` });
    }
  }
  return plan;
}

/** Phase 1: log what we would fan out to without changing behavior. */
export function logShadowResolve(context) {
  if (!context?.shadow) return;
  const s = context.shadow;
  const remapNote = s.episodeRemapChanged
    ? ` | rawExtras=${(s.rawExtras || []).join(' | ')} | mappedExtras=${(s.mappedExtras || []).join(' | ')}`
    : '';
  console.log(
    `[ID-RESOLVE][SHADOW] ${s.parsed.imdbId}` +
      (s.parsed.season !== undefined ? ` S${s.parsed.season}E${s.parsed.episode}` : '') +
      ` | type=${s.stremioType} category=${s.category} anime=${s.isAnimeContent}` +
      ` | ids=${JSON.stringify(s.ids)}` +
      ` | wouldQuery=${s.wouldQuery.join(' | ')}` +
      ` | episode=${isIdResolveEpisodeEnabled() ? 'live' : 'shadow-only'}` +
      ` | alias=${isIdResolveAliasEnabled() ? 'live' : 'shadow-only'}` +
      `${remapNote}` +
      (s.primaryTitle ? ` | title="${s.primaryTitle}"` : '') +
      (s.synonyms.length ? ` | synonyms=${s.synonyms.slice(0, 3).join('; ')}` : '') +
      (s.aliasTitles?.length ? ` | aliasSearch=${s.aliasTitles.join('; ')}` : '')
  );
}
