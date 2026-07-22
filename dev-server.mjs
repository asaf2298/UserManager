// Local development server for the Vecret Stremio proxy.
//
// `vercel dev` is the intended dev command, but it requires an interactive
// Vercel login + linked project, which is not available in headless/CI
// environments. This lightweight server reproduces the routing declared in
// `vercel.json` (rewrites) and invokes the exact same serverless handlers in
// `api/*.js` with a Vercel-compatible (req, res) contract. Handler code is
// used unchanged.
//
// Usage:
//   node --env-file=.env.local dev-server.mjs        (env optional)
//   PORT=3000 node dev-server.mjs
//
// Env vars (USER_CONFIGS, ADDON_URLS, SUBTITLE_URLS, TV_ADDON_URL,
// TMDB_API_KEY, AIOMETADATA_URL) are read from the process environment, so a
// `.env.local` file loaded via `node --env-file` (Node >= 20) works well.

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Fallback .env.local loader (only sets vars that are not already defined),
// so the server also works when started without `--env-file`.
function loadDotEnv() {
  const envPath = path.join(__dirname, '.env.local');
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv();

// Build rewrite matchers from vercel.json (first match wins, like Vercel).
const vercelConfig = JSON.parse(readFileSync(path.join(__dirname, 'vercel.json'), 'utf8'));
const rewrites = (vercelConfig.rewrites || []).map((rule) => {
  let re = rule.source.replace(/\./g, '\\.');
  re = re.replace(/:[A-Za-z0-9_]+\*/g, '(?:.+)'); // :param* -> one or more segments
  re = re.replace(/:[A-Za-z0-9_]+/g, '(?:[^/]+)'); // :param  -> single segment
  return { regex: new RegExp('^' + re + '$'), destination: rule.destination };
});

function resolveHandlerPath(pathname) {
  for (const rule of rewrites) {
    if (rule.regex.test(pathname)) {
      return path.join(__dirname, rule.destination + '.js'); // e.g. /api/manifest -> api/manifest.js
    }
  }
  if (pathname.startsWith('/api/')) {
    return path.join(__dirname, pathname + '.js');
  }
  return null;
}

const handlerCache = new Map();
async function loadHandler(handlerPath) {
  if (handlerCache.has(handlerPath)) return handlerCache.get(handlerPath);
  if (!existsSync(handlerPath)) return null;
  const mod = await import(pathToFileURL(handlerPath).href);
  const handler = mod.default;
  handlerCache.set(handlerPath, handler);
  return handler;
}

function enhanceResponse(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = (body) => {
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
    return res;
  };
  return res;
}

const server = http.createServer(async (req, res) => {
  enhanceResponse(res);
  try {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(parsed.pathname);

    // Vercel exposes parsed query params on req.query.
    const query = {};
    for (const [k, v] of parsed.searchParams.entries()) query[k] = v;
    req.query = query;

    const handlerPath = resolveHandlerPath(pathname);
    if (!handlerPath) {
      res.status(404).json({ error: 'Not Found', path: pathname });
      return;
    }

    const handler = await loadHandler(handlerPath);
    if (typeof handler !== 'function') {
      res.status(404).json({ error: 'No handler export', path: pathname });
      return;
    }

    console.log(`[dev] ${req.method} ${req.url} -> ${path.relative(__dirname, handlerPath)}`);
    await handler(req, res);
    if (!res.writableEnded) res.end();
  } catch (err) {
    console.error('[dev] handler error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal Server Error', message: String(err && err.message || err) });
    else if (!res.writableEnded) res.end();
  }
});

server.listen(PORT, () => {
  console.log(`\nVecret dev server listening on http://localhost:${PORT}`);
  console.log('Stremio manifest: http://localhost:' + PORT + '/<USER_KEY>/manifest.json');
  console.log('Kodi endpoint:    http://localhost:' + PORT + '/api/kodi?imdb_id=tt0111161&type=movie\n');
});
