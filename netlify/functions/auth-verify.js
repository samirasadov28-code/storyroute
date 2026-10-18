// POST {email, code} -> {token, user}. Replaces Supabase verifyOtp.
import { sql, json, signSession, hashCode } from './_lib.js';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let email, code;
  try { ({ email, code } = await req.json()); } catch { return json({ error: 'Bad request' }, 400); }
  email = String(email || '').trim().toLowerCase();
  code = String(code || '').trim();
  if (!email || !/^\d{6,8}$/.test(code)) return json({ error: 'Invalid code' }, 400);

  const db = sql();
  const rows = await db`select code_hash, expires_at < now() as expired, attempts from auth_codes where email=${email}`;
  if (!rows.length || rows[0].expired || rows[0].attempts >= 5) return json({ error: 'Invalid or expired code' }, 401);
  if (rows[0].code_hash !== hashCode(email, code)) {
    await db`update auth_codes set attempts = attempts + 1 where email=${email}`;
    return json({ error: 'Invalid or expired code' }, 401);
  }
  await db`delete from auth_codes where email=${email}`;

  const users = await db`insert into users (email) values (${email})
                         on conflict (email) do update set email=excluded.email returning id, email`;
  const user = users[0];

  // Attach a purchase made before first sign-in.
  const pending = await db`select * from pending_pro where email=${email}`;
  await db`insert into profiles (id, email) values (${user.id}, ${email}) on conflict (id) do nothing`;
  if (pending.length) {
    const p = pending[0];
    await db`update profiles set is_pro=true, stripe_customer_id=${p.stripe_customer_id},
               stripe_subscription_id=${p.stripe_subscription_id}, stripe_payment_intent_id=${p.stripe_payment_intent_id},
               current_period_end=${p.current_period_end}, updated_at=now() where id=${user.id}`;
    await db`delete from pending_pro where email=${email}`;
  }
  return json({ token: signSession(user), user: { id: user.id, email: user.email } });
};

export const config = { path: '/api/auth-verify' };
