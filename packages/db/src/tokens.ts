import { createHash, randomBytes } from 'node:crypto';

/**
 * A random 256-bit token, URL- and cookie-safe. Used for sessions, invites and resets, and for
 * the one-time Telegram link codes (43 base64url characters are also a valid `/start` deep-link
 * parameter).
 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 (hex) of a token. Only this hash is stored (as `session.id` / `password_token.id` or a
 * Telegram link code), so a leaked database cannot be used to log in or to redeem links. A fast
 * hash is right here: the input already has 256 bits of entropy, unlike a password.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
