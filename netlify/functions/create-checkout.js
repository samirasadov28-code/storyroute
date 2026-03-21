export default async (req) => {
  const cors = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body;
  try { body = await req.json(); } catch(e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: cors });
  }

  const { userId, userEmail } = body;
  const siteUrl = process.env.URL || 'https://your-site.netlify.app';

  const params = new URLSearchParams({
    mode: 'subscription',
    'line_items[0][price]': process.env.STRIPE_PRICE_ID,
    'line_items[0][quantity]': '1',
    success_url: `${siteUrl}/?upgraded=true&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl}/`,
    client_reference_id: userId || 'anonymous',
    ...(userEmail ? { customer_email: userEmail } : {})
  });

  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  const session = await r.json();
  if (session.error) {
    return new Response(JSON.stringify({ error: session.error.message }), { status: 400, headers: cors });
  }

  return new Response(JSON.stringify({ url: session.url }), { status: 200, headers: cors });
};

export const config = { path: '/api/create-checkout' };
