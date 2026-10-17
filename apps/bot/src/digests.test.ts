import { GrammyError, type Api } from 'grammy';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  claimDigest: vi.fn(),
  linkedHouseholds: vi.fn(),
  loadAgenda: vi.fn(),
  recordDigestMessage: vi.fn(),
  releaseDigest: vi.fn(),
}));
vi.mock('@tracker/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tracker/db')>()),
  ...db,
}));

const { deliverDigests, resetDigestBackoff } = await import('./digests.js');
const { silentLogger } = await import('./logger.js');

const household = {
  id: 'h1',
  timezone: 'Europe/London',
  morningSlot: '08:00:00',
  eveningSlot: '18:00:00',
  telegramGroupChatId: -1001,
};

describe('deliverDigests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDigestBackoff();
  });

  it('gives the claim back when the digest cannot be built, so a later tick tries again', async () => {
    db.linkedHouseholds.mockResolvedValue([household]);
    db.claimDigest.mockResolvedValue(true);
    db.loadAgenda.mockRejectedValue(new Error('connection lost'));
    const sendMessage = vi.fn();
    const warnings: string[] = [];
    const logger = { ...silentLogger, warn: (msg: string) => void warnings.push(msg) };

    const sent = await deliverDigests({} as never, { sendMessage } as unknown as Api, {
      db: {} as never,
      now: () => new Date('2026-11-02T08:05:00Z'),
      logger,
      publicBaseUrl: undefined,
    });

    expect(sent).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(db.releaseDigest).toHaveBeenCalledWith(
      {},
      { householdId: 'h1', kind: 'morning', localDate: '2026-11-02' },
    );
    expect(warnings).toEqual(['digest not built']);
  });

  describe('after a 429', () => {
    const rateLimited = (retryAfter?: number) =>
      new GrammyError(
        'Call to sendMessage failed!',
        {
          ok: false,
          error_code: 429,
          description: 'Too Many Requests',
          ...(retryAfter === undefined ? {} : { parameters: { retry_after: retryAfter } }),
        },
        'sendMessage',
        {},
      );

    /** The delivery run with the clock `seconds` after 08:05 on Monday, and its `sendMessage`. */
    function setup(households: unknown[] = [household]) {
      db.linkedHouseholds.mockResolvedValue(households);
      db.claimDigest.mockResolvedValue(true);
      db.loadAgenda.mockResolvedValue({
        today: '2026-11-02',
        items: [{ title: 'Bins', dueDate: '2026-11-02', assigneeName: 'Alex' }],
        holidays: [],
      });
      const sendMessage = vi.fn().mockResolvedValue({ chat: { id: -1001 }, message_id: 7 });
      const run = (seconds: number) =>
        deliverDigests({} as never, { sendMessage } as unknown as Api, {
          db: {} as never,
          now: () => new Date(Date.parse('2026-11-02T08:05:00Z') + seconds * 1000),
          logger: silentLogger,
          publicBaseUrl: undefined,
        });
      return { run, sendMessage };
    }

    it('is not tried again, nor even claimed, before retry_after has passed', async () => {
      const { run, sendMessage } = setup();
      sendMessage.mockRejectedValueOnce(rateLimited(120));

      expect(await run(0)).toBe(0);
      expect(db.releaseDigest).toHaveBeenCalledTimes(1);

      expect(await run(119)).toBe(0);
      expect(db.claimDigest).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledTimes(1);

      expect(await run(120)).toBe(1);
      expect(db.claimDigest).toHaveBeenCalledTimes(2);
    });

    it('waits a minute when Telegram does not say how long', async () => {
      const { run, sendMessage } = setup();
      sendMessage.mockRejectedValueOnce(rateLimited());

      await run(0);
      await run(59);
      expect(db.claimDigest).toHaveBeenCalledTimes(1);

      expect(await run(60)).toBe(1);
    });

    it('makes only that digest wait, not other households', async () => {
      const { run, sendMessage } = setup([household, { ...household, id: 'h2' }]);
      sendMessage.mockRejectedValueOnce(rateLimited(3600));

      // A claim is kept once taken, as in the database.
      const claimed = new Set<string>();
      db.claimDigest.mockImplementation(async (_db, { householdId }) => {
        const free = !claimed.has(householdId);
        claimed.add(householdId);
        return free;
      });

      // h1 is refused and gives its claim back; h2 gets its digest in the same run.
      db.releaseDigest.mockImplementation(async (_db, { householdId }) => {
        claimed.delete(householdId);
      });
      expect(await run(0)).toBe(1);

      // A minute on, h1 is still waiting (and is not even claimed), and h2 is done.
      expect(await run(60)).toBe(0);
      expect(db.claimDigest.mock.calls.map(([, key]) => key.householdId)).toEqual([
        'h1',
        'h2',
        'h2',
      ]);
    });

    it('does not wait after a 502', async () => {
      const { run, sendMessage } = setup();
      sendMessage.mockRejectedValueOnce(
        new GrammyError(
          'Call to sendMessage failed!',
          { ok: false, error_code: 502, description: 'Bad Gateway' },
          'sendMessage',
          {},
        ),
      );

      await run(0);

      expect(await run(1)).toBe(1);
    });
  });
});
