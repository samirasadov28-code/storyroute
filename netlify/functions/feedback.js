// netlify/functions/feedback.js
// Receives feedback from the app and emails samir.asadov.28@gmail.com
// Requires RESEND_API_KEY in Netlify env vars — sign up free at resend.com

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const { name, email, message, userEmail } = body;

  if (!message || message.trim().length === 0) {
    return new Response(JSON.stringify({ error: 'Message is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.error('RESEND_API_KEY not set');
    return new Response(JSON.stringify({ error: 'Email not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const emailBody = `
New StoryRoute feedback

From: ${name || 'Anonymous'}
Email: ${email || 'Not provided'}
App user: ${userEmail || 'Not signed in'}

Message:
${message}

---
Sent from StoryRoute feedback form
  `.trim();

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'StoryRoute <feedback@yourdomain.com>', // ← replace with your verified Resend domain
        to: 'samir.asadov.28@gmail.com',
        reply_to: email || undefined,
        subject: `StoryRoute feedback${name ? ' from ' + name : ''}`,
        text: emailBody
      })
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('Resend error:', err);
      return new Response(JSON.stringify({ error: 'Failed to send email' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    console.error('Feedback error:', e);
    return new Response(JSON.stringify({ error: 'Server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const config = { path: '/api/feedback' };
