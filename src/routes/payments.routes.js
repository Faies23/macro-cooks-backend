const router = require('express').Router();
const { query } = require('../db');
const { authRequired } = require('../auth');
const provider = require('../payments/azampay'); // active provider (swap this require to change provider)

const PRICES = {
  recipes: parseFloat(process.env.PRICE_RECIPES_USD) || 9.99,
  plan:    parseFloat(process.env.PRICE_PLAN_USD)    || 19.99,
  full:    parseFloat(process.env.PRICE_FULL_USD)    || 49.99
};
const USD_TZS = parseFloat(process.env.USD_TZS) || 2600;

// 1) Start checkout: create an order and trigger the mobile-money prompt.
//    Body: { product, phone, network }  (network = Mpesa|Tigo|Airtel|Halopesa|Azampesa)
router.post('/checkout', authRequired, async (req, res) => {
  try {
    const { product, phone, network } = req.body || {};
    if (!PRICES[product]) return res.status(400).json({ error: 'Unknown product' });
    const usd = PRICES[product];
    const tzs = Math.round(usd * USD_TZS);
    const o = await query(
      'insert into orders(user_id,product,amount_usd,amount_tzs,method,phone,status) ' +
      "values($1,$2,$3,$4,'mobile_money',$5,'pending') returning id",
      [req.user.id, product, usd, tzs, phone || null]
    );
    const orderId = o.rows[0].id;
    let pr;
    try {
      pr = await provider.initiateMobileMoney({ orderRef: orderId, amountTzs: tzs, phone, network });
    } catch (e) {
      await query("update orders set status='failed' where id=$1", [orderId]);
      return res.status(502).json({ error: 'Payment init failed', detail: String(e) });
    }
    await query('update orders set provider_ref=$1 where id=$2',
      [(pr && (pr.transactionId || pr.reference || pr.id)) || null, orderId]);
    res.json({ orderId, status: 'pending', message: 'Approve the prompt on your phone.' });
  } catch (e) { res.status(500).json({ error: 'checkout failed' }); }
});

// 2) Webhook/callback: AzamPay posts the result here -> grant the entitlement.
router.post('/webhook', async (req, res) => {
  const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
  const sig = req.headers['x-azampay-signature'] || req.headers['authorization'] || req.query.token || '';
  if (!provider.verifyWebhook(raw, sig)) return res.status(401).send('bad signature');
  const evt = req.body || {};
  const orderRef = evt.utilityref || evt.externalId || evt.orderReference || evt.orderId;
  const status = String(evt.transactionstatus || evt.status || evt.paymentStatus || '').toUpperCase();
  if (!orderRef) return res.status(200).send('ignored');

  if (['SUCCESS', 'SUCCESSFUL', 'PAID', 'COMPLETED'].includes(status)) {
    const r = await query(
      "update orders set status='paid', updated_at=now() where id=$1 returning user_id, product",
      [orderRef]
    );
    if (r.rows[0]) {
      const { user_id, product } = r.rows[0];
      const grants = product === 'full' ? ['plan', 'recipes', 'full'] : [product];
      for (const g of grants) {
        await query('insert into entitlements(user_id,product) values($1,$2) on conflict do nothing', [user_id, g]);
      }
    }
  } else if (['FAILED', 'FAILURE', 'CANCELLED'].includes(status)) {
    await query("update orders set status='failed', updated_at=now() where id=$1", [orderRef]);
  }
  res.status(200).send('ok');
});

// 3) Order status (the app polls this after checkout).
router.get('/orders/:id', authRequired, async (req, res) => {
  const r = await query(
    'select id,product,status,amount_usd,amount_tzs from orders where id=$1 and user_id=$2',
    [req.params.id, req.user.id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
  res.json(r.rows[0]);
});

// 4) Entitlements: what the user has unlocked.
router.get('/entitlements', authRequired, async (req, res) => {
  const r = await query('select product from entitlements where user_id=$1', [req.user.id]);
  res.json({ products: r.rows.map(x => x.product) });
});
module.exports = router;
