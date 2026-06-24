require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const app = express();
// Trust the first proxy hop (Render/most PaaS) so rate-limit & logs see the real client IP.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// --- Security headers (dependency-free; mirrors the essentials of helmet) ---
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});

// --- CORS allowlist ---
// APP_ORIGIN may be a comma-separated list of allowed origins. If it's unset or '*',
// we reflect any origin (handy while testing) but warn — this API uses Bearer tokens,
// not cookies, so it is not credentialed. Set APP_ORIGIN in production to lock it down.
const allowed = (process.env.APP_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
const allowAll = allowed.length === 0 || allowed.includes('*');
if (allowAll) console.warn('[cors] APP_ORIGIN not set — allowing all origins. Set APP_ORIGIN in production.');
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowAll || allowed.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  }
}));

// Capture the raw body so payment webhooks can verify their signature.
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

// --- Simple in-memory rate limiter (no external deps; resets on restart) ---
function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const key = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    let rec = hits.get(key);
    if (!rec || now - rec.start > windowMs) { rec = { start: now, count: 0 }; hits.set(key, rec); }
    rec.count++;
    if (rec.count > max) {
      res.setHeader('Retry-After', Math.ceil((rec.start + windowMs - now) / 1000));
      return res.status(429).json({ error: message || 'Too many requests, try again later' });
    }
    next();
  };
}
// Strict limiter on auth (brute-force / enumeration), looser global limiter on the rest.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many attempts, try again in a few minutes' });
const apiLimiter  = rateLimit({ windowMs: 60 * 1000, max: 120 });

app.get('/health', (req, res) =>
  res.json({ ok: true, service: 'macro-cooks-backend', time: new Date().toISOString() }));

app.use('/api/', apiLimiter);
app.use('/api/auth', authLimiter, require('./routes/auth.routes'));
app.use('/api/profile', require('./routes/profile.routes'));
app.use('/api/payments', require('./routes/payments.routes'));
app.use('/api/content', require('./routes/content.routes'));

// Minimal admin dashboard for testing uploads.
app.use('/admin', express.static(path.join(__dirname, '..', 'admin')));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Central error handler: catches anything routes pass to next(err) (incl. async rejections
// via asyncHandler) so a bad request can never hang or crash the process. Never leak details.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err && err.stack ? err.stack : err);
  if (res.headersSent) return;
  res.status(err && err.status === 400 ? 400 : 500).json({ error: 'server error' });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('Macro Cooks backend listening on :' + port));
