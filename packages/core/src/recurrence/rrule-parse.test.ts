import { describe, expect, it } from 'vitest';
import { IANAZone } from 'luxon';
import { MAX_WALL } from './calendar.js';
import { RecurrenceError, type RecurrenceErrorCode } from './errors.js';
import { parseRRule, RRule, untilWall } from './rrule-parse.js';

function codeOf(text: string): RecurrenceErrorCode | 'no error' {
  try {
    parseRRule(text);
    return 'no error';
  } catch (error) {
    if (error instanceof RecurrenceError) return error.code;
    throw error;
  }
}

describe('parseRRule', () => {
  it('parses every supported part', () => {
    const rule = parseRRule(
      'rrule:freq=monthly;interval=2;count=12;byday=2TU,-1FR,MO;bymonthday=1,-1;bymonth=1,12;bysetpos=-1;wkst=su',
    );
    expect(rule.until).toBeNull();
    expect(rule.options).toMatchObject({
      freq: RRule.MONTHLY,
      interval: 2,
      count: 12,
      bymonthday: [1, -1],
      bymonth: [1, 12],
      bysetpos: [-1],
      wkst: 6,
    });
    expect(rule.options.byweekday).toEqual([
      expect.objectContaining({ weekday: 1, n: 2 }),
      expect.objectContaining({ weekday: 4, n: -1 }),
      expect.objectContaining({ weekday: 0, n: undefined }),
    ]);
  });

  it('defaults to weeks starting on Monday and accepts the RRULE: prefix and spaces', () => {
    const rule = parseRRule(' RRULE:FREQ=WEEKLY ');
    expect(rule.options).toEqual({ freq: RRule.WEEKLY, wkst: RRule.MO });
  });

  it.each(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])('accepts FREQ=%s', (freq) => {
    expect(codeOf(`FREQ=${freq}`)).toBe('no error');
  });

  it('reads a date UNTIL as inclusive through that local day', () => {
    const rule = parseRRule('FREQ=DAILY;UNTIL=20261231');
    expect(rule.untilIsDate).toBe(true);
    const london = IANAZone.create('Europe/London');
    expect(untilWall(rule, london)).toBe(Date.UTC(2026, 11, 31, 23, 59, 59, 999));
  });

  it('reads a date-time UNTIL as a UTC instant converted to wall time', () => {
    const rule = parseRRule('FREQ=DAILY;UNTIL=20260701T223000Z');
    expect(rule.untilIsDate).toBe(false);
    const london = IANAZone.create('Europe/London');
    // 22:30Z in July is 23:30 BST.
    expect(untilWall(rule, london)).toBe(Date.UTC(2026, 6, 1, 23, 30));
  });

  it('has no end without UNTIL', () => {
    expect(untilWall(parseRRule('FREQ=DAILY'), IANAZone.create('Europe/London'))).toBe(MAX_WALL);
  });

  it.each([
    ['', 'empty'],
    ['FREQ=DAILY;', 'trailing semicolon'],
    ['DAILY', 'not NAME=VALUE'],
    ['INTERVAL=2', 'missing FREQ'],
    ['FREQ=FORTNIGHTLY', 'unknown FREQ'],
    ['FREQ=DAILY;FREQ=WEEKLY', 'duplicate part'],
    ['FREQ=DAILY;FOO=1', 'unknown part'],
    ['FREQ=DAILY;INTERVAL=0', 'zero interval'],
    ['FREQ=DAILY;INTERVAL=-1', 'negative interval'],
    ['FREQ=DAILY;INTERVAL=2.5', 'fractional interval'],
    ['FREQ=DAILY;INTERVAL=9999999', 'huge interval'],
    ['FREQ=DAILY;COUNT=0', 'zero count'],
    ['FREQ=DAILY;COUNT=2;UNTIL=20261231', 'COUNT with UNTIL'],
    ['FREQ=WEEKLY;BYDAY=XX', 'bad weekday'],
    ['FREQ=WEEKLY;BYDAY=MO,', 'empty weekday'],
    ['FREQ=MONTHLY;BYDAY=0MO', 'zero ordinal'],
    ['FREQ=MONTHLY;BYDAY=54MO', 'ordinal too large'],
    ['FREQ=MONTHLY;BYMONTHDAY=0', 'day zero'],
    ['FREQ=MONTHLY;BYMONTHDAY=32', 'day 32'],
    ['FREQ=MONTHLY;BYMONTHDAY=-32', 'day -32'],
    ['FREQ=MONTHLY;BYMONTHDAY=abc', 'day not a number'],
    ['FREQ=YEARLY;BYMONTH=13', 'month 13'],
    ['FREQ=YEARLY;BYMONTH=0', 'month 0'],
    ['FREQ=MONTHLY;BYDAY=MO;BYSETPOS=0', 'set position zero'],
    ['FREQ=WEEKLY;WKST=XX', 'bad WKST'],
    ['FREQ=DAILY;UNTIL=tomorrow', 'UNTIL format'],
    ['FREQ=DAILY;UNTIL=20261301', 'UNTIL month 13'],
    ['FREQ=DAILY;UNTIL=20260230', 'UNTIL 30 Feb'],
    ['FREQ=DAILY;UNTIL=20260101T250000Z', 'UNTIL hour 25'],
    ['FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30', '30 February'],
    ['FREQ=YEARLY;BYMONTH=4,6;BYMONTHDAY=31', '31 April / June'],
  ])('rejects %j (%s) as invalid_rrule', (text) => {
    expect(codeOf(text)).toBe('invalid_rrule');
  });

  it.each([
    'FREQ=HOURLY',
    'FREQ=MINUTELY',
    'FREQ=SECONDLY',
    'FREQ=DAILY;BYHOUR=8',
    'FREQ=DAILY;BYMINUTE=30',
    'FREQ=DAILY;BYSECOND=1',
    'FREQ=YEARLY;BYWEEKNO=20',
    'FREQ=YEARLY;BYYEARDAY=100',
    'DTSTART:20260101T080000Z\nRRULE:FREQ=DAILY',
    'DTSTART=20260101;FREQ=DAILY',
    'FREQ=DAILY;TZID=Europe/London',
    'FREQ=DAILY\nEXDATE:20260102',
    'FREQ=DAILY;RDATE=20260102',
    'FREQ=DAILY;EXRULE=FREQ=WEEKLY',
    'FREQ=DAILY\r\nFREQ=WEEKLY',
  ])('rejects %j as unsupported_rrule', (text) => {
    expect(codeOf(text)).toBe('unsupported_rrule');
  });

  it('accepts month-day combinations that do occur', () => {
    expect(codeOf('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29')).toBe('no error');
    expect(codeOf('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30,-1')).toBe('no error');
    expect(codeOf('FREQ=YEARLY;BYMONTH=2,7;BYMONTHDAY=31')).toBe('no error');
  });
});
