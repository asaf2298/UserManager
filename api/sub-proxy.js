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
