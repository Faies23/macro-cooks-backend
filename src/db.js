const { Pool } = require('pg');
const cs = process.env.DATABASE_URL || '';
const isLocal = cs.includes('localhost') || cs.includes('127.0.0.1');
const pool = new Pool({
  connectionString: cs,
  ssl: cs && !isLocal ? { rejectUnauthorized: false } : false
});
async function query(text, params) { return pool.query(text, params); }
module.exports = { pool, query };
