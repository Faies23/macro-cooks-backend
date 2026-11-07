const router = require('express').Router();
const { pool, query } = require('../db');
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
// AzamPay's provider names, keyed the way the app and older clients may send them.
const NETWORKS = {
  tigo: { provider: 'Tigo', label: 'Mixx by Yas' },
  mixx: { provider: 'Tigo', label: 'Mixx by Yas' },
  airtel: { provider: 'Airtel', label: 'Airtel Money' },
  mpesa: { provider: 'Mpesa', label: 'M-Pesa' },
  'm-pesa': { provider: 'Mpesa', label: 'M-Pesa' },
  halopesa: { provider: 'Halopesa', label: 'Halopesa' },
  azampesa: { provider: 'Azampesa', label: 'AzamPesa' }
};

// Returns the number as 0XXXXXXXXX, or null when it is not a Tanzanian mobile number.
function normaliseTzMobile(raw) {
  let d = String(raw || '').replace(/[^0-9]/g, '');
  if (d.startsWith('255') && d.length === 12) d = '0' + d.slice(3);
  else if (d.length === 9 && /^[67]/.test(d)) d = '0' + d;
  return /^0[67][0-9]{8}$/.test(d) ? d : null;
}

function customerMessage(e, net) {
  const stage = e && e.stage;
  const said = String((e && e.providerMessage) || '');
  if (stage === 'declined' && /invalid vendor/i.test(said)) {
    return net.label + ' payments are not switched on yet. Please choose another mobile network.';
  }
  if (stage === 'declined') {
    return net.label + ' could not start this payment. Check that the number is registered for ' +
      net.label + ' and try again.';
  }
  if (stage === 'token') return 'Payments are briefly unavailable. Please try again in a few minutes.';
  return 'We could not start the payment. Please try again.';
}

