// netlify/functions/cancel-subscription.js
// Cancels the authenticated user's Pro subscription at period end.
// No refund is issued — access continues until current_period_end, then Stripe
// fires customer.subscription.deleted and the webhook sets is_pro=false.
//
// Needs env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ error: 'Not signed in' }, 401);

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) return json({ error: 'Invalid session' }, 401);
  const user = userData.user;

  const { data: profile, error: profileErr } = await supabase
    .from('profiles')
    .select('is_pro, stripe_subscription_id, subscription_cancel_at_period_end')
    .eq('id', user.id)
    .single();

  if (profileErr || !profile) return json({ error: 'Profile not found' }, 404);
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

  await supabase
    .from('profiles')
    .update({
      subscription_cancel_at_period_end: true,
      current_period_end: periodEndIso,
    })
    .eq('id', user.id);

  return json({
    success: true,
    period_end: sub.current_period_end,
    period_end_iso: periodEndIso,
  });
};

export const config = { path: '/api/cancel-subscription' };
