const fs = require('fs');
const { Pool } = require('pg');
const cs = process.env.DATABASE_URL || '';
const isLocal = cs.includes('localhost') || cs.includes('127.0.0.1');

// TLS for managed Postgres. Prefer verifying the server certificate against a provided CA
// (set DATABASE_CA_CERT_PEM to the PEM, or DATABASE_CA_CERT to a file path — most providers
// publish one). Only when no CA is configured do we fall back to encrypted-but-unverified,
// which is convenient but vulnerable to MITM; pin a CA in production.
let ssl = false;
if (cs && !isLocal) {
  const caPem = process.env.DATABASE_CA_CERT_PEM
    || (process.env.DATABASE_CA_CERT ? fs.readFileSync(process.env.DATABASE_CA_CERT, 'utf8') : '');
  if (caPem) {
    ssl = { rejectUnauthorized: true, ca: caPem };
  } else {
    console.warn('[db] No DATABASE_CA_CERT(_PEM) set — using TLS without certificate verification. Pin a CA in production.');
    ssl = { rejectUnauthorized: false };
  }
}

const pool = new Pool({ connectionString: cs, ssl });
async function query(text, params) { return pool.query(text, params); }
module.exports = { pool, query };
