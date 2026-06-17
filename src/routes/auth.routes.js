const router = require('express').Router();
const { query } = require('../db');
const { hashPassword, verifyPassword, signToken, authRequired } = require('../auth');

router.post('/signup', async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const hash = await hashPassword(password);
    const r = await query(
      'insert into users(email,password_hash,name) values($1,$2,$3) returning id,email,name,role',
      [email.toLowerCase(), hash, name || null]
    );
    const user = r.rows[0];
    await query("insert into profiles(user_id,data) values($1,'{}'::jsonb) on conflict do nothing", [user.id]);
    res.json({ token: signToken(user), user });
  } catch (e) {
    if (String(e).includes('duplicate')) return res.status(409).json({ error: 'Email already registered' });
    res.status(500).json({ error: 'signup failed' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const r = await query('select * from users where email=$1', [(email || '').toLowerCase()]);
    const u = r.rows[0];
    if (!u || !(await verifyPassword(password || '', u.password_hash)))
      return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ token: signToken(u), user: { id: u.id, email: u.email, name: u.name, role: u.role } });
  } catch (e) { res.status(500).json({ error: 'login failed' }); }
});

router.get('/me', authRequired, (req, res) => res.json({ user: req.user }));
module.exports = router;
