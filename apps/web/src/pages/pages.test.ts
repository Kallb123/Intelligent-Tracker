import type { MemberDto } from '@tracker/shared';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMembersStore } from '../stores/members.js';
import { apiError, fakeServer, json, mountApp, session, type Handler } from '../test-util.js';

const ME = 'GET /api/auth/me';
const unauthorized = apiError(401, 'unauthorized', 'Log in to continue');
const loggedOut: Record<string, Handler> = {
  [ME]: unauthorized,
  'GET /api/setup': json({ needsSetup: false }),
};
const PASSWORD = 'correct-horse-battery';

let mounted: VueWrapper | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

async function open(handlers: Record<string, Handler>, path: string) {
  const app = await mountApp(fakeServer(handlers), path);
  mounted = app.wrapper;
  return app;
}

async function fill(wrapper: VueWrapper, values: Record<string, string>) {
  for (const [id, value] of Object.entries(values)) await wrapper.find(`#${id}`).setValue(value);
}

async function submit(wrapper: VueWrapper) {
  await wrapper.find('form').trigger('submit');
  await flushPromises();
}

describe('LoginPage', () => {
  it('shows the server error when the login is refused', async () => {
    const server = fakeServer({
      ...loggedOut,
      'POST /api/auth/login': apiError(401, 'unauthorized', 'Incorrect username or password'),
    });
    const { wrapper, router } = await mountApp(server, '/login');
    mounted = wrapper;

    await fill(wrapper, { identifier: 'alex', password: 'wrong' });
    await submit(wrapper);

    expect(wrapper.find('[role="alert"]').text()).toBe('Incorrect username or password');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('login'));
    expect(server.callsTo('POST /api/auth/login')[0]?.body).toEqual({
      identifier: 'alex',
      password: 'wrong',
      remember: false,
    });
  });

  it('logs in and returns to the page the visitor wanted', async () => {
    const { wrapper, router } = await open(
      {
        ...loggedOut,
        'POST /api/auth/login': json(session()),
        'GET /api/members': json({ members: [] }),
      },
      '/people',
    );
    expect(router.currentRoute.value.fullPath).toBe('/login?redirect=/people');

    await fill(wrapper, { identifier: 'alex', password: PASSWORD });
    await wrapper.find('#remember').setValue(true);
    await submit(wrapper);

    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/people'));
    await vi.waitFor(() => expect(wrapper.text()).toContain('The Smiths'));
  });

  it('asks for both fields before calling the api', async () => {
    const server = fakeServer(loggedOut);
    const { wrapper } = await mountApp(server, '/login');
    mounted = wrapper;

    await submit(wrapper);

    expect(wrapper.findAll('.field-error').map((e) => e.text())).toEqual(['Required', 'Required']);
    expect(server.callsTo('POST /api/auth/login')).toHaveLength(0);
  });

  it('tells the visitor how long a rate limit lasts', async () => {
    const { wrapper } = await open(
      {
        ...loggedOut,
        'POST /api/auth/login': json(
          { error: 'too_many_attempts', message: 'Too many failed attempts.' },
          429,
          {
            'retry-after': '600',
          },
        ),
      },
      '/login',
    );

    await fill(wrapper, { identifier: 'alex', password: 'x' });
    await submit(wrapper);

    expect(wrapper.find('[role="alert"]').text()).toBe(
      'Too many failed attempts. Try again in 10 minutes.',
    );
  });
});

