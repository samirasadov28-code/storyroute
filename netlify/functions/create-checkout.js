export default async (req) => {
  const { email } = await req.json();

  // One-off lifetime price (EUR 3.99), live Stripe account ModeLoop.
  // Old monthly/annual prices stay in Stripe so existing subscribers keep working.
  const priceId = 'price_1UOKtzLtprV4p6afniAVjlzz';
  const origin = process.env.PUBLIC_SITE_URL || new URL(req.url).origin;

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      mode: 'payment',
      customer_creation: 'always',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      success_url: `${origin}/?upgraded=true`,
      cancel_url: `${origin}/`,
      ...(email && { customer_email: email }),
    }),
  });

  const session = await res.json();
  return new Response(JSON.stringify({ url: session.url }), {
    headers: { 'Content-Type': 'application/json' }
  });
};

export const config = { path: '/api/create-checkout' };
