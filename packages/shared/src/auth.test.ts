import { describe, expect, it } from 'vitest';
import {
  createInviteBodySchema,
  loginBodySchema,
  passwordSchema,
  setAwayBodySchema,
  setupBodySchema,
  usernameSchema,
} from './auth.js';

describe('auth schemas', () => {
  it('accepts simple usernames and rejects ones that look like emails or are odd', () => {
    for (const ok of ['sam', 'Sam.Smith', 'a_b-c', 'x1']) {
      expect(usernameSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ['s', 'sam@home', 'has space', '-lead', '', 'x'.repeat(33)]) {
      expect(usernameSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('requires 10 to 128 character passwords', () => {
    expect(passwordSchema.safeParse('x'.repeat(9)).success).toBe(false);
    expect(passwordSchema.safeParse('x'.repeat(10)).success).toBe(true);
    expect(passwordSchema.safeParse('x'.repeat(128)).success).toBe(true);
    expect(passwordSchema.safeParse('x'.repeat(129)).success).toBe(false);
  });

  it('does not apply password rules to login, so old passwords still work', () => {
    expect(loginBodySchema.safeParse({ identifier: ' sam ', password: 'short' })).toMatchObject({
      success: true,
      data: { identifier: 'sam' },
    });
  });

  it('defaults invited members to the member role and trims names', () => {
    const parsed = createInviteBodySchema.parse({ name: ' Sam ', username: 'sam' });
    expect(parsed).toEqual({ name: 'Sam', username: 'sam', role: 'member' });
  });

  it('takes a real calendar date or null as the away date', () => {
    expect(setAwayBodySchema.safeParse({ awayUntil: '2026-07-10' }).success).toBe(true);
    expect(setAwayBodySchema.safeParse({ awayUntil: null }).success).toBe(true);
    for (const bad of ['2026-02-30', '10/07/2026', '2026-07-10T00:00:00Z', undefined]) {
      expect(setAwayBodySchema.safeParse({ awayUntil: bad }).success, String(bad)).toBe(false);
    }
  });

  it('validates the setup body', () => {
    const body = {
      householdName: 'Home',
      name: 'Kal',
      username: 'kal',
      email: 'kal@example.com',
      password: 'long enough password',
    };
    expect(setupBodySchema.safeParse(body).success).toBe(true);
    expect(setupBodySchema.safeParse({ ...body, email: 'nope' }).success).toBe(false);
    expect(setupBodySchema.safeParse({ ...body, householdName: ' ' }).success).toBe(false);
  });
});
