import { describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD_PARAMS, hashPassword, verifyPassword } from './passwords.js';
import { FAST_PASSWORD_PARAMS } from '../test-util.js';

describe('passwords', () => {
  it('hashes to a PHC-encoded argon2id string with a fresh salt each time', async () => {
    const a = await hashPassword('correct horse', FAST_PASSWORD_PARAMS);
    const b = await hashPassword('correct horse', FAST_PASSWORD_PARAMS);
    expect(a).toMatch(/^\$argon2id\$v=19\$m=8,t=1,p=1\$/);
    expect(a).not.toBe(b);
  });

  it('verifies the right password and rejects others', async () => {
    const hash = await hashPassword('correct horse', FAST_PASSWORD_PARAMS);
    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('Correct horse', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('treats a malformed hash as a mismatch instead of throwing', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
  });

  it('defaults to the OWASP minimum and verifies under those parameters', async () => {
    expect(DEFAULT_PASSWORD_PARAMS).toEqual({ memoryKiB: 19_456, iterations: 2, parallelism: 1 });
    const hash = await hashPassword('correct horse');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword('correct horse', hash)).toBe(true);
  });
});
