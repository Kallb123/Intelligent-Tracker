import type { Api } from 'grammy';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deliverDigests: vi.fn(),
  giveUpStaleNotifications: vi.fn(),
  deliverOutboxBatches: vi.fn(),
  pruneQuickAddDrafts: vi.fn(),
}));
vi.mock('./digests.js', () => ({ deliverDigests: mocks.deliverDigests }));
vi.mock('@tracker/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tracker/db')>()),
  giveUpStaleNotifications: mocks.giveUpStaleNotifications,
  deliverOutboxBatches: mocks.deliverOutboxBatches,
  pruneQuickAddDrafts: mocks.pruneQuickAddDrafts,
}));

const { runDeliveryTick } = await import('./delivery.js');
const { silentLogger } = await import('./logger.js');

describe('runDeliveryTick', () => {
  it('still delivers the reminders when the digests fail, and logs the failure', async () => {
    mocks.deliverDigests.mockRejectedValue(new Error('connection lost'));
    mocks.giveUpStaleNotifications.mockResolvedValue(0);
    mocks.deliverOutboxBatches.mockResolvedValue({ delivered: 0, failures: [] });
    const errors: { msg: string; fields?: unknown }[] = [];
    const logger = {
      ...silentLogger,
      error: (msg: string, fields?: unknown) => void errors.push({ msg, fields }),
    };

    await runDeliveryTick({} as never, {} as Api, {
      db: {} as never,
      now: () => new Date('2026-11-02T08:05:00Z'),
      logger,
      publicBaseUrl: undefined,
    });

    expect(mocks.deliverOutboxBatches).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([{ msg: 'digest run failed', fields: { error: 'connection lost' } }]);
  });

  it('sweeps the expired quick-add cards last, and a failing sweep is only a warning', async () => {
    mocks.deliverDigests.mockResolvedValue(0);
    mocks.giveUpStaleNotifications.mockResolvedValue(0);
    mocks.deliverOutboxBatches.mockResolvedValue({ delivered: 0, failures: [] });
    mocks.pruneQuickAddDrafts.mockRejectedValue(new Error('connection lost'));
    const now = new Date('2026-11-02T08:05:00Z');
    const warnings: string[] = [];
    const logger = { ...silentLogger, warn: (msg: string) => void warnings.push(msg) };

    await runDeliveryTick({} as never, {} as Api, {
      db: {} as never,
      now: () => now,
      logger,
      publicBaseUrl: undefined,
    });

    expect(mocks.pruneQuickAddDrafts).toHaveBeenCalledWith({}, { now });
    expect(warnings).toEqual(['quick-add drafts not pruned']);
  });
});