describe('SetPasswordPage (invite)', () => {
  const info = {
    name: 'Sam',
    username: 'sam',
    householdName: 'The Smiths',
    expiresAt: '2026-07-20T10:30:00Z',
  };

  it('explains a used or expired link', async () => {
    const { wrapper } = await open(
      { ...loggedOut, 'GET /api/invites/old': apiError(410, 'gone', 'Link used') },
      '/invite/old',
    );

    expect(wrapper.find('[role="alert"]').text()).toContain('expired or has already been used');
    expect(wrapper.find('form').exists()).toBe(false);
  });

  it('explains an unknown link', async () => {
    const { wrapper } = await open(
      { ...loggedOut, 'GET /api/invites/nope': apiError(404, 'not_found', 'Not found') },
      '/invite/nope',
    );

    expect(wrapper.find('[role="alert"]').text()).toContain('not valid');
  });

  it('greets the invitee, checks the confirmation and joins', async () => {
    const server = fakeServer({
      ...loggedOut,
      'GET /api/invites/tok1': json(info),
      'POST /api/invites/tok1/accept': json(
        session({ name: 'Sam', username: 'sam', role: 'member' }),
      ),
    });
    const { wrapper, router } = await mountApp(server, '/invite/tok1');
    mounted = wrapper;

    expect(wrapper.find('h1').text()).toBe('Hi Sam, join The Smiths');
    // 10:30 UTC on 20 July is 11:30 BST.
    expect(wrapper.text()).toContain('20/07/2026, 11:30');

    await fill(wrapper, { password: PASSWORD, confirmation: 'something-else-entirely' });
    await submit(wrapper);
    expect(wrapper.find('#confirmation-error').text()).toBe('The passwords do not match');
    expect(server.callsTo('POST /api/invites/tok1/accept')).toHaveLength(0);

    await fill(wrapper, { confirmation: PASSWORD });
    await submit(wrapper);

    expect(server.callsTo('POST /api/invites/tok1/accept')[0]?.body).toEqual({
      password: PASSWORD,
      remember: false,
    });
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('home'));
  });

  it('shows the link problem if the link is used between loading and submitting', async () => {
    const { wrapper } = await open(
      {
        ...loggedOut,
        'GET /api/invites/tok1': json(info),
        'POST /api/invites/tok1/accept': apiError(410, 'gone', 'Link used'),
      },
      '/invite/tok1',
    );

    await fill(wrapper, { password: PASSWORD, confirmation: PASSWORD });
    await submit(wrapper);

    expect(wrapper.find('[role="alert"]').text()).toContain('expired or has already been used');
  });
});

describe('SetPasswordPage (reset)', () => {
  it('uses the password-reset endpoints', async () => {
    const server = fakeServer({
      ...loggedOut,
      'GET /api/password-resets/r1': json({
        name: 'Sam',
        username: 'sam',
        householdName: 'The Smiths',
        expiresAt: '2026-01-02T09:00:00Z',
      }),
      'POST /api/password-resets/r1': json(session({ name: 'Sam', role: 'member' })),
    });
    const { wrapper, router } = await mountApp(server, '/reset-password/r1');
    mounted = wrapper;

    expect(wrapper.find('h1').text()).toBe('Hi Sam, choose a new password');
    await fill(wrapper, { password: PASSWORD, confirmation: PASSWORD });
    await submit(wrapper);

    expect(server.callsTo('POST /api/password-resets/r1')).toHaveLength(1);
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('home'));
  });
});

