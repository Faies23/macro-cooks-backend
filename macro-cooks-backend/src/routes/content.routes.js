const router = require('express').Router();
const { query } = require('../db');
const { authRequired } = require('../auth');
const adminOnly = require('../middleware/adminOnly');
const cf = require('../video/cloudflareStream');

// Wrap async handlers so rejections reach the central error middleware instead of hanging.
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// List published classes. Free classes play for everyone; premium classes only reveal a
// playback URL to users holding an ACTIVE 'full' entitlement — otherwise we withhold the URL
// (playbackUrl:null, locked:true) so the gate is enforced server-side, not just in the app.
router.get('/classes', authRequired, wrap(async (req, res) => {
  const ent = await query(
    "select 1 from entitlements where user_id=$1 and product='full' and expires_at > now() limit 1",
    [req.user.id]
  );
  const hasFull = ent.rows.length > 0;

  const r = await query('select id,"by",title,free,uid from classes order by created_at desc');
  const classes = r.rows.map(c => {
    const free = !!c.free;
    const unlocked = free || hasFull;
    return {
      id: c.id,
      title: c.title,
      by: c.by,
      free,
      uid: c.uid,
      playbackUrl: unlocked ? cf.playbackUrl(c.uid) : null,
      ...(unlocked ? {} : { locked: true })
    };
  });
  res.json({ classes });
}));

// Admin: get a one-time direct-upload URL for Cloudflare Stream.
router.post('/admin/upload-url', authRequired, adminOnly, wrap(async (req, res) => {
  try { res.json(await cf.createDirectUpload({ maxDurationSeconds: 60 * 60 })); }
  catch (e) { console.error('upload-url error:', e); res.status(502).json({ error: 'upload url failed' }); }
}));

// Admin: save a published class after the video was uploaded (client got the uid).
//    Body: { title, by, free, uid }
router.post('/admin/classes', authRequired, adminOnly, wrap(async (req, res) => {
  const { title, by, free, uid } = req.body || {};
  if (typeof title !== 'string' || !title.trim() || typeof uid !== 'string' || !uid.trim())
    return res.status(400).json({ error: 'title and uid required' });
  if (title.length > 200 || uid.length > 100 || (by != null && (typeof by !== 'string' || by.length > 100)))
    return res.status(400).json({ error: 'invalid field length' });
  const r = await query(
    'insert into classes(title,"by",free,uid) values($1,$2,$3,$4) returning id',
    [title.trim(), (typeof by === 'string' ? by.trim() : null) || null, !!free, uid.trim()]
  );
  res.json({ id: r.rows[0].id, ok: true });
}));

router.delete('/admin/classes/:id', authRequired, adminOnly, wrap(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  await query('delete from classes where id=$1', [req.params.id]);
  res.json({ ok: true });
}));
module.exports = router;
