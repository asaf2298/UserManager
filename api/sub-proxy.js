// api/sub-proxy.js
// Fetches a remote subtitle file and re-emits it as clean UTF-8 (SRT/VTT).
import fetch from 'node-fetch';
import http from 'http';
import https from 'https';
import { decodeSubtitleBuffer } from '../lib/subtitleUtils.js';

const httpAgent = new http.Agent();
const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const dynamicAgent = (_parsedURL) => _parsedURL.protocol === 'http:' ? httpAgent : httpsAgent;

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const urlObj = new URL(req.url, 'http://localhost');
    const target = urlObj.searchParams.get('url');
    if (!target || !/^https?:\/\//i.test(target)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ error: 'Missing or invalid url param' }));
    }

    const response = await fetchWithTimeout(target, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/plain,*/*' },
      agent: dynamicAgent
    }, 8000);

    if (!response.ok) {
      console.warn(`[PERSONAL SUB-PROXY] upstream HTTP ${response.status} for ${target.substring(0, 80)}`);
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ error: 'Upstream subtitle fetch failed' }));
    }

    const buf = Buffer.from(await response.arrayBuffer());
    const text = decodeSubtitleBuffer(buf);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.end(text);
  } catch (e) {
    console.error(`[PERSONAL SUB-PROXY] 💥 ${e.message}`);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: 'Subtitle proxy error' }));
  }
}
