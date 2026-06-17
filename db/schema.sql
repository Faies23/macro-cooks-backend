-- Macro Cooks database schema (PostgreSQL). Works on Supabase or any Postgres.
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

create table if not exists entitlements (
  user_id uuid references users(id) on delete cascade,
  product text not null,                     -- 'recipes' | 'plan' | 'full'
  granted_at timestamptz default now(),
  primary key (user_id, product)
);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  product text not null,
  amount_usd numeric not null,
  amount_tzs numeric,
  method text,
  phone text,
  status text not null default 'pending',    -- pending | paid | failed
  provider_ref text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists classes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  chef text,
  is_premium boolean default false,
  stream_uid text,                           -- Cloudflare Stream video UID
  status text default 'ready',               -- ready | processing
  created_at timestamptz default now()
);
