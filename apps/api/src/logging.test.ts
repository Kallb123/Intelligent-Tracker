import { describe, expect, it } from 'vitest';
import { loggerOptions, redactUrl } from './logging.js';

describe('redactUrl', () => {
  it('hides one-time link tokens', () => {
    expect(redactUrl('/api/invites/abc123_-XYZ')).toBe('/api/invites/[redacted]');
    expect(redactUrl('/api/invites/abc123/accept')).toBe('/api/invites/[redacted]/accept');
    expect(redactUrl('/api/password-resets/abc123?x=1')).toBe(
      '/api/password-resets/[redacted]?x=1',
    );
  });

  it('leaves other URLs alone', () => {
    expect(redactUrl('/api/invites')).toBe('/api/invites');
    expect(redactUrl('/api/members/1/password-reset')).toBe('/api/members/1/password-reset');
    expect(redactUrl('/api/health')).toBe('/api/health');
  });
});

describe('loggerOptions', () => {
  it('serialises requests without tokens or headers', () => {
    const { level, serializers } = loggerOptions('warn') as {
      level: string;
      serializers: { req: (r: unknown) => unknown };
    };
    expect(level).toBe('warn');
    expect(
      serializers.req({
        method: 'POST',
        url: '/api/invites/secret/accept',
        ip: '1.2.3.4',
        headers: { cookie: 'x' },
      }),
    ).toEqual({ method: 'POST', url: '/api/invites/[redacted]/accept', remoteAddress: '1.2.3.4' });
  });
});
