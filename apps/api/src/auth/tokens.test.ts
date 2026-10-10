import { describe, expect, it } from 'vitest';
import { csrfTokenFor, generateToken, hashToken, safeEqual } from './tokens.js';

describe('tokens', () => {
  it('generates distinct 256-bit URL-safe tokens', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hashes to a stable SHA-256 hex digest that does not contain the token', () => {
    const hash = hashToken('abc');
    expect(hash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashToken('abc')).toBe(hash);
    expect(hashToken('abd')).not.toBe(hash);
  });

  it('derives a CSRF token per session that differs from the stored hash', () => {
    const csrf = csrfTokenFor('session-token-1');
    expect(csrfTokenFor('session-token-1')).toBe(csrf);
    expect(csrfTokenFor('session-token-2')).not.toBe(csrf);
    expect(csrf).not.toBe(hashToken('session-token-1'));
    expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('compares strings safely, including different lengths', () => {
    expect(safeEqual('same', 'same')).toBe(true);
    expect(safeEqual('same', 'diff')).toBe(false);
    expect(safeEqual('short', 'longer string')).toBe(false);
  });
});
