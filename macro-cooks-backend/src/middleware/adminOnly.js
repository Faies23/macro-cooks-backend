const { query } = require('../db');

// Re-check the role against the DB rather than trusting only the (long-lived) token claim,
// so a demoted user loses admin access immediately and a forged claim can't pass even if the
// signing key were ever compromised. Fails closed on any error.
module.exports = async function adminOnly(req, res, next) {
  try {
    if (!req.user || !req.user.id) return res.status(403).json({ error: 'Admin only' });
    const r = await query('select role from users where id=$1', [req.user.id]);
    const role = r.rows[0] && r.rows[0].role;
    if (role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  } catch (e) {
    return res.status(403).json({ error: 'Admin only' });
  }
};
