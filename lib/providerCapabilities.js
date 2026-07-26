/**
 * Provider capability registry (capabilityVersion = providers-v1).
 *
 * Single source of truth for what a provider *can* say and what we are willing
 * to believe from it. Availability ("cached"), VIP status, and query-mode
 * fan-out all resolve through this map instead of scanning free-text titles,
 * so an uploader cannot mint cache or VIP status by typing a keyword.
 *
 * Matching is most-specific-first: exact hostname beats hostname label beats
 * substring beats configured-but-unknown beats unknown.
 */
import crypto from 'node:crypto';
import { CAPABILITY_VERSION } from './versions.js';

/** Transport classes a provider row can resolve to. */
export const TRANSPORT = {
  DIRECT_OWNER: 'direct_owner',
  DEBRID: 'debrid',
  P2P: 'p2p',
  USENET: 'usenet',
  GENERIC_HTTP: 'generic_http',
  EXTERNAL: 'external',
};

/** Cache claim classes emitted by provider-specific parsers. */
export const CACHE_CLAIM = {
  POSITIVE: 'cache_positive',
  QUEUED: 'queued',
  NONE: null,
};

/** Query modes the retrieval planner can schedule, in priority order. */
export const QUERY_MODE = {
  CANONICAL_ID: 'canonical_id',
  MAPPED_ID: 'mapped_id',
  PRIMARY_TITLE: 'primary_title',
  ALIAS_TITLE: 'alias_title',
  EXTRA_LANGUAGE: 'extra_language',
};

export const QUERY_MODE_PRIORITY = {
  [QUERY_MODE.CANONICAL_ID]: 0,
  [QUERY_MODE.MAPPED_ID]: 1,
  [QUERY_MODE.PRIMARY_TITLE]: 2,
  [QUERY_MODE.ALIAS_TITLE]: 3,
  [QUERY_MODE.EXTRA_LANGUAGE]: 4,
};

const MATCH = { EXACT_HOST: 400, HOST_LABEL: 300, HOST_SUBSTRING: 200, PATH_SUBSTRING: 100 };

/**
 * Debrid abbreviations shared across Torrentio-class addons. A trailing
 * "+"/"⚡"/"instant" marks an already-cached file; the bare tag marks a file
 * that still has to be downloaded to the debrid service first.
 */
const DEBRID_CACHED_SUFFIX = /[([][^)\]]*\b(?:tb|rd|ad|pm|dl|oc|ed)[\s._-]?(?:\+|⚡|instant)[^)\]]*[)\]]/i;
const DEBRID_BARE_TAG = /[([][^)\]]*\b(?:tb|rd|ad|pm|oc|ed)\b(?![\s._-]?(?:\+|⚡|instant))[^)\]]*[)\]]/i;
const EXPLICIT_UNCACHED = /un[\s._-]?cached|not[\s._-]?cached|⏳|⌛|⬇️|⬇|download[\s._-]?to[\s._-]?debrid|add[\s._-]?to[\s._-]?debrid|instant[\s:=_-]?false|cached[\s:=_-]*\s*(?:no|false|0)/i;

/** Debrid marker parser shared by Torrentio-family addons. */
function debridMarkerParser(text) {
  if (EXPLICIT_UNCACHED.test(text)) {
    return { claim: CACHE_CLAIM.QUEUED, marker: 'explicit_uncached' };
  }
  if (DEBRID_CACHED_SUFFIX.test(text)) {
    return { claim: CACHE_CLAIM.POSITIVE, marker: 'debrid_cached_suffix' };
  }
  if (DEBRID_BARE_TAG.test(text)) {
    return { claim: CACHE_CLAIM.QUEUED, marker: 'debrid_bare_tag' };
  }
  return { claim: CACHE_CLAIM.NONE, marker: null };
}

/** Comet also emits a "[Comet]"/sync-prompt shape alongside standard debrid tags. */
function cometMarkerParser(text) {
  const base = debridMarkerParser(text);
  if (base.claim !== CACHE_CLAIM.NONE) return base;
  if (/[([][^)\]]*\bcomet\b[^)\]]*[)\]]/i.test(text)) {
    return { claim: CACHE_CLAIM.POSITIVE, marker: 'comet_tag' };
  }
  return base;
}

/** Yastream documents its own convention explicitly: [TB+] cached, [TB] will download. */
function yastreamMarkerParser(text) {
  if (/\[tb\s*[+⚡]\]|\[tb[\s._-]?instant\]/i.test(text)) {
    return { claim: CACHE_CLAIM.POSITIVE, marker: 'yastream_tb_plus' };
  }
  if (/\[tb\]/i.test(text)) {
    return { claim: CACHE_CLAIM.QUEUED, marker: 'yastream_tb_bare' };
  }
  return debridMarkerParser(text);
}

