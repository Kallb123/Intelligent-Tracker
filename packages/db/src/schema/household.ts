import { HOUSEHOLD_DEFAULTS } from '@tracker/shared';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  bigint,
  date,
  index,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, updatedAt } from './columns.js';
import { bankHolidayRegion, memberRole, reminderProfile } from './enums.js';

export const household = pgTable('household', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default(HOUSEHOLD_DEFAULTS.timezone),
  locale: text('locale').notNull().default(HOUSEHOLD_DEFAULTS.locale),
  bankHolidayRegion: bankHolidayRegion('bank_holiday_region')
    .notNull()
    .default(HOUSEHOLD_DEFAULTS.bankHolidayRegion),
  icalPublicHost: text('ical_public_host').notNull().default(HOUSEHOLD_DEFAULTS.icalPublicHost),
  // bigint: Telegram group chat ids (e.g. -100…) do not fit in int32. mode 'number' is exact
  // up to 2^53, far beyond any Telegram id.
  telegramGroupChatId: bigint('telegram_group_chat_id', { mode: 'number' }),
  defaultReminderProfile: reminderProfile('default_reminder_profile')
    .notNull()
    .default(HOUSEHOLD_DEFAULTS.defaultReminderProfile),
  morningSlot: time('morning_slot').notNull().default(HOUSEHOLD_DEFAULTS.slots.morningDigest),
  eveningSlot: time('evening_slot').notNull().default(HOUSEHOLD_DEFAULTS.slots.eveningDigest),
  quietHoursStart: time('quiet_hours_start').notNull().default(HOUSEHOLD_DEFAULTS.quietHours.start),
  quietHoursEnd: time('quiet_hours_end').notNull().default(HOUSEHOLD_DEFAULTS.quietHours.end),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const member = pgTable(
  'member',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => household.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    username: text('username').notNull(),
    email: text('email'),
    role: memberRole('role').notNull().default('member'),
    // Null until the member sets a password via the setup/invite flow (PR 5).
    passwordHash: text('password_hash'),
    telegramUserId: bigint('telegram_user_id', { mode: 'number' }).unique(),
    telegramLinkCode: text('telegram_link_code').unique(),
    preferredReminderTimes: time('preferred_reminder_times')
      .array()
      .notNull()
      .default(sql`'{}'::time[]`),
    awayUntil: date('away_until', { mode: 'string' }),
    // Secret in the member's iCal feed URL; generated app-side (no pgcrypto needed).
    icalToken: text('ical_token')
      .notNull()
      .unique()
      .$defaultFn(() => randomBytes(24).toString('base64url')),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Usernames are case-insensitive: "Sam" and "sam" are the same login.
    uniqueIndex('member_username_lower_uq').on(sql`lower(${t.username})`),
    index('member_household_id_idx').on(t.householdId),
  ],
);

export const session = pgTable(
  'session',
  {
    // Opaque token id; how it is derived or hashed is decided with auth in PR 5.
    id: text('id').primaryKey(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [
    index('session_member_id_idx').on(t.memberId),
    index('session_expires_at_idx').on(t.expiresAt),
  ],
);

/** Reference data (not per household): looked up by the household's `bank_holiday_region`. */
export const bankHoliday = pgTable(
  'bank_holiday',
  {
    region: bankHolidayRegion('region').notNull(),
    date: date('date', { mode: 'string' }).notNull(),
    title: text('title').notNull(),
  },
  (t) => [primaryKey({ columns: [t.region, t.date] })],
);

export type Household = typeof household.$inferSelect;
export type NewHousehold = typeof household.$inferInsert;
export type Member = typeof member.$inferSelect;
export type NewMember = typeof member.$inferInsert;
export type Session = typeof session.$inferSelect;
export type NewSession = typeof session.$inferInsert;
export type BankHoliday = typeof bankHoliday.$inferSelect;
export type NewBankHoliday = typeof bankHoliday.$inferInsert;
