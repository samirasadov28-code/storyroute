// netlify/functions/stripe-webhook.js
// Unlocks / revokes StoryRoute Pro in Neon from Stripe events.
// Env: STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY, NEON_DATABASE_URL, STRIPE_PRICE_ID (optional override of the live price)
//
// Hardening vs the old Supabase version:
//  - only grants Pro when the paid line item is StoryRoute's own price (other apps share this Stripe account)
//  - requires payment_status === 'paid'
//  - refunds (charge.refunded / full) revoke Pro
//  - idempotent per Stripe event id

import { sql } from './_lib.js';

const LIVE_PRICE_ID = 'price_1UOKtzLtprV4p6afniAVjlzz';
const stripeGet = async (path) => {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } });
  return r.json();
};
const iso = (s) => (s ? new Date(s * 1000).toISOString() : null);

export default async (req) => {
  const sig = req.headers.get('stripe-signature');
  const rawBody = await req.text();

  let event;
  try {
    event = await verifyStripeWebhook(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return new Response('Webhook Error: ' + err.message, { status: 400 });
  }

  const db = sql();
  const claimed = await db`insert into stripe_events_processed (event_id) values (${event.id}) on conflict do nothing returning event_id`;
  if (!claimed.length) return ok({ received: true, duplicate: true });

  try {
    await handle(db, event);
  } catch (e) {
    console.error('Webhook handler error:', e);
    await db`delete from stripe_events_processed where event_id=${event.id}`; // let Stripe retry
    return new Response('Handler error', { status: 500 });
  }
  return ok({ received: true });
};

const ok = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });

async function handle(db, event) {
  const priceId = process.env.STRIPE_PRICE_ID || LIVE_PRICE_ID;

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.payment_status !== 'paid') { console.log('Ignored: not paid', session.id); return; }
    const items = await stripeGet(`checkout/sessions/${session.id}/line_items?limit=10`);
    const isOurs = (items.data || []).some((li) => li.price && li.price.id === priceId);
    if (!isOurs) { console.log('Ignored: session is not for StoryRoute price', session.id); return; }

    const email = String(session.customer_details?.email || session.customer_email || '').toLowerCase();
    if (!email) throw new Error('No email in checkout session');
    const customer = session.customer || null;
    const subscription = session.subscription || null;
    const pi = session.payment_intent || null;
    let periodEnd = null;
    if (subscription) {
      const sub = await stripeGet(`subscriptions/${subscription}`);
      periodEnd = iso(sub.current_period_end);
    }

    const users = await db`select id from users where email=${email}`;
    if (users.length) {
      await db`insert into profiles (id, email, is_pro, stripe_customer_id, stripe_subscription_id, stripe_payment_intent_id,
                 subscription_cancel_at_period_end, current_period_end)
               values (${users[0].id}, ${email}, true, ${customer}, ${subscription}, ${pi}, false, ${periodEnd})
               on conflict (id) do update set is_pro=true, stripe_customer_id=excluded.stripe_customer_id,
                 stripe_subscription_id=excluded.stripe_subscription_id, stripe_payment_intent_id=excluded.stripe_payment_intent_id,
                 subscription_cancel_at_period_end=false, current_period_end=excluded.current_period_end, updated_at=now()`;
      console.log('Pro unlocked for', email);
    } else {
      await db`insert into pending_pro (email, stripe_customer_id, stripe_subscription_id, stripe_payment_intent_id, current_period_end)
               values (${email}, ${customer}, ${subscription}, ${pi}, ${periodEnd})
               on conflict (email) do update set stripe_customer_id=excluded.stripe_customer_id,
                 stripe_subscription_id=excluded.stripe_subscription_id, stripe_payment_intent_id=excluded.stripe_payment_intent_id,
                 current_period_end=excluded.current_period_end`;
      console.log('Pending pro stored for', email);
    }
    return;
  }

  // Full refund revokes Pro (one-off payments). Partial refunds keep access.
  if (event.type === 'charge.refunded') {
    const charge = event.data.object;
    if (!charge.refunded || charge.amount_refunded < charge.amount) return;
    const pi = charge.payment_intent;
    if (!pi) return;
    await db`update profiles set is_pro=false, updated_at=now() where stripe_payment_intent_id=${pi}`;
    await db`delete from pending_pro where stripe_payment_intent_id=${pi}`;
    console.log('Pro revoked for refunded payment', pi);
    return;
  }

  // Legacy subscribers.
  if (event.type === 'customer.subscription.updated') {
    const s = event.data.object;
    await db`update profiles set subscription_cancel_at_period_end=${!!s.cancel_at_period_end},
               current_period_end=${iso(s.current_period_end)}, updated_at=now() where stripe_subscription_id=${s.id}`;
    return;
  }
  if (event.type === 'customer.subscription.deleted') {
    const s = event.data.object;
    await db`update profiles set is_pro=false, subscription_cancel_at_period_end=false, stripe_subscription_id=null,
               current_period_end=null, updated_at=now() where stripe_subscription_id=${s.id}`;
  }
}

// ── Stripe webhook signature verification ──────────────────
// Stripe uses HMAC-SHA256 — we verify manually since no SDK
async function verifyStripeWebhook(payload, sigHeader, secret) {
  if (!sigHeader || !secret) throw new Error('Missing signature or secret');

  const parts = sigHeader.split(',').reduce((acc, part) => {
    const [k, v] = part.split('=');
    acc[k] = v;
    return acc;
  }, {});

  const timestamp = parts['t'];
  const signature = parts['v1'];
  if (!timestamp || !signature) throw new Error('Invalid signature header');

  // Reject webhooks older than 5 minutes
  const tolerance = 300;
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > tolerance) {
    throw new Error('Webhook timestamp too old');
  }

  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const expected = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');

  if (expected !== signature) throw new Error('Signature mismatch');

  return JSON.parse(payload);
}

export const config = { path: '/api/stripe-webhook' };
