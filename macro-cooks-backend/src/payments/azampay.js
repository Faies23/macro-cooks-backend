/*
 * AzamPay mobile-money adapter (Tanzania): M-Pesa (Vodacom), Tigo/Mixx, Airtel, Halopesa, Azampesa.
 *
 * Flow:  GenerateToken  ->  MNO Checkout (push to the customer's phone)  ->  AzamPay
 *        posts the result to your callback URL (/api/payments/webhook).
 *
 * IMPORTANT: paths/fields below follow AzamPay's documented MNO Checkout pattern.
 * Confirm the EXACT URLs, headers and field names against the CURRENT AzamPay docs
 * (developer portal) and TEST in their sandbox before switching to production.
 */
const crypto = require('crypto');
const AUTH_BASE     = process.env.AZAMPAY_AUTH_BASE_URL     || 'https://authenticator-sandbox.azampay.co.tz';
const CHECKOUT_BASE = process.env.AZAMPAY_CHECKOUT_BASE_URL || 'https://sandbox.azampay.co.tz';

// 1) Get a bearer token from your app credentials.
async function getToken() {
  const res = await fetch(AUTH_BASE + '/AppRegistration/GenerateToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appName: process.env.AZAMPAY_APP_NAME || '',
      clientId: process.env.AZAMPAY_CLIENT_ID || '',
      clientSecret: process.env.AZAMPAY_CLIENT_SECRET || ''
    })
  });
  if (!res.ok) throw new Error('AzamPay token failed: ' + res.status);
  const j = await res.json();
  return (j.data && j.data.accessToken) || j.accessToken || j.token;
}

// 2) Push a payment prompt to the phone.
//    network = "Mpesa" | "Tigo" | "Airtel" | "Halopesa" | "Azampesa"
//    Pass the (TZS) amount as `amountTzs` (preferred) or `amount`; it is forwarded to AzamPay.
async function initiateMobileMoney({ orderRef, amountTzs, amount, phone, network }) {
  const token = await getToken();
  const payAmount = amountTzs != null ? amountTzs : amount;
  const res = await fetch(CHECKOUT_BASE + '/azampay/mno/checkout', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'X-API-Key': process.env.AZAMPAY_API_KEY || ''   // some setups require this header
    },
    body: JSON.stringify({
      accountNumber: phone,
      amount: String(payAmount),
      currency: 'TZS',
      externalId: orderRef,
      provider: network || 'Mpesa'
    })
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('AzamPay checkout failed: ' + res.status + ' ' + JSON.stringify(j));
  return j; // expect a transactionId / reference + success flag
}

// 3) (optional) Re-confirm a transaction directly with AzamPay before granting access.
//    Configure AZAMPAY_STATUS_URL (and the provider's expected response shape) to enable.
//    Returns { paid: true|false } or throws/returns null when verification is unavailable.
async function getTransactionStatus(ref) {
  const url = process.env.AZAMPAY_STATUS_URL;
  if (!url || !ref) return null; // not configured -> caller falls back to signature + amount checks
  const token = await getToken();
  const res = await fetch(url.replace('{ref}', encodeURIComponent(ref)), {
    headers: { 'Authorization': 'Bearer ' + token }
  });
  if (!res.ok) return null;
  const j = await res.json().catch(() => ({}));
  const s = String((j.data && j.data.transactionStatus) || j.transactionStatus || j.status || '').toUpperCase();
  if (!s) return null;
  return { paid: ['SUCCESS', 'SUCCESSFUL', 'PAID', 'COMPLETED'].includes(s) };
}

/*
 * 4) Verify the callback is genuine. AzamPay does not send a standard HMAC, so the
 *    protections are: keep the callback secret, allow-list AzamPay's IPs at your host,
 *    re-check the transaction status (getTransactionStatus above), AND require a shared
 *    AZAMPAY_CALLBACK_TOKEN sent as a request HEADER (never a URL query string).
 *
 *    SECURITY: this FAILS CLOSED. With no token configured we reject every callback,
 *    so a misconfigured deployment can't be tricked into granting paid access for free.
 */
function verifyWebhook(rawBody, signatureHeader) {
  const expected = process.env.AZAMPAY_CALLBACK_TOKEN || '';
  if (!expected) {
    console.warn('[azampay] AZAMPAY_CALLBACK_TOKEN not set — rejecting webhook (fail closed).');
    return false;
  }
  const provided = String(signatureHeader || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}
module.exports = { getToken, initiateMobileMoney, verifyWebhook, getTransactionStatus };
