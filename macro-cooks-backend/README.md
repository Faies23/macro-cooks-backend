# Macro Cooks — Backend API

A production-shaped backend for the Macro Cooks app: **accounts/login, profile & plan sync, real payments (mobile money + cards), cooking-video hosting, and admin**. Node.js (Express) + PostgreSQL. Swap one file to change payment provider.

> Built as a clean starting point. Every file is syntax-checked. You still need to (a) plug in real keys, (b) confirm the aggregator's exact API fields against their current docs, and (c) test in their sandbox before going live.

## What's inside

```
src/server.js              Express app (mounts everything)
src/db.js                  Postgres connection
src/auth.js                JWT + bcrypt (signup/login/protect)
src/routes/auth.routes.js      POST /api/auth/signup | /login,  GET /api/auth/me
src/routes/profile.routes.js   GET/PUT /api/profile  (sync app state across devices)
src/routes/payments.routes.js  checkout, webhook, order status, entitlements
src/routes/content.routes.js   list classes, admin upload-url, admin publish/delete
src/payments/azampay.js    Payment adapter (AzamPay, ACTIVE) — EDIT THIS for your provider
src/payments/clickpesa.js  Alternative adapter (ClickPesa) — swap the require to use it
src/video/cloudflareStream.js  Cloudflare Stream video adapter
src/middleware/adminOnly.js
db/schema.sql              PostgreSQL tables
scripts/migrate.js         Creates the tables
admin/index.html           Tiny admin console to test uploads
```

## Run it locally

Prerequisites: **Node 18+** and a **PostgreSQL** database (a free Supabase project works great — copy its connection string).

```bash
npm install
cp .env.example .env          # then fill in the values
npm run migrate               # creates the tables
npm start                     # API on http://localhost:8080
```

Check it's alive: open `http://localhost:8080/health`.

## Deploy to the cloud (recommended: Render + Supabase)

1. Create a **Supabase** project → copy the **connection string** into `DATABASE_URL`.
2. Push this folder to a GitHub repo.
3. On **Render** (or Railway): *New Web Service* → connect the repo → build `npm install`, start `npm start`.
4. Add all the `.env` values as environment variables in the Render dashboard.
5. Run the migration once (Render shell: `npm run migrate`, or run `db/schema.sql` in the Supabase SQL editor).
6. Your API is live at `https://your-service.onrender.com`.

## Make a user an admin

After signing up, in the Supabase SQL editor:
```sql
update users set role='admin' where email='you@example.com';
```
Then the admin console at `https://your-api/admin` and the `/api/content/admin/*` endpoints work for you.

## API quick reference

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /api/auth/signup | – | Create account → returns token |
| POST | /api/auth/login | – | Log in → returns token |
| GET | /api/profile | user | Load saved app state |
| PUT | /api/profile | user | Save/sync app state `{ data: {...} }` |
| POST | /api/payments/checkout | user | `{ product, phone }` → starts mobile-money prompt |
| GET | /api/payments/orders/:id | user | Poll order status |
| POST | /api/payments/webhook | provider | Aggregator confirms payment (set this URL in their dashboard) |
| GET | /api/payments/entitlements | user | What the user has unlocked |
| GET | /api/content/classes | – | List published classes |
| POST | /api/content/admin/upload-url | admin | One-time Cloudflare upload URL |
| POST | /api/content/admin/classes | admin | Publish a class `{ title, chef, is_premium, stream_uid }` |

## Connecting the app

In the Macro Cooks app, replace the on-device storage calls with calls to this API:
- On signup/login → store the returned **token**; send it as `Authorization: Bearer <token>`.
- Save progress → `PUT /api/profile` with `{ data: <your state object> }`.
- Unlock check → `GET /api/payments/entitlements` instead of the local `unlock` flags.
- Pay → `POST /api/payments/checkout`, then poll `GET /api/payments/orders/:id` until `paid`.
- Classes → `GET /api/content/classes` for the Learn feed.

## Security checklist before launch
- Set a long random `JWT_SECRET`; never commit `.env`.
- Set `AZAMPAY_CALLBACK_TOKEN` and keep callback verification ON.
- Restrict `APP_ORIGIN` to your real domains.
- Use HTTPS (Render/Railway give it automatically).
- Register with Tanzania's PDPC and add a privacy policy (see the Production Plan).
