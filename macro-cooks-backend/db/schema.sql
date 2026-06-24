-- Macro Cooks database schema (PostgreSQL). Works on Supabase, Render or any Postgres.
-- Idempotent: safe to run repeatedly (`node scripts/migrate.js`). New columns are added
-- with `alter table ... add column if not exists` so existing deployments upgrade cleanly.
create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  password_hash text not null,
  name text,
  role text not null default 'user',        -- 'user' | 'admin'
  created_at timestamptz default now()
);

create table if not exists profiles (
  user_id uuid primary key references users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,   -- the app state (profile, plan, progress)
  updated_at timestamptz default now()
);

-- Orders: one row per checkout attempt (a mobile-money push).
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  product text not null,                     -- 'plan' | 'recipes' | 'full'
  cycle text,                                -- 'mo' (30d) | 'yr' (365d)
  amount_usd numeric not null,               -- price charged, looked up server-side
  amount_tzs numeric,                        -- TZS actually pushed to the phone (mobile money)
  method text,
  phone text,
  status text not null default 'pending',    -- pending | paid | failed
  provider_ref text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
-- Upgrade older deployments that predate the subscription model.
alter table orders add column if not exists cycle text;
alter table orders add column if not exists amount_tzs numeric;
alter table orders add column if not exists method text;
alter table orders add column if not exists phone text;
alter table orders add column if not exists updated_at timestamptz default now();

-- Entitlements: time-limited access grants. Each paid order inserts one row whose
-- expires_at = now() + cycle days. A product is "active" while expires_at > now();
-- when it lapses the user simply pays again (mobile money can't auto-renew).
create table if not exists entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  product text not null,                     -- 'plan' | 'recipes' | 'full'
  expires_at timestamptz,
  created_at timestamptz default now()
);
-- Upgrade older deployments where entitlements were permanent (composite PK + granted_at).
alter table entitlements add column if not exists id uuid default gen_random_uuid();
alter table entitlements add column if not exists expires_at timestamptz;
alter table entitlements add column if not exists created_at timestamptz default now();
-- The old schema had primary key (user_id, product), which would block renewals (one row per
-- payment for the same product). Drop whatever PK exists and make `id` the primary key instead.
-- Idempotent: re-running is a no-op once `id` is already the PK.
do $$
declare pk_name text;
begin
  update entitlements set id = gen_random_uuid() where id is null;
  select conname into pk_name
    from pg_constraint
    where conrelid = 'entitlements'::regclass and contype = 'p';
  if pk_name is not null and pk_name <> 'entitlements_pkey' then
    execute 'alter table entitlements drop constraint ' || quote_ident(pk_name);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'entitlements'::regclass and contype = 'p'
  ) then
    alter table entitlements add primary key (id);
  end if;
end $$;
create index if not exists entitlements_user_product_idx on entitlements (user_id, product);

-- Classes: published cooking videos backed by Cloudflare Stream.
create table if not exists classes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  "by" text,                                 -- chef / presenter name
  free boolean default false,                -- free classes play for everyone; premium need 'full'
  uid text,                                  -- Cloudflare Stream video UID
  created_at timestamptz default now()
);
-- Upgrade older deployments that used chef / is_premium / stream_uid column names.
alter table classes add column if not exists "by" text;
alter table classes add column if not exists free boolean default false;
alter table classes add column if not exists uid text;