describe('SetupPage', () => {
  const needsSetup = { [ME]: unauthorized, 'GET /api/setup': json({ needsSetup: true }) };

  it('walks through the two steps and logs the new admin in', async () => {
    const server = fakeServer({ ...needsSetup, 'POST /api/setup': json(session(), 201) });
    const { wrapper, router } = await mountApp(server, '/');
    mounted = wrapper;
    expect(router.currentRoute.value.name).toBe('setup');

    await submit(wrapper);
    expect(wrapper.find('#householdName-error').text()).toBe('Required');
    expect(wrapper.find('#username').exists()).toBe(false);

    await fill(wrapper, { householdName: 'The Smiths', name: 'Alex' });
    await submit(wrapper);
    expect(wrapper.text()).toContain('Step 2 of 2');

    await fill(wrapper, {
      username: 'alex',
      email: 'alex@example.com',
      password: PASSWORD,
      confirmation: PASSWORD,
    });
    await submit(wrapper);

    expect(server.callsTo('POST /api/setup')[0]?.body).toEqual({
      householdName: 'The Smiths',
      name: 'Alex',
      username: 'alex',
      email: 'alex@example.com',
      password: PASSWORD,
      remember: true,
    });
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('home'));
  });

  it('validates the username and password with the shared rules, and omits a blank email', async () => {
    const server = fakeServer({ ...needsSetup, 'POST /api/setup': json(session(), 201) });
    const { wrapper } = await mountApp(server, '/setup');
    mounted = wrapper;
    await fill(wrapper, { householdName: 'The Smiths', name: 'Alex' });
    await submit(wrapper);

    await fill(wrapper, { username: 'a b', password: 'short', confirmation: 'short' });
    await submit(wrapper);
    expect(wrapper.find('#username-error').text()).toContain('2 to 32 letters');
    expect(wrapper.find('#password-error').text()).toBe('Use at least 10 characters');
    expect(server.callsTo('POST /api/setup')).toHaveLength(0);

    await fill(wrapper, { username: 'alex', password: PASSWORD, confirmation: PASSWORD });
    await submit(wrapper);
    expect(server.callsTo('POST /api/setup')[0]?.body).not.toHaveProperty('email');
  });

  it('offers the login page if someone else finished setup first', async () => {
    const { wrapper } = await open(
      {
        ...needsSetup,
        'POST /api/setup': apiError(
          409,
          'already_set_up',
          'This household has already been set up',
        ),
      },
      '/setup',
    );
    await fill(wrapper, { householdName: 'The Smiths', name: 'Alex' });
    await submit(wrapper);
    await fill(wrapper, { username: 'alex', password: PASSWORD, confirmation: PASSWORD });
    await submit(wrapper);

    expect(wrapper.find('[role="alert"]').text()).toContain('already been set up');
    expect(wrapper.find('[role="alert"] a').attributes('href')).toBe('/login');
  });
});

