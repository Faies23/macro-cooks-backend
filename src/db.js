const fs = require('fs');
const { Pool } = require('pg');
const cs = process.env.DATABASE_URL || '';
const isLocal = cs.includes('localhost') || cs.includes('127.0.0.1');

// TLS for managed Postgres. Prefer verifying the server certificate against a provided CA
// (set DATABASE_CA_CERT_PEM to the PEM, or DATABASE_CA_CERT to a file path ΓÇö most providers
// publish one). Only when no CA is configured do we fall back to encrypted-but-unverified,
// which is convenient but vulnerable to MITM; pin a CA in production.
let ssl = false;
if (cs && !isLocal) {
  const caPem = process.env.DATABASE_CA_CERT_PEM
    || (process.env.DATABASE_CA_CERT ? fs.readFileSync(process.env.DATABASE_CA_CERT, 'utf8') : '');
  if (caPem) {
    ssl = { rejectUnauthorized: true, ca: caPem };
  } else {
    console.warn('[db] No DATABASE_CA_CERT(_PEM) set ΓÇö using TLS without certificate verification. Pin a CA in production.');
    ssl = { rejectUnauthorized: false };
  }
}

const pool = new Pool({ connectionString: cs, ssl });

// The Supavisor pooler drops idle connections. pg surfaces that as an 'error' event on the
// Pool, and an 'error' event with no listener is fatal in Node: the whole API would exit,
// potentially in the middle of settling a payment. pg has already discarded the broken
// client by this point, so logging is all that is needed to stay alive.
pool.on('error', (err) => {
  console.error('[db] idle client error (pool recovers):', (err && err.message) || err);
});

async function query(text, params) { return pool.query(text, params); }
module.exports = { pool, query };
