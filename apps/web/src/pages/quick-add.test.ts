import type { MemberDto } from '@tracker/shared';
import { UK_TEMPLATES } from '@tracker/shared';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, fakeServer, json, mountApp, session, type Handler } from '../test-util.js';

// Sunday 11 October 2026, 11:00 in London (BST).
const NOW = '2026-10-11T10:00:00Z';
const ME = '11111111-1111-4111-8111-111111111111';
const SAM = '44444444-4444-4444-8444-444444444444';
const EXAMPLE = 'Car insurance renews 1/11 every year, sort it a month before';

const alex: MemberDto = {
  id: ME,
  name: 'Alex',
  username: 'alex',
  email: null,
  role: 'admin',
  pending: false,
  awayUntil: null,
  telegramLinked: false,
};
const sam: MemberDto = { ...alex, id: SAM, name: 'Sam', username: 'sam', role: 'member' };

const created = { task: { id: '55555555-5555-4555-8555-555555555555' } };
const base: Record<string, Handler> = {
  'GET /api/auth/me': json(session()),
  'GET /api/templates': json({ templates: UK_TEMPLATES }),
  'GET /api/bank-holidays': json({ holidays: [] }),
  'GET /api/members': json({ members: [alex, sam] }),
  'GET /api/occurrences': json({ occurrences: [] }),
  'GET /api/tasks': json({ tasks: [] }),
  'POST /api/tasks': json(created, 201),
};

let mounted: VueWrapper | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

async function open(path: string, handlers: Record<string, Handler> = {}) {
  const server = fakeServer({ ...base, ...handlers });
  const app = await mountApp(server, path);
  mounted = app.wrapper;
  return { ...app, server };
}

const input = (wrapper: VueWrapper) => wrapper.get<HTMLInputElement>('#quick-add-text');
const card = (wrapper: VueWrapper) => wrapper.find('[aria-label="Task preview"]');
const rows = (wrapper: VueWrapper) =>
  Object.fromEntries(
    card(wrapper)
      .findAll('dt')
      .map((dt, i) => [dt.text(), card(wrapper).findAll('dd')[i]?.text()]),
  );
function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find((b) => b.text() === label);
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}

/** Types into the bar and presses Add. */
async function add(wrapper: VueWrapper, text: string) {
  await input(wrapper).setValue(text);
  await wrapper.get('form.quick-add-row').trigger('submit');
  await flushPromises();
}

