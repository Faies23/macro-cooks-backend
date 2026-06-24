const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// SECURITY: never fall back to a public/default secret. A predictable secret lets
// anyone forge tokens (including { role: 'admin' }). Fail closed at startup instead.
const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 32) {
  throw new Error('JWT_SECRET must be set to a strong random value (>= 32 chars). Generate one with: openssl rand -hex 32');
}

async function hashPassword(p) { return bcrypt.hash(p, 10); }
async function verifyPassword(p, hash) { return bcrypt.compare(p, hash); }
function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, SECRET, { expiresIn: '30d' });
}
function authRequired(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try { req.user = jwt.verify(token, SECRET); next(); }
  catch (e) { return res.status(401).json({ error: 'Invalid token' }); }
}
module.exports = { hashPassword, verifyPassword, signToken, authRequired };
