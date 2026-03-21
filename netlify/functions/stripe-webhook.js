import crypto from 'crypto';

export default async (req) => {
  const sig    = req.headers.get('stripe-signature');
  const body   = await req.text();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!verifyStripeSignature(body, sig, secret)) {
    return new Response('Invalid signature', { status: 400 });
  }

  const event = JSON.parse(body);

  // Payment succeeded — upgrade user to Pro
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId  = session.client_reference_id;
    if (userId && userId !== 'anonymous') {
      await setUserPlan(userId, 'pro');
    }
  }

  // Subscription cancelled — downgrade back to free
  if (event.type === 'customer.subscription.deleted') {
    const customerId = event.data.object.customer;
    const userId = await getUserIdByCustomer(customerId);
    if (userId) await setUserPlan(userId, 'free');
  }

  return new Response('OK', { status: 200 });
};

// ── Netlify Identity admin API ────────────────────────────────
async function setUserPlan(userId, plan) {
  const url   = `${process.env.URL}/.netlify/identity/admin/users/${userId}`;
  const token = process.env.NETLIFY_IDENTITY_TOKEN;
  await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ app_metadata: { plan } })
  });
}

async function getUserIdByCustomer(customerId) {
  // Look up Netlify Identity users and find by stripe_customer_id in app_metadata
  const url   = `${process.env.URL}/.netlify/identity/admin/users?per_page=500`;
  const token = process.env.NETLIFY_IDENTITY_TOKEN;
  const r     = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  const data  = await r.json();
  const user  = (data.users || []).find(u => u.app_metadata?.stripe_customer_id === customerId);
  return user?.id || null;
}

// ── Stripe signature verification ─────────────────────────────
function verifyStripeSignature(payload, sigHeader, secret) {
  try {
    const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
    const signed  = `${parts.t}.${payload}`;
    const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(parts.v1, 'hex'), Buffer.from(expected, 'hex'));
  } catch(e) { return false; }
}

export const config = { path: '/api/stripe-webhook' };
