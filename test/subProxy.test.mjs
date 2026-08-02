/**
 * P0 · lib/urlSigning.js + api/sub-proxy.js (#53).
 *
 * The proxy must only ever fetch URLs it signed itself -- these tests pin the
 * signing contract and the handler's rejection paths, which is what closes the
 * open-SSRF/open-relay hole.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import subProxyHandler from '../api/sub-proxy.js';
import { canSign, signValue, verifyValue } from '../lib/urlSigning.js';

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    // process.env coerces `undefined` to the string "undefined" on assignment,
    // so an intentionally-unset var must be deleted, not assigned.
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    end(body) { this.body = body; return this; },
  };
}

test('urlSigning: sign/verify round-trips and rejects tampering', async () => {
  await withEnv({ SUB_PROXY_SECRET: 'test-secret', SUPABASE_SERVICE_ROLE_KEY: undefined }, async () => {
    assert.equal(canSign(), true);
    const sig = signValue('https://example.com/a.srt');
    assert.ok(sig && sig.length > 0);
    assert.equal(verifyValue('https://example.com/a.srt', sig), true);
    assert.equal(verifyValue('https://example.com/b.srt', sig), false, 'signature must not verify a different URL');
    assert.equal(verifyValue('https://example.com/a.srt', sig + 'x'), false, 'tampered signature must fail');
    assert.equal(verifyValue('https://example.com/a.srt', null), false);
  });
});

test('urlSigning: refuses to sign/verify with no key configured', async () => {
  await withEnv({ SUB_PROXY_SECRET: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined }, async () => {
    assert.equal(canSign(), false);
    assert.equal(signValue('https://example.com/a.srt'), null);
  });
});

test('sub-proxy: rejects a missing/invalid url param before any signature check', async () => {
  const res = mockRes();
  await subProxyHandler({ method: 'GET', url: '/api/sub-proxy?url=not-a-url', headers: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.match(String(res.body), /Missing or invalid url/);
});

test('sub-proxy: 503s when no signing key is configured at all', async () => {
  await withEnv({ SUB_PROXY_SECRET: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined }, async () => {
    const res = mockRes();
    await subProxyHandler({
      method: 'GET',
      url: `/api/sub-proxy?url=${encodeURIComponent('http://127.0.0.1:9000/')}`,
      headers: {},
    }, res);
    assert.equal(res.statusCode, 503);
  });
});

test('sub-proxy: rejects an unsigned SSRF target even with signing configured', async () => {
  await withEnv({ SUB_PROXY_SECRET: 'test-secret' }, async () => {
    const res = mockRes();
    await subProxyHandler({
      method: 'GET',
      url: `/api/sub-proxy?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`,
      headers: {},
    }, res);
    assert.equal(res.statusCode, 403);
  });
});

test('sub-proxy: rejects a tampered signature', async () => {
  await withEnv({ SUB_PROXY_SECRET: 'test-secret' }, async () => {
    const target = 'http://127.0.0.1:9000/';
    const sig = signValue(target) + 'tampered';
    const res = mockRes();
    await subProxyHandler({
      method: 'GET',
      url: `/api/sub-proxy?url=${encodeURIComponent(target)}&sig=${encodeURIComponent(sig)}`,
      headers: {},
    }, res);
    assert.equal(res.statusCode, 403);
  });
});

test('sub-proxy: a correctly signed URL passes verification (proceeds past the 403 gate)', async () => {
  await withEnv({ SUB_PROXY_SECRET: 'test-secret' }, async () => {
    // Port 0 on localhost refuses the connection immediately -- this proves the
    // request cleared signature verification without depending on a live host.
    const target = 'http://127.0.0.1:0/unreachable.srt';
    const sig = signValue(target);
    const res = mockRes();
    await subProxyHandler({
      method: 'GET',
      url: `/api/sub-proxy?url=${encodeURIComponent(target)}&sig=${encodeURIComponent(sig)}`,
      headers: {},
    }, res);
    assert.notEqual(res.statusCode, 403, 'a validly signed URL must not be rejected as unsigned/tampered');
    assert.notEqual(res.statusCode, 503);
  });
});
