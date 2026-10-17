import { syncBankHolidays, type Database } from '@tracker/db';
import { bankHolidayFeedSchema } from '@tracker/shared';

export const BANK_HOLIDAY_URL = 'https://www.gov.uk/bank-holidays.json';

export async function refreshBankHolidays(db: Database, now: Date, fetcher: typeof fetch = fetch) {
  return syncBankHolidays(db, {
    now,
    load: async () => {
      const response = await fetcher(BANK_HOLIDAY_URL, {
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`Bank holiday feed returned HTTP ${response.status}`);
      return bankHolidayFeedSchema.parse(await response.json())['england-and-wales'].events;
    },
  });
}
