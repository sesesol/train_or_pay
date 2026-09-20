import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const normalizeUsername = (value: string) => value.trim().toLowerCase();
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function equal(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password: string, encoded: string) {
  const [salt, hash] = encoded.split(':');
  return Boolean(salt && hash && equal(scryptSync(password, salt, 64).toString('hex'), hash));
}
export function migrationToken(username: string, secret: string, expires: number) {
  const payload = Buffer.from(JSON.stringify({ username: normalizeUsername(username), expires })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('hex')}`;
}
export function verifyMigrationToken(token: string, username: string, secret?: string) {
  if (!secret || !token) return false;
  try {
    const [payload, signature] = token.split('.');
    if (!equal(signature || '', createHmac('sha256', secret).update(payload).digest('hex'))) return false;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.username === username && Number.isFinite(data.expires) && data.expires > Date.now();
  } catch { return false; }
}
