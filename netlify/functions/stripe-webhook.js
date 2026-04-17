// netlify/functions/stripe-webhook.js
// Handles Stripe webhook events — unlocks Pro in Supabase after successful payment
//
// Setup:
// 1. Stripe dashboard → Developers → Webhooks → Add endpoint
//    URL: https://YOUR-SITE.netlify.app/api/stripe-webhook
//    Events: checkout.session.completed, customer.subscription.updated, customer.subscription.deleted
// 2. Copy the webhook signing secret → add to Netlify env vars as STRIPE_WEBHOOK_SECRET
// 3. Also needs: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//    (Service role key is in Supabase → Settings → API — NOT the anon key)

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

export default async (req) => {
  const sig = req.headers.get('stripe-signature');
  const rawBody = await req.text();

  // Verify the webhook came from Stripe
  let event;
  try {
    event = await verifyStripeWebhook(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return new Response('Webhook Error: ' + err.message, { status: 400 });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY // service role bypasses RLS
  );

  // ── Handle events ──────────────────────────────────────────
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details?.email || session.customer_email;
    const stripe_customer_id = session.customer || null;
    const stripe_subscription_id = session.subscription || null;

    if (!email) {
      console.error('No email in checkout session');
      return new Response('No email', { status: 400 });
    }

    // Fetch period end from subscription (so UI can show billing-period end)
    let current_period_end = null;
    if (stripe_subscription_id) {
      try {
        const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${stripe_subscription_id}`, {
          headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` }
        });
        const sub = await subRes.json();
        if (sub.current_period_end) current_period_end = new Date(sub.current_period_end * 1000).toISOString();
      } catch (e) { console.error('Failed to fetch subscription:', e); }
    }

    // Find user by email in Supabase auth
    const { data: users, error: userErr } = await supabase.auth.admin.listUsers();
    if (userErr) {
      console.error('Error listing users:', userErr);
      return new Response('Supabase error', { status: 500 });
    }

    const user = users?.users?.find(u => u.email === email);

    if (user) {
      // User is signed in — update their profile to Pro
      const { error } = await supabase
        .from('profiles')
        .upsert({
          id: user.id,
          email,
          is_pro: true,
          stripe_customer_id,
          stripe_subscription_id,
          subscription_cancel_at_period_end: false,
          current_period_end,
        })
        .eq('id', user.id);

      if (error) console.error('Error updating profile:', error);
      else console.log('Pro unlocked for user:', email);
    } else {
      // User paid but hasn't signed in yet — store pending pro by email
      // When they sign in, they'll need to be matched (see notes below)
      const { error } = await supabase
        .from('pending_pro')
        .upsert({
          email,
          stripe_customer_id,
          stripe_subscription_id,
          current_period_end,
          created_at: new Date().toISOString(),
        });

      if (error) console.error('Error storing pending pro:', error);
      else console.log('Pending pro stored for:', email);
    }
  }

  // When a user cancels at period end, Stripe fires customer.subscription.updated.
  // Mirror the cancel flag + period end on the profile so the UI reflects it.
  if (event.type === 'customer.subscription.updated') {
    const subscription = event.data.object;
    const customerId = subscription.customer;
    const customerRes = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
      headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` }
    });
    const customer = await customerRes.json();
    const email = customer.email;

    if (email) {
      const { data: users } = await supabase.auth.admin.listUsers();
      const user = users?.users?.find(u => u.email === email);
      if (user) {
        await supabase.from('profiles').update({
          subscription_cancel_at_period_end: !!subscription.cancel_at_period_end,
          current_period_end: subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000).toISOString()
            : null,
        }).eq('id', user.id);
        console.log('Subscription updated for:', email, 'cancel_at_period_end=', !!subscription.cancel_at_period_end);
      }
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    // Subscription fully ended — revoke Pro
    const subscription = event.data.object;
    const customerId = subscription.customer;

    // Get customer email from Stripe
    const customerRes = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
      headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` }
    });
    const customer = await customerRes.json();
    const email = customer.email;

    if (email) {
      const { data: users } = await supabase.auth.admin.listUsers();
      const user = users?.users?.find(u => u.email === email);
      if (user) {
        await supabase.from('profiles').update({
          is_pro: false,
          subscription_cancel_at_period_end: false,
          stripe_subscription_id: null,
          current_period_end: null,
        }).eq('id', user.id);
        console.log('Pro revoked for:', email);
      }
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};

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