/** Providers with no trusted cache vocabulary: text can never create a claim. */
function noMarkerParser() {
  return { claim: CACHE_CLAIM.NONE, marker: null };
}

function hostAuthoritativeVip() {
  return true;
}

function noVip() {
  return false;
}

/**
 * Ordered registry. `matchers` are evaluated for every entry and the highest
 * specificity wins, so a Torrentio instance hosted on an ElfHosted path still
 * resolves to the torrentio family rather than generic_known.
 */
const REGISTRY = [
  {
    family: 'kan_box',
    label: 'Kan-Box',
    matchers: [{ kind: 'exactHost', value: 'kan-box-addon.vercel.app', score: MATCH.EXACT_HOST }],
    idSchemes: ['tt', 'tmdb', 'il', 'dbz', 'channel'],
    supportsTextSearch: true,
    supportsAnimeIds: false,
    transports: [TRANSPORT.DIRECT_OWNER],
    trustedFields: ['url', 'behaviorHints.videoSize', 'behaviorHints.filename'],
    markerParser: noMarkerParser,
    vipRule: hostAuthoritativeVip,
    integrityPrior: { mu0: 0.85, kappa0: 8 },
    cacheClaimPrior: null,
  },
  {
    family: 'animeil',
    label: 'AnimeIL',
    matchers: [{ kind: 'hostLabel', value: 'animeil', score: MATCH.HOST_LABEL }],
    idSchemes: ['tt', 'tmdb', 'mal', 'kitsu'],
    supportsTextSearch: true,
    supportsAnimeIds: true,
    transports: [TRANSPORT.DIRECT_OWNER],
    trustedFields: ['url', 'behaviorHints.filename'],
    markerParser: noMarkerParser,
    vipRule: hostAuthoritativeVip,
    integrityPrior: { mu0: 0.82, kappa0: 8 },
    cacheClaimPrior: null,
  },
  {
    family: 'personal_telegram',
    label: 'Personal Telegram',
    matchers: [{
      kind: 'exactHost',
      value: 'advantage-shot-petition-crucial.trycloudflare.com',
      score: MATCH.EXACT_HOST,
    }],
    idSchemes: ['tt', 'tgfile', 'personal'],
    supportsTextSearch: false,
    supportsAnimeIds: false,
    transports: [TRANSPORT.DIRECT_OWNER],
    trustedFields: ['url', 'behaviorHints.filename'],
    markerParser: noMarkerParser,
    vipRule: hostAuthoritativeVip,
    integrityPrior: { mu0: 0.82, kappa0: 8 },
    cacheClaimPrior: null,
  },
  {
    family: 'torrentio',
    label: 'Torrentio',
    matchers: [
      { kind: 'hostSubstring', value: 'torrentio', score: MATCH.HOST_SUBSTRING },
      { kind: 'pathSubstring', value: 'torrentio', score: MATCH.PATH_SUBSTRING },
    ],
    idSchemes: ['tt', 'tmdb', 'mal', 'kitsu'],
    supportsTextSearch: true,
    supportsAnimeIds: true,
    transports: [TRANSPORT.DEBRID, TRANSPORT.P2P],
    trustedFields: ['infoHash', 'fileIdx', 'behaviorHints.videoSize', 'behaviorHints.filename', 'seeders'],
    markerParser: debridMarkerParser,
    vipRule: noVip,
    integrityPrior: { mu0: 0.78, kappa0: 10 },
    cacheClaimPrior: { mu0: 0.80, kappa0: 10 },
  },
  {
    family: 'yastream',
    label: 'Yastream',
    matchers: [
      { kind: 'hostSubstring', value: 'yastream', score: MATCH.HOST_SUBSTRING },
      { kind: 'pathSubstring', value: 'yastream', score: MATCH.PATH_SUBSTRING },
    ],
    idSchemes: ['tt', 'tmdb', 'kisskh', 'idrama', 'onetouchtv'],
    supportsTextSearch: true,
    supportsAnimeIds: false,
    transports: [TRANSPORT.DEBRID, TRANSPORT.DIRECT_OWNER, TRANSPORT.P2P],
    trustedFields: ['infoHash', 'behaviorHints.videoSize', 'behaviorHints.filename'],
    markerParser: yastreamMarkerParser,
    vipRule: noVip,
    integrityPrior: { mu0: 0.75, kappa0: 8 },
    cacheClaimPrior: { mu0: 0.75, kappa0: 8 },
  },
  {
    family: 'comet',
    label: 'Comet',
    matchers: [
      { kind: 'hostSubstring', value: 'comet', score: MATCH.HOST_SUBSTRING },
      { kind: 'pathSubstring', value: 'comet', score: MATCH.PATH_SUBSTRING },
    ],
    idSchemes: ['tt', 'tmdb', 'mal', 'kitsu'],
    supportsTextSearch: true,
    supportsAnimeIds: true,
    transports: [TRANSPORT.DEBRID, TRANSPORT.P2P],
    trustedFields: ['infoHash', 'behaviorHints.videoSize', 'behaviorHints.filename', 'seeders'],
    markerParser: cometMarkerParser,
    vipRule: noVip,
    integrityPrior: { mu0: 0.75, kappa0: 8 },
    cacheClaimPrior: { mu0: 0.78, kappa0: 8 },
  },
  {
    family: 'mediafusion',
    label: 'MediaFusion',
    matchers: [
      { kind: 'hostSubstring', value: 'mediafusion', score: MATCH.HOST_SUBSTRING },
      { kind: 'pathSubstring', value: 'mediafusion', score: MATCH.PATH_SUBSTRING },
    ],
    idSchemes: ['tt', 'tmdb', 'mal', 'kitsu'],
    supportsTextSearch: true,
    supportsAnimeIds: true,
    transports: [TRANSPORT.DEBRID, TRANSPORT.P2P, TRANSPORT.DIRECT_OWNER],
    trustedFields: ['infoHash', 'behaviorHints.videoSize', 'behaviorHints.filename', 'seeders'],
    markerParser: debridMarkerParser,
    vipRule: noVip,
    integrityPrior: { mu0: 0.72, kappa0: 8 },
    cacheClaimPrior: { mu0: 0.75, kappa0: 8 },
  },
  {
    family: 'debridio',
    label: 'Debridio',
    matchers: [
      { kind: 'hostSubstring', value: 'debridio', score: MATCH.HOST_SUBSTRING },
      { kind: 'pathSubstring', value: 'debridio', score: MATCH.PATH_SUBSTRING },
    ],
    idSchemes: ['tt', 'tmdb', 'mal', 'kitsu'],
    supportsTextSearch: true,
    supportsAnimeIds: true,
    transports: [TRANSPORT.DEBRID],
    trustedFields: ['infoHash', 'behaviorHints.videoSize', 'behaviorHints.filename'],
    markerParser: debridMarkerParser,
    vipRule: noVip,
    integrityPrior: { mu0: 0.68, kappa0: 6 },
    cacheClaimPrior: { mu0: 0.70, kappa0: 6 },
  },
  {
    family: 'knaben',
    label: 'Knaben',
    matchers: [
      { kind: 'hostSubstring', value: 'knaben', score: MATCH.HOST_SUBSTRING },
      { kind: 'pathSubstring', value: 'knaben', score: MATCH.PATH_SUBSTRING },
    ],
    idSchemes: ['tt', 'tmdb'],
    supportsTextSearch: true,
    supportsAnimeIds: true,
    transports: [TRANSPORT.P2P],
    trustedFields: ['infoHash', 'seeders'],
    markerParser: noMarkerParser,
    vipRule: noVip,
    integrityPrior: { mu0: 0.60, kappa0: 6 },
    cacheClaimPrior: null,
  },
];

