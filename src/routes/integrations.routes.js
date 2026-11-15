const crypto = require('crypto');
const router = require('express').Router();
const { notifyMacrosOS } = require('../integrations/macrosos');

// Take App (take.app/macrocooks) posts an event here whenever a store order is created or
// changes. We verify it, answer 200 at once (Take App retries non-2xx and switches off an
// endpoint that keeps failing), then forward a normalised sale to Macros OS.
//
// Take App signs every delivery: header X-Take-Signature is "t=<unix seconds>,v1=<hex>",
// where v1 = HMAC-SHA256("<t>.<raw body>") with the endpoint's signing secret. Verify on the
// raw bytes, never on re-serialised JSON. The secret lives in TAKEAPP_WEBHOOK_SECRET.
function verifyTakeSignature(rawBody, header, secret) {
  try {
    const parts = Object.fromEntries(String(header || '').split(',').map(p => p.split('=')));
    const t = Number(parts.t);
    if (!Number.isFinite(t) || Math.abs(Math.floor(Date.now() / 1000) - t) > 300) return false;
    const expected = crypto.createHmac('sha256', secret).update(t + '.' + rawBody).digest('hex');
    const a = Buffer.from(expected), b = Buffer.from(String(parts.v1 || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

// Delivery is at-least-once, so remember recent delivery ids and drop retries of ones we
// already handled. Macros OS is idempotent on the order id as well; this just saves calls.
const seen = new Map();
function alreadyHandled(id) {
  if (!id) return false;
  const now = Date.now();
  for (const [k, at] of seen) if (now - at > 60 * 60 * 1000) seen.delete(k);
  if (seen.has(id)) return true;
  seen.set(id, now);
  return false;
}

router.post('/takeapp', (req, res) => {
  const secret = process.env.TAKEAPP_WEBHOOK_SECRET || '';
  if (!secret) {
    console.warn('[takeapp] TAKEAPP_WEBHOOK_SECRET is not set; delivery refused');
    return res.status(503).send('not configured');
  }
  const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
  if (!verifyTakeSignature(raw, req.headers['x-take-signature'], secret)) {
    console.warn('[takeapp] rejected delivery: bad signature');
    return res.status(401).send('bad signature');
  }
  res.status(200).send('ok');

  if (alreadyHandled(req.headers['x-take-delivery-id'])) return;
  const evt = req.body || {};
  if (evt.type !== 'order.created' && evt.type !== 'order.updated') return;
  const o = evt.data || {};
  if (!o || !o.id) return;
  if (String(o.currency || 'TZS').toUpperCase() !== 'TZS') {
    console.warn('[takeapp] skipped order', o.id, 'in currency', o.currency);
    return;
  }
  if (/cancel/i.test(String(o.order_status || ''))) {
    console.log('[takeapp] order', o.id, 'is cancelled. If it was already recorded, adjust Macros OS by hand.');
    return;
  }
  const items = (o.line_items || []).map(li => {
    const qty = Number(li.quantity_float != null ? li.quantity_float : li.quantity) || 1;
    const total = Number(li.total_amount);
    const rate = Number.isFinite(total) && qty > 0 ? total / qty : Number(li.price) || 0;
    return { name: String(li.name || 'Item'), qty, price: Math.round(rate) };
  });
  const paid = /^paid$/i.test(String(o.payment_status || '')) ? Number(o.total_amount) || 0 : 0;
  notifyMacrosOS({
    source: 'takeapp',
    externalId: String(o.id),
    orderNo: String(o.number || o.name || o.id),
    date: String(o.created_at || '').slice(0, 10) || undefined,
    customer: {
      name: (o.customer && o.customer.name) || 'Take App customer',
      phone: (o.customer && o.customer.phone) || '',
      email: ''
    },
    items,
    total: Number(o.total_amount) || 0,
    paid,
    method: 'Take App',
    ref: 'Take App order ' + String(o.number || o.id)
  }).catch(e => console.error('[takeapp] forward failed:', (e && e.message) || e));
});

// People paste webhook URLs into browsers to check them; answer plainly instead of a 404.
router.get('/takeapp', (req, res) => res.json({
  ok: true,
  endpoint: 'Take App webhook',
  accepts: 'POST',
  note: 'Live. Point Take App at this URL under Settings, Apps, Webhooks, and put the signing secret in TAKEAPP_WEBHOOK_SECRET.'
}));

router.verifyTakeSignature = verifyTakeSignature; // exposed for tests
module.exports = router;
