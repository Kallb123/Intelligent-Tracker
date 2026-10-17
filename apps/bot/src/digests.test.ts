import type { Api } from 'grammy';
import { describe, expect, it, vi } from 'vitest';

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

const { deliverDigests } = await import('./digests.js');
const { silentLogger } = await import('./logger.js');

describe('deliverDigests', () => {
  it('gives the claim back when the digest cannot be built, so a later tick tries again', async () => {
    db.linkedHouseholds.mockResolvedValue([
      {
        id: 'h1',
        timezone: 'Europe/London',
        morningSlot: '08:00:00',
        eveningSlot: '18:00:00',
        telegramGroupChatId: -1001,
      },
    ]);
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
});
