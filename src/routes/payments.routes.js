const router = require('express').Router();
const { query } = require('../db');
const { authRequired } = require('../auth');
const provider = require('../payments/azampay'); // active provider (swap this require to change provider)
const { getAmount, getDays, isProduct, isCycle } = require('../pricing');

// Wrap async handlers so any rejection reaches the central error middleware instead of hanging.
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Mobile money settles in TZS, so we convert the USD list price for the push.
// amount_usd stays the source-of-truth price; amount_tzs is just what the phone is charged.
const USD_TZS = parseFloat(process.env.USD_TZS) || 2600;

// 1) Start checkout: create a (pending) order and trigger the mobile-money prompt.
//    Body: { product, cycle, phone, network }
//      product = plan | recipes | full
//      cycle   = mo (30 days) | yr (365 days)
//      network = Mpesa | Tigo | Airtel | Halopesa | Azampesa
router.post('/checkout', authRequired, wrap(async (req, res) => {
  const { product, cycle, phone, network } = req.body || {};
  if (!isProduct(product)) return res.status(400).json({ error: 'Unknown product' });
  if (!isCycle(cycle)) return res.status(400).json({ error: 'Unknown cycle' });
  if (phone != null && typeof phone !== 'string') return res.status(400).json({ error: 'invalid phone' });

  // SINGLE SOURCE OF TRUTH: amount comes from the server price table, never the client.
  const usd = getAmount(product, cycle);
  // Round UP so the charged amount is never shaved below the listed price.
  const tzs = Math.ceil(usd * USD_TZS);

  const o = await query(
    'insert into orders(user_id,product,cycle,amount_usd,amount_tzs,method,phone,status) ' +
    "values($1,$2,$3,$4,$5,'mobile_money',$6,'pending') returning id",
    [req.user.id, product, cycle, usd, tzs, phone || null]
  );
  const orderId = o.rows[0].id;

  let pr;
  try {
    // Forward the amount (TZS), phone and network to the AzamPay MNO checkout push.
    pr = await provider.initiateMobileMoney({ orderRef: orderId, amountTzs: tzs, phone, network });
  } catch (e) {
    // Surface the provider's actual reason in the Render logs. Vital during sandbox
    // integration: field names and URLs must match AzamPay's current docs.
    console.error('AZAMPAY CHECKOUT ERROR:', (e && e.message) || e);
    await query("update orders set status='failed', updated_at=now() where id=$1", [orderId]);
    const detail = process.env.NODE_ENV === 'production' ? undefined : String((e && e.message) || e);
    return res.status(502).json({ error: 'Payment init failed', detail });
  }
  // Save the provider reference so the webhook can match the callback back to this order.
  const providerRef = (pr && (pr.transactionId || pr.reference || pr.id)) || null;
  await query('update orders set provider_ref=$1, updated_at=now() where id=$2',
    [providerRef, orderId]);

  // providerRef is the AzamPay transaction id; returned so it can be shared for
  // sandbox integration sign-off without querying the database.
  res.json({ orderId, providerRef, status: 'pending', message: 'Approve the prompt on your phone.' });
}));

