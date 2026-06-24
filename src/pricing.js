/*
 * Subscription pricing — the SINGLE SOURCE OF TRUTH for what a tier costs.
 *
 * SECURITY: prices live on the server, never on the client. /checkout looks the
 * amount up here from {product, cycle}; a client-sent amount is always ignored,
 * so a tampered request can't lower the charge or unlock a tier for free.
 *
 * Tiers are cumulative (the app maps that itself): full ⊇ recipes ⊇ plan.
 * Mobile money can't auto-renew, so each payment grants TIME-LIMITED access:
 *   cycle 'mo' = 30 days, cycle 'yr' = 365 days. On expiry the user pays again.
 */
const PRICES = {
  plan:    { mo: 9.99,  yr: 100 },
  recipes: { mo: 14.99, yr: 160 },
  full:    { mo: 19.99, yr: 220 }
}; // USD

const PRODUCTS = ['plan', 'recipes', 'full'];
const CYCLES = ['mo', 'yr'];

function isProduct(product) { return PRODUCTS.includes(product); }
function isCycle(cycle) { return CYCLES.includes(cycle); }

// Look up the USD price for a tier/cycle. Throws (status 400) on bad input so the
// route turns it into a clean 400 rather than charging a wrong/undefined amount.
function getAmount(product, cycle) {
  if (!isProduct(product)) {
    const err = new Error('Unknown product'); err.status = 400; throw err;
  }
  if (!isCycle(cycle)) {
    const err = new Error('Unknown cycle'); err.status = 400; throw err;
  }
  return PRICES[product][cycle];
}

// Days of access a cycle buys. yr => 365, anything else (mo) => 30.
function getDays(cycle) { return cycle === 'yr' ? 365 : 30; }

module.exports = { PRICES, PRODUCTS, CYCLES, isProduct, isCycle, getAmount, getDays };