describe('MembersPage', () => {
  const members = [
    {
      id: session().member.id,
      name: 'Alex',
      username: 'alex',
      email: 'alex@example.com',
      role: 'admin',
      pending: false,
      awayUntil: null,
      telegramLinked: true,
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Sam',
      username: 'sam',
      email: null,
      role: 'member',
      pending: true,
      awayUntil: null,
      telegramLinked: false,
    },
    {
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Jo',
      username: 'jo',
      email: null,
      role: 'member',
      pending: false,
      awayUntil: null,
      telegramLinked: false,
    },
  ];
  const JO = members[2]?.id ?? '';
  const noTasks = { 'GET /api/tasks': json({ tasks: [] }) };

  // Sunday 11 October 2026, 11:00 in London (BST).
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-11T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists members, flags pending invites, and lets admins invite', async () => {
    const server = fakeServer({
      [ME]: json(session()),
      'GET /api/members': json({ members }),
      ...noTasks,
      'POST /api/invites': json(
        {
          member: members[1],
          invite: {
            token: 't',
            url: 'https://home.example/invite/t',
            expiresAt: '2026-07-20T10:30:00Z',
          },
        },
        201,
      ),
    });
    const { wrapper } = await mountApp(server, '/people');
    mounted = wrapper;

    const rows = wrapper.findAll('.member');
    expect(rows.map((r) => r.find('strong').text())).toEqual(['Alex', 'Sam', 'Jo']);
    expect(rows[0]?.text()).toContain('(you)');
    expect(rows[1]?.text()).toContain('Pending');
    expect(rows[0]?.text()).not.toContain('Reset password');
    expect(rows[1]?.text()).toContain('New invite link');

    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Invite member')
      ?.trigger('click');
    await fill(wrapper, { 'invite-name': 'Sam', 'invite-username': 'sam' });
    await submit(wrapper);

    expect(server.callsTo('POST /api/invites')[0]?.body).toEqual({
      name: 'Sam',
      username: 'sam',
      role: 'member',
    });
    expect(server.callsTo('POST /api/invites')[0]?.headers.get('x-csrf-token')).toBe('csrf-abc');
    const box = wrapper.find('.link-box');
    expect((box.find('input').element as HTMLInputElement).value).toBe(
      'https://home.example/invite/t',
    );
    expect(box.text()).toContain('20/07/2026, 11:30');
  });

  it('shows the server error when an invite is refused', async () => {
    const { wrapper } = await open(
      {
        [ME]: json(session()),
        'GET /api/members': json({ members }),
        ...noTasks,
        'POST /api/invites': apiError(409, 'username_taken', 'That username is already taken'),
      },
      '/people',
    );
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Invite member')
      ?.trigger('click');
    await fill(wrapper, { 'invite-name': 'Sam', 'invite-username': 'sam' });
    await submit(wrapper);

    expect(wrapper.find('[role="alert"]').text()).toBe('That username is already taken');
  });

  it('lets admins start a password reset for someone else', async () => {
    const server = fakeServer({
      [ME]: json(session()),
      'GET /api/members': json({ members }),
      ...noTasks,
      'POST /api/members/44444444-4444-4444-8444-444444444444/password-reset': json({
        purpose: 'reset',
        link: {
          token: 'r',
          url: 'https://home.example/reset-password/r',
          expiresAt: '2026-01-02T09:00:00Z',
        },
      }),
    });
    const { wrapper } = await mountApp(server, '/people');
    mounted = wrapper;

    await wrapper.findAll('.member')[2]?.find('button').trigger('click');
    await flushPromises();

    expect(wrapper.find('.link-box h2').text()).toBe('Reset link for Jo');
    expect((wrapper.find('.link-box input').element as HTMLInputElement).value).toBe(
      'https://home.example/reset-password/r',
    );
  });

  it('hides admin actions from ordinary members', async () => {
    const { wrapper } = await open(
      {
        [ME]: json(session({ role: 'member' })),
        'GET /api/members': json({ members }),
        ...noTasks,
      },
      '/people',
    );

    expect(wrapper.text()).not.toContain('Invite member');
    expect(wrapper.text()).not.toContain('Reset password');
    expect(wrapper.findAll('.member')).toHaveLength(3);
  });

  const away = (id: string, awayUntil: string | null) => ({
    ...members.find((m) => m.id === id),
    awayUntil,
  });
  const rowOf = (wrapper: VueWrapper, name: string) =>
    wrapper.findAll('.member').find((r) => r.find('strong').text() === name);
  const rotation = (id: string, title: string, assigneeIds: string[], nextAssigneeId: string) => ({
    id,
    title,
    assignmentMode: 'rotation',
    assigneeIds,
    nextAssigneeId,
    archived: false,
  });

  it('shows who is away and which rotations each person is in', async () => {
    const SAM = members[1]?.id ?? '';
    const bins = '55555555-5555-4555-8555-555555555555';
    const { wrapper } = await open(
      {
        [ME]: json(session()),
        'GET /api/members': json({
          members: [members[0], members[1], away(JO, '2026-10-14')],
        }),
        'GET /api/tasks': json({
          tasks: [
            rotation(bins, 'Put the bins out', [JO, SAM], SAM),
            {
              ...rotation('66666666-6666-4666-8666-666666666666', 'Old', [JO], JO),
              archived: true,
            },
            {
              ...rotation('77777777-7777-4777-8777-777777777777', 'Fixed', [JO], JO),
              assignmentMode: 'fixed',
            },
          ],
        }),
      },
      '/people',
    );

    expect(rowOf(wrapper, 'Jo')?.text()).toContain('Away until Wed 14 Oct');
    expect(rowOf(wrapper, 'Alex')?.text()).not.toContain('Away until Wed');
    const rotations = rowOf(wrapper, 'Jo')?.find('.member-rotations');
    expect(rotations?.text()).toContain('Put the bins out (next: Sam)');
    expect(rotations?.text()).not.toContain('Old');
    expect(rotations?.text()).not.toContain('Fixed');
    expect(rotations?.find('a').attributes('href')).toBe(`/tasks/${bins}`);
    expect(rowOf(wrapper, 'Alex')?.find('.member-rotations').exists()).toBe(false);
  });

  it('does not show an away date that has passed', async () => {
    const { wrapper } = await open(
      {
        [ME]: json(session()),
        'GET /api/members': json({ members: [away(JO, '2026-10-10')] }),
        ...noTasks,
      },
      '/people',
    );

    expect(wrapper.find('.member-tags').text()).not.toContain('Away');
    expect((wrapper.get(`#away-${JO}`).element as HTMLInputElement).value).toBe('');
  });

  it('lets an admin set and clear anyone away date without reloading the list', async () => {
    const server = fakeServer({
      [ME]: json(session()),
      'GET /api/members': json({ members }),
      ...noTasks,
      [`PATCH /api/members/${JO}/away`]: (call) =>
        json({ member: away(JO, (call.body as { awayUntil: string | null }).awayUntil) }),
    });
    const { wrapper } = await mountApp(server, '/people');
    mounted = wrapper;

    await wrapper.get(`#away-${JO}`).setValue('2026-10-20');
    await rowOf(wrapper, 'Jo')?.get('form').trigger('submit');
    await flushPromises();

    expect(server.callsTo(`PATCH /api/members/${JO}/away`)[0]?.body).toEqual({
      awayUntil: '2026-10-20',
    });
    expect(server.callsTo(`PATCH /api/members/${JO}/away`)[0]?.headers.get('x-csrf-token')).toBe(
      'csrf-abc',
    );
    expect(rowOf(wrapper, 'Jo')?.text()).toContain('Away until Tue 20 Oct');
    expect(server.callsTo('GET /api/members')).toHaveLength(1);

    await wrapper.get('button[aria-label="Clear away date for Jo"]').trigger('click');
    await flushPromises();

    expect(server.callsTo(`PATCH /api/members/${JO}/away`)[1]?.body).toEqual({ awayUntil: null });
    expect(rowOf(wrapper, 'Jo')?.text()).not.toContain('Away until Tue');
    expect((wrapper.get(`#away-${JO}`).element as HTMLInputElement).value).toBe('');
  });

  it('lets a member set and clear their own, but not anyone else’s', async () => {
    const mine = session().member.id;
    const server = fakeServer({
      [ME]: json(session({ role: 'member' })),
      'GET /api/members': json({ members: [away(mine, '2026-10-13'), members[2]] }),
      ...noTasks,
      [`PATCH /api/members/${mine}/away`]: json({ member: away(mine, null) }),
    });
    const { wrapper } = await mountApp(server, '/people');
    mounted = wrapper;

    expect(wrapper.find(`#away-${JO}`).exists()).toBe(false);
    expect((wrapper.get(`#away-${mine}`).element as HTMLInputElement).value).toBe('2026-10-13');

    await wrapper.get('button[aria-label="I\'m back"]').trigger('click');
    await flushPromises();

    expect(server.callsTo(`PATCH /api/members/${mine}/away`)[0]?.body).toEqual({
      awayUntil: null,
    });
    expect(rowOf(wrapper, 'Alex')?.get('.member-tags').text()).not.toContain('Away');
  });

  it('shows who has linked Telegram, and nothing for a pending invite', async () => {
    const { wrapper } = await open(
      { [ME]: json(session()), 'GET /api/members': json({ members }), ...noTasks },
      '/people',
    );

    expect(rowOf(wrapper, 'Alex')?.get('.member-tags').text()).toContain('Telegram linked');
    expect(rowOf(wrapper, 'Jo')?.get('.member-tags').text()).toContain('No Telegram');
    expect(rowOf(wrapper, 'Sam')?.get('.member-tags').text()).not.toContain('Telegram');
  });

  it('shows a warning when the rotations cannot be loaded', async () => {
    const { wrapper } = await open(
      {
        [ME]: json(session()),
        'GET /api/members': json({ members }),
        'GET /api/tasks': apiError(500, 'internal', 'Tasks are down'),
      },
      '/people',
    );

    expect(wrapper.text()).toContain('Could not load the rotations: Tasks are down');
    expect(wrapper.findAll('.member')).toHaveLength(3);
    expect(wrapper.find('.member-rotations').exists()).toBe(false);
  });

  it('cannot save an empty date, and ties an error to its date box', async () => {
    const { wrapper } = await open(
      { [ME]: json(session()), 'GET /api/members': json({ members }), ...noTasks },
      '/people',
    );
    const save = () => wrapper.get('button[aria-label="Save away date for Jo"]');

    expect(save().attributes('disabled')).toBeDefined();
    await wrapper.get(`#away-${JO}`).setValue('2026-10-01');
    expect(save().attributes('disabled')).toBeUndefined();
    await wrapper.get(`#away-${JO}`).setValue('');
    expect(save().attributes('disabled')).toBeDefined();

    await wrapper.get(`#away-${JO}`).setValue('2026-10-01');
    await rowOf(wrapper, 'Jo')?.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get(`#away-${JO}`).attributes('aria-describedby')).toBe(`away-${JO}-error`);
    expect(wrapper.get(`#away-${JO}-error`).text()).toBe('Choose today or a later date.');
  });

  it('drops a typed date when the stored one changes underneath it', async () => {
    const { wrapper, pinia } = await open(
      { [ME]: json(session()), 'GET /api/members': json({ members }), ...noTasks },
      '/people',
    );
    const input = () => wrapper.get(`#away-${JO}`).element as HTMLInputElement;

    await wrapper.get(`#away-${JO}`).setValue('2026-10-20');
    expect(input().value).toBe('2026-10-20');

    // Someone else set a date, which a reload brings in.
    const store = useMembersStore(pinia);
    store.replace({ ...members[2], awayUntil: '2026-10-25' } as MemberDto);
    await flushPromises();
    expect(input().value).toBe('2026-10-25');

    // A change to someone else leaves a draft alone.
    await wrapper.get(`#away-${JO}`).setValue('2026-10-30');
    store.replace({ ...members[0], name: 'Alexandra' } as MemberDto);
    await flushPromises();
    expect(input().value).toBe('2026-10-30');
  });

  it('refuses a date in the past and shows api errors', async () => {
    const server = fakeServer({
      [ME]: json(session()),
      'GET /api/members': json({ members }),
      ...noTasks,
      [`PATCH /api/members/${JO}/away`]: apiError(403, 'forbidden', 'Not allowed'),
    });
    const { wrapper } = await mountApp(server, '/people');
    mounted = wrapper;
    const submitJo = async () => {
      await rowOf(wrapper, 'Jo')?.get('form').trigger('submit');
      await flushPromises();
    };

    await wrapper.get(`#away-${JO}`).setValue('2026-10-01');
    await submitJo();
    expect(rowOf(wrapper, 'Jo')?.get('[role="alert"]').text()).toBe(
      'Choose today or a later date.',
    );
    expect(server.callsTo(`PATCH /api/members/${JO}/away`)).toHaveLength(0);

    await wrapper.get(`#away-${JO}`).setValue('2026-10-12');
    await submitJo();
    expect(rowOf(wrapper, 'Jo')?.get('[role="alert"]').text()).toBe('Not allowed');
  });
});

