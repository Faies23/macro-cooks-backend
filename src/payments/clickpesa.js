/*
 * ClickPesa mobile-money adapter (M-Pesa, Tigo/Mixx, Airtel, HaloPesa + cards).
 *
 * IMPORTANT: the endpoint paths and field names below follow ClickPesa's
 * "USSD push" mobile-money pattern. CONFIRM the exact paths, auth headers and
 * payloads against the CURRENT ClickPesa API docs in your developer dashboard,
 * and TEST in their sandbox before going live. Selcom/DPO/Flutterwave follow the
 * same shape — swap this one file to switch provider.
 */
const crypto = require('crypto');
const BASE = process.env.CLICKPESA_BASE_URL || 'https://api.clickpesa.com';

// Most aggregators issue a short-lived bearer token from client credentials.
async function getToken() {
  const res = await fetch(BASE + '/third-parties/generate-token', {
    method: 'POST',
    headers: {
      'client-id': process.env.CLICKPESA_CLIENT_ID || '',
      'api-key': process.env.CLICKPESA_API_KEY || ''
    }
  });
  if (!res.ok) throw new Error('ClickPesa token failed: ' + res.status);
  const j = await res.json();
  return j.token || j.access_token;
}

// Trigger a payment prompt on the customer's phone.
async function initiateMobileMoney({ orderRef, amountTzs, phone }) {
  const token = await getToken();
  const res = await fetch(BASE + '/third-parties/payments/initiate-ussd-push-request', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: String(amountTzs),
      currency: 'TZS',
      orderReference: orderRef,
      phoneNumber: phone
    })
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('ClickPesa initiate failed: ' + res.status + ' ' + JSON.stringify(j));
  return j; // expect a provider reference / status here
}

// Verify a webhook really came from ClickPesa (HMAC shared-secret pattern).
function verifyWebhook(rawBody, signatureHeader) {
  const secret = process.env.CLICKPESA_WEBHOOK_SECRET || '';
  if (!secret) return true; // NOTE: configure the secret in production!
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader || '')); }
  catch (e) { return false; }
}
module.exports = { getToken, initiateMobileMoney, verifyWebhook };
