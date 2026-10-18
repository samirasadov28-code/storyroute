// netlify/functions/cancel-subscription.js
// Cancels the authenticated user's Pro subscription at period end.
// No refund is issued — access continues until current_period_end, then Stripe
// fires customer.subscription.deleted and the webhook sets is_pro=false.
//
// Needs env vars: NEON_DATABASE_URL, SESSION_SECRET, STRIPE_SECRET_KEY.

import { sql, verifySession } from './_lib.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const user = verifySession(req);
  if (!user) return json({ error: 'Invalid session' }, 401);
  const db = sql();
  const rows = await db`select is_pro, stripe_subscription_id, subscription_cancel_at_period_end from profiles where id=${user.id}`;
  const profile = rows[0];
  if (!profile) return json({ error: 'Profile not found' }, 404);
  if (!profile.is_pro) return json({ error: 'No active Pro subscription' }, 400);
  if (profile.subscription_cancel_at_period_end) {
    return json({ error: 'Subscription already scheduled to cancel' }, 400);
  }
  if (!profile.stripe_subscription_id) {
    return json({ error: 'No Stripe subscription on file — contact support' }, 400);
  }

  // Tell Stripe to cancel at period end (no refund, keeps access until then).
  const stripeRes = await fetch(
    `https://api.stripe.com/v1/subscriptions/${profile.stripe_subscription_id}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ cancel_at_period_end: 'true' }),
    }
  );
  const sub = await stripeRes.json();
  if (!stripeRes.ok || sub.error) {
    console.error('Stripe cancel failed:', sub.error || sub);
    return json({ error: sub.error?.message || 'Stripe error' }, 500);
  }

  const periodEndIso = sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString()
    : null;

  await db`update profiles set subscription_cancel_at_period_end=true, current_period_end=${periodEndIso}, updated_at=now() where id=${user.id}`;

  return json({
    success: true,
    period_end: sub.current_period_end,
    period_end_iso: periodEndIso,
  });
};

export const config = { path: '/api/cancel-subscription' };
