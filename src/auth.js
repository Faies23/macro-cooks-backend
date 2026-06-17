const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

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
