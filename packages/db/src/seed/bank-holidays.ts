import type { NewBankHoliday } from '../schema/index.js';

/**
 * England and Wales bank holidays (the household default region).
 *
 * Source: the `england-and-wales` division of https://www.gov.uk/bank-holidays.json.
 * PR 16 replaces this static list with a live gov.uk sync that caches into `bank_holiday`.
 * Sorted by date; dates are ISO `YYYY-MM-DD`. Where the feed marks an entry as a substitute
 * day (the holiday fell on a weekend), the title says so.
 */
export const ENGLAND_AND_WALES_BANK_HOLIDAYS: readonly NewBankHoliday[] = (
  [
    ['2025-01-01', 'New Year’s Day'],
    ['2025-04-18', 'Good Friday'],
    ['2025-04-21', 'Easter Monday'],
    ['2025-05-05', 'Early May bank holiday'],
    ['2025-05-26', 'Spring bank holiday'],
    ['2025-08-25', 'Summer bank holiday'],
    ['2025-12-25', 'Christmas Day'],
    ['2025-12-26', 'Boxing Day'],
    ['2026-01-01', 'New Year’s Day'],
    ['2026-04-03', 'Good Friday'],
    ['2026-04-06', 'Easter Monday'],
    ['2026-05-04', 'Early May bank holiday'],
    ['2026-05-25', 'Spring bank holiday'],
    ['2026-08-31', 'Summer bank holiday'],
    ['2026-12-25', 'Christmas Day'],
    ['2026-12-28', 'Boxing Day (substitute day)'],
    ['2027-01-01', 'New Year’s Day'],
    ['2027-03-26', 'Good Friday'],
    ['2027-03-29', 'Easter Monday'],
    ['2027-05-03', 'Early May bank holiday'],
    ['2027-05-31', 'Spring bank holiday'],
    ['2027-08-30', 'Summer bank holiday'],
    ['2027-12-27', 'Christmas Day (substitute day)'],
    ['2027-12-28', 'Boxing Day (substitute day)'],
  ] as const
).map(([date, title]) => ({ region: 'england-and-wales', date, title }));
