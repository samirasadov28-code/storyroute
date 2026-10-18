// Shared helpers: Neon connection, signed session tokens, JSON responses.
import { neon } from '@neondatabase/serverless';
import { createHmac, timingSafeEqual } from 'node:crypto';

export const sql = () => neon(process.env.NEON_DATABASE_URL);

export const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

const b64u = (b) => Buffer.from(b).toString('base64url');

export function signSession(user, ttlSeconds = 60 * 60 * 24 * 60) {
  const payload = b64u(JSON.stringify({ id: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const sig = createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySession(req) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token || !process.env.SESSION_SECRET) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.exp || data.exp < Date.now() / 1000) return null;
    return { id: data.id, email: data.email };
  } catch { return null; }
}

export const hashCode = (email, code) =>
  createHmac('sha256', process.env.SESSION_SECRET).update(`${email}:${code}`).digest('hex');
