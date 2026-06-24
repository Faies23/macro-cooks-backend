const router = require('express').Router();
const { query } = require('../db');
const { authRequired } = require('../auth');

// Wrap async handlers so rejections reach the central error middleware instead of hanging.
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const MAX_PROFILE_BYTES = 256 * 1024; // generous for plan + logs, well under the 1mb body limit

// Load the user's saved app state (profile, plan, progress).
router.get('/', authRequired, wrap(async (req, res) => {
  const r = await query('select data from profiles where user_id=$1', [req.user.id]);
  res.json({ data: r.rows[0] ? r.rows[0].data : {} });
}));

// Save / sync the user's app state.
router.put('/', authRequired, wrap(async (req, res) => {
  const data = (req.body && req.body.data) ? req.body.data : {};
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    return res.status(400).json({ error: 'data must be an object' });
  const serialized = JSON.stringify(data);
  if (serialized.length > MAX_PROFILE_BYTES)
    return res.status(400).json({ error: 'data too large' });
  await query(
    'insert into profiles(user_id,data,updated_at) values($1,$2::jsonb,now()) ' +
    'on conflict(user_id) do update set data=$2::jsonb, updated_at=now()',
    [req.user.id, serialized]
  );
  res.json({ ok: true });
}));
module.exports = router;
