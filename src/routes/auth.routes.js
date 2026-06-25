const router = require('express').Router();
const { query } = require('../db');
const { hashPassword, verifyPassword, signToken, authRequired } = require('../auth');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Validate the shape of an auth body up front so bad input is a clean 400 instead of a
// 500 (e.g. email.toLowerCase() on a non-string) or a weak/oversized password reaching bcrypt.
function validateCredentials(body, requireName) {
  const { email, password, name } = body || {};
  if (typeof email !== 'string' || typeof password !== 'string') return 'email and password required';
  const e = email.trim();
  if (!EMAIL_RE.test(e) || e.length > 254) return 'valid email required';
  if (password.length < 8 || password.length > 128) return 'password must be 8–128 characters';
  if (requireName && name != null && (typeof name !== 'string' || name.length > 100)) return 'invalid name';
  return null;
}

router.post('/signup', async (req, res) => {
  try {
    const err = validateCredentials(req.body, true);
    if (err) return res.status(400).json({ error: err });
    const { email, password, name } = req.body;
    const hash = await hashPassword(password);
    const r = await query(
      'insert into users(email,password_hash,name) values($1,$2,$3) returning id,email,name,role',
      [email.trim().toLowerCase(), hash, (typeof name === 'string' ? name.trim() : null) || null]
    );
    const user = r.rows[0];
    await query("insert into profiles(user_id,data) values($1,'{}'::jsonb) on conflict do nothing", [user.id]);
    res.json({ token: signToken(user), user });
  } catch (e) {
    if (String(e).includes('duplicate')) return res.status(409).json({ error: 'Email already registered' });
    console.error('SIGNUP ERROR:', e);
    res.status(500).json({ error: 'signup failed', detail: String((e && (e.message || e.code)) || e) });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string')
      return res.status(401).json({ error: 'Invalid credentials' });
    const r = await query('select * from users where email=$1', [email.trim().toLowerCase()]);
    const u = r.rows[0];
    if (!u || !(await verifyPassword(password || '', u.password_hash)))
      return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ token: signToken(u), user: { id: u.id, email: u.email, name: u.name, role: u.role } });
  } catch (e) { console.error('LOGIN ERROR:', e); res.status(500).json({ error: 'login failed', detail: String((e && (e.message || e.code)) || e) }); }
});

router.get('/me', authRequired, (req, res) => res.json({ user: req.user }));
module.exports = router;