router.post('/checkout', authRequired, wrap(async (req, res) => {
  const { product, cycle, phone, network } = req.body || {};
  if (!isProduct(product)) return res.status(400).json({ error: 'Unknown product' });
  if (!isCycle(cycle)) return res.status(400).json({ error: 'Unknown cycle' });
  if (phone != null && typeof phone !== 'string') return res.status(400).json({ error: 'invalid phone' });

  // Customers type numbers every way there is: +255 7.., 255 7.., 07.., with spaces and
  // dashes. Charge one clean local form, and refuse anything that is not a Tanzanian mobile
  // number here, where the customer can be told plainly, rather than at the network.
  const msisdn = normaliseTzMobile(phone);
  if (!msisdn) {
    return res.status(400).json({ error: 'Enter your mobile number like 0712 345 678' });
  }
  const net = NETWORKS[String(network || '').toLowerCase()];
  if (!net) return res.status(400).json({ error: 'Choose a mobile network' });

  // SINGLE SOURCE OF TRUTH: amount comes from the server price table, never the client.
  const usd = getAmount(product, cycle);
  // Round UP so the charged amount is never shaved below the listed price.
  const tzs = Math.ceil(usd * USD_TZS);

  const o = await query(
    'insert into orders(user_id,product,cycle,amount_usd,amount_tzs,method,phone,status) ' +
    "values($1,$2,$3,$4,$5,'mobile_money',$6,'pending') returning id",
    [req.user.id, product, cycle, usd, tzs, msisdn]
  );
  const orderId = o.rows[0].id;

  let pr;
  try {
    // Forward the amount (TZS), phone and network to the AzamPay MNO checkout push.
    pr = await provider.initiateMobileMoney({ orderRef: orderId, amountTzs: tzs, phone: msisdn, network: net.provider });
  } catch (e) {
    // Surface the provider's actual reason in the Render logs. Vital during sandbox
    // integration: field names and URLs must match AzamPay's current docs.
    //
    // Deliberately DO NOT mark the order failed here. A thrown error does not mean the push
    // was never sent: a cold start, a socket timeout, or a 5xx from the provider edge can all
    // arrive after the prompt already reached the customer's phone. Writing a terminal
    // 'failed' on that ambiguous outcome means the customer approves, is debited, and the
    // later SUCCESS callback finds a non-pending order and silently drops the payment.
    // A pending order that never settles costs nothing; a wrongly failed one loses real money.
    console.error('AZAMPAY CHECKOUT ERROR for order', orderId, ':', (e && e.message) || e);
    // One exception to the paragraph above: when the provider ANSWERED and declined, the
    // outcome is not ambiguous at all. No prompt was sent, so no money can arrive against
    // this order, and leaving it pending only fills the pending list with orders that can
    // never settle. Timeouts and 5xx responses still stay pending, exactly as described.
    if (e && e.refused) {
      await query("update orders set status='failed', updated_at=now() where id=$1 and status='pending'",
        [orderId]).catch(err => console.error('could not close refused order', orderId, err && err.message));
    }
    const detail = process.env.NODE_ENV === 'production' ? undefined : String((e && e.message) || e);
    // 'stage' names which half of the handshake failed and contains no credential of any
    // kind. Without it a failed payment looks identical whether the keys are wrong or the
    // account is not switched on, and the owner cannot tell who to go and ask.
    return res.status(502).json({
      // What the customer reads. The provider's own wording ("contact system admin") means
      // nothing to them, so it is translated here into the one thing they can act on.
      error: customerMessage(e, net),
      orderId,
      stage: (e && e.stage) || 'unknown',
      providerMessage: (e && e.providerMessage) || undefined,
      detail
    });
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
  //
  // This used to take the FIRST value it found, in header order. A caller that also sent an
  // Authorization header of its own had that header checked instead, and the correct ?token=
  // in the URL was never looked at, so a genuine payment confirmation was thrown away. Every
  // place the token can arrive is now checked, and any one of them matching is enough.
  const q = req.query || {};
  const candidates = [
    ['x-azampay-signature', req.headers['x-azampay-signature']],
    ['authorization', req.headers['authorization']],
    ['query token', q.token || q.Token]
  ].filter(c => c[1]).map(c => [c[0], String(c[1])]);
  const matched = candidates.find(c => provider.verifyWebhook(raw, c[1]));
  if (!matched) {
    // Say exactly what arrived, as fingerprints, and what the callback reported. Without this
    // a rejected confirmation could have been a payment the customer had already made.
    const e0 = req.body || {};
    console.warn('[webhook] rejected: callback token did not match AZAMPAY_CALLBACK_TOKEN.' +
      ' expected ' + provider.tokenPrint(provider.configuredCallbackToken()) +
      '; received ' + (candidates.length
        ? candidates.map(c => c[0] + ' ' + provider.tokenPrint(c[1])).join(', ')
        : 'no token anywhere') +
      '; callback status=' + String(e0.transactionstatus || e0.status || '?') +
      ' order=' + String(e0.utilityref || e0.externalId || e0.orderId || '?').slice(0, 40) +
      ' amount=' + String(e0.amount || '?') +
      ' operator=' + String(e0.operator || e0.provider || '?') +
      ' ref=' + String(e0.reference || e0.transactionId || e0.transid || '?').slice(0, 40));
    return res.status(401).send('bad signature');
  }

  const evt = req.body || {};
  // One line per accepted confirmation, so the log always shows what AzamPay reported for an
  // order, including ones that match nothing here and would otherwise leave no trace.
  console.log('[webhook] accepted via ' + matched[0] +
    ': status=' + String(evt.transactionstatus || evt.status || '?') +
    ' order=' + String(evt.utilityref || evt.externalId || evt.orderId || '?').slice(0, 40) +
    ' amount=' + String(evt.amount || '?') +
    ' operator=' + String(evt.operator || evt.provider || '?') +
    ' ref=' + String(evt.reference || evt.transactionId || evt.transid || '?').slice(0, 40));
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
    // Find by our id, or by the provider_ref we saved at checkout, whichever the callback
    // carries. Match any order that is not already paid, not only a pending one. If checkout could
    // not confirm the push the order may be sitting in another state, and this callback is
    // the provider telling us the money actually moved. Idempotency is preserved because a
    // row that is already 'paid' is excluded here and in the guarded update below.
    const ord = await query(
      "select id, user_id, product, cycle, amount_tzs, provider_ref from orders " +
      "where status <> 'paid' and (id=$1 or provider_ref=$2) limit 1",
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

    // Flip the order and grant the entitlement in ONE transaction on ONE connection.
    // Run as two auto-commit statements these can half-apply: the order reads 'paid' while
    // the grant fails, leaving a paying customer with no access and no way back, because the
    // guarded update will never match that row again. Committing them together means the
    // sale is either fully recorded or not recorded at all.
    const client = await pool.connect();
    let granted = false;
    try {
      await client.query('begin');
      // Two callbacks for the same customer and product arriving together would both read
      // the same max(expires_at) and both extend from it, so the second payment would add no
      // time at all. Serialise the grant on the pair for the length of this transaction.
      await client.query('select pg_advisory_xact_lock(hashtext($1::text))',
        [String(order.user_id) + ':' + String(order.product)]);
      // Idempotent transition: only flips a row that is not already paid.
      const r = await client.query(
        "update orders set status='paid', updated_at=now() where id=$1 and status <> 'paid' " +
        'returning user_id, product, cycle',
        [order.id]
      );
      if (r.rows[0]) {
        const { user_id, product, cycle } = r.rows[0];
        const days = getDays(cycle);
        // One time-limited entitlement per payment. Tiers are cumulative, but the app maps
        // that itself from the active product names, so we grant just one row.
        // A renewal extends from the current expiry so paying again never throws away time
        // the customer has already bought; a lapsed entitlement simply starts from now.
        await client.query(
          "insert into entitlements(user_id,product,expires_at) select $1,$2, " +
          "greatest(now(), coalesce((select max(expires_at) from entitlements " +
          "where user_id=$1 and product=$2), now())) + ($3::int * interval '1 day')",
          [user_id, product, days]
        );
        granted = true;
      }
      await client.query('commit');
    } catch (e) {
      await client.query('rollback').catch(() => {});
      // Answer non-2xx so AzamPay retries this callback. Swallowing it with a 200 would
      // tell the provider the payment was handled when the customer got nothing.
      console.error('[webhook] settlement FAILED for order', order.id, ':', (e && e.message) || e);
      return res.status(500).send('settlement failed');
    } finally {
      client.release();
    }
    if (granted) console.log('[webhook] settled order', order.id);
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

// A GET is never a real callback, but people do paste this URL into a browser to check the
// endpoint is alive, and some provider dashboards probe it the same way. Without this the
// request falls through to the catch-all 404 and reads as "the callback URL is wrong", which
// is misleading. Answer plainly instead. No token is checked and nothing is revealed here,
// because this handler reads no state and performs no action.
const describeCallback = (req, res) => res.json({
  ok: true,
  endpoint: 'AzamPay callback',
  accepts: 'POST',
  note: 'This endpoint is live. Callbacks must be sent as POST with the shared token.'
});
router.get('/webhook', describeCallback);
router.get('/callback', describeCallback);

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
