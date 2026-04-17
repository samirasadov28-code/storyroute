# StoryRoute — Project Notes

## Versioning rule (always apply)

Whenever you make a user-visible or deployable change, **bump the version number in every place it appears**. Do this as part of the same commit as the change.

Known version locations (keep in sync):

- `public/index.html` — splash badge: `<div id="splash-version">vX.Y.Z</div>`
- `public/index.html` — JS header comment: `// STORYROUTE vX.Y.Z`
- `public/sw.js` — service worker cache name: `const CACHE = 'storyroute-vX.Y.Z';` (bumping this invalidates old caches so clients pick up fresh assets)

Bumping rules:

- Bug fix / small tweak / content change → bump patch (`2.2.4` → `2.2.5`)
- New feature / UI change → bump minor (`2.2.x` → `2.3.0`)
- Breaking change or major redesign → bump major (`2.x.y` → `3.0.0`)

Before finishing any task that edits shipped code, grep for the current version string to confirm no location was missed:

```
rg -n "vX\.Y\.Z|STORYROUTE v|storyroute-v" public/
```

## Supabase `profiles` schema

Columns used by the subscription flow (run once in Supabase SQL editor if missing):

```sql
alter table profiles
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists subscription_cancel_at_period_end boolean default false,
  add column if not exists current_period_end timestamptz;

-- Optional matching columns on pending_pro (for users who pay before signing in):
alter table pending_pro
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists current_period_end timestamptz;
```

## Stripe webhook events (subscribe to all three)

- `checkout.session.completed` — unlock Pro + persist `stripe_customer_id` + `stripe_subscription_id`.
- `customer.subscription.updated` — mirrors `cancel_at_period_end` + `current_period_end` back to the profile.
- `customer.subscription.deleted` — final cancel: clears Pro + subscription id.

## Netlify env vars

- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — Stripe.
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — service role (bypasses RLS for the webhook + cancel fn).
- `PUBLIC_SITE_URL` (optional) — override for Stripe checkout `success_url` / `cancel_url`. If unset, the function infers origin from the request.