/** Configured provider that matched no family: parse structure, never trust cache text. */
const GENERIC_KNOWN = {
  family: 'generic_known',
  label: 'Provider',
  matchers: [],
  idSchemes: ['tt', 'tmdb'],
  supportsTextSearch: true,
  supportsAnimeIds: false,
  transports: [TRANSPORT.GENERIC_HTTP, TRANSPORT.P2P],
  trustedFields: ['infoHash', 'behaviorHints.videoSize', 'behaviorHints.filename'],
  markerParser: noMarkerParser,
  vipRule: noVip,
  integrityPrior: { mu0: 0.60, kappa0: 4 },
  cacheClaimPrior: null,
};

/** Row with no recognizable, configured origin. */
const UNKNOWN = {
  family: 'unknown',
  label: 'Unknown',
  matchers: [],
  idSchemes: [],
  supportsTextSearch: false,
  supportsAnimeIds: false,
  transports: [TRANSPORT.GENERIC_HTTP],
  trustedFields: [],
  markerParser: noMarkerParser,
  vipRule: noVip,
  integrityPrior: { mu0: 0.50, kappa0: 4 },
  cacheClaimPrior: null,
};

/** Path segments that look like config blobs / API tokens rather than routing. */
const SECRET_SEGMENT = /^(?:[0-9a-f]{16,}|[A-Za-z0-9_-]{24,}|[A-Za-z0-9+/=]{24,})$/;

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

/**
 * Canonicalize a configured addon base URL into a stable, secret-free identity.
 * Credentials, query, and fragment are dropped; token-looking path segments are
 * replaced by a hash so telemetry never stores a usable provider credential.
 */
