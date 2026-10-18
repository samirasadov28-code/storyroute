// GET (Bearer session) -> the signed-in user's Pro status.
import { sql, json, verifySession } from './_lib.js';

export default async (req) => {
  const user = verifySession(req);
  if (!user) return json({ error: 'Not signed in' }, 401);
  const rows = await sql()`select is_pro, subscription_cancel_at_period_end, current_period_end from profiles where id=${user.id}`;
  return json(rows[0] || { is_pro: false, subscription_cancel_at_period_end: false, current_period_end: null });
};

export const config = { path: '/api/profile' };
