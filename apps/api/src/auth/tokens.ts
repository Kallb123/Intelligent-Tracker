import { generateToken, hashToken } from '@tracker/db';
import { createHmac, timingSafeEqual } from 'node:crypto';

export { generateToken, hashToken };

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
