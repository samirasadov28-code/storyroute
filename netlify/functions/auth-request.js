// POST {email} -> emails an 8-digit sign-in code (Resend). Replaces Supabase signInWithOtp.
import { randomInt } from 'node:crypto';
import { sql, json, hashCode } from './_lib.js';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let email;
  try { ({ email } = await req.json()); } catch { return json({ error: 'Bad request' }, 400); }
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) return json({ error: 'Enter a valid email' }, 400);

  const db = sql();
  // Throttle: one code per 30 seconds per email.
  const recent = await db`select 1 from auth_codes where email=${email} and sent_at > now() - interval '30 seconds'`;
  if (recent.length) return json({ error: 'Please wait a few seconds before requesting another code' }, 429);

  const code = String(randomInt(0, 100000000)).padStart(8, '0');
  await db`insert into auth_codes (email, code_hash, expires_at, attempts, sent_at)
           values (${email}, ${hashCode(email, code)}, now() + interval '10 minutes', 0, now())
           on conflict (email) do update set code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0, sent_at=now()`;

  if (process.env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.AUTH_FROM_EMAIL || 'StoryRoute <onboarding@resend.dev>',
        to: [email],
        subject: `Your StoryRoute code: ${code}`,
        text: `Your StoryRoute sign-in code is ${code}. It expires in 10 minutes. If you did not ask for it, ignore this email.`,
      }),
    });
    if (!res.ok) { console.error('Resend failed', res.status); return json({ error: 'Could not send email' }, 502); }
  } else {
    console.error('RESEND_API_KEY not set: code stored but not emailed');
  }
  return json({ ok: true });
};

export const config = { path: '/api/auth-request' };
