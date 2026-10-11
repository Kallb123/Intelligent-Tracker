import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatRelative } from './format.js';

describe('formatDate', () => {
  it('uses DD/MM/YYYY', () => {
    expect(formatDate('2026-01-05T12:00:00Z')).toBe('05/01/2026');
    expect(formatDate(new Date('2026-12-31T12:00:00Z'))).toBe('31/12/2026');
  });

  it('uses the zone for the calendar day (23:30 UTC on 30 June is already 1 July in BST)', () => {
    expect(formatDate('2026-06-30T23:30:00Z')).toBe('01/07/2026');
    expect(formatDate('2026-06-30T23:30:00Z', 'UTC')).toBe('30/06/2026');
  });

  it('accepts epoch milliseconds', () => {
    expect(formatDate(Date.UTC(2026, 2, 1, 12))).toBe('01/03/2026');
  });

  it('returns an empty string for an invalid date', () => {
    expect(formatDate('not a date')).toBe('');
    expect(formatDateTime('not a date')).toBe('');
    expect(formatRelative('not a date')).toBe('');
  });
});

describe('formatDateTime', () => {
  it('shows GMT in winter', () => {
    expect(formatDateTime('2026-01-15T14:30:00Z')).toBe('15/01/2026, 14:30');
  });

  it('shows BST (UTC+1) in summer', () => {
    expect(formatDateTime('2026-07-15T14:30:00Z')).toBe('15/07/2026, 15:30');
  });

  it('switches at the clocks change (29 March 2026, 01:00 UTC)', () => {
    expect(formatDateTime('2026-03-29T00:59:00Z')).toBe('29/03/2026, 00:59');
    expect(formatDateTime('2026-03-29T01:00:00Z')).toBe('29/03/2026, 02:00');
  });

  it('uses a 24-hour clock with midnight as 00:00', () => {
    expect(formatDateTime('2026-01-15T00:05:00Z')).toBe('15/01/2026, 00:05');
    expect(formatDateTime('2026-01-15T23:59:00Z')).toBe('15/01/2026, 23:59');
  });

  it('honours another household time zone', () => {
    expect(formatDateTime('2026-01-15T14:30:00Z', 'Europe/Paris')).toBe('15/01/2026, 15:30');
  });
});

describe('formatRelative', () => {
  const now = new Date('2026-05-10T12:00:00Z');

  it('describes the future and the past', () => {
    expect(formatRelative('2026-05-17T12:00:00Z', now)).toBe('in 7 days');
    expect(formatRelative('2026-05-11T12:00:00Z', now)).toBe('tomorrow');
    expect(formatRelative('2026-05-09T12:00:00Z', now)).toBe('yesterday');
    expect(formatRelative('2026-05-10T14:00:00Z', now)).toBe('in 2 hours');
    expect(formatRelative('2026-05-10T11:15:00Z', now)).toBe('45 minutes ago');
  });

  it('says now for less than a minute', () => {
    expect(formatRelative('2026-05-10T12:00:20Z', now)).toBe('now');
  });

  it('defaults to the current time', () => {
    expect(formatRelative(new Date(Date.now() + 3 * 3_600_000 + 60_000))).toBe('in 3 hours');
  });
});
