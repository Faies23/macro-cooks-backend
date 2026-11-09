// Forwards recorded sales to Macros OS, the company's bookkeeping app on Google Sheets.
// MACROS_OS_WEBHOOK_URL is the Apps Script web app URL INCLUDING its ?key= secret
// (Macros OS sheet menu: Macros OS > Webhook settings). Keep it out of logs.
//
// Fire-and-forget with small retries: a sale that cannot be forwarded is logged loudly,
// but it must never fail the payment flow that produced it.

const urlOf = () => String(process.env.MACROS_OS_WEBHOOK_URL || '').trim();

async function postOnce(sale) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    // Apps Script answers a POST with a redirect to a one-time URL; follow it.
    const res = await fetch(urlOf(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sale),
      redirect: 'follow',
      signal: ctrl.signal
    });
    const text = await res.text();
    let body = {};
    try { body = JSON.parse(text); } catch (e) { /* non-JSON answer falls through below */ }
    if (res.ok && body && body.ok) {
      console.log('[macrosos] recorded', sale.source, sale.externalId, 'as', body.invoice || 'ok',
        body.duplicate ? '(already there)' : body.updated ? '(payment updated)' : '');
      return;
    }
    throw new Error('HTTP ' + res.status + ' ' + String(text).slice(0, 160));
  } finally {
    clearTimeout(timer);
  }
}

async function notifyMacrosOS(sale) {
  if (!urlOf()) {
    console.warn('[macrosos] MACROS_OS_WEBHOOK_URL is not set, so this sale was NOT forwarded:',
      sale.source, sale.externalId);
    return;
  }
  for (let i = 1; i <= 3; i++) {
    try { await postOnce(sale); return; } catch (e) {
      console.warn('[macrosos] attempt ' + i + ' failed for ' + sale.source + ' ' + sale.externalId + ':',
        (e && e.message) || e);
      if (i < 3) await new Promise(r => setTimeout(r, i * 4000));
    }
  }
  console.error('[macrosos] GIVING UP on', sale.source, sale.externalId,
    '- record this sale in Macros OS by hand (Quick sale).');
}

module.exports = { notifyMacrosOS };
