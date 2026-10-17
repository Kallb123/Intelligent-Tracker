import { describe, expect, it } from 'vitest';
import { findLeadTime, findReminderOffset } from './lead.js';

describe('findLeadTime', () => {
  it.each<[string, string, number]>([
    ['a month before', 'a month before', 30],
    ['sort it a month before', 'sort it a month before', 30],
    ['remind me a month before', 'remind me a month before', 30],
    ['start 2 weeks ahead', 'start 2 weeks ahead', 14],
    ['3 days before', '3 days before', 3],
    ['1 week early', '1 week early', 7],
    ['a fortnight earlier', 'a fortnight earlier', 14],
    ['two months in advance', 'two months in advance', 60],
    ['3 days ahead of', '3 days ahead of', 3],
    ['get started 6 weeks beforehand', 'get started 6 weeks beforehand', 42],
    ['SORT IT OUT A WEEK BEFORE', 'SORT IT OUT A WEEK BEFORE', 7],
  ])('reads %j', (text, phrase, days) => {
    const found = findLeadTime(`Renew ${text}.`);
    expect(found?.leadTimeDays).toBe(days);
    expect(`Renew ${text}.`.slice(found?.start, found?.end)).toBe(phrase);
  });

  it('needs a count and a unit', () => {
    for (const text of [
      'the day before',
      'the week before',
      'before Friday',
      '3 before',
      'a month',
    ]) {
      expect(findLeadTime(text), text).toBeNull();
    }
  });

  it('ignores a window longer than the api allows', () => {
    expect(findLeadTime('999 months before')).toBeNull();
  });
});

describe('findReminderOffset', () => {
  it.each<[string, string, 'evening' | 'morning']>([
    ['the night before', 'the night before', 'evening'],
    ['remind me the night before', 'remind me the night before', 'evening'],
    ['and remind me the evening before', 'and remind me the evening before', 'evening'],
    ['the day before', 'the day before', 'evening'],
    ['on the day before', 'on the day before', 'evening'],
    ['ping me the morning before', 'ping me the morning before', 'morning'],
  ])('reads %j as the day before', (text, phrase, slot) => {
    const found = findReminderOffset(`Bins, ${text}`);
    expect(found).toMatchObject({ remindOffsetDays: -1, reminderSlot: slot });
    expect(`Bins, ${text}`.slice(found?.start, found?.end)).toBe(phrase);
  });

  it('leaves counted phrases to the lead-time stage', () => {
    expect(findReminderOffset('remind me a month before')).toBeNull();
    expect(findReminderOffset('2 days before')).toBeNull();
    expect(findReminderOffset('the night')).toBeNull();
  });
});