export function canonicalizeSourceBase(rawUrl) {
  const raw = String(rawUrl || '').trim();
  if (!raw) return { hostname: '', pathKey: '', instanceKey: '', raw: '' };

  let hostname = '';
  let segments = [];
  try {
    const url = new URL(raw.replace(/\/manifest\.json$/i, '').replace(/\/+$/, ''));
    hostname = url.hostname.toLowerCase();
    segments = url.pathname.split('/').filter(Boolean);
  } catch {
    const cleaned = raw.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[?#].*$/, '');
    const parts = cleaned.split('/').filter(Boolean);
    hostname = (parts.shift() || '').split('@').pop() || '';
    segments = parts;
  }

  const safeSegments = segments.map(seg =>
    SECRET_SEGMENT.test(seg) ? `cfg-${shortHash(seg)}` : seg.toLowerCase()
  );
  const pathKey = safeSegments.join('/');
  return {
    hostname,
    pathKey,
    instanceKey: pathKey ? `${hostname}/${pathKey}` : hostname,
    raw,
  };
}

function matcherScore(entry, canonical) {
  const { hostname, pathKey } = canonical;
  const hostLabels = hostname.split('.');
  let best = 0;
  for (const matcher of entry.matchers) {
    let hit = false;
    if (matcher.kind === 'exactHost') hit = hostname === matcher.value;
    else if (matcher.kind === 'hostLabel') hit = hostLabels.some(label => label.includes(matcher.value));
    else if (matcher.kind === 'hostSubstring') hit = hostname.includes(matcher.value);
    else if (matcher.kind === 'pathSubstring') hit = pathKey.includes(matcher.value);
    if (hit && matcher.score > best) best = matcher.score;
  }
  return best;
}

const capabilityCache = new Map();

/**
 * Resolve the capability entry for a provider base URL.
 * @param {string} rawUrl configured addon base (may include config path)
 * @param {{ configured?: boolean }} [opts] configured=false marks an origin we never asked for
 */
export function resolveProvider(rawUrl, opts = {}) {
  const configured = opts.configured !== false;
  const cacheKey = `${configured ? 'c' : 'u'}|${rawUrl || ''}`;
  const cached = capabilityCache.get(cacheKey);
  if (cached) return cached;

  const canonical = canonicalizeSourceBase(rawUrl);
  let entry = null;
  let bestScore = 0;
  if (canonical.hostname) {
    for (const candidate of REGISTRY) {
      const score = matcherScore(candidate, canonical);
      if (score > bestScore) {
        bestScore = score;
        entry = candidate;
      }
    }
  }
  if (!entry) entry = canonical.hostname && configured ? GENERIC_KNOWN : UNKNOWN;

  const resolved = {
    ...entry,
    capabilityVersion: CAPABILITY_VERSION,
    matchScore: bestScore,
    hostname: canonical.hostname,
    instanceKey: canonical.instanceKey || entry.family,
    providerId: `${entry.family}:${canonical.instanceKey || entry.family}`,
  };
  capabilityCache.set(cacheKey, resolved);
  return resolved;
}

/** True when the provider is declared able to answer this ID scheme. */
export function providerSupportsIdScheme(provider, scheme) {
  if (!provider || !scheme) return false;
  return provider.idSchemes.includes(scheme);
}

/** True when the provider can answer `search=` style text queries. */
export function providerSupportsTextSearch(provider) {
  return !!provider?.supportsTextSearch;
}

/** True when mal:/kitsu: fan-out is meaningful for this provider. */
export function providerSupportsAnimeIds(provider) {
  return !!provider?.supportsAnimeIds;
}

/** Parse a provider-specific cache claim. Generic text yields no claim. */
export function parseCacheClaim(provider, text) {
  if (!provider) return { claim: CACHE_CLAIM.NONE, marker: null };
  return provider.markerParser(String(text || ''));
}

/** Evaluate the provider's VIP rule. VIP is business precedence, not quality. */
export function evaluateVip(provider, context) {
  if (!provider) return false;
  try {
    return !!provider.vipRule(context);
  } catch {
    return false;
  }
}

/** Prior used by the trust model before any observation exists. */
export function integrityPrior(provider) {
  return provider?.integrityPrior || UNKNOWN.integrityPrior;
}

/** Prior confidence that this provider's cache markers tell the truth. */
export function cacheClaimPrior(provider) {
  return provider?.cacheClaimPrior || null;
}

/** All known families, for migrations/diagnostics. */
export function knownFamilies() {
  return [...REGISTRY.map(e => e.family), GENERIC_KNOWN.family, UNKNOWN.family];
}
