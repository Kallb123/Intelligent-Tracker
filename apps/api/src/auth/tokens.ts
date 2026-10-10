import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** A random 256-bit token, URL- and cookie-safe. Used for sessions, invites and resets. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 (hex) of a token. Only this hash is stored (as `session.id` / `password_token.id`), so
 * a leaked database cannot be used to log in or to redeem links. A fast hash is right here: the
 * input already has 256 bits of entropy, unlike a password.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * The CSRF token for a session: an HMAC keyed by the session token. It needs no storage, is
 * different for every session, and cannot be derived from the stored hash. A cross-site page
 * can neither read it nor compute it.
 */
export function csrfTokenFor(sessionToken: string): string {
  return createHmac('sha256', sessionToken).update('csrf-v1').digest('base64url');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
