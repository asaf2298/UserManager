/**
 * Shared text primitives.
 *
 * Ranking now lives in the deterministic pipeline (`streamFeatures` →
 * `streamRanker` → `streamSelector`), and cache/VIP semantics come from
 * `providerCapabilities`. What remains here is the small set of text helpers
 * several subsystems still share: display cleanup patterns and the non-content
 * "notice row" filter.
 *
 * The old lexicographic comparator (`masterSortFunc`), size tiers
 * (`getWeightTiers`), sort-resolution demotion (`getSortResWeight`), and the
 * text-authoritative `isCached` were removed deliberately. They double counted
 * evidence, made output depend on which upstream answered first, and let any
 * uploader mint "cached" status by typing a keyword.
 */

/** Display cleanup: delivery tags providers embed in `name`/`title`. */
export const REGEX_BRACKETS = /\[[^\]]*\b(torbox|tb|rd\+?|ad\+?|pm|cached|real-?debrid|all-?debrid|premiumize|elfhosted|elfcache|comet)\b[^\]]*\]/gi;
export const REGEX_PARENS = /\([^)]*\b(torbox|tb|rd\+?|ad\+?|pm|cached|real-?debrid|all-?debrid|premiumize|elfhosted|elfcache|comet)\b[^)]*\)/gi;
export const REGEX_DOWNLOAD = /\[[^\]]*(download|un[\s._-]?cached|not[\s._-]?cached|⬇️|⬇|⏳|⌛)[^\]]*\]/gi;

/**
 * Non-content "notice" rows some addons inject as if they were real streams:
 * sign-in / auth prompts (e.g. PenguPlay unconfigured), donation / funding
 * announcements (e.g. PenguPlay "monthly cost covered" — hidden by a donor
 * token we don't have), "no results" placeholder videos (e.g. YukiStreams
 * "[YS INFO] No streams found", "[YS NOTICE] Stream search failed"),
 * metadata-lookup failures (e.g. Comet returning "Unable to get metadata."
 * with its own base URL as the link when it can't resolve the title), and
 * Comet's "[TB🔄] Comet Sync" / "/debrid-sync/" prompt. These carry a
 * playable `url` so they pass every other filter and would otherwise show
 * up as a fake stream.
 */
export const REGEX_NOTICE_STREAM = /\bno (?:streams?|playable streams?|movies?|shows?|sources?|results?) (?:were )?found\b|\bno direct http rows? (?:were|was) available\b|\bcould not load streams?\b|\btry another source,?\s*episode,?\s*or playback option\b|you must sign in\b|sign[\s._-]?in (?:is )?required|authentication is (?:missing|invalid|revoked)|\b(?:monthly|server|hosting) costs? (?:is|are)?\s*covered\b|\bdonor token\b|please\s+(?:donate|consider donating)|please\s+re-?configure\s+the\s+plugin|select this stream to see how to sign in|\/stream-errors\/|the operation was aborted\b|unable to get metadata\b|\/debrid-sync\/|sync\s+debrid\s+account\s+library|select this stream,?\s*then retry this title\b|\[ys\s+notice\]|\bstream search failed\b/i;

/**
 * Lowercased concatenation of the fields providers use to describe a stream.
 * Memoized on the row because parsing and matching both read it.
 */
export function getTextForAnalysis(stream) {
  if (stream._text !== undefined) return stream._text;
  const fallbackText = stream.description || stream.behaviorHints?.filename || '';
  stream._text = ((stream.name || '') + ' ' + (stream.title || '') + ' ' + fallbackText).toLowerCase();
  return stream._text;
}

/** True for rows that are announcements/errors rather than playable content. */
export function isNoticeStream(stream) {
  if (stream._isNotice !== undefined) return stream._isNotice;
  const text = getTextForAnalysis(stream) + ' ' + (stream.url || '');
  stream._isNotice = REGEX_NOTICE_STREAM.test(text);
  return stream._isNotice;
}