// 2) Webhook/callback: AzamPay posts the result here -> grant a time-limited entitlement.
//    SECURITY: the webhook is an UNTRUSTED trigger, never the source of truth. We:
//    (a) require a valid signature/token (fail closed, see provider.verifyWebhook),
//    (b) only transition orders that are still 'pending' (idempotent / no downgrade),
//    (c) verify the reported amount/currency against the stored order,
//    (d) re-confirm with the provider when a status API is available,
//    before granting any entitlement.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const handleWebhook = wrap(async (req, res) => {
  const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
  // AzamPay sends the shared secret as a ?token= query parameter on the callback URL,
  // so we accept that as well as the header forms. Header is preferred (query strings can
  // appear in access logs); the check still fails closed when no token matches.
  const sig = req.headers['x-azampay-signature']
    || req.headers['authorization']
    || (req.query && (req.query.token || req.query.Token))
    || '';
  if (!provider.verifyWebhook(raw, sig)) {
    console.warn('[webhook] rejected: callback token did not match AZAMPAY_CALLBACK_TOKEN');
    return res.status(401).send('bad signature');
  }

  const evt = req.body || {};
  // Match on our order id first; fall back to the provider's transaction reference.
  const orderRef = evt.utilityref || evt.externalId || evt.orderReference || evt.orderId;
  const txnRef = evt.transactionId || evt.reference || evt.transactionref || null;
  const status = String(evt.transactionstatus || evt.status || evt.paymentStatus || '').toUpperCase();

  // `id` is a uuid column: only compare it when the callback carried a real uuid,
  // otherwise Postgres raises "invalid input syntax for type uuid" and the webhook 500s.
  // Both the success and the failure branch match on these, so resolve them once here.
  const idParam = (typeof orderRef === 'string' && UUID_RE.test(orderRef)) ? orderRef : null;
  const refParam = (typeof txnRef === 'string' && txnRef) ? txnRef : null;
  if (!idParam && !refParam) return res.status(200).send('ok'); // nothing to match on

  if (['SUCCESS', 'SUCCESSFUL', 'PAID', 'COMPLETED'].includes(status)) {
    // Look up the order while it is still pending; anything else is a replay / already-handled.
    // Find by our id, or by the provider_ref we saved at checkout, whichever the callback carries.
    const ord = await query(
      "select id, user_id, product, cycle, amount_tzs, provider_ref from orders " +
      "where status='pending' and (id=$1 or provider_ref=$2) limit 1",
      [idParam, refParam]
    );
    if (!ord.rows[0]) return res.status(200).send('ok'); // unknown id or already settled -> no-op

    const order = ord.rows[0];

    // (c) Amount/currency sanity: if the callback reports an amount, it must cover the order.
    const reportedAmount = Number(evt.amount != null ? evt.amount : evt.transactionamount);
    const reportedCurrency = String(evt.currency || 'TZS').toUpperCase();
    if (Number.isFinite(reportedAmount) && (reportedAmount < Number(order.amount_tzs) || reportedCurrency !== 'TZS')) {
      console.warn('[webhook] amount/currency mismatch for order', order.id);
      return res.status(200).send('ignored');
    }

    // (d) Server-to-server re-confirmation with the provider, when supported.
    if (typeof provider.getTransactionStatus === 'function') {
      try {
        const verified = await provider.getTransactionStatus(order.provider_ref || txnRef || order.id);
        if (verified && verified.paid === false) {
          console.warn('[webhook] provider says NOT paid for order', order.id);
          return res.status(200).send('ignored');
        }
      } catch (e) { /* provider check unavailable, fall through to the gated grant */ }
    }

    // Idempotent transition: only flips a row that is still pending.
    const r = await query(
      "update orders set status='paid', updated_at=now() where id=$1 and status='pending' " +
      'returning user_id, product, cycle',
      [order.id]
    );
    if (r.rows[0]) {
      const { user_id, product, cycle } = r.rows[0];
      const days = getDays(cycle);
      // One time-limited entitlement for the purchased product. Tiers are cumulative,
      // but the app maps that itself from the active product names, so we grant just one row.
      await query(
        "insert into entitlements(user_id,product,expires_at) values($1,$2, now() + ($3::int * interval '1 day'))",
        [user_id, product, days]
      );
    }
  } else if (['FAILED', 'FAILURE', 'CANCELLED'].includes(status)) {
    // Never let a late/forged FAILED downgrade an order that is already paid.
    // Uses the same guarded params as the success branch: a non-uuid reference is
    // nulled out, so a real mobile-money code like MPESA9TZ8KQ0X2 can no longer
    // raise "invalid input syntax for type uuid" and turn this into an HTTP 500.
    await query(
      "update orders set status='failed', updated_at=now() where status='pending' and (id=$1 or provider_ref=$2)",
      [idParam, refParam]
    );
  }
  res.status(200).send('ok');
});

// AzamPay posts here. Keep /callback as an alias for older configurations.
router.post('/webhook', handleWebhook);
router.post('/callback', handleWebhook);

// 3) Order status (the app polls this after checkout).
router.get('/orders/:id', authRequired, wrap(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const r = await query(
    'select id,product,cycle,status,amount_usd from orders where id=$1 and user_id=$2',
    [req.params.id, req.user.id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
  res.json({ status: r.rows[0].status, order: r.rows[0] });
}));

// 4) Entitlements: the ACTIVE product names the user currently holds (expires_at in the future).
//    The app maps tiers cumulatively itself, so we just return distinct active product names.
router.get('/entitlements', authRequired, wrap(async (req, res) => {
  const r = await query(
    'select distinct product from entitlements where user_id=$1 and expires_at > now()',
    [req.user.id]
  );
  res.json({ products: r.rows.map(x => x.product) });
}));

module.exports = router;
