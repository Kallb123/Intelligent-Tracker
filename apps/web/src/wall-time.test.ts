import { describe, expect, it } from 'vitest';
import { instantToWall, wallToInstant } from './wall-time.js';

const iso = (d: Date | undefined) => d?.toISOString();

describe('wallToInstant', () => {
  it('applies the zone offset in force on that day', () => {
    expect(iso(wallToInstant('2026-01-15', '14:30', 'Europe/London'))).toBe(
      '2026-01-15T14:30:00.000Z',
    );
    // BST is UTC+1.
    expect(iso(wallToInstant('2026-07-15', '14:30', 'Europe/London'))).toBe(
      '2026-07-15T13:30:00.000Z',
    );
    expect(iso(wallToInstant('2026-07-15', '14:30', 'America/New_York'))).toBe(
      '2026-07-15T18:30:00.000Z',
    );
    expect(iso(wallToInstant('2026-07-15', '14:30', 'UTC'))).toBe('2026-07-15T14:30:00.000Z');
  });

  it('copes with clock changes', () => {
    // 01:30 does not exist on 29 March 2026 in London; it lands an hour later.
    expect(iso(wallToInstant('2026-03-29', '01:30', 'Europe/London'))).toBe(
      '2026-03-29T01:30:00.000Z',
    );
    // Just before the change and just after.
    expect(iso(wallToInstant('2026-03-29', '00:30', 'Europe/London'))).toBe(
      '2026-03-29T00:30:00.000Z',
    );
    expect(iso(wallToInstant('2026-03-29', '03:30', 'Europe/London'))).toBe(
      '2026-03-29T02:30:00.000Z',
    );
    // 01:30 happens twice on 25 October 2026 (BST, then GMT); the later one is taken.
    expect(iso(wallToInstant('2026-10-25', '01:30', 'Europe/London'))).toBe(
      '2026-10-25T01:30:00.000Z',
    );
  });

  it('rejects anything that is not a real date and time', () => {
    expect(wallToInstant('2026-02-30', '10:00', 'UTC')).toBeUndefined();
    expect(wallToInstant('2026-02-10', '25:00', 'UTC')).toBeUndefined();
    expect(wallToInstant('', '10:00', 'UTC')).toBeUndefined();
    expect(wallToInstant('2026-02-10', '', 'UTC')).toBeUndefined();
  });
});

describe('instantToWall', () => {
  it('reads the clock in the zone', () => {
    expect(instantToWall('2026-07-15T23:30:00Z', 'Europe/London')).toEqual({
      date: '2026-07-16',
      time: '00:30',
    });
    expect(instantToWall(new Date('2026-01-15T00:05:00Z'), 'Europe/London')).toEqual({
      date: '2026-01-15',
      time: '00:05',
    });
  });

  it('round-trips with wallToInstant', () => {
    for (const zone of [
      'Europe/London',
      'America/Los_Angeles',
      'Asia/Kolkata',
      'Pacific/Auckland',
    ]) {
      const instant = wallToInstant('2026-06-01', '09:15', zone) as Date;
      expect(instantToWall(instant, zone)).toEqual({ date: '2026-06-01', time: '09:15' });
    }
  });
});
