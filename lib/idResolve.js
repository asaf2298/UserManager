/**
 * Content ID resolver (Phase 0–2).
 *
 * Reads merged mapping rows from Supabase. When disabled or on any failure,
 * returns null so callers keep today's behavior unchanged.
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — required when enabled
 *   SUPABASE_ANON_KEY — optional read-only fallback (personal_titles SELECT policy)
 *   ID_RESOLVE_ENABLED=true|false (default false)
 *   ID_RESOLVE_SHADOW=true|false (default false) — log only, no query changes
 *   ID_RESOLVE_QUERY=true|false (default false) — Phase 2: additive mal/kitsu fan-out
 *   ID_RESOLVE_TIMEOUT_MS (default 400)
 */
import fetch from 'node-fetch';

const DEFAULT_TIMEOUT_MS = 400;

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

function resolveTimeoutMs() {
  const n = Number(process.env.ID_RESOLVE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
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

function buildAnimeExtraIds(parsed, row) {
  if (!isAnimeContent(row)) return [];
  const ids = rowToIds(row);
  const extras = [];
  const ep = parsed.episode;
  if (ids.mal) {
    extras.push(ep !== undefined ? `mal:${ids.mal}:${ep}` : `mal:${ids.mal}`);
  }
  if (ids.kitsu) {
    extras.push(ep !== undefined ? `kitsu:${ids.kitsu}:${ep}` : `kitsu:${ids.kitsu}`);
  }
  return extras;
}

function buildShadowPlan(parsed, row, stremioType) {
  const ids = rowToIds(row);
  const anime = isAnimeContent(row);
  const queries = [];
  if (parsed.imdbId) {
    if (parsed.season !== undefined && parsed.episode !== undefined) {
      queries.push(`imdb:${parsed.imdbId}:${parsed.season}:${parsed.episode}`);
    } else {
      queries.push(`imdb:${parsed.imdbId}`);
    }
  }
  if (anime) {
    for (const id of buildAnimeExtraIds(parsed, row)) {
      queries.push(id);
    }
  }
  return {
    stremioType,
    parsed,
    category: row?.category || 'unknown',
    isAnimeContent: anime,
    ids,
    primaryTitle: row?.primary_title || null,
    synonyms: Array.isArray(row?.titles?.synonyms) ? row.titles.synonyms.slice(0, 5) : [],
    wouldQuery: queries,
    sources: row?.sources || [],
  };
}

async function fetchTitleByImdb(imdbId, timeoutMs) {
  const cfg = supabaseConfig();
  if (!cfg) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const params = new URLSearchParams({
      select: 'imdb_id,tmdb_id,tvdb_id,mal_id,kitsu_id,anilist_id,anidb_id,media_type,category,primary_title,titles,sources,hints,is_date_based,is_absolute_ep',
      imdb_id: `eq.${imdbId}`,
      limit: '1',
    });
    const res = await fetch(`${cfg.url}/rest/v1/personal_titles?${params}`, {
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[ID-RESOLVE] Supabase ${res.status} for ${imdbId}`);
      return null;
    }
    const rows = await res.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'timeout' : e.message;
    console.warn(`[ID-RESOLVE] lookup failed for ${imdbId}: ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve mapping context for a stream/meta request.
 * Returns null when disabled, unconfigured, non-tt id, missing row, or on error.
 */
export async function resolveContentContext(stremioType, rawIdWithExt) {
  if (!isIdResolveEnabled()) return null;

  const parsed = parseStremioImdbId(rawIdWithExt);
  if (!parsed) return null;

  const row = await fetchTitleByImdb(parsed.imdbId, resolveTimeoutMs());
  if (!row) return null;

  return {
    parsed,
    row,
    isAnimeContent: isAnimeContent(row),
    ids: rowToIds(row),
    extraStreamIds: buildAnimeExtraIds(parsed, row),
    shadow: buildShadowPlan(parsed, row, stremioType),
  };
}

/**
 * Extra Stremio stream paths for additive anime fan-out (mal:/kitsu:).
 * Empty when query flag off or not anime.
 */
export function getExtraStreamIds(context) {
  if (!isIdResolveQueryEnabled() || !context?.isAnimeContent) return [];
  return (context.extraStreamIds || []).slice(0, 2);
}

/** Phase 1: log what we would fan out to without changing behavior. */
export function logShadowResolve(context) {
  if (!context?.shadow) return;
  const s = context.shadow;
  console.log(
    `[ID-RESOLVE][SHADOW] ${s.parsed.imdbId}` +
      (s.parsed.season !== undefined ? ` S${s.parsed.season}E${s.parsed.episode}` : '') +
      ` | type=${s.stremioType} category=${s.category} anime=${s.isAnimeContent}` +
      ` | ids=${JSON.stringify(s.ids)}` +
      ` | wouldQuery=${s.wouldQuery.join(' | ')}` +
      (s.primaryTitle ? ` | title="${s.primaryTitle}"` : '') +
      (s.synonyms.length ? ` | synonyms=${s.synonyms.slice(0, 3).join('; ')}` : '')
  );
}
