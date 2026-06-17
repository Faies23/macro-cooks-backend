const router = require('express').Router();
const { query } = require('../db');
const { authRequired } = require('../auth');

// Load the user's saved app state (profile, plan, progress).
router.get('/', authRequired, async (req, res) => {
  const r = await query('select data from profiles where user_id=$1', [req.user.id]);
  res.json({ data: r.rows[0] ? r.rows[0].data : {} });
});

// Save / sync the user's app state.
router.put('/', authRequired, async (req, res) => {
  const data = (req.body && req.body.data) ? req.body.data : {};
  await query(
    'insert into profiles(user_id,data,updated_at) values($1,$2::jsonb,now()) ' +
    'on conflict(user_id) do update set data=$2::jsonb, updated_at=now()',
    [req.user.id, JSON.stringify(data)]
  );
  res.json({ ok: true });
});
module.exports = router;
