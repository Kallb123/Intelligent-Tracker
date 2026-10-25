import type { MemberDto, OccurrenceDto, TaskDto } from '@tracker/shared';
import { UK_TEMPLATES } from '@tracker/shared';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiError,
  fakeServer,
  json,
  mountApp,
  session,
  type Call,
  type Handler,
} from '../test-util.js';

// Sunday 11 October 2026, 11:00 in London (BST).
const NOW = '2026-10-11T10:00:00Z';
const ME = '11111111-1111-4111-8111-111111111111';
const SAM = '44444444-4444-4444-8444-444444444444';
const TASK_ID = '55555555-5555-4555-8555-555555555555';

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

let counter = 0;
function occurrence(title: string, overrides: Partial<OccurrenceDto> = {}): OccurrenceDto {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    taskId: TASK_ID,
    task: { title, category: null, priority: 0, allDay: true, scheduleKind: 'fixed' },
    dueDate: '2026-10-11',
    dueAt: null,
    startAt: null,
    assigneeId: null,
    status: 'active',
    completedAt: null,
    completedBy: null,
    snoozedUntil: null,
    overdue: false,
    ...overrides,
  };
}

function task(overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id: TASK_ID,
    title: 'Put the bins out',
    notes: '',
    category: null,
    tags: [],
    priority: 0,
    reminderSlot: 'evening',
    reminderCustomTime: null,
    effortMinutes: null,
    scheduleKind: 'fixed',
    allDay: true,
    dueDate: '2026-10-12',
    dueAt: null,
    rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO',
    intervalAfterCompletionDays: null,
    workingDaysOnly: false,
    remindOffsetDays: 0,
    leadTimeDays: null,
    reminderProfile: 'standard',
    assignmentMode: 'fixed',
    assigneeIds: [ME],
    nextAssigneeId: ME,
    nextDue: null,
    milestones: [],
    archived: false,
    archivedAt: null,
    createdBy: ME,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

const base: Record<string, Handler> = {
  'GET /api/auth/me': json(session()),
  'GET /api/templates': json({ templates: [] }),
  'GET /api/bank-holidays': json({ holidays: [] }),
  'GET /api/members': json({ members: [alex, sam] }),
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

async function open(handlers: Record<string, Handler>, path: string) {
  const server = fakeServer({ ...base, ...handlers });
  const app = await mountApp(server, path);
  mounted = app.wrapper;
  return { ...app, server };
}

const texts = (wrapper: VueWrapper, selector: string) =>
  wrapper.findAll(selector).map((e) => e.text());

function button(wrapper: VueWrapper, name: string) {
  const found = wrapper.findAll('button').find((b) => b.attributes('aria-label') === name);
  if (!found) throw new Error(`No button named "${name}"`);
  return found;
}

/** The body of the last call to `key`, which must exist. */
function lastBody(server: ReturnType<typeof fakeServer>, key: string): unknown {
  const calls = server.callsTo(key);
  return calls[calls.length - 1]?.body;
}

describe('Today', () => {
  const overdue = occurrence('File the tax return', {
    dueDate: '2026-10-05',
    overdue: true,
    assigneeId: SAM,
  });
  const mine = occurrence('Put the bins out', { assigneeId: ME });
  const theirs = occurrence('Water the plants', { assigneeId: SAM });
  const nobody = occurrence('Check the post');

  it('shows overdue items first, then today grouped by person', async () => {
    const { wrapper } = await open(
      { 'GET /api/occurrences': json({ occurrences: [overdue, mine, theirs, nobody] }) },
      '/',
    );

    expect(wrapper.find('h1').text()).toBe('Today');
    expect(texts(wrapper, 'h2')).toEqual(['Overdue', 'Alex (you)', 'Sam', 'Anyone']);
    expect(texts(wrapper, 'li.occurrence .occurrence-title')).toEqual([
      'File the tax return',
      'Put the bins out',
      'Water the plants',
      'Check the post',
    ]);
    const first = wrapper.find('li.occurrence');
    expect(first.text()).toContain('Overdue, was due Mon 5 Oct');
    expect(first.text()).toContain('Sam');
    expect(wrapper.text()).toContain('Sun 11 Oct 2026');
  });

  it('asks the api for the today view', async () => {
    const { server } = await open({ 'GET /api/occurrences': json({ occurrences: [] }) }, '/');
    expect(server.callsTo('GET /api/occurrences').map((c) => c.search)).toEqual(['view=today']);
  });

  it('filters by person, and keeps the choice in the address', async () => {
    const { wrapper, server, router } = await open(
      {
        'GET /api/occurrences': (call) =>
          json({
            occurrences: call.search.includes(`memberId=${SAM}`) ? [theirs] : [mine, theirs],
          }),
      },
      '/',
    );
    expect(texts(wrapper, '#filter-person option')).toEqual(['Everyone', 'Alex', 'Sam']);

    await wrapper.get('#filter-person').setValue(SAM);
    await flushPromises();

    expect(server.callsTo('GET /api/occurrences').map((c) => c.search)).toEqual([
      'view=today',
      `view=today&memberId=${SAM}`,
    ]);
    expect(texts(wrapper, '.occurrence-title')).toEqual(['Water the plants']);
    expect(router.currentRoute.value.query).toEqual({ person: SAM });

    await wrapper.get('#filter-person').setValue('');
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({});
    expect(texts(wrapper, '.occurrence-title')).toEqual(['Put the bins out', 'Water the plants']);
  });

  it('starts filtered when the address names a person, and says when they have nothing', async () => {
    const { wrapper, server } = await open(
      { 'GET /api/occurrences': json({ occurrences: [] }) },
      `/?person=${SAM}`,
    );

    // The page waits for the household before asking, so there is no unfiltered first request.
    expect(server.callsTo('GET /api/occurrences').map((c) => c.search)).toEqual([
      `view=today&memberId=${SAM}`,
    ]);
    expect((wrapper.get('#filter-person').element as HTMLSelectElement).value).toBe(SAM);
    expect(wrapper.text()).toContain('Nothing is due today for Sam.');
  });

  it('ignores an unknown person in the address without asking for them', async () => {
    const { server, router } = await open(
      { 'GET /api/occurrences': json({ occurrences: [] }) },
      '/upcoming?person=nobody&days=30',
    );

    expect(server.callsTo('GET /api/occurrences').map((c) => c.search)).toEqual([
      'view=upcoming&days=30',
    ]);
    expect(router.currentRoute.value.query).toEqual({ days: '30' });
  });

  it('shows everyone again when navigating to the plain page', async () => {
    const { wrapper, router } = await open(
      { 'GET /api/occurrences': json({ occurrences: [] }) },
      `/?person=${SAM}`,
    );

    await router.push('/');
    await flushPromises();

    expect((wrapper.get('#filter-person').element as HTMLSelectElement).value).toBe('');
  });

  it('names the row buttons after the task', async () => {
    const { wrapper } = await open({ 'GET /api/occurrences': json({ occurrences: [mine] }) }, '/');

    const row = wrapper.get('li');
    expect(row.find('button[aria-label="Complete Put the bins out"]').text()).toBe('Complete');
    expect(row.find('button[aria-label="Snooze Put the bins out"]').exists()).toBe(true);
    expect(row.find('button[aria-label="Start Put the bins out"]').exists()).toBe(true);
  });

  it('completes an item and refreshes the list', async () => {
    let open_ = [mine, nobody];
    const { wrapper, server } = await open(
      {
        'GET /api/occurrences': () => json({ occurrences: open_ }),
        [`POST /api/occurrences/${mine.id}/complete`]: () => {
          open_ = [nobody];
          return json({ occurrence: { ...mine, status: 'done' }, next: null });
        },
      },
      '/',
    );
    expect(texts(wrapper, '.occurrence-title')).toEqual(['Put the bins out', 'Check the post']);

    await button(wrapper, 'Complete Put the bins out').trigger('click');
    await flushPromises();

    expect(server.callsTo(`POST /api/occurrences/${mine.id}/complete`)).toHaveLength(1);
    expect(server.callsTo('GET /api/occurrences')).toHaveLength(2);
    expect(texts(wrapper, '.occurrence-title')).toEqual(['Check the post']);
    expect(server.calls.find((c) => c.method === 'POST')?.headers.get('x-csrf-token')).toBe(
      'csrf-abc',
    );
  });

  it('starts an item', async () => {
    let state = mine;
    const { wrapper, server } = await open(
      {
        'GET /api/occurrences': () => json({ occurrences: [state] }),
        [`POST /api/occurrences/${mine.id}/start`]: () => {
          state = { ...mine, status: 'started' };
          return json({ occurrence: state });
        },
      },
      '/',
    );

    await button(wrapper, 'Start Put the bins out').trigger('click');
    await flushPromises();

    expect(server.callsTo(`POST /api/occurrences/${mine.id}/start`)).toHaveLength(1);
    expect(wrapper.get('li').text()).toContain('Started');
    // Nothing left to start.
    expect(wrapper.find('button[aria-label="Start Put the bins out"]').exists()).toBe(false);
  });

  it('snoozes an item from the menu', async () => {
    let list = [mine];
    const { wrapper, server } = await open(
      {
        'GET /api/occurrences': () => json({ occurrences: list }),
        [`POST /api/occurrences/${mine.id}/snooze`]: () => {
          list = [];
          return json({ occurrence: mine });
        },
      },
      '/',
    );

    await button(wrapper, 'Snooze Put the bins out').trigger('click');
    await flushPromises();
    const choices = [...document.body.querySelectorAll('.p-menu-item-link')];
    expect(choices.map((c) => c.textContent?.trim())).toEqual(['1 day', '3 days', '1 week']);

    (choices[1] as HTMLElement).click();
    await flushPromises();

    expect(lastBody(server, `POST /api/occurrences/${mine.id}/snooze`)).toEqual({ days: 3 });
    expect(wrapper.find('li').exists()).toBe(false);
    expect(wrapper.text()).toContain('Nothing is due today');
  });

  it('shows the error when an action fails, and still refreshes', async () => {
    const { wrapper, server } = await open(
      {
        'GET /api/occurrences': json({ occurrences: [mine] }),
        [`POST /api/occurrences/${mine.id}/complete`]: apiError(
          409,
          'occurrence_closed',
          'That occurrence is already done',
        ),
      },
      '/',
    );

    await button(wrapper, 'Complete Put the bins out').trigger('click');
    await flushPromises();

    expect(wrapper.find('[role="alert"]').text()).toBe('That occurrence is already done');
    expect(server.callsTo('GET /api/occurrences')).toHaveLength(2);
    // The button is usable again.
    expect(button(wrapper, 'Complete Put the bins out').attributes('disabled')).toBeUndefined();
  });

  it('has an empty state', async () => {
    const { wrapper } = await open({ 'GET /api/occurrences': json({ occurrences: [] }) }, '/');

    expect(wrapper.text()).toContain('Nothing is due today');
    expect(wrapper.find('li').exists()).toBe(false);
  });

  it('offers a retry when the list cannot be loaded', async () => {
    let up = false;
    const { wrapper } = await open(
      {
        'GET /api/occurrences': () =>
          up ? json({ occurrences: [mine] }) : apiError(500, 'internal', 'Something broke'),
      },
      '/',
    );
    expect(wrapper.find('[role="alert"]').text()).toContain('Something broke');

    up = true;
    await wrapper.find('[role="alert"] button').trigger('click');
    await flushPromises();

    expect(texts(wrapper, '.occurrence-title')).toEqual(['Put the bins out']);
  });
});

describe('Coming up', () => {
  const tomorrow = occurrence('Take the car in', {
    dueDate: '2026-10-12',
    assigneeId: ME,
    startAt: '2026-10-08T23:00:00.000Z',
  });
  const later = occurrence('Pay car tax', { dueDate: '2026-10-30', assigneeId: SAM });
  const timed = occurrence('Dentist', {
    task: {
      title: 'Dentist',
      category: 'Health',
      priority: 0,
      allDay: false,
      scheduleKind: 'once',
    },
    dueDate: null,
    dueAt: '2026-10-30T14:30:00.000Z',
  });

  it('groups by date with the prep window and times', async () => {
    const { wrapper } = await open(
      { 'GET /api/occurrences': json({ occurrences: [tomorrow, later, timed] }) },
      '/upcoming',
    );

    expect(wrapper.find('h1').text()).toBe('Coming up');
    expect(texts(wrapper, 'h2')).toEqual(['Mon 12 Oct', 'Fri 30 Oct']);
    const rows = wrapper.findAll('li.occurrence');
    expect(rows[0]?.text()).toContain('Prep started Fri 9 Oct');
    expect(rows[2]?.text()).toContain('Due at 14:30');
    expect(rows[2]?.text()).toContain('Health');
  });

  it('switches between 30 and 90 days', async () => {
    const seen: string[] = [];
    const { wrapper } = await open(
      {
        'GET /api/occurrences': (call: Call) => {
          seen.push(call.search);
          return json({ occurrences: [] });
        },
      },
      '/upcoming',
    );
    expect(wrapper.text()).toContain('Nothing is due in the next 30 days');
    const pressed = () => wrapper.findAll('[aria-pressed="true"]').map((b) => b.text());
    expect(pressed()).toEqual(['30 days']);

    await wrapper
      .findAll('button')
      .find((b) => b.text() === '90 days')
      ?.trigger('click');
    await flushPromises();

    expect(pressed()).toEqual(['90 days']);
    expect(seen).toEqual(['view=upcoming&days=30', 'view=upcoming&days=90']);
    expect(wrapper.text()).toContain('Nothing is due in the next 90 days');
  });

  it('filters by person and keeps the days', async () => {
    const { wrapper, server, router } = await open(
      { 'GET /api/occurrences': json({ occurrences: [] }) },
      '/upcoming',
    );

    await wrapper.get('#filter-person').setValue(SAM);
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '90 days')
      ?.trigger('click');
    await flushPromises();

    expect(server.callsTo('GET /api/occurrences').map((c) => c.search)).toEqual([
      'view=upcoming&days=30',
      `view=upcoming&days=30&memberId=${SAM}`,
      `view=upcoming&days=90&memberId=${SAM}`,
    ]);
    expect(router.currentRoute.value.query).toEqual({ person: SAM });
    expect(wrapper.text()).toContain('Nothing is due for Sam in the next 90 days');
  });

  it('completes and snoozes from the list', async () => {
    let list = [tomorrow, later];
    const { wrapper, server } = await open(
      {
        'GET /api/occurrences': () => json({ occurrences: list }),
        [`POST /api/occurrences/${tomorrow.id}/complete`]: () => {
          list = [later];
          return json({ occurrence: tomorrow, next: null });
        },
        [`POST /api/occurrences/${later.id}/snooze`]: () => json({ occurrence: later }),
      },
      '/upcoming',
    );

    await button(wrapper, 'Complete Take the car in').trigger('click');
    await flushPromises();
    expect(texts(wrapper, '.occurrence-title')).toEqual(['Pay car tax']);

    await button(wrapper, 'Snooze Pay car tax').trigger('click');
    await flushPromises();
    (document.body.querySelectorAll('.p-menu-item-link')[2] as HTMLElement).click();
    await flushPromises();
    expect(lastBody(server, `POST /api/occurrences/${later.id}/snooze`)).toEqual({ days: 7 });
  });
});

describe('All tasks', () => {
  const tasks = [
    task({
      id: 'a0000000-0000-4000-8000-000000000001',
      title: 'Put the bins out',
      category: 'Home',
      tags: ['weekly'],
      nextDue: '2026-10-11T23:00:00.000Z',
    }),
    task({
      id: 'a0000000-0000-4000-8000-000000000002',
      title: 'Descale kettle',
      notes: 'Use vinegar',
      category: 'Kitchen',
      tags: ['descale'],
      scheduleKind: 'after_completion',
      rrule: null,
      intervalAfterCompletionDays: 42,
      assigneeIds: [SAM],
      nextDue: '2026-10-14T23:00:00.000Z',
      createdAt: '2026-10-05T10:00:00.000Z',
    }),
    task({
      id: 'a0000000-0000-4000-8000-000000000003',
      title: 'Renew passport',
      scheduleKind: 'once',
      rrule: null,
      dueDate: '2026-11-01',
      assigneeIds: [],
      assignmentMode: 'any',
      createdAt: '2026-10-08T10:00:00.000Z',
    }),
  ];
  const titles = (wrapper: VueWrapper) => texts(wrapper, '.task-title');
  beforeEach(() => localStorage.clear());

  it('lists tasks with a description of their schedule', async () => {
    const { wrapper } = await open({ 'GET /api/tasks': json({ tasks }) }, '/tasks');

    expect(wrapper.find('h1').text()).toBe('All tasks');
    expect(titles(wrapper)).toEqual(['Put the bins out', 'Descale kettle', 'Renew passport']);
    const rows = texts(wrapper, '.task-row');
    expect(rows[0]).toContain('Every week on Monday');
    expect(rows[0]).toContain('For Alex');
    expect(rows[1]).toContain("Every 6 weeks after it's done");
    expect(rows[1]).toContain('For Sam');
    expect(rows[2]).toContain('Once, 1 Nov 2026');
    expect(rows[2]).toContain('For anyone');
    expect(wrapper.find('.task-title').attributes('href')).toBe(`/tasks/${tasks[0]?.id}`);
  });

  it('orders by next due by default, with undated tasks last, and shows the date', async () => {
    const [bins, kettle, passport] = tasks;
    const { wrapper } = await open(
      { 'GET /api/tasks': json({ tasks: [passport, kettle, bins] }) },
      '/tasks',
    );

    expect(titles(wrapper)).toEqual(['Put the bins out', 'Descale kettle', 'Renew passport']);
    expect(texts(wrapper, '#task-sort option')).toEqual([
      'Next due',
      'Next milestone or due',
      'Title (A–Z)',
      'Priority',
      'Newest first',
    ]);
    expect(wrapper.find('label[for="task-sort"]').text()).toBe('Sort by');
    const rows = texts(wrapper, '.task-row');
    expect(rows[0]).toContain('Next due tomorrow');
    expect(rows[1]).toContain('Next due Thu 15 Oct');
    expect(rows[2]).not.toContain('Next due');
  });

  it('shows the next milestone alongside the next due date', async () => {
    const withMilestones = task({
      ...tasks[1],
      milestones: [
        {
          id: 'b0000000-0000-4000-8000-000000000001',
          title: 'Buy descaler',
          offsetDaysBeforeDue: 4,
        },
        {
          id: 'b0000000-0000-4000-8000-000000000002',
          title: 'Order filters',
          offsetDaysBeforeDue: 2,
        },
        { id: 'b0000000-0000-4000-8000-000000000003', title: 'Too late', offsetDaysBeforeDue: 10 },
      ],
    });
    const { wrapper } = await open(
      { 'GET /api/tasks': json({ tasks: [tasks[0], withMilestones] }) },
      '/tasks',
    );

    const rows = texts(wrapper, '.task-row');
    expect(rows[0]).not.toContain('Next milestone');
    expect(rows[1]).toContain('Next due Thu 15 Oct');
    expect(rows[1]).toContain('Next milestone: Buy descaler, today');
  });

  it('sorts by the next milestone or due date', async () => {
    const [bins, kettle, passport] = tasks;
    const kettleWithMilestone = task({
      ...kettle,
      milestones: [
        {
          id: 'b0000000-0000-4000-8000-000000000001',
          title: 'Buy descaler',
          offsetDaysBeforeDue: 4,
        },
      ],
    });
    const { wrapper } = await open(
      { 'GET /api/tasks': json({ tasks: [bins, kettleWithMilestone, passport] }) },
      '/tasks',
    );
    expect(titles(wrapper)).toEqual(['Put the bins out', 'Descale kettle', 'Renew passport']);

    await wrapper.get('#task-sort').setValue('milestone');

    expect(titles(wrapper)).toEqual(['Descale kettle', 'Put the bins out', 'Renew passport']);
    expect(localStorage.getItem('tracker.tasks.sort')).toBe('milestone');
  });

  it('reorders when the sort changes, and remembers the choice', async () => {
    const [bins, kettle, passport] = tasks;
    const { wrapper } = await open(
      { 'GET /api/tasks': json({ tasks: [bins, kettle, passport] }) },
      '/tasks',
    );

    await wrapper.get('#task-sort').setValue('title');
    expect(titles(wrapper)).toEqual(['Descale kettle', 'Put the bins out', 'Renew passport']);
    expect(localStorage.getItem('tracker.tasks.sort')).toBe('title');

    await wrapper.get('#task-sort').setValue('newest');
    expect(titles(wrapper)).toEqual(['Renew passport', 'Descale kettle', 'Put the bins out']);
    mounted?.unmount();

    const again = await open(
      { 'GET /api/tasks': json({ tasks: [bins, kettle, passport] }) },
      '/tasks',
    );
    expect(again.wrapper.get('#task-sort').element).toHaveProperty('value', 'newest');
    expect(titles(again.wrapper)).toEqual(['Renew passport', 'Descale kettle', 'Put the bins out']);
  });

  it('sorts the filtered tasks', async () => {
    const { wrapper } = await open({ 'GET /api/tasks': json({ tasks }) }, '/tasks');
    await wrapper.get('#task-sort').setValue('title');
    await wrapper.get('#task-search').setValue('e');
    expect(titles(wrapper)).toEqual(['Descale kettle', 'Put the bins out', 'Renew passport']);
    await wrapper.get('#task-search').setValue('weekly');
    expect(titles(wrapper)).toEqual(['Put the bins out']);
  });

  it('shows whose turn it is on rotation tasks', async () => {
    const rotating = task({
      title: 'Clean the bathroom',
      assignmentMode: 'rotation',
      assigneeIds: [ME, SAM],
      nextAssigneeId: SAM,
    });
    const { wrapper } = await open(
      { 'GET /api/tasks': json({ tasks: [...tasks, rotating] }) },
      '/tasks',
    );

    const rows = texts(wrapper, '.task-row');
    const rotatingRow = rows.find((row) => row.includes('Clean the bathroom'));
    expect(rotatingRow).toContain('For Alex, Sam');
    expect(rotatingRow).toContain('Next: Sam');
    expect(rows.filter((row) => row.includes('Next:'))).toHaveLength(1);
  });

  it('starts with the person from the address and writes changes back', async () => {
    const { wrapper, router } = await open(
      { 'GET /api/tasks': json({ tasks }) },
      `/tasks?person=${SAM}`,
    );
    expect(titles(wrapper)).toEqual(['Descale kettle']);

    await wrapper.get('#filter-person').setValue('');
    await flushPromises();

    expect(router.currentRoute.value.query).toEqual({});
    expect(titles(wrapper)).toHaveLength(3);
  });

  it('searches title, notes, category and tags', async () => {
    const { wrapper } = await open({ 'GET /api/tasks': json({ tasks }) }, '/tasks');
    const search = wrapper.get('#task-search');

    await search.setValue('vinegar');
    expect(titles(wrapper)).toEqual(['Descale kettle']);
    await search.setValue('HOME');
    expect(titles(wrapper)).toEqual(['Put the bins out']);
    await search.setValue('weekly');
    expect(titles(wrapper)).toEqual(['Put the bins out']);
    await search.setValue('passport');
    expect(titles(wrapper)).toEqual(['Renew passport']);
    await search.setValue('zzz');
    expect(wrapper.text()).toContain('No tasks match these filters');
  });

  it('filters by person, category and tag', async () => {
    const { wrapper } = await open({ 'GET /api/tasks': json({ tasks }) }, '/tasks');

    await wrapper.get('#filter-person').setValue(SAM);
    expect(titles(wrapper)).toEqual(['Descale kettle']);
    await wrapper.get('#filter-person').setValue('');

    expect(texts(wrapper, '#filter-category option')).toEqual([
      'All categories',
      'Home',
      'Kitchen',
    ]);
    await wrapper.get('#filter-category').setValue('Home');
    expect(titles(wrapper)).toEqual(['Put the bins out']);
    await wrapper.get('#filter-category').setValue('');

    expect(texts(wrapper, '#filter-tag option')).toEqual(['All tags', 'descale', 'weekly']);
    await wrapper.get('#filter-tag').setValue('descale');
    expect(titles(wrapper)).toEqual(['Descale kettle']);
  });

  it('shows archived tasks on request', async () => {
    const archived = task({ title: 'Old chore', archived: true });
    const { wrapper, server } = await open(
      {
        'GET /api/tasks': (call) =>
          json({ tasks: call.search.includes('archived=true') ? [archived] : tasks }),
      },
      '/tasks',
    );
    expect(server.callsTo('GET /api/tasks').map((c) => c.search)).toEqual(['archived=false']);

    await wrapper.get('#show-archived').setValue(true);
    await flushPromises();

    expect(server.callsTo('GET /api/tasks').map((c) => c.search)).toEqual([
      'archived=false',
      'archived=true',
    ]);
    expect(titles(wrapper)).toEqual(['Old chore']);
    expect(wrapper.get('.task-row').text()).toContain('Archived');
  });

  it('has an empty state and a New task button', async () => {
    const { wrapper, router } = await open({ 'GET /api/tasks': json({ tasks: [] }) }, '/tasks');
    expect(wrapper.text()).toContain('No tasks yet');

    const newTask = wrapper.findAll('button').find((b) => b.text() === 'New task');
    await newTask?.trigger('click');

    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('task-new'));
  });
});

