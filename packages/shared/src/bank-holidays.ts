import { z } from 'zod';
import { calendarDateSchema } from './tasks.js';

export const bankHolidayEventSchema = z.object({
  date: calendarDateSchema,
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(1000).optional(),
  bunting: z.boolean().optional(),
});
export const bankHolidayFeedSchema = z.object({
  'england-and-wales': z.object({
    division: z.literal('england-and-wales'),
    events: z.array(bankHolidayEventSchema).min(1).max(1000),
  }),
});
export type BankHolidayEvent = z.infer<typeof bankHolidayEventSchema>;

export const bankHolidaysResponseSchema = z.object({
  holidays: z.array(z.object({ date: calendarDateSchema, title: z.string() })),
});