describe('Quick-add bar', () => {
  it('shows a confirmation card for the worked example and saves nothing yet', async () => {
    const { wrapper, server } = await open('/');
    expect(input(wrapper).attributes('placeholder')).toContain('Car insurance renews 1/11');
    expect(wrapper.get('label[for="quick-add-text"]').text()).toBe('Quick add a task');

    await add(wrapper, EXAMPLE);

    expect(card(wrapper).get('h3').text()).toBe('Car insurance renews');
    expect(rows(wrapper)).toEqual({
      When: 'Sun 1 Nov',
      Repeats: 'Every year on 1 November',
      'Prep starts': '30 days before (Fri 2 Oct)',
      Milestones: 'Get quotes (30 days before), Decide (14 days before), Renew (7 days before)',
      Template: 'Car insurance renewal',
    });
    expect(
      card(wrapper)
        .findAll('mark')
        .map((m) => [m.attributes('data-kind'), m.text()]),
    ).toEqual([
      ['template', 'Car insurance'],
      ['date', '1/11'],
      ['recurrence', 'every year'],
      ['lead', 'sort it a month before'],
    ]);
    expect(server.callsTo('POST /api/tasks')).toHaveLength(0);
  });

  it('does nothing for blank input, and loads templates only when first used', async () => {
    const { wrapper, server } = await open('/');
    expect(button(wrapper, 'Add').attributes('disabled')).toBeDefined();
    await add(wrapper, '   ');
    expect(card(wrapper).exists()).toBe(false);
    expect(server.callsTo('GET /api/templates')).toHaveLength(0);

    await add(wrapper, 'Water the plants every week');
    await add(wrapper, 'Water the plants every week');
    expect(server.callsTo('GET /api/templates')).toHaveLength(1);
  });

  it('saves the parsed task for the signed-in member, then clears and refreshes the list', async () => {
    const { wrapper, server } = await open('/');
    await add(wrapper, EXAMPLE);
    const listed = server.callsTo('GET /api/occurrences').length;

    await button(wrapper, 'Save').trigger('click');
    await flushPromises();

    const [post] = server.callsTo('POST /api/tasks');
    expect(post?.body).toMatchObject({
      title: 'Car insurance renews',
      scheduleKind: 'fixed',
      rrule: 'FREQ=YEARLY;INTERVAL=1;BYMONTH=11;BYMONTHDAY=1',
      dueDate: '2026-11-01',
      leadTimeDays: 30,
      reminderProfile: 'standard',
      assigneeIds: [ME],
      milestones: [
        { title: 'Get quotes', offsetDaysBeforeDue: 30 },
        { title: 'Decide', offsetDaysBeforeDue: 14 },
        { title: 'Renew', offsetDaysBeforeDue: 7 },
      ],
    });
    expect(post?.headers.get('x-csrf-token')).toBe('csrf-abc');
    expect(card(wrapper).exists()).toBe(false);
    expect(input(wrapper).element.value).toBe('');
    expect(server.callsTo('GET /api/occurrences').length).toBe(listed + 1);
  });

  it('assigns whoever is named with @Name instead of the signed-in member', async () => {
    const { wrapper, server } = await open('/');
    await add(wrapper, 'Put the bins out every Monday @Sam');
    expect(rows(wrapper)['For']).toBe('Sam');

    await button(wrapper, 'Save').trigger('click');
    await flushPromises();
    expect(server.callsTo('POST /api/tasks')[0]?.body).toMatchObject({ assigneeIds: [SAM] });
  });

  it('posts nothing on Cancel, and keeps the text to adjust', async () => {
    const { wrapper, server } = await open('/');
    await add(wrapper, EXAMPLE);

    await button(wrapper, 'Cancel').trigger('click');

    expect(card(wrapper).exists()).toBe(false);
    expect(input(wrapper).element.value).toBe(EXAMPLE);
    expect(server.callsTo('POST /api/tasks')).toHaveLength(0);
  });

  it('shows what the api says when saving fails, and keeps the preview', async () => {
    const { wrapper } = await open('/', {
      'POST /api/tasks': apiError(422, 'invalid', 'Title is too long'),
    });
    await add(wrapper, EXAMPLE);

    await button(wrapper, 'Save').trigger('click');
    await flushPromises();

    expect(wrapper.get('.quick-add [role="alert"]').text()).toContain('Title is too long');
    expect(card(wrapper).exists()).toBe(true);
    expect(input(wrapper).element.value).toBe(EXAMPLE);
  });

  it('says so, and opens no preview, when the household’s members cannot be loaded', async () => {
    const { wrapper } = await open('/', {
      'GET /api/members': apiError(500, 'server_error', 'Members are unavailable'),
    });

    await add(wrapper, 'Put the bins out every Monday @Sam');

    expect(wrapper.get('.quick-add [role="alert"]').text()).toContain('Members are unavailable');
    expect(card(wrapper).exists()).toBe(false);
    expect(input(wrapper).element.value).toBe('Put the bins out every Monday @Sam');
  });

  it('shows an error instead of throwing when the parsed task cannot go in the editor', async () => {
    const broken = {
      id: 'broken',
      title: 'Broken',
      keywords: ['zzz'],
      builtIn: false,
      defaults: { leadTimeDays: 99_999 },
    };
    const { wrapper, router } = await open('/', {
      'GET /api/templates': json({ templates: [broken] }),
    });
    await add(wrapper, 'zzz');

    await button(wrapper, 'Edit details').trigger('click');
    await flushPromises();

    expect(wrapper.get('.quick-add [role="alert"]').text()).toContain('cannot be opened');
    expect(router.currentRoute.value.name).not.toBe('task-new');
    expect(card(wrapper).exists()).toBe(true);
  });

  it('keeps the preview in step with the text, and closes it when the text is cleared', async () => {
    const { wrapper } = await open('/');
    await add(wrapper, 'Water the plants every week');
    expect(rows(wrapper)['Repeats']).toBe('Every week on Sunday');

    await input(wrapper).setValue('Water the plants every fortnight @Sam');
    expect(card(wrapper).get('h3').text()).toBe('Water the plants');
    expect(rows(wrapper)['Repeats']).toBe('Every 2 weeks on Sunday');
    expect(rows(wrapper)['For']).toBe('Sam');

    await input(wrapper).setValue('');
    expect(card(wrapper).exists()).toBe(false);
  });

  it('opens the task editor prefilled with the parsed task, once', async () => {
    const { wrapper, router, server } = await open('/');
    await add(wrapper, EXAMPLE);

    await button(wrapper, 'Edit details').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('task-new'));
    await flushPromises();

    expect(wrapper.get<HTMLInputElement>('#task-title').element.value).toBe('Car insurance renews');
    expect(wrapper.get<HTMLInputElement>('#task-due-date').element.value).toBe('2026-11-01');
    expect(wrapper.get<HTMLSelectElement>('#repeat-kind').element.value).toBe('yearly');
    expect(wrapper.get<HTMLInputElement>('#task-lead').element.value).toBe('30');
    expect(wrapper.get<HTMLSelectElement>('#task-assignee').element.value).toBe(ME);
    expect(server.callsTo('POST /api/tasks')).toHaveLength(0);

    // A later New task starts blank again.
    await router.push('/tasks');
    await router.push({ name: 'task-new' });
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.find('#task-title').exists()).toBe(true));
    expect(wrapper.get<HTMLInputElement>('#task-title').element.value).toBe('');
    expect(wrapper.get<HTMLInputElement>('#task-due-date').element.value).toBe('2026-10-11');
  });

  it('is on All tasks too, and refreshes that list after saving', async () => {
    const { wrapper, server } = await open('/tasks');
    const listed = server.callsTo('GET /api/tasks').length;

    await add(wrapper, 'Water the plants every week');
    await button(wrapper, 'Save').trigger('click');
    await flushPromises();

    expect(server.callsTo('POST /api/tasks')).toHaveLength(1);
    expect(server.callsTo('GET /api/tasks').length).toBe(listed + 1);
  });
});

describe('Quick-add link from Telegram', () => {
  it('opens the preview for ?quickAdd, then drops it from the address', async () => {
    const { wrapper, router, server } = await open(`/?quickAdd=${encodeURIComponent(EXAMPLE)}`);

    expect(input(wrapper).element.value).toBe(EXAMPLE);
    expect(card(wrapper).get('h3').text()).toBe('Car insurance renews');
    expect(rows(wrapper)['When']).toBe('Sun 1 Nov');
    expect(router.currentRoute.value.query).toEqual({});
    expect(router.currentRoute.value.fullPath).toBe('/');
    expect(server.callsTo('POST /api/tasks')).toHaveLength(0);
  });

  it('shows nothing extra for an empty parameter', async () => {
    const { wrapper, router } = await open('/?quickAdd=');
    expect(card(wrapper).exists()).toBe(false);
    expect(router.currentRoute.value.query).toEqual({});
  });
});
