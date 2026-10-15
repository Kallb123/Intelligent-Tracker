import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, type ComputedRef, type WritableComputedRef } from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { useMembersStore } from '../stores/members.js';
import { usePersonFilter } from './usePersonFilter.js';

const ALEX = '11111111-1111-4111-8111-111111111111';
const SAM = '44444444-4444-4444-8444-444444444444';
const member = (id: string, name: string) => ({
  id,
  name,
  username: name.toLowerCase(),
  email: null,
  role: 'member' as const,
  pending: false,
  awayUntil: null,
  telegramLinked: false,
});

let mounted: ReturnType<typeof mount> | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

/** A page using the filter at `path`, with the members store loaded (or not). */
async function setup(path: string, { loaded = true } = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useMembersStore();
  if (loaded) {
    store.members = [member(ALEX, 'Alex'), member(SAM, 'Sam')];
    store.loaded = true;
  }
  let person!: WritableComputedRef<string>;
  let ready!: ComputedRef<boolean>;
  const Page = defineComponent({
    setup() {
      ({ person, ready } = usePersonFilter());
      return () => null;
    },
  });
  const router: Router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: Page },
      { path: '/other', name: 'other', component: { render: () => null } },
    ],
  });
  await router.push(path);
  await router.isReady();
  mounted = mount(Page, { global: { plugins: [pinia, router] } });
  await flushPromises();
  return {
    person: () => person,
    value: () => person.value,
    ready: () => ready.value,
    router,
    store,
  };
}

describe('usePersonFilter', () => {
  it('starts as everyone', async () => {
    const { value, router } = await setup('/');
    expect(value()).toBe('');
    expect(router.currentRoute.value.query).toEqual({});
  });

  it('takes a member id from the address', async () => {
    const { value, router } = await setup(`/?person=${SAM}`);
    expect(value()).toBe(SAM);
    expect(router.currentRoute.value.query).toEqual({ person: SAM });
  });

  it('writes the choice to the address, keeping other parameters, and removes it for everyone', async () => {
    const { person, router, value } = await setup('/?days=90');

    person().value = ALEX;
    await flushPromises();
    expect(value()).toBe(ALEX);
    expect(router.currentRoute.value.query).toEqual({ days: '90', person: ALEX });

    person().value = '';
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ days: '90' });
  });

  it.each([
    ['an id that is not a member', 'person=99999999-9999-4999-8999-999999999999'],
    ['something that is not an id', 'person=not-a-uuid'],
    ['a repeated parameter', `person=${ALEX}&person=${SAM}`],
  ])('ignores %s and clears it from the address', async (_name, search) => {
    const { value, router } = await setup(`/?${search}&days=30`);
    expect(value()).toBe('');
    expect(router.currentRoute.value.query).toEqual({ days: '30' });
  });

  it('is everyone until the members are known, then checks the address', async () => {
    const { value, router, store } = await setup(`/?person=${SAM}&days=30`, { loaded: false });
    expect(value()).toBe('');
    // Left alone while unverified: it may well be valid.
    expect(router.currentRoute.value.query).toEqual({ person: SAM, days: '30' });

    store.members = [member(ALEX, 'Alex'), member(SAM, 'Sam')];
    store.loaded = true;
    await flushPromises();
    expect(value()).toBe(SAM);
    expect(router.currentRoute.value.query).toEqual({ person: SAM, days: '30' });
  });

  it('is ready at once without a person, and waits for the members when there is one', async () => {
    expect((await setup('/', { loaded: false })).ready()).toBe(true);
    mounted?.unmount();

    const { ready, store } = await setup(`/?person=${SAM}`, { loaded: false });
    expect(ready()).toBe(false);
    store.members = [member(SAM, 'Sam')];
    store.loaded = true;
    await flushPromises();
    expect(ready()).toBe(true);
  });

  it('stops waiting when the members cannot be loaded', async () => {
    const { ready, store } = await setup(`/?person=${SAM}`, { loaded: false });
    store.error = 'down';
    await flushPromises();
    expect(ready()).toBe(true);
  });

  it('drops an unknown id once the members have loaded', async () => {
    const { value, router, store } = await setup('/?person=not-a-uuid', { loaded: false });
    expect(value()).toBe('');

    store.members = [member(ALEX, 'Alex')];
    store.loaded = true;
    await flushPromises();

    expect(value()).toBe('');
    expect(router.currentRoute.value.query).toEqual({});
  });

  it('shows everyone again when the address loses the person', async () => {
    const { value, router } = await setup(`/?person=${SAM}`);
    await router.push('/');
    await flushPromises();
    expect(value()).toBe('');
  });

  it('leaves the next page’s address alone when navigating away', async () => {
    const { router } = await setup(`/?person=${SAM}`);
    await router.push({ name: 'other', query: { x: '1' } });
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/other?x=1');
  });
});
