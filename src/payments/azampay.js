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
async function initiateMobileMoney({ orderRef, amountTzs, phone, network }) {
  const token = await getToken();
  const res = await fetch(CHECKOUT_BASE + '/azampay/mno/checkout', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'X-API-Key': process.env.AZAMPAY_API_KEY || ''   // some setups require this header
    },
    body: JSON.stringify({
      accountNumber: phone,
      amount: String(amountTzs),
      currency: 'TZS',
      externalId: orderRef,
      provider: network || 'Mpesa'
    })
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('AzamPay checkout failed: ' + res.status + ' ' + JSON.stringify(j));
  return j; // expect a transactionId / reference + success flag
}

/*
 * 3) Verify the callback is genuine. AzamPay does not send a standard HMAC, so the
 *    recommended protections are: keep the callback URL secret, allow-list AzamPay's
 *    IPs at your host, and (best) re-check the transaction status via AzamPay before
 *    granting. As a simple extra check, set AZAMPAY_CALLBACK_TOKEN and include it as a
 *    header/query value on your registered callback URL; we compare it here.
 */
function verifyWebhook(rawBody, signatureHeader) {
  const expected = process.env.AZAMPAY_CALLBACK_TOKEN || '';
  if (!expected) return true; // configure AZAMPAY_CALLBACK_TOKEN in production
  return (signatureHeader || '').includes(expected);
}
module.exports = { getToken, initiateMobileMoney, verifyWebhook };
