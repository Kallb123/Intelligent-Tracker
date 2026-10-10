import { household, member, passwordToken, session } from '@tracker/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { ApiContext } from '../context.js';
import { AppError, notFound } from '../errors.js';
import { generateToken, hashToken } from './tokens.js';

export type PasswordTokenPurpose = 'invite' | 'reset';

/** Where the web app serves the page for each kind of link. */
const LINK_PATHS: Record<PasswordTokenPurpose, string> = {
  invite: '/invite',
  reset: '/reset-password',
};

export interface IssuedLink {
  token: string;
  url: string;
  expiresAt: Date;
}

/** Public origin for links: `PUBLIC_BASE_URL` if configured, else the host the admin used. */
function baseUrl(ctx: ApiContext, request: FastifyRequest): string {
  return ctx.config.publicBaseUrl ?? `${request.protocol}://${request.host}`;
}

/**
 * Issues a one-time link for `memberId` and voids any earlier unused ones, so only the newest
 * link works. Runs on `executor` so callers can do it inside their own transaction.
 */
export async function issuePasswordToken(
  ctx: ApiContext,
  request: FastifyRequest,
  executor: Pick<ApiContext['db'], 'insert' | 'delete'>,
  options: { memberId: string; purpose: PasswordTokenPurpose; createdBy: string },
): Promise<IssuedLink> {
  const token = generateToken();
  const ttlMs = options.purpose === 'invite' ? ctx.config.inviteTtlMs : ctx.config.resetTtlMs;
  const expiresAt = new Date(ctx.config.clock().getTime() + ttlMs);

  await executor
    .delete(passwordToken)
    .where(and(eq(passwordToken.memberId, options.memberId), isNull(passwordToken.usedAt)));
  await executor.insert(passwordToken).values({
    id: hashToken(token),
    memberId: options.memberId,
    purpose: options.purpose,
    expiresAt,
    createdBy: options.createdBy,
  });

  return {
    token,
    url: `${baseUrl(ctx, request)}${LINK_PATHS[options.purpose]}/${token}`,
    expiresAt,
  };
}

export interface LinkTarget {
  tokenId: string;
  memberId: string;
  name: string;
  username: string;
  householdName: string;
  expiresAt: Date;
}

/**
 * Finds the member a link is for. A token that does not exist (or is for the other purpose) is
 * a 404; one that was used or has expired is a 410 Gone.
 */
export async function lookupPasswordToken(
  ctx: ApiContext,
  token: string,
  purpose: PasswordTokenPurpose,
): Promise<LinkTarget> {
  const tokenId = hashToken(token);
  const [row] = await ctx.db
    .select({
      purpose: passwordToken.purpose,
      usedAt: passwordToken.usedAt,
      expiresAt: passwordToken.expiresAt,
      memberId: member.id,
      name: member.name,
      username: member.username,
      householdName: household.name,
    })
    .from(passwordToken)
    .innerJoin(member, eq(member.id, passwordToken.memberId))
    .innerJoin(household, eq(household.id, member.householdId))
    .where(eq(passwordToken.id, tokenId))
    .limit(1);

  if (!row || row.purpose !== purpose) throw notFound('This link is not valid');
  if (row.usedAt || row.expiresAt <= ctx.config.clock()) {
    throw new AppError(410, 'link_expired', 'This link has already been used or has expired');
  }
  return { tokenId, ...row };
}

/**
 * Sets the member's password and uses the link up, atomically: the conditional update only
 * matches a link that is still unused and unexpired, so concurrent redemptions cannot both win.
 * All of the member's existing sessions are ended, so a reset also logs out whoever had the
 * old password.
 */
export async function redeemPasswordToken(
  ctx: ApiContext,
  target: LinkTarget,
  passwordHash: string,
): Promise<void> {
  const now = ctx.config.clock();
  await ctx.db.transaction(async (tx) => {
    const claimed = await tx
      .update(passwordToken)
      .set({ usedAt: now })
      .where(
        and(
          eq(passwordToken.id, target.tokenId),
          isNull(passwordToken.usedAt),
          gt(passwordToken.expiresAt, now),
        ),
      )
      .returning({ id: passwordToken.id });
    if (claimed.length === 0) {
      throw new AppError(410, 'link_expired', 'This link has already been used or has expired');
    }
    await tx.update(member).set({ passwordHash }).where(eq(member.id, target.memberId));
    await tx.delete(session).where(eq(session.memberId, target.memberId));
  });
}
