import { household, type Member } from '@tracker/db';
import type { MemberDto, SessionInfo } from '@tracker/shared';
import { eq } from 'drizzle-orm';
import type { ApiContext } from '../context.js';

/**
 * The only shape in which a member leaves the api. It is a whitelist: the password hash, iCal
 * token, Telegram link code and the like must never be added here.
 */
export function toMemberDto(m: Member): MemberDto {
  return {
    id: m.id,
    name: m.name,
    username: m.username,
    email: m.email,
    role: m.role,
    pending: m.passwordHash === null,
    awayUntil: m.awayUntil,
  };
}

/** The body returned when a session starts and by `GET /api/auth/me`. */
export async function sessionInfo(
  ctx: ApiContext,
  m: Member,
  csrfToken: string,
): Promise<SessionInfo> {
  const [h] = await ctx.db.select().from(household).where(eq(household.id, m.householdId));
  if (!h) throw new Error(`member ${m.id} has no household`);
  return {
    member: toMemberDto(m),
    household: { id: h.id, name: h.name, timezone: h.timezone, locale: h.locale },
    csrfToken,
  };
}