const TELEGRAM = 'GET /api/telegram';
const notLinked = { botUsername: 'tracker_bot', groupLinked: false, memberLinked: false };

describe('AccountPage', () => {
  it('changes the password', async () => {
    const server = fakeServer({
      [ME]: json(session()),
      [TELEGRAM]: json(notLinked),
      'POST /api/auth/password': json({ ok: true }),
    });
    const { wrapper } = await mountApp(server, '/account');
    mounted = wrapper;

    await fill(wrapper, {
      currentPassword: 'old-password-1',
      newPassword: PASSWORD,
      confirmation: PASSWORD,
    });
    await submit(wrapper);

    expect(server.callsTo('POST /api/auth/password')[0]?.body).toEqual({
      currentPassword: 'old-password-1',
      newPassword: PASSWORD,
    });
    expect(wrapper.find('[role="status"]').text()).toContain('Password changed');
  });

  it('shows the api message for a wrong current password without logging out', async () => {
    const { wrapper, pinia } = await open(
      {
        [ME]: json(session()),
        [TELEGRAM]: json(notLinked),
        'POST /api/auth/password': apiError(
          400,
          'wrong_password',
          'Your current password is incorrect',
        ),
      },
      '/account',
    );

    await fill(wrapper, { currentPassword: 'nope', newPassword: PASSWORD, confirmation: PASSWORD });
    await submit(wrapper);

    expect(wrapper.find('[role="alert"]').text()).toBe('Your current password is incorrect');
    expect(pinia.state.value['session']).toBeDefined();
    expect(wrapper.find('h1').text()).toBe('Account');
  });
});

