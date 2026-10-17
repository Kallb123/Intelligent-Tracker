import type { Api } from 'grammy';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deliverDigests: vi.fn(),
  giveUpStaleNotifications: vi.fn(),
  deliverOutboxBatches: vi.fn(),
}));
vi.mock('./digests.js', () => ({ deliverDigests: mocks.deliverDigests }));
vi.mock('@tracker/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tracker/db')>()),
  giveUpStaleNotifications: mocks.giveUpStaleNotifications,
  deliverOutboxBatches: mocks.deliverOutboxBatches,
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
});