describe('Task editor', () => {
  const fillTitle = (wrapper: VueWrapper, title: string) =>
    wrapper.get('#task-title').setValue(title);
  const save = async (wrapper: VueWrapper) => {
    await wrapper.get('form').trigger('submit');
    await flushPromises();
  };
  const previewDates = (wrapper: VueWrapper) => texts(wrapper, '.preview ol li');

  it('suggests a template without applying it, then saves explicitly accepted milestones', async () => {
    const { wrapper, server } = await open(
      {
        'GET /api/templates': json({ templates: UK_TEMPLATES }),
        'POST /api/tasks': json({ task: task() }, 201),
        'GET /api/tasks': json({ tasks: [] }),
      },
      '/tasks/new',
    );
    await fillTitle(wrapper, 'Renew car insurance');
    expect(wrapper.get('#task-lead').element).toHaveProperty('value', '');
    const suggested = wrapper.findAll('button').find((b) => b.text() === 'Car insurance renewal');
    expect(suggested).toBeDefined();
    await suggested!.trigger('click');
    expect(wrapper.get('#task-lead').element).toHaveProperty('value', '');
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Apply template')!
      .trigger('click');
    expect(wrapper.get('#task-lead').element).toHaveProperty('value', '30');
    await save(wrapper);
    expect(lastBody(server, 'POST /api/tasks')).toMatchObject({
      title: 'Renew car insurance',
      leadTimeDays: 30,
      milestones: [
        { title: 'Get quotes', offsetDaysBeforeDue: 30 },
        { title: 'Decide', offsetDaysBeforeDue: 14 },
        { title: 'Renew', offsetDaysBeforeDue: 7 },
      ],
    });
  });

  it('labels its controls for assistive technology', async () => {
    const { wrapper } = await open({}, '/tasks/new');
    await wrapper.get('#repeat-kind').setValue('weekly');

    const labelled = (id: string) => wrapper.find(`label[for="${id}"]`).text();
    expect(wrapper.find('h1').text()).toBe('New task');
    expect(labelled('task-title')).toBe('Title');
    expect(labelled('repeat-kind')).toBe('Repeats');
    expect(texts(wrapper, '#repeat-kind option')).toContain('Weekly');
    expect(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].map((d) => labelled(`weekday-${d}`))).toEqual(
      ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
    );
    expect(wrapper.find('h3').text()).toBe('Next 5 dates');
    expect(
      wrapper
        .findAll('button')
        .some((b) => b.text() === 'Save task' && b.attributes('type') === 'submit'),
    ).toBe(true);
  });

  it('starts as an all-day one-off due today for the current member', async () => {
    const { wrapper } = await open({}, '/tasks/new');

    expect((wrapper.get('#task-due-date').element as HTMLInputElement).value).toBe('2026-10-11');
    expect((wrapper.get('#task-all-day').element as HTMLInputElement).checked).toBe(true);
    expect((wrapper.get('#repeat-kind').element as HTMLSelectElement).value).toBe('once');
    expect((wrapper.get('#task-slot').element as HTMLSelectElement).value).toBe('evening');
    expect((wrapper.get('#task-mode').element as HTMLSelectElement).value).toBe('fixed');
    expect((wrapper.get('#task-assignee').element as HTMLSelectElement).value).toBe(ME);
    expect(previewDates(wrapper)).toEqual(['Sun 11 Oct 2026']);
  });

  it('builds a weekly RRULE, previews the next five dates and creates the task', async () => {
    const created = task();
    const { wrapper, router, server } = await open(
      { 'POST /api/tasks': () => json({ task: created }, 201) },
      '/tasks/new',
    );

    await fillTitle(wrapper, 'Put the bins out');
    await wrapper.get('#repeat-kind').setValue('weekly');
    // No weekday yet: the preview says so rather than showing dates.
    expect(wrapper.get('.preview').text()).toContain('Pick at least one weekday');
    expect(previewDates(wrapper)).toEqual([]);

    await wrapper.get('#weekday-MO').setValue(true);
    expect(previewDates(wrapper)).toEqual([
      'Mon 12 Oct 2026',
      'Mon 19 Oct 2026',
      'Mon 26 Oct 2026',
      'Mon 2 Nov 2026',
      'Mon 9 Nov 2026',
    ]);

    await save(wrapper);

    expect(lastBody(server, 'POST /api/tasks')).toEqual({
      title: 'Put the bins out',
      workingDaysOnly: false,
      remindOffsetDays: 0,
      notes: '',
      category: null,
      tags: [],
      priority: 0,
      effortMinutes: null,
      reminderSlot: 'evening',
      reminderCustomTime: null,
      scheduleKind: 'fixed',
      allDay: true,
      dueDate: '2026-10-11',
      dueAt: null,
      rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO',
      intervalAfterCompletionDays: null,
      leadTimeDays: null,
      assignmentMode: 'fixed',
      assigneeIds: [ME],
      milestones: [],
    });
    expect(router.currentRoute.value.name).toBe('tasks');
  });

  it('updates the preview as the pattern changes', async () => {
    const { wrapper } = await open({}, '/tasks/new');

    await wrapper.get('#repeat-kind').setValue('daily');
    await wrapper.get('#repeat-interval').setValue('3');
    expect(previewDates(wrapper).slice(0, 3)).toEqual([
      'Sun 11 Oct 2026',
      'Wed 14 Oct 2026',
      'Sat 17 Oct 2026',
    ]);

    await wrapper.get('#repeat-kind').setValue('monthly');
    await wrapper.get('#repeat-interval').setValue('1');
    await wrapper.get('#last-day').setValue(true);
    await wrapper.get('#task-due-date').setValue('2026-10-01');
    expect(previewDates(wrapper).slice(0, 2)).toEqual(['Sat 31 Oct 2026', 'Mon 30 Nov 2026']);

    await wrapper.get('#repeat-kind').setValue('after_completion');
    expect(wrapper.get('.preview').text()).toContain(
      'Later dates are set when each one is completed',
    );

    await wrapper.get('#repeat-kind').setValue('custom');
    await wrapper.get('#custom-rrule').setValue('FREQ=SOMETIMES');
    expect(wrapper.get('.preview [role="status"]').text()).toContain(
      'That repeat rule cannot be used',
    );
    await wrapper.get('#custom-rrule').setValue('FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25');
    expect(previewDates(wrapper)[0]).toBe('Fri 25 Dec 2026');
  });

  const patterns: [string, (w: VueWrapper) => Promise<unknown>, unknown[]][] = [
    [
      'monthly on a day',
      async (w) => {
        await w.get('#repeat-kind').setValue('monthly');
        await w.get('#month-day').setValue('15');
      },
      ['fixed', 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15', null],
    ],
    [
      'monthly on the last day',
      async (w) => {
        await w.get('#repeat-kind').setValue('monthly');
        await w.get('#last-day').setValue(true);
      },
      ['fixed', 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=-1', null],
    ],
    [
      'monthly on the last Friday, every other month',
      async (w) => {
        await w.get('#repeat-kind').setValue('monthly');
        await w.get('#repeat-interval').setValue('2');
        await w.get('#monthly-mode').setValue('weekday');
        await w.get('#nth-week').setValue('-1');
        await w.get('#nth-weekday').setValue('FR');
      },
      ['fixed', 'FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR', null],
    ],
    [
      'yearly',
      async (w) => {
        await w.get('#repeat-kind').setValue('yearly');
        await w.get('#year-month').setValue('3');
        await w.get('#month-day').setValue('5');
      },
      ['fixed', 'FREQ=YEARLY;INTERVAL=1;BYMONTH=3;BYMONTHDAY=5', null],
    ],
    [
      'fortnightly on Monday and Thursday',
      async (w) => {
        await w.get('#repeat-kind').setValue('weekly');
        await w.get('#repeat-interval').setValue('2');
        await w.get('#weekday-TH').setValue(true);
        await w.get('#weekday-MO').setValue(true);
      },
      ['fixed', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH', null],
    ],
    [
      'custom',
      async (w) => {
        await w.get('#repeat-kind').setValue('custom');
        await w.get('#custom-rrule').setValue('FREQ=DAILY;COUNT=3');
      },
      ['fixed', 'FREQ=DAILY;COUNT=3', null],
    ],
    [
      'after completion',
      async (w) => {
        await w.get('#repeat-kind').setValue('after_completion');
        await w.get('#after-days').setValue('42');
      },
      ['after_completion', null, 42],
    ],
  ];

  it.each(patterns)('creates a task that repeats %s', async (_name, choose, expected) => {
    const { wrapper, server } = await open(
      { 'POST /api/tasks': () => json({ task: task() }, 201) },
      '/tasks/new',
    );

    await fillTitle(wrapper, 'Thing');
    await choose(wrapper);
    await save(wrapper);

    const body = lastBody(server, 'POST /api/tasks') as Record<string, unknown>;
    expect([body['scheduleKind'], body['rrule'], body['intervalAfterCompletionDays']]).toEqual(
      expected,
    );
  });

  it('offers an effort-based lead and applies it only when accepted', async () => {
    const { wrapper, server } = await open(
      { 'POST /api/tasks': () => json({ task: task() }, 201) },
      '/tasks/new',
    );
    await fillTitle(wrapper, 'Clear the garage');
    await wrapper.get('#task-effort').setValue('180');
    expect(wrapper.text()).toContain('Allow 7 days to prepare?');
    expect((wrapper.get('#task-lead').element as HTMLInputElement).value).toBe('');
    await button(wrapper, 'Use 7-day lead time').trigger('click');
    expect((wrapper.get('#task-lead').element as HTMLInputElement).value).toBe('7');
    expect(wrapper.text()).not.toContain('days to prepare?');
    await save(wrapper);
    expect(lastBody(server, 'POST /api/tasks')).toMatchObject({
      effortMinutes: 180,
      leadTimeDays: 7,
    });
  });

  it('keeps an unaccepted suggestion out of the saved task and respects an explicit zero', async () => {
    const { wrapper, server } = await open(
      { 'POST /api/tasks': () => json({ task: task() }, 201) },
      '/tasks/new',
    );
    await fillTitle(wrapper, 'Sort paperwork');
    await wrapper.get('#task-effort').setValue('60');
    expect(wrapper.text()).toContain('Allow 3 days to prepare?');
    await wrapper.get('#task-lead').setValue('0');
    expect(wrapper.text()).not.toContain('days to prepare?');
    await wrapper.get('#task-lead').setValue('');
    expect(wrapper.text()).toContain('Allow 3 days to prepare?');
    await save(wrapper);
    expect(lastBody(server, 'POST /api/tasks')).toMatchObject({
      effortMinutes: 60,
      leadTimeDays: null,
    });
  });

  it('sends a timed due as an instant and the optional fields', async () => {
    const { wrapper, server } = await open(
      { 'POST /api/tasks': () => json({ task: task() }, 201) },
      '/tasks/new',
    );

    await fillTitle(wrapper, 'Call the council');
    await wrapper.get('#task-all-day').setValue(false);
    await wrapper.get('#task-due-date').setValue('2026-10-20');
    await wrapper.get('#task-due-time').setValue('14:30');
    await wrapper.get('#task-notes').setValue('Ask about the permit');
    await wrapper.get('#task-category').setValue('Admin');
    await wrapper.get('#task-tags').setValue('phone, council');
    await wrapper.get('#task-priority').setValue('2');
    await wrapper.get('#task-effort').setValue('15');
    await wrapper.get('#task-lead').setValue('3');
    await wrapper.get('#task-profile').setValue('persistent');
    await wrapper.get('#task-slot').setValue('custom_time');
    await wrapper.get('#task-slot-time').setValue('07:45');
    await wrapper.get('#task-mode').setValue('rotation');
    await wrapper.get(`#rotation-${SAM}`).setValue(true);
    await wrapper.get(`#rotation-${ME}`).setValue(true);
    expect(wrapper.text()).toContain('Order: Sam, then Alex.');
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Add milestone')
      ?.trigger('click');
    await wrapper.get('#milestone-0-name').setValue('Find the number');
    await wrapper.get('#milestone-0-days').setValue('2');
    expect(wrapper.get('.preview').text()).toContain('Tue 20 Oct 2026 at 14:30');

    await save(wrapper);

    expect(lastBody(server, 'POST /api/tasks')).toMatchObject({
      title: 'Call the council',
      notes: 'Ask about the permit',
      category: 'Admin',
      tags: ['phone', 'council'],
      priority: 2,
      effortMinutes: 15,
      leadTimeDays: 3,
      reminderProfile: 'persistent',
      reminderSlot: 'custom_time',
      reminderCustomTime: '07:45',
      scheduleKind: 'once',
      allDay: false,
      dueDate: null,
      // 14:30 BST is 13:30 UTC.
      dueAt: '2026-10-20T13:30:00.000Z',
      assignmentMode: 'rotation',
      assigneeIds: [SAM, ME],
      milestones: [{ title: 'Find the number', offsetDaysBeforeDue: 2 }],
    });
  });

  it('reorders the rotation with move up and move down buttons', async () => {
    const { wrapper, server } = await open(
      { 'POST /api/tasks': json({ task: task() }, 201) },
      '/tasks/new',
    );
    await fillTitle(wrapper, 'Clean the bathroom');
    await wrapper.get('#task-mode').setValue('rotation');
    expect(wrapper.find('.rotation-order').exists()).toBe(false);

    await wrapper.get(`#rotation-${ME}`).setValue(true);
    await wrapper.get(`#rotation-${SAM}`).setValue(true);
    const order = () => texts(wrapper, '.rotation-order li');
    expect(order()).toEqual(['1. Alex', '2. Sam']);
    expect(wrapper.text()).toContain('Order: Alex, then Sam.');
    // The end buttons stay focusable (aria-disabled, not disabled) and do nothing.
    expect(button(wrapper, 'Move Alex up').attributes('aria-disabled')).toBe('true');
    expect(button(wrapper, 'Move Alex up').attributes('disabled')).toBeUndefined();
    expect(button(wrapper, 'Move Sam down').attributes('aria-disabled')).toBe('true');
    expect(button(wrapper, 'Move Sam up').attributes('aria-disabled')).toBe('false');
    await button(wrapper, 'Move Alex up').trigger('click');
    expect(order()).toEqual(['1. Alex', '2. Sam']);
    expect(wrapper.get('[aria-live="polite"]').text()).toBe('');

    await button(wrapper, 'Move Sam up').trigger('click');

    expect(order()).toEqual(['1. Sam', '2. Alex']);
    expect(wrapper.text()).toContain('Order: Sam, then Alex.');
    expect(wrapper.get('[aria-live="polite"]').text()).toBe('Sam moved to position 1');
    // Focus stays on the button that was used, now at the top and so aria-disabled.
    expect(document.activeElement).toBe(button(wrapper, 'Move Sam up').element);

    await button(wrapper, 'Move Sam down').trigger('click');
    expect(order()).toEqual(['1. Alex', '2. Sam']);
    await button(wrapper, 'Move Alex down').trigger('click');
    await save(wrapper);

    expect(lastBody(server, 'POST /api/tasks')).toMatchObject({
      assignmentMode: 'rotation',
      assigneeIds: [SAM, ME],
    });
  });

  it('marks members who are away in the pickers', async () => {
    const { wrapper } = await open(
      {
        'GET /api/templates': json({ templates: [] }),
        'GET /api/bank-holidays': json({ holidays: [] }),
        'GET /api/members': json({ members: [alex, { ...sam, awayUntil: '2026-10-14' }] }),
      },
      '/tasks/new',
    );

    expect(texts(wrapper, '#task-assignee option')).toEqual([
      'Nobody in particular',
      'Alex',
      'Sam (away until Wed 14 Oct)',
    ]);

    await wrapper.get('#task-mode').setValue('rotation');
    await wrapper.get(`#rotation-${SAM}`).setValue(true);

    expect(wrapper.get(`label[for="rotation-${SAM}"]`).text()).toBe('Sam (away until Wed 14 Oct)');
    expect(wrapper.get('.rotation-order li').text()).toContain('Sam (away until Wed 14 Oct)');
    expect(wrapper.find('button[aria-label="Move Sam up"]').exists()).toBe(true);
  });

  it('checks the form before calling the api', async () => {
    const { wrapper, server } = await open({}, '/tasks/new');

    await wrapper.get('#repeat-kind').setValue('weekly');
    await save(wrapper);

    expect(wrapper.get('#task-title-error').text()).toBe('Required');
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Pick at least one weekday');
    expect(server.callsTo('POST /api/tasks')).toHaveLength(0);

    await wrapper.get('#repeat-kind').setValue('once');
    await wrapper.get('#task-due-date').setValue('');
    await fillTitle(wrapper, 'Undated is fine');
    await wrapper.get('#repeat-kind').setValue('daily');
    await save(wrapper);
    expect(wrapper.get('#task-due-date-error').text()).toContain('dueDate is required');

    await wrapper.get('#repeat-kind').setValue('once');
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Add milestone')
      ?.trigger('click');
    await wrapper.get('#milestone-0-name').setValue('No days given');
    await save(wrapper);
    expect(wrapper.text()).toContain('Each milestone needs a name');
    expect(server.callsTo('POST /api/tasks')).toHaveLength(0);
  });

  it('shows what the server says when saving fails', async () => {
    const { wrapper, router } = await open(
      {
        'POST /api/tasks': apiError(400, 'invalid_schedule', 'That repeat rule is not supported'),
      },
      '/tasks/new',
    );

    await fillTitle(wrapper, 'Thing');
    await save(wrapper);

    expect(wrapper.find('[role="alert"]').text()).toBe('That repeat rule is not supported');
    expect(router.currentRoute.value.name).toBe('task-new');
  });

  describe('editing', () => {
    const open_ = (stored: TaskDto, extra: Record<string, Handler> = {}) =>
      open(
        { [`GET /api/tasks/${stored.id}`]: json({ task: stored }), ...extra },
        `/tasks/${stored.id}`,
      );

    it('reads the stored RRULE back into the builder', async () => {
      const { wrapper } = await open_(
        task({
          rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH',
          milestones: [
            {
              id: '66666666-6666-4666-8666-666666666666',
              title: 'Put out',
              offsetDaysBeforeDue: 1,
            },
          ],
        }),
      );

      expect(wrapper.find('h1').text()).toBe('Edit task');
      expect((wrapper.get('#task-title').element as HTMLInputElement).value).toBe(
        'Put the bins out',
      );
      expect((wrapper.get('#repeat-kind').element as HTMLSelectElement).value).toBe('weekly');
      expect((wrapper.get('#repeat-interval').element as HTMLInputElement).value).toBe('2');
      const checked = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].filter(
        (d) => (wrapper.get(`#weekday-${d}`).element as HTMLInputElement).checked,
      );
      expect(checked).toEqual(['MO', 'TH']);
      expect((wrapper.get('#milestone-0-name').element as HTMLInputElement).value).toBe('Put out');
      expect(previewDates(wrapper).slice(0, 3)).toEqual([
        'Mon 12 Oct 2026',
        'Thu 15 Oct 2026',
        'Mon 26 Oct 2026',
      ]);
    });

    it('shows whose turn it is on a rotation task', async () => {
      const { wrapper } = await open_(
        task({ assignmentMode: 'rotation', assigneeIds: [ME, SAM], nextAssigneeId: SAM }),
      );

      expect(wrapper.text()).toContain('Order: Alex, then Sam.');
      expect(wrapper.text()).toContain('Next up: Sam');
    });

    it('drops next up when that person is taken out of the rotation', async () => {
      const { wrapper } = await open_(
        task({ assignmentMode: 'rotation', assigneeIds: [ME, SAM], nextAssigneeId: SAM }),
      );
      expect(wrapper.text()).toContain('Next up: Sam');

      await wrapper.get(`#rotation-${SAM}`).setValue(false);

      expect(wrapper.text()).not.toContain('Next up');
    });

    it('has no next up for a task that does not take turns', async () => {
      const { wrapper } = await open_(task({ nextAssigneeId: ME }));
      expect(wrapper.text()).not.toContain('Next up');

      await wrapper.get('#task-mode').setValue('rotation');
      expect(wrapper.text()).not.toContain('Next up');
    });

    it('falls back to a custom rule for patterns the builder cannot show', async () => {
      const { wrapper } = await open_(task({ rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=4' }));

      expect((wrapper.get('#repeat-kind').element as HTMLSelectElement).value).toBe('custom');
      expect((wrapper.get('#custom-rrule').element as HTMLInputElement).value).toBe(
        'FREQ=WEEKLY;BYDAY=MO;COUNT=4',
      );
      expect(previewDates(wrapper)).toHaveLength(4);
    });

    it('saves changes with a patch', async () => {
      const stored = task();
      const { wrapper, router, server } = await open_(stored, {
        [`PATCH /api/tasks/${stored.id}`]: json({ task: stored }),
      });

      await fillTitle(wrapper, 'Put all the bins out');
      await wrapper.get('#weekday-WE').setValue(true);
      await save(wrapper);

      expect(lastBody(server, `PATCH /api/tasks/${stored.id}`)).toMatchObject({
        title: 'Put all the bins out',
        rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE',
        dueDate: '2026-10-12',
        assigneeIds: [ME],
        reminderProfile: 'standard',
      });
      expect(router.currentRoute.value.name).toBe('tasks');
    });

    it('archives, restores and deletes', async () => {
      const stored = task();
      const url = `/api/tasks/${stored.id}`;
      const { wrapper, router, server } = await open_(stored, {
        [`PATCH ${url}`]: json({ task: { ...stored, archived: true } }),
        [`DELETE ${url}`]: new Response(null, { status: 204 }),
      });
      const click = async (label: string) => {
        await wrapper
          .findAll('button')
          .find((b) => b.text() === label)
          ?.trigger('click');
        await flushPromises();
      };

      await click('Archive task');
      expect(lastBody(server, `PATCH ${url}`)).toEqual({ archived: true });
      expect(router.currentRoute.value.name).toBe('tasks');

      await router.push({ name: 'task-edit', params: { id: stored.id } });
      await flushPromises();
      await click('Delete task');
      expect(wrapper.text()).toContain('Delete this task for good?');
      expect(server.callsTo(`DELETE ${url}`)).toHaveLength(0);
      await click('Keep task');
      await click('Delete task');
      await click('Delete permanently');

      expect(server.callsTo(`DELETE ${url}`)).toHaveLength(1);
      expect(router.currentRoute.value.name).toBe('tasks');
    });

    it('offers to restore an archived task', async () => {
      const stored = task({ archived: true, archivedAt: '2026-10-01T10:00:00.000Z' });
      const { wrapper, server } = await open_(stored, {
        [`PATCH /api/tasks/${stored.id}`]: json({ task: { ...stored, archived: false } }),
      });

      expect(wrapper.text()).toContain('Archived');
      expect(wrapper.findAll('button').some((b) => b.text() === 'Archive task')).toBe(false);
      await wrapper
        .findAll('button')
        .find((b) => b.text() === 'Restore task')
        ?.trigger('click');
      await flushPromises();

      expect(lastBody(server, `PATCH /api/tasks/${stored.id}`)).toEqual({ archived: false });
    });

    it('explains a task that cannot be loaded', async () => {
      const { wrapper } = await open(
        { [`GET /api/tasks/${TASK_ID}`]: apiError(404, 'not_found', 'No such task') },
        `/tasks/${TASK_ID}`,
      );

      expect(wrapper.find('[role="alert"]').text()).toContain('No such task');
      expect(wrapper.find('form').exists()).toBe(false);
    });
  });
});