describe('Telegram on the AccountPage', () => {
  const expiresAt = '2026-10-15T13:00:00.000Z';
  const buttonLabelled = (wrapper: VueWrapper, label: string) =>
    wrapper.findAll('button').find((b) => b.text() === label);

  it('shows the link status and offers to connect', async () => {
    const { wrapper } = await open(
      { [ME]: json(session()), [TELEGRAM]: json(notLinked) },
      '/account',
    );

    const panel = wrapper.get('[aria-labelledby="telegram-heading"]');
    expect(panel.text()).toContain('Not connected');
    expect(buttonLabelled(wrapper, 'Connect Telegram')).toBeDefined();
    expect(buttonLabelled(wrapper, 'Disconnect')).toBeUndefined();
  });

  it('connects: shows the deep link to open, then notices the bot linked the account', async () => {
    const server = fakeServer({
      [ME]: json(session({ role: 'member' })),
      [TELEGRAM]: json(notLinked),
      'POST /api/telegram/link': json({
        code: 'abc123',
        expiresAt,
        url: 'https://t.me/tracker_bot?start=abc123',
      }),
    });
    const { wrapper } = await mountApp(server, '/account');
    mounted = wrapper;

    await buttonLabelled(wrapper, 'Connect Telegram')?.trigger('click');
    await flushPromises();

    const open = wrapper.get('a[href="https://t.me/tracker_bot?start=abc123"]');
    expect(open.text()).toBe('Open Telegram');
    expect(open.attributes('target')).toBe('_blank');
    expect(open.attributes('rel')).toContain('noopener');
    expect(wrapper.get('.link-box').text()).toContain('Works once');

    server.handlers[TELEGRAM] = json({ ...notLinked, memberLinked: true });
    await buttonLabelled(wrapper, 'Refresh status')?.trigger('click');
    await flushPromises();

    expect(wrapper.find('.link-box').exists()).toBe(false);
    expect(wrapper.get('[aria-labelledby="telegram-heading"]').text()).toContain('Connected');
    expect(buttonLabelled(wrapper, 'Disconnect')).toBeDefined();
  });

  it('shows the message to send the bot when no bot username is configured', async () => {
    const { wrapper } = await open(
      {
        [ME]: json(session()),
        [TELEGRAM]: json({ ...notLinked, botUsername: null }),
        'POST /api/telegram/link': json({ code: 'abc123', expiresAt, url: null }),
      },
      '/account',
    );

    await buttonLabelled(wrapper, 'Connect Telegram')?.trigger('click');
    await flushPromises();

    expect(wrapper.find('a[href^="https://t.me"]').exists()).toBe(false);
    expect((wrapper.get('.link-box input').element as HTMLInputElement).value).toBe(
      '/start abc123',
    );
  });

  it('disconnects a linked account', async () => {
    const server = fakeServer({
      [ME]: json(session()),
      [TELEGRAM]: json({ ...notLinked, memberLinked: true }),
      'DELETE /api/telegram/link': new Response(null, { status: 204 }),
    });
    const { wrapper } = await mountApp(server, '/account');
    mounted = wrapper;
    expect(wrapper.get('[aria-labelledby="telegram-heading"]').text()).toContain('Connected');

    server.handlers[TELEGRAM] = json(notLinked);
    await buttonLabelled(wrapper, 'Disconnect')?.trigger('click');
    await flushPromises();

    expect(server.callsTo('DELETE /api/telegram/link')).toHaveLength(1);
    expect(server.callsTo('DELETE /api/telegram/link')[0]?.headers.get('x-csrf-token')).toBe(
      'csrf-abc',
    );
    expect(wrapper.get('[aria-labelledby="telegram-heading"]').text()).toContain('Not connected');
  });

  it('shows the api message when connecting fails', async () => {
    const { wrapper } = await open(
      {
        [ME]: json(session()),
        [TELEGRAM]: json(notLinked),
        'POST /api/telegram/link': apiError(500, 'internal', 'Something went wrong'),
      },
      '/account',
    );

    await buttonLabelled(wrapper, 'Connect Telegram')?.trigger('click');
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toBe('Something went wrong');
    expect(wrapper.find('.link-box').exists()).toBe(false);
  });

  describe('house group', () => {
    it('is only offered to admins', async () => {
      const { wrapper } = await open(
        { [ME]: json(session({ role: 'member' })), [TELEGRAM]: json(notLinked) },
        '/account',
      );

      expect(wrapper.find('[aria-labelledby="telegram-group-heading"]').exists()).toBe(false);
      expect(wrapper.text()).not.toContain('Link house group');
    });

    it('shows the /linkgroup command to send in the group', async () => {
      const server = fakeServer({
        [ME]: json(session()),
        [TELEGRAM]: json(notLinked),
        'POST /api/telegram/group-link': json({
          code: 'grp456',
          expiresAt,
          command: '/linkgroup grp456',
        }),
      });
      const { wrapper } = await mountApp(server, '/account');
      mounted = wrapper;
      const group = () => wrapper.get('[aria-labelledby="telegram-group-heading"]');
      expect(group().text()).toContain('Not linked');

      await buttonLabelled(wrapper, 'Link house group')?.trigger('click');
      await flushPromises();

      const box = wrapper.get('.link-box');
      expect(box.text()).toContain('Add the bot to the house group');
      expect((box.get('input').element as HTMLInputElement).value).toBe('/linkgroup grp456');

      server.handlers[TELEGRAM] = json({ ...notLinked, groupLinked: true });
      await buttonLabelled(wrapper, 'Refresh status')?.trigger('click');
      await flushPromises();

      expect(wrapper.find('.link-box').exists()).toBe(false);
      expect(group().text()).toContain('Linked');
    });

    it('asks for confirmation before unlinking the group', async () => {
      const server = fakeServer({
        [ME]: json(session()),
        [TELEGRAM]: json({ ...notLinked, groupLinked: true }),
        'DELETE /api/telegram/group-link': new Response(null, { status: 204 }),
      });
      const { wrapper } = await mountApp(server, '/account');
      mounted = wrapper;

      await buttonLabelled(wrapper, 'Unlink group')?.trigger('click');
      expect(server.callsTo('DELETE /api/telegram/group-link')).toHaveLength(0);
      expect(wrapper.text()).toContain('Stop sending reminders to the house group?');

      await buttonLabelled(wrapper, 'Keep linked')?.trigger('click');
      expect(wrapper.text()).not.toContain('Stop sending reminders');

      await buttonLabelled(wrapper, 'Unlink group')?.trigger('click');
      server.handlers[TELEGRAM] = json(notLinked);
      await buttonLabelled(wrapper, 'Unlink group')?.trigger('click');
      await flushPromises();

      expect(server.callsTo('DELETE /api/telegram/group-link')).toHaveLength(1);
      expect(wrapper.get('[aria-labelledby="telegram-group-heading"]').text()).toContain(
        'Not linked',
      );
      expect(wrapper.text()).not.toContain('Stop sending reminders');
    });
  });
});

