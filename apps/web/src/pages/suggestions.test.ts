import type { SuggestionDto } from '@tracker/shared';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { apiError, fakeServer, json, mountApp, session, type Handler } from '../test-util.js';

const suggestion: SuggestionDto = {
  id: 'a'.repeat(40),
  taskId: '11111111-1111-4111-8111-111111111111',
  title: 'Insurance',
  kind: 'lateness',
  message: 'Start reminders 14 days before the due date?',
};
let wrapper: VueWrapper | undefined;
afterEach(() => {
  wrapper?.unmount();
  document.body.innerHTML = '';
});
async function open(handlers: Record<string, Handler> = {}) {
  const server = fakeServer({
    'GET /api/auth/me': json(session()),
    'GET /api/notifications': json({ notifications: [], unreadCount: 0 }),
    'GET /api/suggestions': json({ suggestions: [suggestion] }),
    ...handlers,
  });
  const app = await mountApp(server, '/suggestions');
  wrapper = app.wrapper;
  return { ...app, server };
}
const button = (w: VueWrapper, label: string) =>
  w.findAll('button').find((b) => b.text() === label)!;

describe('suggestions inbox', () => {
  it('shows task cards with a task link and changes nothing before acceptance', async () => {
    const { wrapper, server } = await open();
    expect(wrapper.text()).toContain(suggestion.message);
    expect(wrapper.get('section a').attributes('href')).toBe(`/tasks/${suggestion.taskId}`);
    expect(server.callsTo(`POST /api/suggestions/${suggestion.id}`)).toEqual([]);
  });
  for (const action of ['accept', 'dismiss'] as const) {
    it(`${action}s with CSRF and refreshes the shared inbox`, async () => {
      const { wrapper, server } = await open({
        [`POST /api/suggestions/${suggestion.id}`]: new Response(null, { status: 204 }),
      });
      server.handlers['GET /api/suggestions'] = json({ suggestions: [] });
      await button(wrapper, action === 'accept' ? 'Accept' : 'Dismiss').trigger('click');
      await flushPromises();
      expect(server.callsTo(`POST /api/suggestions/${suggestion.id}`)[0]).toMatchObject({
        body: { action },
      });
      expect(
        server.callsTo(`POST /api/suggestions/${suggestion.id}`)[0]?.headers.get('x-csrf-token'),
      ).toBe('csrf-abc');
      expect(wrapper.text()).toContain('No suggestions right now');
      expect(wrapper.get('[role="status"]').text()).toContain(
        action === 'accept' ? 'Task updated.' : 'dismissed.',
      );
    });
  }
  it('shows stale-action errors and lets the user refresh', async () => {
    const { wrapper, server } = await open({
      [`POST /api/suggestions/${suggestion.id}`]: apiError(
        409,
        'suggestion_stale',
        'Refresh the inbox.',
      ),
    });
    await button(wrapper, 'Accept').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('Refresh the inbox.');
    expect(wrapper.text()).not.toContain('Task updated.');
    server.handlers['GET /api/suggestions'] = json({ suggestions: [] });
    await button(wrapper, 'Refresh').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('No suggestions right now');
  });
  it('offers a retry after an inbox load fails', async () => {
    const { wrapper, server } = await open({
      'GET /api/suggestions': apiError(500, 'failed', 'Unable to load suggestions'),
    });
    expect(wrapper.get('[role="alert"]').text()).toContain('Unable to load suggestions');
    server.handlers['GET /api/suggestions'] = json({ suggestions: [suggestion] });
    await button(wrapper, 'Refresh').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain(suggestion.message);
  });
});
