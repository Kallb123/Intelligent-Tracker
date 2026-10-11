import { flushPromises, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Sam',
      username: 'sam',
      email: null,
      role: 'member',
      pending: true,
    },
    {
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Jo',
      username: 'jo',
      email: null,
      role: 'member',
      pending: false,
    },
  ];

  it('lists members, flags pending invites, and lets admins invite', async () => {
    const server = fakeServer({
      [ME]: json(session()),
      'GET /api/members': json({ members }),
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
      { [ME]: json(session({ role: 'member' })), 'GET /api/members': json({ members }) },
      '/people',
    );

    expect(wrapper.text()).not.toContain('Invite member');
    expect(wrapper.text()).not.toContain('Reset password');
    expect(wrapper.findAll('.member')).toHaveLength(3);
  });
});

describe('AccountPage', () => {
  it('changes the password', async () => {
    const server = fakeServer({
      [ME]: json(session()),
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

describe('app shell', () => {
  it('shows the household and navigation, and logging out returns to /login', async () => {
    const { wrapper, router } = await open(
      {
        [ME]: json(session()),
        'POST /api/auth/logout': json({ ok: true }),
        'GET /api/setup': json({ needsSetup: false }),
      },
      '/',
    );

    expect(wrapper.find('.brand-name').text()).toBe('The Smiths');
    expect(wrapper.findAll('.nav-top a').map((a) => a.text())).toEqual([
      'Today',
      'People',
      'Account',
    ]);
    expect(wrapper.find('h1').text()).toBe('Today');
    expect(wrapper.text()).toContain('Hi Alex');

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
