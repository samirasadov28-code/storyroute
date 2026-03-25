export default async (req) => {
  const { plan, email } = await req.json();

  const PRICES = {
    monthly: 'price_1TDCnoLtprV4p6afIJSw2eyJ',  // ← paste from Stripe
    annual:  'price_1TF0ezLtprV4p6afZJegaIat',   // ← paste from Stripe
  };

  const priceId = PRICES[plan] || PRICES.monthly;

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      mode: 'subscription',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      success_url: 'https://YOUR-SITE.netlify.app/?upgraded=true',
      cancel_url: 'https://YOUR-SITE.netlify.app/',
      ...(email && { customer_email: email }),
    }),
  });

  const session = await res.json();
  return new Response(JSON.stringify({ url: session.url }), {
    headers: { 'Content-Type': 'application/json' }
  });
};

export const config = { path: '/api/create-checkout' };
