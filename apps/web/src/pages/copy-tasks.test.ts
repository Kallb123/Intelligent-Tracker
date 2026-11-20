import type { MemberDto, OccurrenceDto } from '@tracker/shared';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, fakeServer, json, mountApp, session, type Handler } from '../test-util.js';

// Sunday 11 October 2026, 11:00 in London (BST).
const NOW = '2026-10-11T10:00:00Z';
const ME = '11111111-1111-4111-8111-111111111111';
const SAM = '44444444-4444-4444-8444-444444444444';
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
    taskId: '55555555-5555-4555-8555-555555555555',
    task: { title, category: null, priority: 0, allDay: true, scheduleKind: 'fixed' },
    dueDate: '2026-10-11',
    dueAt: null,
    startAt: null,
    assigneeId: null,
    status: 'active',
    completedAt: null,
    completedBy: null,
    snoozedUntil: null,
    milestones: [],
    overdue: false,
    ...overrides,
  };
}

const base: Record<string, Handler> = {
  'GET /api/auth/me': json(session()),
  'GET /api/templates': json({ templates: [] }),
  'GET /api/bank-holidays': json({ holidays: [] }),
  'GET /api/members': json({ members: [alex, sam] }),
  'GET /api/tasks': json({ tasks: [] }),
};

let mounted: VueWrapper | undefined;
const writeText = vi.fn<(text: string) => Promise<void>>();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  writeText.mockReset();
  writeText.mockResolvedValue();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

async function open(handlers: Record<string, Handler>) {
  const server = fakeServer({ ...base, ...handlers });
  const app = await mountApp(server, '/tasks');
  mounted = app.wrapper;
  return { ...app, server };
}

async function click(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('.copy-tasks button').find((b) => b.text() === label);
  if (!found) throw new Error(`No button "${label}"`);
  await found.trigger('click');
  await flushPromises();
}

const status = (wrapper: VueWrapper) => wrapper.get('.copy-tasks [aria-live="polite"]').text();

const bins = occurrence('Put the bins out', { assigneeId: ME });
const tax = occurrence('File the tax return', {
  dueDate: '2026-10-05',
  overdue: true,
  assigneeId: SAM,
});
const plants = occurrence('Water the plants', { dueDate: '2026-10-12' });

describe('Copy tasks panel', () => {
  it('copies today from the today view and says how many', async () => {
    const { wrapper, server } = await open({
      'GET /api/occurrences': json({ occurrences: [tax, bins] }),
    });

    await click(wrapper, 'Copy today');

    const searches = server.callsTo('GET /api/occurrences').map((c) => c.search);
    expect(searches).toEqual(['view=today&limit=500']);
    expect(writeText).toHaveBeenCalledWith(
      [
        'Today (Sun 11 Oct)',
        'Overdue\n• File the tax return — Sam (was due Mon 5 Oct)',
        'Sun 11 Oct\n• Put the bins out — Alex',
      ].join('\n\n'),
    );
    expect(status(wrapper)).toBe('Copied 2 tasks');
  });

  it('asks for the upcoming view too for the week and for all, once each', async () => {
    const { wrapper, server } = await open({
      'GET /api/occurrences': (call) =>
        json({ occurrences: call.search.includes('upcoming') ? [plants] : [bins] }),
    });

    await click(wrapper, 'Copy this week');
    await click(wrapper, 'Copy all');

    expect(server.callsTo('GET /api/occurrences').map((c) => c.search)).toEqual([
      'view=today&limit=500',
      'view=upcoming&limit=500&days=6',
      'view=today&limit=500',
      'view=upcoming&limit=500&days=366',
    ]);
    expect(writeText.mock.calls[1]?.[0]).toContain('Mon 12 Oct\n• Water the plants — Anyone');
    expect(status(wrapper)).toBe('Copied 2 tasks');
  });

  it('passes memberId when Only me is on', async () => {
    const { wrapper, server } = await open({
      'GET /api/occurrences': json({ occurrences: [bins] }),
    });

    await wrapper.get('#copy-only-me').setValue(true);
    await click(wrapper, 'Copy undated');

    expect(server.callsTo('GET /api/occurrences').map((c) => c.search)).toEqual([
      `view=today&limit=500&memberId=${ME}`,
    ]);
    expect(status(wrapper)).toBe('Nothing to copy');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('shows an api error, and a clipboard error', async () => {
    let fail = true;
    const { wrapper } = await open({
      'GET /api/occurrences': () =>
        fail ? apiError(500, 'boom', 'The server broke') : json({ occurrences: [bins] }),
    });

    await click(wrapper, 'Copy today');
    expect(status(wrapper)).toContain('The server broke');

    fail = false;
    writeText.mockRejectedValue(new Error('denied'));
    await click(wrapper, 'Copy today');
    expect(status(wrapper)).toBe('Could not copy to the clipboard');
  });

  it('disables the buttons while copying', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { wrapper } = await open({
      'GET /api/occurrences': async () => {
        await gate;
        return json({ occurrences: [bins] });
      },
    });

    const pending = wrapper.findAll('.copy-tasks button')[0]!.trigger('click');
    await flushPromises();
    const disabled = wrapper.findAll('.copy-tasks button').map((b) => b.attributes('disabled'));
    expect(disabled.every((d) => d !== undefined)).toBe(true);

    release();
    await pending;
    await flushPromises();
    expect(wrapper.findAll('.copy-tasks button')[0]!.attributes('disabled')).toBeUndefined();
  });
});
