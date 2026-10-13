require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const app = express();

// Render terminates TLS at its proxy, so without this every request looks like it comes from
// the proxy and the rate limiter below would bucket all customers together.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// --- Security headers (dependency-free, covers the essentials helmet would add) ---
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // This API is deliberately called from another site (the app on Netlify) and from the
  // Android WebView, so the resource policy must be cross-origin. 'same-site' would block
  // the very clients it exists to serve.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});

// CORS policy is unchanged from the previous deployment: APP_ORIGIN when set, otherwise open.
// Setting APP_ORIGIN in Render to your real origin(s) narrows this with no code change.
// Note this API authenticates with Bearer tokens and uses no cookies, so CORS is not what
// protects it; the rate limiting and the auth checks are.
app.use(cors({ origin: process.env.APP_ORIGIN || '*' }));
if (!process.env.APP_ORIGIN) {
  console.warn('[cors] APP_ORIGIN is not set, so any origin is accepted. Set it to your real origin(s) to narrow this.');
}

// Capture the raw body so payment webhooks can verify their signature.
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

// --- Simple in-memory rate limiter (no external deps, resets on restart) ---
// There was previously no rate limiting of any kind on this service.
function rateLimit({ windowMs, max, message, key }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
  }, windowMs).unref();
  const MAX_KEYS = 50000; // hard cap so a flood of distinct IPs cannot grow the map unbounded
  return (req, res, next) => {
    const bucket = (key && key(req)) || req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
    const now = Date.now();
    let rec = hits.get(bucket);
    if (!rec || now - rec.start > windowMs) {
      if (hits.size >= MAX_KEYS) {
        for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
        if (hits.size >= MAX_KEYS) hits.delete(hits.keys().next().value);
      }
      rec = { start: now, count: 0 }; hits.set(bucket, rec);
    }
    rec.count++;
    if (rec.count > max) {
      res.setHeader('Retry-After', Math.ceil((rec.start + windowMs - now) / 1000));
      return res.status(429).json({ error: message || 'Too many requests, try again later' });
    }
    next();
  };
}

// Most customers here reach the internet through a handful of carrier NAT addresses, so
// counting login attempts per IP alone would punish everyone on the same mobile network for
// one person's typos. The strict bucket is per account (IP plus the submitted email), which
// is what actually stops guessing against a specific user, backed by a much higher per-IP
// ceiling that still stops a flood from one source.
const authKey = (req) => {
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
  const email = req.body && typeof req.body.email === 'string'
    ? req.body.email.trim().toLowerCase() : '';
  return email ? 'acct:' + ip + '|' + email : 'ip:' + ip;
};
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, key: authKey,
  message: 'Too many attempts, try again in a few minutes'
});
const authIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 300,
  message: 'Too many attempts from this network, try again in a few minutes'
});
// The app polls order status right after money is taken, so the general ceiling has to sit
// comfortably above what one shared carrier address produces in normal use.
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 600 });

app.get('/health', (req, res) =>
  res.json({ ok: true, service: 'macro-cooks-backend', time: new Date().toISOString() }));

app.use('/api/', apiLimiter);
app.use('/api/auth', authIpLimiter, authLimiter, require('./routes/auth.routes'));
app.use('/api/profile', require('./routes/profile.routes'));
app.use('/api/payments', require('./routes/payments.routes'));
app.use('/api/content', require('./routes/content.routes'));

// Minimal admin dashboard for testing uploads.
app.use('/admin', express.static(path.join(__dirname, '..', 'admin')));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Central error handler. Anything a route passes to next(err), including async rejections
// via the wrap() helper, lands here instead of hanging the request or leaking a stack trace
// to the caller. The detail still goes to the Render logs.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err && err.stack ? err.stack : err);
  if (res.headersSent) return;
  res.status(err && err.status === 400 ? 400 : 500).json({ error: 'server error' });
});

// A promise rejected outside any handler terminates the process on modern Node. Record it
// and keep serving: losing the API in the middle of settling a payment is worse than a log.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('Macro Cooks backend listening on :' + port));
