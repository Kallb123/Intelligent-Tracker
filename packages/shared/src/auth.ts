import { z } from 'zod';
import { calendarDateSchema } from './tasks.js';

/** Request and response shapes of the auth API, shared by the api and the web app. */

/** Letters, digits, `.`, `_` and `-` only. No `@`, so a username never looks like an email. */
export const usernameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/,
    'Use 2 to 32 letters, digits, dots, dashes or underscores',
  );

export const emailSchema = z.string().trim().max(254).pipe(z.email());

/** The upper bound keeps hashing cheap to bound; the lower one is a basic length floor. */
export const passwordSchema = z.string().min(10, 'Use at least 10 characters').max(128);

const nameSchema = z.string().trim().min(1).max(80);

/** Keeps the session for 30 days instead of a day. */
const rememberSchema = z.boolean().optional();

export const setupBodySchema = z.object({
  householdName: nameSchema,
  name: nameSchema,
  username: usernameSchema,
  email: emailSchema.optional(),
  password: passwordSchema,
  remember: rememberSchema,
});

export const loginBodySchema = z.object({
  /** Username or email, case-insensitive. */
  identifier: z.string().trim().min(1).max(254),
  // Not passwordSchema: login must not reveal the password rules (or reject old passwords).
  password: z.string().min(1).max(128),
  remember: rememberSchema,
});

export const changePasswordBodySchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

export const createInviteBodySchema = z.object({
  name: nameSchema,
  username: usernameSchema,
  email: emailSchema.optional(),
  role: z.enum(['admin', 'member']).default('member'),
});

/** Body for accepting an invite or a password reset link. */
export const setPasswordBodySchema = z.object({
  password: passwordSchema,
  remember: rememberSchema,
});

export const memberSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  username: z.string(),
  email: z.string().nullable(),
  role: z.enum(['admin', 'member']),
  /** True while the member has not yet set a password (an invite that has not been accepted). */
  pending: z.boolean(),
  /**
   * Away through this household-local date, inclusive: rotating tasks skip the member for dues
   * up to and including it. `null` when not away.
   */
  awayUntil: calendarDateSchema.nullable(),
});

/** Body of `PATCH /api/members/:id/away`; `null` clears the away date. */
export const setAwayBodySchema = z.object({ awayUntil: calendarDateSchema.nullable() });

export const householdSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  timezone: z.string(),
  locale: z.string(),
});

/** Returned whenever a session starts or is looked up. */
export const sessionInfoSchema = z.object({
  member: memberSchema,
  household: householdSummarySchema,
  /** Send as the `X-CSRF-Token` header on POST/PUT/PATCH/DELETE requests. */
  csrfToken: z.string(),
});

export const setupStatusSchema = z.object({ needsSetup: z.boolean() });

export const oneTimeLinkSchema = z.object({
  /** Shown once: only a hash of it is stored. */
  token: z.string(),
  url: z.string(),
  expiresAt: z.iso.datetime(),
});

export const createInviteResponseSchema = z.object({
  member: memberSchema,
  invite: oneTimeLinkSchema,
});

export const passwordResetResponseSchema = z.object({
  purpose: z.enum(['invite', 'reset']),
  link: oneTimeLinkSchema,
});

/** Who a one-time link is for, so the page can greet them before they choose a password. */
export const linkInfoSchema = z.object({
  name: z.string(),
  username: z.string(),
  householdName: z.string(),
  expiresAt: z.iso.datetime(),
});

export const memberResponseSchema = z.object({ member: memberSchema });

export const membersResponseSchema = z.object({ members: z.array(memberSchema) });

export const okSchema = z.object({ ok: z.literal(true) });

export const errorSchema = z.object({ error: z.string(), message: z.string() });

export type SetupBody = z.infer<typeof setupBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>;
export type CreateInviteBody = z.infer<typeof createInviteBodySchema>;
export type SetAwayBody = z.infer<typeof setAwayBodySchema>;
export type SetPasswordBody = z.infer<typeof setPasswordBodySchema>;
export type MemberDto = z.infer<typeof memberSchema>;
export type SessionInfo = z.infer<typeof sessionInfoSchema>;
