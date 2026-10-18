-- StoryRoute Neon schema (idempotent)
create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists profiles (
  id uuid primary key,
  email text not null,
  is_pro boolean not null default false,
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_payment_intent_id text,
  subscription_cancel_at_period_end boolean not null default false,
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists pending_pro (
  email text primary key,
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_payment_intent_id text,
  current_period_end timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists auth_codes (
  email text primary key,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  sent_at timestamptz not null default now()
);

create table if not exists stripe_events_processed (
  event_id text primary key,
  processed_at timestamptz not null default now()
);

-- Upgrade path for databases created from the earlier Supabase-style schema.
alter table profiles add column if not exists stripe_payment_intent_id text;
alter table profiles add column if not exists updated_at timestamptz not null default now();
alter table pending_pro add column if not exists stripe_payment_intent_id text;
insert into users (id, email) select id, lower(email) from profiles where email is not null on conflict do nothing;
