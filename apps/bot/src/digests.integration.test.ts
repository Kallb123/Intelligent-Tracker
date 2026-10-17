import { occurrence, task, telegramDigest } from '@tracker/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { botDeps } from './bot.js';
import { deliverDigests } from './digests.js';
import {
  adminUrl,
  CHAT_ID,
  newHousehold,
  newMember,
  newOccurrence,
  newTestBot,
  useTestDatabase,
} from './test-harness.js';

// Times are in London, which is on GMT (UTC) from 25 October 2026.
const MONDAY_MORNING = new Date('2026-11-02T08:05:00Z');
const SUNDAY_MORNING = new Date('2026-11-08T08:05:00Z');
const SUNDAY_EVENING = new Date('2026-11-08T19:05:00Z');
const MONDAY_EVENING = new Date('2026-11-09T19:05:00Z');

describe.skipIf(!adminUrl)('scheduled digests (integration)', () => {
  const test = useTestDatabase();

  async function setup() {
    const household = await newHousehold(test.db);
    const alex = await newMember(test.db, household.id, 'Alex', 1001);
    await newOccurrence(test.db, household.id, 'Put the bins out', {
      assigneeId: alex.id,
      dueDate: '2026-11-02',
    });
    return { household, alex, ...newTestBot(test.db) };
  }

  /** Runs the delivery with the clock at `at`; the clock is read when it runs. */
  const deliver = (harness: Awaited<ReturnType<typeof setup>>, at: Date): Promise<number> =>
    deliverDigests(
      test.db,
      harness.bot.api,
      botDeps(test.db, { now: () => at, logger: harness.logger }),
    );

  const claims = () => test.db.select().from(telegramDigest);

  it('sends the morning digest once a day, and records the message', async () => {
    const harness = await setup();
    const { household, telegram } = harness;

    expect(await deliver(harness, MONDAY_MORNING)).toBe(1);

    expect(telegram.to('sendMessage')).toHaveLength(1);
    expect(telegram.to('sendMessage')[0]).toMatchObject({
      chat_id: CHAT_ID,
      text: '☀️ Mon 2 Nov\n\nToday\n• Put the bins out — Alex',
      link_preview_options: { is_disabled: true },
    });
    expect(telegram.to('sendMessage')[0]).not.toHaveProperty('parse_mode');
    expect(await claims()).toMatchObject([
      {
        householdId: household.id,
        kind: 'morning',
        localDate: '2026-11-02',
        telegramChatId: CHAT_ID,
        telegramMessageId: expect.any(Number),
      },
    ]);

    // Later ticks of the same morning send nothing more.
    expect(await deliver(harness, new Date(MONDAY_MORNING.getTime() + 60 * 60 * 1000))).toBe(0);
    expect(telegram.to('sendMessage')).toHaveLength(1);

    // The next morning it goes out again.
    expect(await deliver(harness, new Date('2026-11-03T08:00:00Z'))).toBe(1);
    expect(telegram.to('sendMessage')).toHaveLength(2);
  });

  it('sends nothing before the morning slot, or long after it', async () => {
    const harness = await setup();
    for (const at of ['2026-11-02T07:59:59Z', '2026-11-02T10:00:00Z', '2026-11-02T19:00:00Z']) {
      expect(await deliver(harness, new Date(at))).toBe(0);
    }
    expect(harness.telegram.calls).toEqual([]);
    expect(await claims()).toEqual([]);
  });

  it('gives the claim back when the send fails, and sends on the next run', async () => {
    const harness = await setup();
    harness.telegram.failNext('sendMessage', { error_code: 502, description: 'Bad Gateway' });

    expect(await deliver(harness, MONDAY_MORNING)).toBe(0);

    expect(harness.logger.warnings).toEqual(['digest not sent']);
    expect(await claims()).toEqual([]);

    expect(await deliver(harness, new Date(MONDAY_MORNING.getTime() + 10_000))).toBe(1);
    expect(harness.telegram.to('sendMessage')).toHaveLength(2);
    expect(await claims()).toHaveLength(1);
  });

  it('stays quiet when there is nothing on, and does not look again that day', async () => {
    const harness = await setup();
    const { household } = harness;
    // The day's only job is not due yet and has not started.
    await test.db.delete(task);
    await newOccurrence(test.db, household.id, 'Later', { dueDate: '2026-12-25' });

    expect(await deliver(harness, MONDAY_MORNING)).toBe(0);
    expect(harness.telegram.calls).toEqual([]);
    // The claim is kept, so the next ticks do not build the digest again.
    expect(await claims()).toMatchObject([{ kind: 'morning', telegramMessageId: null }]);

    await newOccurrence(test.db, household.id, 'Too late for this morning', {
      dueDate: '2026-11-02',
    });
    expect(await deliver(harness, new Date(MONDAY_MORNING.getTime() + 60_000))).toBe(0);
    expect(harness.telegram.calls).toEqual([]);
  });

  it('sends the week ahead on Sunday evening, and not on other evenings', async () => {
    const harness = await setup();
    await newOccurrence(test.db, harness.household.id, 'Mow the lawn', { dueDate: '2026-11-10' });

    expect(await deliver(harness, MONDAY_EVENING)).toBe(0);
    expect(await deliver(harness, SUNDAY_EVENING)).toBe(1);

    expect(harness.telegram.sentTexts).toMatchInlineSnapshot(`
      [
        "📅 Week ahead

      Overdue
      • Put the bins out — Alex (6 days overdue)

      Tue 10 Nov
      • Mow the lawn — Anyone",
      ]
    `);
    expect((await claims()).map((c) => [c.kind, c.localDate])).toEqual([
      ['week_ahead', '2026-11-08'],
    ]);
    expect(await deliver(harness, new Date(SUNDAY_EVENING.getTime() + 60_000))).toBe(0);
  });

  it('sends only the morning digest on a Sunday morning', async () => {
    const harness = await setup();
    await test.db.update(occurrence).set({ dueDate: '2026-11-08' });

    expect(await deliver(harness, SUNDAY_MORNING)).toBe(1);
    expect(harness.telegram.sentTexts[0]).toMatch(/^☀️ Sun 8 Nov/);
    expect((await claims()).map((c) => c.kind)).toEqual(['morning']);
  });

  it('sends each linked household its own digest, and one failing does not stop the others', async () => {
    const harness = await setup();
    const broken = await newHousehold(test.db, {
      name: 'Broken',
      telegramGroupChatId: -2001,
      timezone: 'Not/AZone',
    });
    await newOccurrence(test.db, broken.id, 'Never seen');
    const other = await newHousehold(test.db, { name: 'Other', telegramGroupChatId: -2002 });
    await newOccurrence(test.db, other.id, 'Recycling', { dueDate: '2026-11-02' });
    // No group, so no digest.
    const unlinked = await newHousehold(test.db, { name: 'Unlinked', telegramGroupChatId: null });
    await newOccurrence(test.db, unlinked.id, 'Nobody to tell');

    expect(await deliver(harness, MONDAY_MORNING)).toBe(2);

    const sent = harness.telegram.to('sendMessage');
    expect(sent.map((p) => p['chat_id']).sort()).toEqual([-2002, CHAT_ID].sort());
    expect(sent.find((p) => p['chat_id'] === -2002)?.['text']).toContain('Recycling');
    expect(harness.logger.errors).toEqual(['digests failed']);
    expect(
      await test.db.select().from(telegramDigest).where(eq(telegramDigest.householdId, broken.id)),
    ).toEqual([]);
  });
});
