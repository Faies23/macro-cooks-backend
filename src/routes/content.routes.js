const router = require('express').Router();
const { query } = require('../db');
const { authRequired } = require('../auth');
const adminOnly = require('../middleware/adminOnly');
const cf = require('../video/cloudflareStream');

// List published classes. Premium classes are flagged; the app gates playback by entitlement.
router.get('/classes', async (req, res) => {
  const r = await query(
    "select id,title,chef,is_premium,stream_uid,status from classes where status='ready' order by created_at desc"
  );
  res.json({ classes: r.rows.map(c => ({
    id: c.id, title: c.title, chef: c.chef, is_premium: c.is_premium,
    playback: cf.playbackUrl(c.stream_uid)
  })) });
});

// Admin: get a one-time direct-upload URL for Cloudflare Stream.
router.post('/admin/upload-url', authRequired, adminOnly, async (req, res) => {
  try { res.json(await cf.createDirectUpload({ maxDurationSeconds: 60 * 60 })); }
  catch (e) { res.status(502).json({ error: 'upload url failed', detail: String(e) }); }
});

// Admin: save the class record after the video was uploaded (client got the uid).
router.post('/admin/classes', authRequired, adminOnly, async (req, res) => {
  const { title, chef, is_premium, stream_uid } = req.body || {};
  if (!title || !stream_uid) return res.status(400).json({ error: 'title and stream_uid required' });
  const r = await query(
    'insert into classes(title,chef,is_premium,stream_uid) values($1,$2,$3,$4) returning id',
    [title, chef || null, !!is_premium, stream_uid]
  );
  res.json({ id: r.rows[0].id, ok: true });
});

router.delete('/admin/classes/:id', authRequired, adminOnly, async (req, res) => {
  await query('delete from classes where id=$1', [req.params.id]);
  res.json({ ok: true });
});
module.exports = router;
