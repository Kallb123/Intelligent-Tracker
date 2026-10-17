import { describe, expect, it } from 'vitest';
import { findDateTime } from './date.js';
import { NOW, TZ } from './test-util.js';

const read = (text: string, now = NOW) => {
  const found = findDateTime(text, now, TZ);
  return {
    date: found.date,
    time: found.time,
    implied: found.impliedDate,
    pieces: found.pieces.map((p) => `${p.kind}:${text.slice(p.start, p.end)}`),
  };
};

describe('findDateTime: numeric dates', () => {
  it('reads day first', () => {
    expect(read('Pay 1/11')).toMatchObject({ date: '2026-11-01', pieces: ['date:1/11'] });
    expect(read('Pay 12/10 please').date).toBe('2027-10-12');
    expect(read('Pay 17/10').date).toBe('2026-10-17');
    expect(read('Pay 01/11/2026').date).toBe('2026-11-01');
    expect(read('Pay 5/11/27').date).toBe('2027-11-05');
    expect(read('Pay 1.11.2026').date).toBe('2026-11-01');
    expect(read('Pay 1-11-2026').date).toBe('2026-11-01');
  });

  it('moves a date without a year that has passed to next year', () => {
    expect(read('MOT 14/03').date).toBe('2027-03-14');
    expect(read('MOT 16/10').date).toBe('2027-10-16');
  });

  it('finds a leap day, written either way', () => {
    expect(read('Cake 29/02').date).toBe('2028-02-29');
    expect(read('Cake 29 Feb').date).toBe('2028-02-29');
    expect(read('Cake 29th of February').date).toBe('2028-02-29');
    expect(read('Cake 29 Feb 2028').date).toBe('2028-02-29');
    expect(read('Cake 29/02/2027').date).toBeUndefined();
  });

  it('leaves things that are not dates alone', () => {
    for (const text of ['Pay 31/02', 'ratio 3-4', 'Call 0161 555 1234', 'Pay 13/13']) {
      expect(read(text), text).toMatchObject({ date: undefined, pieces: [] });
    }
  });

  it('takes the connector word with the date', () => {
    expect(read('MOT due 14/03').pieces).toEqual(['date:due 14/03']);
    expect(read('Pay due on 14/03').pieces).toEqual(['date:due on 14/03']);
    expect(read('Pay by 14/03').pieces).toEqual(['date:by 14/03']);
    expect(read('Pay before 14/03').pieces).toEqual(['date:before 14/03']);
  });

  it('combines a numeric date with a time', () => {
    expect(read('Dentist 5/11 at 2:30pm')).toMatchObject({
      date: '2026-11-05',
      time: '14:30',
      pieces: ['date:5/11', 'time:at 2:30pm'],
    });
  });
});

describe('findDateTime: spoken dates', () => {
  it('reads dates and times chrono understands, in the household zone', () => {
    expect(read('tomorrow')).toMatchObject({ date: '2026-10-18', time: undefined });
    expect(read('Dentist next Tuesday at 3pm')).toMatchObject({
      date: '2026-10-20',
      time: '15:00',
    });
    expect(read('Friday')).toMatchObject({ date: '2026-10-23' });
    expect(read('25th December').date).toBe('2026-12-25');
    expect(read('5 March 2027').date).toBe('2027-03-05');
    expect(read('in 2 weeks').date).toBe('2026-10-31');
    expect(read('Mon 2 Nov').date).toBe('2026-11-02');
    expect(read('1 Jan').date).toBe('2027-01-01');
  });

  it('reads "tomorrow" in the household zone, not UTC', () => {
    // 23:30 UTC on Saturday is 00:30 BST on Sunday in London.
    const late = new Date('2026-10-17T23:30:00Z');
    expect(read('today', late).date).toBe('2026-10-18');
    expect(read('tomorrow', late).date).toBe('2026-10-19');
    expect(read('5pm', late)).toMatchObject({ time: '17:00', implied: '2026-10-18' });
  });

  it('reads a time on its own and when it next falls', () => {
    expect(read('Meet at 5pm')).toMatchObject({
      date: undefined,
      time: '17:00',
      implied: '2026-10-17',
      pieces: ['time:at 5pm'],
    });
    expect(read('Meet 8am')).toMatchObject({ time: '08:00', implied: '2026-10-18' });
    expect(read('Meet 17:45').time).toBe('17:45');
    expect(read('Meet 9.15am').time).toBe('09:15');
    expect(read('Meet at 09.30').time).toBe('09:30');
  });

  it('reports a date and time together as one piece', () => {
    expect(read('tomorrow at 7pm')).toMatchObject({
      date: '2026-10-18',
      time: '19:00',
      pieces: ['date:tomorrow at 7pm'],
    });
  });

  it('ignores a second date', () => {
    expect(read('tomorrow or Friday')).toMatchObject({ date: '2026-10-18' });
    expect(read('1/11 or tomorrow').date).toBe('2026-11-01');
    expect(read('1/11 or tomorrow').pieces).toEqual(['date:1/11']);
  });

  it('does not guess at vague or ambiguous text', () => {
    for (const text of [
      'Sun cream',
      'Sat down',
      'Pay March invoice',
      'Dec 25 party',
      'Feb 29',
      'next month',
      'Renew 2 year warranty',
      'in a month',
      'Call dentist at 5',
      'Done by now',
      'a day',
    ]) {
      expect(read(text), text).toMatchObject({ date: undefined, time: undefined, pieces: [] });
    }
  });

  it('reads times that are clear without a meridiem', () => {
    expect(read('tomorrow morning')).toMatchObject({ date: '2026-10-18' });
    expect(read('Friday at noon')).toMatchObject({ date: '2026-10-23', time: '12:00' });
  });
});
