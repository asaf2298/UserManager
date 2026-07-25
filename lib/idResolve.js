/**
 * Content ID resolver (Phase 0–3).
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
 *   ID_RESOLVE_TIMEOUT_MS (default 400)
 *   ID_RESOLVE_MAX_EXTRA_FETCHES (default 4) — cap total extra addon requests
 *   ID_RESOLVE_ANIME_ADDON_PATTERNS — comma host substrings (default torrentio,comet,…)
 *   ID_RESOLVE_CACHE_TTL_MS (default 300000) — in-memory resolve cache TTL
 */
import fetch from 'node-fetch';

const DEFAULT_TIMEOUT_MS = 400;
const DEFAULT_MAX_EXTRA_FETCHES = 4;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_ANIME_ADDON_PATTERNS = [
  'torrentio',
  'comet',
  'mediafusion',
  'animeil',
  'kan-box',
  'yastream',
  'debridio',
  'knaben',
];

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

function resolveTimeoutMs() {
  const n = Number(process.env.ID_RESOLVE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

function maxExtraFetches() {
  const n = Number(process.env.ID_RESOLVE_MAX_EXTRA_FETCHES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_EXTRA_FETCHES;
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
  return DEFAULT_ANIME_ADDON_PATTERNS;
}

/** Hosts likely to answer mal:/kitsu: stream ids (Torrentio-class addons). */
export function isAnimeCapableAddonUrl(url) {
  const u = (url || '').toLowerCase();
  return animeAddonPatterns().some(pattern => u.includes(pattern));
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

function buildShadowPlan(parsed, row, stremioType, episodeMaps = {}) {
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

  const remapChanged = rawExtras.join('|') !== mappedExtras.join('|');

  return {
    stremioType,
    parsed,
    category: row?.category || 'unknown',
    isAnimeContent: anime,
    ids,
    primaryTitle: row?.primary_title || null,
    synonyms: Array.isArray(row?.titles?.synonyms) ? row.titles.synonyms.slice(0, 5) : [],
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
    select: 'imdb_id,tmdb_id,tvdb_id,mal_id,kitsu_id,anilist_id,anidb_id,media_type,category,primary_title,titles,sources,hints,is_date_based,is_absolute_ep',
    imdb_id: `eq.${imdbId}`,
    limit: '1',
  });
  const rows = await supabaseGet(`personal_titles?${params}`, timeoutMs);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/**
 * Episode remap rows for Stremio S/E → mal/kitsu provider id + episode.
 * @returns {Promise<{ mal?: object, kitsu?: object }>}
 */
async function fetchEpisodeMaps(imdbId, season, episode, timeoutMs) {
  if (season === undefined || episode === undefined) return {};

  const params = new URLSearchParams({
    select: 'scheme_to,to_provider_id,to_e,from_e',
    imdb_id: `eq.${imdbId}`,
    from_s: `eq.${season}`,
    from_e: `eq.${episode}`,
    source: 'eq.anibridge',
  });
  const rows = await supabaseGet(`personal_episode_map?${params}`, timeoutMs);
  if (!Array.isArray(rows) || !rows.length) return {};

  const maps = {};
  for (const row of rows) {
    if (row.scheme_to === 'mal' || row.scheme_to === 'kitsu') {
      maps[row.scheme_to] = row;
    }
  }
  return maps;
}

function finalizeContext(parsed, row, episodeMaps, stremioType) {
  const rawExtraStreamIds = buildAnimeExtraIds(parsed, row, {}, false);
  const mappedExtraStreamIds = buildAnimeExtraIds(parsed, row, episodeMaps, true);
  const useEpisode = isIdResolveEpisodeEnabled();
  const extraStreamIds = useEpisode ? mappedExtraStreamIds : rawExtraStreamIds;

  return {
    parsed,
    row,
    episodeMaps,
    isAnimeContent: isAnimeContent(row),
    ids: rowToIds(row),
    rawExtraStreamIds,
    mappedExtraStreamIds,
    extraStreamIds,
    shadow: buildShadowPlan(parsed, row, stremioType, episodeMaps),
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
    return finalizeContext(parsed, cached.row, cached.episodeMaps || {}, stremioType);
  }

  const timeoutMs = resolveTimeoutMs();
  const needsEpisode =
    parsed.season !== undefined &&
    parsed.episode !== undefined;

  const [row, episodeMaps] = await Promise.all([
    fetchTitleByImdb(parsed.imdbId, timeoutMs),
    needsEpisode
      ? fetchEpisodeMaps(parsed.imdbId, parsed.season, parsed.episode, timeoutMs)
      : Promise.resolve({}),
  ]);

  if (!row) return null;

  const stored = { row, episodeMaps: episodeMaps || {} };
  setCachedContext(parsed, stored);

  return finalizeContext(parsed, row, episodeMaps || {}, stremioType);
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
      ` | episode=${isIdResolveEpisodeEnabled() ? 'live' : 'shadow-only'}${remapNote}` +
      (s.primaryTitle ? ` | title="${s.primaryTitle}"` : '') +
      (s.synonyms.length ? ` | synonyms=${s.synonyms.slice(0, 3).join('; ')}` : '')
  );
}
