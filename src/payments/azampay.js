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
  if (!res.ok) {
    const err = new Error('AzamPay token failed: ' + res.status);
    // 'token' means AzamPay refused the credentials themselves, before any payment was
    // discussed: the app name, client id or client secret does not match what they hold.
    err.stage = 'token';
    throw err;
  }
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
  if (!res.ok) {
    const err = new Error('AzamPay checkout failed: ' + res.status + ' ' + JSON.stringify(j));
    err.stage = 'checkout';
    throw err;
  }

  // AzamPay answers HTTP 200 even when it REFUSES the request. The body then carries
  // success:false, a message such as "Invalid Vendor", and the literal string "null" as the
  // transaction id. Taking that as a sent push is the worst outcome available here: the
  // customer is told to approve a prompt that never arrived, and the string "null" is stored
  // as the provider reference, where it would go on to match any later callback that also
  // carries no reference. Treat a declined body as the failure it is.
  const txn = j.transactionId || j.reference || j.id;
  const usable = txn != null && String(txn).trim() !== '' && String(txn).trim().toLowerCase() !== 'null';
  if (j.success === false || !usable) {
    const why = String(j.message || j.messageCode || JSON.stringify(j)).slice(0, 300);
    const err = new Error('AzamPay refused the checkout: ' + why);
    err.stage = 'declined';
    err.providerMessage = String(j.message || '').slice(0, 200);
    // The provider answered and declined, so unlike a timeout this outcome is not ambiguous:
    // no prompt was sent and no money can be taken against this order. The caller uses this
    // to close the order instead of leaving it pending forever.
    err.refused = true;
    throw err;
  }
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
// The setting is meant to hold only the token, but the natural thing to paste is the whole
// callback URL that was given to AzamPay, and that is what happened in production: Render
// held all 132 characters of the address while AzamPay sent the 64-character token after
// ?token=, so every payment confirmation was rejected. When the setting is a URL, use its
// token part. The comparison below is still exact; nothing extra is accepted.
function configuredCallbackToken() {
  const raw = String(process.env.AZAMPAY_CALLBACK_TOKEN || '').trim();
  if (/^https?:\/\//i.test(raw)) {
    try { return new URL(raw).searchParams.get('token') || ''; } catch (e) { return ''; }
  }
  return raw;
}
if (/^https?:\/\//i.test(String(process.env.AZAMPAY_CALLBACK_TOKEN || '').trim())) {
  console.warn('[azampay] AZAMPAY_CALLBACK_TOKEN holds a full URL; using its ?token= part. ' +
    'Set it to the token alone to silence this.');
}

function verifyWebhook(rawBody, signatureHeader) {
  const expected = configuredCallbackToken();
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
// A one-way fingerprint for the logs: enough to tell two values apart, or to match one
// against a known candidate offline, and useless for recovering the value itself.
function tokenPrint(v) {
  const s = String(v == null ? '' : v).replace(/^Bearer\s+/i, '');
  if (!s) return '(empty)';
  return 'len ' + s.length + ' sha256:' + crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
}
module.exports = { getToken, initiateMobileMoney, verifyWebhook, getTransactionStatus, tokenPrint, configuredCallbackToken };
