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
import { bankHolidayRegion, memberRole, passwordTokenPurpose, reminderProfile } from './enums.js';

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
  // up to 2^53, far beyond any Telegram id. Unique (NULLs never collide): the bot finds the
  // household of a group by its chat, so a group can belong to one household only.
  telegramGroupChatId: bigint('telegram_group_chat_id', { mode: 'number' }).unique(),
  // SHA-256 (hex) of the one-time code the admin sends as `/linkgroup <code>`; cleared when used.
  telegramGroupLinkCode: text('telegram_group_link_code').unique(),
  telegramGroupLinkExpiresAt: timestamp('telegram_group_link_expires_at', { withTimezone: true }),
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
    // Argon2id PHC string. Null until the member sets a password via setup or an invite link.
    passwordHash: text('password_hash'),
    telegramUserId: bigint('telegram_user_id', { mode: 'number' }).unique(),
    // SHA-256 (hex) of the one-time code in the member's `t.me/<bot>?start=<code>` link; cleared
    // when used.
    telegramLinkCode: text('telegram_link_code').unique(),
    telegramLinkExpiresAt: timestamp('telegram_link_expires_at', { withTimezone: true }),
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
    // Members can also log in by email, so it must identify one member (NULLs never collide).
    uniqueIndex('member_email_lower_uq').on(sql`lower(${t.email})`),
    index('member_household_id_idx').on(t.householdId),
  ],
);

export const session = pgTable(
  'session',
  {
    // SHA-256 (hex) of the random token in the session cookie, so a leaked database does not
    // leak usable sessions.
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

/**
 * A one-time link that lets a member set their password: an invite for a member created by an
 * admin (no password yet) or a reset of an existing one. Only a hash of the link's token is kept.
 */
export const passwordToken = pgTable(
  'password_token',
  {
    // SHA-256 (hex) of the token in the link.
    id: text('id').primaryKey(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    purpose: passwordTokenPurpose('purpose').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // Set when the link is used; a used link can never be used again.
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => member.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('password_token_member_id_idx').on(t.memberId)],
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

export const bankHolidaySync = pgTable('bank_holiday_sync', {
  region: bankHolidayRegion('region').primaryKey(),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
  attemptedAt: timestamp('attempted_at', { withTimezone: true }),
});

export type Household = typeof household.$inferSelect;
export type NewHousehold = typeof household.$inferInsert;
export type Member = typeof member.$inferSelect;
export type NewMember = typeof member.$inferInsert;
export type Session = typeof session.$inferSelect;
export type NewSession = typeof session.$inferInsert;
export type PasswordToken = typeof passwordToken.$inferSelect;
export type NewPasswordToken = typeof passwordToken.$inferInsert;
export type BankHoliday = typeof bankHoliday.$inferSelect;
export type NewBankHoliday = typeof bankHoliday.$inferInsert;
