# Wiring real payments with AzamPay — step by step

Goal: a customer taps **Pay**, approves on their phone with their **M-Pesa / Tigo / Airtel PIN**, and the plan unlocks — money settling to your bank. You do **not** need your own Bank of Tanzania licence; AzamPay's licence covers you.

## How the flow works (already coded for you)

```
App ──POST /api/payments/checkout──▶ Your backend ──GenerateToken+Checkout──▶ AzamPay
       { product, phone, network }                                              │
                                                              customer approves on phone
                                                                                 │
Your backend ◀──callback: "success"──────────────────────────────────────────────┘
        │
        └─ marks order paid + grants entitlement ──▶ app unlocks (GET /entitlements)
```

The only file you edit to match the provider is **`src/payments/azampay.js`**.

## Step 1 — Open an AzamPay merchant account
Sign up with **AzamPay** and complete **KYC**: your **registered business**, **TIN**, ID, and the **bank account** for settlement. (Register the business first — see the Production Plan.) AzamPay has **no setup fees / no monthly minimums** — you pay only per transaction.

## Step 2 — Create an app in the AzamPay developer portal
Register an application to get your **App Name**, **Client ID**, **Client Secret**, and **API Key** — first for **sandbox**, then for **production** after approval.

## Step 3 — Put the credentials in your backend `.env`
```
AZAMPAY_AUTH_BASE_URL=https://authenticator-sandbox.azampay.co.tz
AZAMPAY_CHECKOUT_BASE_URL=https://sandbox.azampay.co.tz
AZAMPAY_APP_NAME=...
AZAMPAY_CLIENT_ID=...
AZAMPAY_CLIENT_SECRET=...
AZAMPAY_API_KEY=...
AZAMPAY_CALLBACK_TOKEN=pick-a-long-random-string
```

## Step 4 — Confirm the exact API shape
Open `src/payments/azampay.js`. It uses AzamPay's documented pattern:
- **Token:** `POST /AppRegistration/GenerateToken` with `{ appName, clientId, clientSecret }`.
- **Checkout:** `POST /azampay/mno/checkout` with `{ accountNumber, amount, currency:"TZS", externalId, provider }` and the bearer token.

Compare these to the **current AzamPay docs** and adjust if any field/path changed. This one file is the only provider-specific code.

## Step 5 — Register your callback URL
In the AzamPay portal, set the **callback URL** to:
```
https://YOUR-API-DOMAIN/api/payments/webhook?token=YOUR_AZAMPAY_CALLBACK_TOKEN
```
AzamPay posts the result there; your backend verifies the token, marks the order **paid**, and grants the entitlement automatically.

## Step 6 — The "network" field
AzamPay needs to know the customer's mobile network. The app sends it in checkout:
```
POST /api/payments/checkout
{ "product": "plan", "phone": "+2557XXXXXXXX", "network": "Mpesa" }
```
`network` = **Mpesa | Tigo | Airtel | Halopesa | Azampesa**. (In the app, ask the user to tap their network, or detect it from the phone-number prefix.)

## Step 7 — Test in sandbox
Use AzamPay's sandbox test numbers/amounts. Run a checkout → approve the prompt → watch the callback arrive → `GET /api/payments/entitlements` should now include the product. Test success, failure, and cancellation.

## Step 8 — Go live
After KYC approval and passing sandbox tests, switch the two base URLs and the keys to **production**, re-test with a small real payment, and you're charging.

## Fees & settlement
Pay-as-you-go (typically ~**2–4%**); confirm the exact rate and settlement schedule with AzamPay.

## IMPORTANT — the app-store rule
Apple/Google usually require **digital** purchases made **inside** the apps to use **their** billing (15–30% cut). So sell on your **website / take.app / PWA** with AzamPay (no store cut), and inside the native apps use the stores' in-app purchases or keep buying on the web within their rules. Decide before submitting.

## Switching provider later
Selcom / DPO / Flutterwave / ClickPesa follow the same shape. A ready ClickPesa version is included at `src/payments/clickpesa.js`; to switch, change the one `require(...)` line in `src/routes/payments.routes.js`.
