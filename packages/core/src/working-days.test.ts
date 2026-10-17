import { describe, expect, it } from 'vitest';
import { onWorkingDay } from './working-days.js';

const zone = 'Europe/London';
describe('working days only', () => {
  it('moves through weekends and consecutive substitute holidays', () => {
    const p = {
      due: { allDay: true as const, date: '2026-12-25' },
      startAt: new Date('2026-12-11T00:00Z'),
    };
    expect(onWorkingDay(p, new Set(['2026-12-25', '2026-12-28']), zone)).toEqual({
      due: { allDay: true, date: '2026-12-29' },
      startAt: new Date('2026-12-15T00:00Z'),
    });
  });
  it('keeps London wall time across the spring clock change', () => {
    const p = {
      due: { allDay: false as const, at: new Date('2026-03-28T09:00Z') },
      startAt: new Date('2026-03-27T09:00Z'),
    };
    expect(onWorkingDay(p, new Set(), zone)).toEqual({
      due: { allDay: false, at: new Date('2026-03-30T08:00Z') },
      startAt: new Date('2026-03-29T08:00Z'),
    });
  });
  it('never moves a due before notBefore', () => {
    const p = { due: { allDay: true as const, date: '2026-11-27' }, startAt: null };
    expect(onWorkingDay(p, new Set(), zone, '2026-11-30').due).toEqual({
      allDay: true,
      date: '2026-11-30',
    });
    expect(onWorkingDay(p, new Set(), zone, '2026-11-28').due).toEqual({
      allDay: true,
      date: '2026-11-30',
    });
  });
  it('preserves dates on working days and null prep starts', () => {
    const p = { due: { allDay: true as const, date: '2026-03-30' }, startAt: null };
    expect(onWorkingDay(p, new Set(), zone)).toBe(p);
    expect(
      onWorkingDay({ ...p, due: { allDay: true, date: '2026-03-29' } }, new Set(), zone),
    ).toEqual(p);
  });
});
