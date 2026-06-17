require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');
(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Migration complete: tables created.');
  process.exit(0);
})().catch(e => { console.error('Migration failed:', e); process.exit(1); });