describe('app shell', () => {
  it('shows the household and navigation, and logging out returns to /login', async () => {
    const { wrapper, router } = await open(
      {
        [ME]: json(session()),
        'POST /api/auth/logout': json({ ok: true }),
        'GET /api/setup': json({ needsSetup: false }),
        'GET /api/occurrences': json({ occurrences: [] }),
        'GET /api/members': json({ members: [] }),
      },
      '/',
    );

    expect(wrapper.find('.brand-name').text()).toBe('The Smiths');
    expect(wrapper.findAll('.nav-top a').map((a) => a.text())).toEqual([
      'Today',
      'Coming up',
      'Tasks',
      'People',
      'Account',
    ]);
    expect(wrapper.find('h1').text()).toBe('Today');
    expect(wrapper.text()).toContain('Nothing is due today');

    const { useSessionStore } = await import('../stores/session.js');
    await useSessionStore().logout();
    await flushPromises();

    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('login'));
  });

  it('offers a retry when the api cannot be reached', async () => {
    let up = false;
    const { wrapper, router } = await open(
      { [ME]: () => (up ? json(session()) : apiError(502, 'bad_gateway', 'Bad gateway')) },
      '/',
    );
    expect(router.currentRoute.value.name).toBe('unavailable');
    expect(wrapper.text()).toContain('Bad gateway');

    up = true;
    await wrapper.find('button').trigger('click');
    await flushPromises();

    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('home'));
  });
});
