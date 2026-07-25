#!/usr/bin/env node
/**
 * Ingest Manami synonym batches into personal_akas.
 *
 * Usage:
 *   node scripts/generate-manami-batches.mjs
 *   node --env-file=.env.local scripts/ingest-manami-aliases.mjs [--dir /tmp/manami-batches]
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import fetch from 'node-fetch';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function supabaseKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || null;
}

async function ingestBatch(supabaseUrl, key, rows) {
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/personal_ingest_aka_rows`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ rows }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`RPC personal_ingest_aka_rows failed ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

async function main() {
  const dir = process.argv.includes('--dir')
    ? process.argv[process.argv.indexOf('--dir') + 1]
    : '/tmp/manami-batches';

  const supabaseUrl = requireEnv('SUPABASE_URL').replace(/\/$/, '');
  const key = supabaseKey();
  if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY');

  const files = readdirSync(dir)
    .filter(f => f.startsWith('batch-') && f.endsWith('.json'))
    .sort();

  if (!files.length) throw new Error(`No batch files in ${dir}`);

  let total = 0;
  for (const file of files) {
    const rows = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const n = await ingestBatch(supabaseUrl, key, rows);
    total += Array.isArray(n) ? n.length : Number(n) || rows.length;
    console.log(`[ingest-manami] ${file}: ${rows.length} rows (rpc=${n})`);
  }

  console.log(`[ingest-manami] done — ${total} rows processed across ${files.length} batches`);
}

main().catch((err) => {
  console.error('[ingest-manami] fatal:', err.message);
  process.exit(1);
});
