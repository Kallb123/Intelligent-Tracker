import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { useMembersStore } from './members.js';

const member = (id: string, name: string, awayUntil: string | null = null) => ({
  id,
  name,
  username: name.toLowerCase(),
  email: null,
  role: 'member' as const,
  pending: false,
  awayUntil,
  telegramLinked: false,
});

describe('members store', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('replace swaps in the updated member and keeps the order', () => {
    const store = useMembersStore();
    store.members = [member('a', 'Alex'), member('b', 'Sam')];

    store.replace(member('b', 'Sam', '2026-10-14'));

    expect(store.members.map((m) => [m.id, m.awayUntil])).toEqual([
      ['a', null],
      ['b', '2026-10-14'],
    ]);
    expect(store.byId.get('b')?.awayUntil).toBe('2026-10-14');
  });

  it('replace ignores a member it does not have', () => {
    const store = useMembersStore();
    store.members = [member('a', 'Alex')];

    store.replace(member('zzz', 'Stranger'));

    expect(store.members.map((m) => m.id)).toEqual(['a']);
  });
});
