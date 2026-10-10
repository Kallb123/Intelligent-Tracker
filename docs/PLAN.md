# Intelligent Tracker — Plan

A self-hosted, shared to-do list and chore helper for a household (or any small group).
It runs locally on Docker Compose, has a Vue web UI, talks to people over Telegram,
and publishes a calendar feed that Google Calendar can subscribe to.

What makes it more than a to-do list is **anticipatory reminders**. It knows that
"car insurance renews on 1 Nov" means "start getting quotes around 1 Oct". It nags
more as the deadline gets closer, and it stays quiet about things that don't need
attention yet.

---

## 1. Goals and non-goals

### Goals
- **Shared list:** one household, many members. Everyone sees everything; each task has an owner.
- **Repeating jobs:** daily, weekly, monthly, yearly, custom (RFC 5545 RRULE), and
  "N days after it was last done" (for flexible chores like "clean the oven").
- **Assignment:** a fixed person, several people, "anyone", or a **rotation**
  (round-robin per occurrence, skipping anyone who is away).
- **Intelligent reminders:** lead times / prep windows, milestones, escalation, quiet hours,
  digests, and suggestions that learn from history.
- **Telegram:** a single **house group chat** is the channel. Reminders @mention the
  assignee and have one-tap actions (Done / Snooze / Started / Reassign), and there's
  quick-add from chat and a daily digest.
- **Google Calendar:** a read-only iCalendar (ICS) feed per person and per household,
  reachable by Google through a tunnel.
- **Local-first:** `docker compose up`, data in a local Postgres volume, no required cloud
  services and no AI/LLM dependency. All the "intelligence" is rule-based and explainable.
- **UK by default:** Europe/London time zone, DD/MM dates, weeks start on Monday,
  UK bank holidays, and a UK template pack (MOT, car tax, TV licence, Self Assessment…).

### Decisions

| Question | Decision |
|---|---|
| Backend language | **TypeScript** end-to-end |
| Auth | **A login for each member** (no shared login or kiosk mode) |
| Calendar exposure | **Tunnel is OK.** Cloudflare Tunnel exposes only `/ical/*` |
| Telegram | **One house group.** No personal DMs, except a one-off DM to link your account |
| Smart features | **Rule-based only.** No LLM |
| Locale | **UK** |

### Non-goals (for v1)
- Two-way Google Calendar sync. Read-only ICS is enough to start (see backlog).
- Native mobile apps. The web UI is responsive and installable as a PWA; Telegram covers push.
- Multi-tenant SaaS hosting. The data model has a `household` so this stays possible later.

---

## 2. Architecture

```
                    ┌──────────────────────── docker compose ────────────────────────┐
                    │                                                                  │
  Browser  ───────► │  web (Caddy)  ──/api──►  api (Fastify)  ───────►  db (Postgres)  │
  (Vue SPA / PWA)   │   serves SPA               REST + auth             ▲      ▲      │
                    │   /ical/* ──────────────►  ICS feeds                │      │      │
                    │                                                     │      │      │
                    │  worker  (same image) ── scheduler tick, materialise │      │      │
                    │                          occurrences, plan & send ───┘      │      │
                    │                          reminders (outbox)                 │      │
                    │                                                             │      │
  Telegram  ◄─────► │  bot     (same image) ── long-polling, commands, buttons ───┘      │
                    │                                                                  │
                    │  tunnel  (optional profile: cloudflared / tailscale funnel)      │
                    │          exposes ONLY /ical/* so Google can fetch the feed        │
                    └──────────────────────────────────────────────────────────────────┘
```

**Why this shape**
- **One backend image with three entrypoints** (`api`, `worker`, `bot`). They share code and
  can be restarted and scaled independently. A slow Telegram API can't stall the HTTP server.
- **Telegram long polling, not webhooks.** No public URL or TLS is needed for the bot,
  which suits a home server.
- **Postgres as the only stateful dependency.** Scheduling uses a DB-backed tick plus an
  idempotent `notification` outbox, so there's no Redis or message broker to run.
- **The Google Calendar caveat:** Google fetches subscribed ICS URLs **from Google's
  servers**, so the feed must be reachable from the internet. The optional `tunnel`
  profile exposes only `/ical/*` (token-protected) and keeps the UI and API private.
  Google also refreshes subscribed calendars slowly (often every 8–24h), so the calendar
  is for *visibility*. Telegram handles *timely* reminders.

### Tech stack (recommended)

| Concern | Choice | Rationale |
|---|---|---|
| Language | TypeScript end-to-end | Shared types/validation between UI, API, bot |
| Monorepo | pnpm workspaces | Simple, fast, good Docker layer caching |
| API | Fastify + Zod (`fastify-type-provider-zod`) | Typed routes, OpenAPI generation |
| DB / ORM | Postgres 16 + Drizzle ORM + drizzle-kit migrations | SQL-first, typed, lightweight |
| Recurrence | `rrule` (RFC 5545) + Luxon for time zones | Same format the ICS feed uses; DST-safe |
| Telegram | grammY | Modern, typed, good inline-keyboard/conversation support |
| ICS | `ical-generator` | Mature VEVENT/VALARM generation |
| NL dates | `chrono-node` (`chrono.en.GB`, day-first) | Parses "every Monday", "1/11", "1st Nov", "in 2 weeks" the UK way |
| Web UI | Vue 3 + Vite + Pinia + Vue Router + PrimeVue (or Vuetify) | Component library speeds up forms/calendars |
| Tests | Vitest (unit/integration), Playwright (e2e) | Playwright is already usable in CI |
| Reverse proxy | Caddy | Serves the SPA, proxies `/api` and `/ical`, simple config |
| CI | GitHub Actions | lint, typecheck, test, docker build |

### Repository layout

```
apps/
  api/        Fastify HTTP API + ICS endpoints
  worker/     scheduler tick: materialise occurrences, plan reminders, deliver outbox
  bot/        Telegram bot (grammY, long polling)
  web/        Vue 3 SPA
packages/
  core/       PURE domain logic: recurrence, rotation, reminder planner, suggestions
  db/         Drizzle schema, migrations, repositories
  shared/     Zod schemas + types shared by web/api/bot
deploy/
  Caddyfile
  docker-compose.yml, docker-compose.dev.yml, .env.example
docs/
```

`packages/core` has no I/O. It is the heavily unit-tested heart of the app (recurrence,
DST, rotation fairness, reminder planning). The worker and bot are thin adapters around it.

---

## 3. Domain model

```
household (id, name, timezone='Europe/London', locale='en-GB',
           bank_holiday_region='england-and-wales', ical_public_host='calendar.kallum.uk',
           telegram_group_chat_id?, default_reminder_profile,
           morning_slot='08:00', evening_slot='19:00', quiet_hours{start='21:30',end='07:30'})
member    (id, household_id, name, email/username, role[admin|member], password_hash,
           telegram_user_id?, telegram_link_code?, preferred_reminder_times[],
           away_until?, ical_token)
session   (id, member_id, expires_at, user_agent)
bank_holiday (date, region[england-and-wales|scotland|northern-ireland], title)

task  (the definition / "series")
  id, household_id, title, notes, category, tags[], priority,
  reminder_slot: evening | morning | custom_time,  -- default evening
  effort_minutes?,                 -- used by the reminder planner
  schedule_kind: once | fixed | after_completion
  due: date | datetime (+ all_day flag), rrule?, interval_after_completion?,
  lead_time?                       -- "start thinking about it N days before"
  reminder_profile: silent | gentle | standard | persistent
  assignment_mode: fixed | any | rotation
  assignees[] (ordered, for rotation), rotation_cursor,
  template_id?, archived_at?

task_milestone   (task_id, title, offset_days_before_due, order)
                 -- e.g. "Get 3 quotes" -30d, "Decide" -14d, "Pay" -7d

occurrence (a concrete instance of a task)
  id, task_id, due_at / due_date, start_at (= due - lead_time),
  assignee_id?, status: upcoming | active | started | done | skipped,
  completed_at?, completed_by?, snoozed_until?, milestone_progress jsonb

reminder      (occurrence_id, member_id, kind[heads_up|milestone|nudge|due|overdue|digest],
               fire_at, status[planned|sent|cancelled], channel[telegram_group|in_app])
notification  (outbox: id, member_id?, channel, payload, dedupe_key UNIQUE,
               telegram_message_id?, sent_at?, attempts, last_error)
activity      (who did what, when; drives history-based suggestions)
template      (built-in + user templates: title, category, rrule, lead_time,
               milestones, profile, keywords[])
```

Key rules:
- **Time:** store instants in UTC. All-day dues are stored as plain `date`. Recurrence
  expands in the household time zone, so "every day at 08:00" survives DST changes.
- **Materialisation:** the worker keeps occurrences materialised for a rolling horizon:
  `max(90 days, lead_time + 30 days)` and at least the next occurrence. Yearly tasks with a
  30-day lead therefore always have their next instance (and its reminders) planned early enough.
- **after_completion:** the next occurrence is created when the current one is completed
  (`completed_at + interval`). "Descale kettle about every 6 weeks" drifts with reality.
- **Rotation:** each new occurrence takes the next assignee in order. Members with
  `away_until` covering the due date are skipped. Completion by someone else is recorded
  so fairness stats stay accurate. Optional effort-weighted balancing comes later.

---

## 4. Intelligent reminders

The **reminder planner** is a pure function in `packages/core`:

```
planReminders(occurrence, task, assignee prefs, household prefs, now) -> Reminder[]
```

It is re-run whenever anything relevant changes (edit, snooze, start, reassign, complete).
Unsent reminders are replaced, and the outbox's `dedupe_key` prevents double sends.

### 4.1 Prep window (lead time)
Each task can have a `lead_time`, giving a **start date** separate from the due date.
Before `start_at` the task is hidden from "Today" and only appears under "Coming up".
At `start_at` the assignee gets a **heads-up**:

> 🚗 *Car insurance renews in 30 days (1 Nov).* Time to start getting quotes.
> [Started] [Snooze 3d] [Not mine]

### 4.2 Milestones
Bigger tasks can carry milestones with offsets relative to the due date, such as
"Get quotes" −30d, "Decide" −14d, "Pay" −7d. Each milestone gets its own reminder
and can be ticked off on its own.

### 4.3 Escalation that respects state
Between `start_at` and `due`, nudges get closer together as the deadline approaches.
The default `standard` profile nudges at about 50%, 75% and 90% of the window, then on
the due day, then during overdue. Every nudge is snapped to a household reminder slot
(see 4.5), and nudges are always at least 1 day apart.
- Tapping **Started** turns the next nudges down a level (you're on it).
- **Done** cancels everything. **Snooze** shifts the next reminder only.
- `silent` (digest only), `gentle` (heads-up + due day), and `persistent` (daily when overdue,
  with a louder "still overdue after N days" message) cover the rest.

### 4.4 Event-anchored ("the night before") tasks
Some jobs happen *before* an event. "Bins are collected Tuesday morning" means
"put bins out Monday 19:00". The planner supports a negative `remind_offset` relative to
the event, so the reminder fires the evening before instead of on the due day.

### 4.5 Delivery hygiene
- **Two daily slots.** Reminders are delivered in two household-wide slots instead of at
  arbitrary times:
  - **Morning, 08:00:** a short digest for planning the day: *Today*, *Starting soon*, *Overdue*,
    and bank holidays. It's informational and has no nagging.
  - **Evening, 19:00: "Tonight's jobs".** This is the main slot, because it's when the kids
    are settling and things actually get done. Nudges, milestones, due-today and overdue chores land
    here with action buttons, sorted so quick jobs (low `effort_minutes`) come first.

  Each task defaults to the evening slot and can be switched to morning or a specific time
  (e.g. "take meds 07:30"). Evening-before tasks like bin night also land at 19:00.
- **Quiet hours** 21:30–07:30 (household-wide, because everything goes to one group). A snooze
  that would land in quiet hours moves to the next slot. Nothing fires at 03:00.
- **Group-friendly batching:** a shared group gets noisy quickly, so each slot sends one message
  with a line per task, each with its own buttons, instead of a message per task. There's also an
  optional Sunday 19:00 "week ahead".
- **Bank-holiday aware:** UK bank holidays (from the gov.uk feed, cached in the DB) can shift
  tasks that are flagged "working days only", and show up in the digest
  ("Bank holiday Monday: bin collection may be a day late").
- **Workload smoothing:** when several prep windows open the same week, the planner
  staggers heads-ups across days so one person doesn't get a wall of reminders on the 1st.
- **Away mode:** reminders for an away member go to the next person in a rotation, or are
  held until they're back.

### 4.6 Smart defaults (anticipation without effort)
- **UK template library** with sensible lead times and milestones:

  | Template | Recurrence | Lead / milestones |
  |---|---|---|
  | Car insurance renewal | yearly | 30d: get quotes −30d (prices are often lowest ~3–4 weeks out), decide −14d, renew −7d |
  | MOT | yearly from expiry date | 30d: book −30d (an MOT up to a month minus a day early keeps the renewal date) |
  | Car tax (VED) | yearly/monthly | 14d |
  | Car service | yearly or by mileage note | 21d |
  | Home insurance | yearly | 30d, same milestones as car insurance |
  | TV licence | yearly | 14d |
  | Passport renewal | from expiry date | 3 months: check photo/forms −3mo, apply −10w |
  | Driving licence photocard | every 10 years from expiry | 2 months |
  | Self Assessment return + payment | yearly 31 Jan | 6 weeks: gather docs −6w, file −2w |
  | Payment on account | yearly 31 Jul | 14d |
  | Boiler service | yearly | 21d |
  | Energy / broadband / mobile contract end | from end date | 6 weeks: compare deals −6w, switch −3w |
  | Birthdays & anniversaries | yearly | 14d: buy gift/card −14d, post card −4d |
  | Smoke/CO alarm test | monthly | none |
  | Clocks change | last Sun Mar / Oct | 2d heads-up |
  | Bin night | weekly/fortnightly (recycling vs general alternate) | evening-before reminder |
- **UK formats everywhere:** DD/MM/YYYY, 24h or 12h per member, £, weeks start on Monday.
- **Keyword heuristics:** typing "renew home insurance" suggests the insurance template's
  lead time and milestones. Suggestions are always shown for the user to accept, never applied silently.
- **Effort-aware lead time:** if there's no lead time but `effort_minutes` is large, a short
  prep window is proposed.

### 4.7 Learning from history
For each task series, the `activity` table records: completion offset vs due (median),
how often reminders are snoozed, and time from heads-up to "Started". From that the app can suggest:
- *"You've finished this an average of 4 days late the last 3 times. Start reminding 1 week earlier?"*
- *"Reminders for this are always snoozed twice. Move the reminder time to the evening?"*
- *"Alex has done 70% of rotation chores this month."* (fairness nudge)

These show up as accept/dismiss cards in the UI and Telegram. Nothing changes unless someone accepts.

### 4.8 Rule-based quick-add
Quick-add turns *"car insurance renews 1 Nov every year, sort it a month before"* into a task.
It runs in stages, and each stage is unit-tested against a corpus of example phrases:
1. `chrono.en.GB` extracts dates (day-first, so "1/11" is 1 November).
2. A small recurrence grammar handles "every day/week/fortnight/month/year", "every other Tuesday",
   "on weekdays", "last Friday of the month", "every 6 weeks after done", and similar.
3. Lead-time phrases: "a month before", "2 weeks ahead", "remind me the night before".
4. Assignee: "@Sam" or "for Sam".
5. Template match: keywords such as "insurance", "MOT" or "passport" fill in any gaps
   (lead time, milestones, profile).

The result is always shown as a preview/confirmation card (in the UI or in Telegram) before it's
saved. Anything the parser didn't understand is left in the title, not guessed.

---

## 5. Integrations

### 5.1 Telegram
- **Setup:** create a bot with @BotFather and put `TELEGRAM_BOT_TOKEN` in `.env`.
Everything goes to **one house group chat**.

- **Group setup (admin, once):** in the web UI, Settings → Telegram shows a one-time code. Add the
  bot to the house group and send `/linkgroup <code>`. The bot stores the group's `chat_id`
  and ignores every other group.
- **Member linking (each person, once):** buttons in a group can be pressed by anyone, so the bot
  needs to know which Telegram user is which member. In the web UI each member clicks
  "Connect Telegram", which opens `t.me/<bot>?start=<one-time code>`. That one-off private chat
  records their `telegram_user_id`. After that, all interaction happens in the group.
- **Mentions:** reminders tag the assignee with a `tg://user?id=…` mention, which notifies them
  even if they've muted the group (provided they haven't turned off mention notifications).
  Rotation and "anyone" tasks tag the current assignee, or say "Anyone 🙋".
- **Inline buttons on every reminder:** ✅ Done · ▶️ Started · ⏰ Snooze (tonight / tomorrow evening / weekend / 3d) ·
  🔁 Reassign · ⏭ Skip this one. The press is attributed to whoever tapped it ("✅ Done by Sam").
  A tap from an unlinked Telegram user gets a private pop-up alert asking them to link first.
  After an action, the original message is edited in place (struck through / updated) instead of
  posting a new one, to keep the group tidy.
- **Commands:** `/today`, `/week`, `/mine`, `/add <text>`, `/away <date>`, `/digest`.
  The bot runs with Telegram **privacy mode on**, so it only sees commands, replies to its own
  messages, and @mentions. It never reads normal family chat.
- **Quick-add from the group:** `/add MOT due 14/03, remind a month before` or a reply to the bot
  goes through the rule-based parser, then a confirmation card with [Save] [Edit in app] [Cancel].
- **Digests:** the 08:00 morning digest, the 19:00 "Tonight's jobs" message and an optional Sunday
  "week ahead" are posted to the group. Snooze options are "Tonight 19:00", "Tomorrow evening",
  "Weekend" and "3 days".

### 5.2 Google Calendar (ICS feed)
- `GET /ical/{token}/me.ics`: the member's assigned occurrences.
- `GET /ical/{token}/household.ics`: everything.
- Each **occurrence** is emitted as its own VEVENT with a stable `UID` (`occ-<id>@intelligent-tracker`)
  instead of an RRULE, so rotations, skips and completions show correctly. Window: −30d … +365d.
- All-day dues become all-day events. Optional **"🔔 Start: …"** events mark the start of prep windows.
  Done items get a ✅ prefix (or are hidden, per feed setting).
- Tokens are 32+ random bytes, can be regenerated from the UI, and the feeds are read-only.
- **Exposure:** a `cloudflared` service (Cloudflare Tunnel, free tier, no open router ports) points
  **`calendar.kallum.uk`** at Caddy. Caddy serves **only** `/ical/*` on that
  hostname, returns 404 for everything else, and rate-limits it. The UI and API stay LAN-only, or
  you can reach them over Tailscale if you want access away from home. The docs also cover
  Tailscale Funnel as an alternative.

---

## 6. Web UI (Vue)

- **Today:** active and due-today items grouped by person, overdue at the top, with one-click complete.
- **Coming up:** prep windows opening soon, with a timeline of the next 30/90 days.
- **All tasks:** filter by person, category, or tag; search.
- **Task editor:** title, notes, due, a **recurrence builder** (daily/weekly/monthly/yearly/custom/after-completion)
  with a live "next 5 dates" preview, assignment mode, lead time, milestones, reminder profile,
  and "Apply template" with suggestions.
- **Quick-add bar** with natural language and a parse preview.
- **People:** members, rotation order, away dates, Telegram link status, fairness stats.
- **Settings:** household time zone, bank-holiday region, morning/evening slot times, quiet hours, Telegram group
  link, calendar feed URLs (copy/regenerate).
- **Suggestions inbox:** history-based suggestions to accept or dismiss.
- **Auth:** a login for each member (username/email + password, argon2 hashes) with an HTTP-only,
  SameSite=Lax session cookie stored server-side, plus CSRF protection on mutating routes.
  The first-run wizard creates the admin, and the admin invites the other members with one-time
  invite links in which they set their own password. Admins can reset passwords. Login attempts
  are rate-limited. "Remember me" sessions last 30 days.
- **PWA** manifest so it installs to phone home screens.

---

## 7. Deployment and operations

- `docker compose up -d` brings up `db`, `api`, `worker`, `bot`, `web`, `tunnel` (cloudflared).
  The tunnel is on by default. It only starts when `CLOUDFLARE_TUNNEL_TOKEN` is set, so the
  rest of the stack works without it.
- `.env.example` documents: `DATABASE_URL`, `SESSION_SECRET`, `PUBLIC_BASE_URL`, `TZ`,
  `TELEGRAM_BOT_TOKEN`, `CLOUDFLARE_TUNNEL_TOKEN`, `ICAL_PUBLIC_HOST`, `BANK_HOLIDAY_REGION`.
- Migrations run automatically on `api` start (guarded by an advisory lock).
- Healthchecks on every service. The worker writes a heartbeat row, and `/api/health` reports
  whether it is stale.
- **Backups:** a `backup` sidecar runs `pg_dump` nightly to a mounted volume and keeps N days.
- Logs: pino JSON to stdout.
- First run: a setup wizard in the UI creates the household (Europe/London, en-GB, England & Wales
  bank holidays, 08:00/19:00 slots) and the first admin, then offers to install the UK template pack.

---

## 8. Implementation plan (PRs)

Each PR is small enough to review in one sitting, ships with tests, and leaves `main`
deployable. Milestones mark points where the app is usable.

### Milestone 0.1: usable shared to-do list (web only)

| # | PR | Scope | Done when |
|---|----|-------|-----------|
| 1 | **Scaffold monorepo + CI** | pnpm workspaces, TS configs, ESLint/Prettier, Vitest, empty `api`/`worker`/`bot`/`web`/`core`/`db`/`shared` packages, GitHub Actions (lint, typecheck, test), `README` | CI green on an empty project |
| 2 | **Docker Compose skeleton** | Multi-stage Dockerfile (one backend image, three commands), web build served by Caddy, Postgres with volume + healthchecks, `.env.example`, dev compose with hot reload | `docker compose up` serves a "hello" SPA calling `/api/health` |
| 3 | **DB schema + migrations** | Drizzle schema for household, member, session, task, task_milestone, occurrence, activity, bank_holiday; migration runner with advisory lock; seed script (UK defaults) | Migrations apply cleanly in CI against a Postgres service container |
| 4 | **Core: recurrence engine** | `packages/core`: RRULE expansion in Europe/London, all-day vs timed, `after_completion`, fortnightly/alternating patterns, materialisation horizon; property-style tests incl. BST↔GMT changes and month-end edge cases | 100% branch coverage on the recurrence module |
| 5 | **Auth: per-member login (API)** | First-run setup (household + admin), argon2 passwords, server-side sessions, CSRF, login rate limiting, one-time invite links for members, admin password reset, role checks | Integration tests for setup/invite/login/logout/permissions |
| 6 | **Tasks & occurrences API** | CRUD for tasks; list occurrences (today/upcoming/overdue/by member); complete/skip/snooze/start; worker skeleton that materialises occurrences on a tick; OpenAPI output | API integration tests; worker tick is idempotent |
| 7 | **Vue app shell + auth** | Vite/Vue 3/Pinia/Router/PrimeVue, typed API client generated from OpenAPI, setup wizard, login, accept-invite page, layout/nav, en-GB date formatting, PWA manifest | Can set up, invite a second member, log in as them |
| 8 | **Vue task views + editor** | Today / Coming up / All tasks; task editor with recurrence builder and "next 5 dates" preview; complete/snooze from list | Playwright smoke test: create a weekly task and complete it |

### Milestone 0.2: people and reminders in the house Telegram group

| # | PR | Scope | Done when |
|---|----|-------|-----------|
| 9 | **Assignment modes + rotation** | fixed / any / rotation in core + API + UI; away mode; People page; per-person filters | Unit tests for rotation with skips/away; UI shows next assignee |
| 10 | **Reminder planner v1 (core)** | Pure `planReminders`: lead time / start_at, milestones, profiles, escalation, morning/evening slots, household quiet hours, evening-before offsets | Table-driven tests, incl. the car-insurance and bin-night examples |
| 11 | **Worker: reminder scheduling + outbox** | Persist planned reminders; re-plan on change; outbox with `dedupe_key`, retries, backoff; in-app notifications + UI bell; worker heartbeat | Kill/restart the worker mid-run → no duplicate or lost reminders |
| 12 | **Telegram bot: group + member linking, reminders** | `bot` service (grammY, long polling, privacy mode on); `/linkgroup <code>`; deep-link member linking; deliver batched reminders to the group with `tg://user` mentions and inline buttons; attribute button presses to the member; edit messages in place after actions; pop-up for unlinked users | Tested with a mocked Telegram API; manual test in a real group |
| 13 | **Telegram commands + digests** | `/today` `/week` `/mine` `/add` `/away` `/digest`; 08:00 morning digest; 19:00 "Tonight's jobs"; Sunday "week ahead"; overdue escalation messages | Digest snapshot tests |

### Milestone 0.3: Google Calendar

| # | PR | Scope | Done when |
|---|----|-------|-----------|
| 14 | **ICS feeds** | `/ical/{token}/me.ics` and `household.ics`, per-occurrence VEVENTs, prep-window events, token regenerate UI | Feed validates (icalendar validator) and imports into Google Calendar |
| 15 | **Cloudflare Tunnel + docs** | `tunnel` service (cloudflared, starts only with a token); Caddy host-based rule serving only `/ical/*` on the public hostname; rate limiting; `docs/google-calendar.md` (tunnel setup, subscribe in Google, refresh caveats) | Step-by-step guide verified end to end; non-`/ical` paths 404 on the public host |

### Milestone 0.4: the "intelligent" part (all rule-based)

| # | PR | Scope | Done when |
|---|----|-------|-----------|
| 16 | **UK template pack + bank holidays** | Built-in UK templates (section 4.6) with milestones; user templates; keyword → template suggestions in the editor; gov.uk bank-holiday sync (`england-and-wales` division, weekly, cached); "working days only" option | Suggestion unit tests; "Apply template" in UI; bank holidays shown in digest |
| 17 | **Rule-based quick-add (en-GB)** | `chrono.en.GB` + recurrence grammar + lead-time phrases + assignee + template match (section 4.8); quick-add bar in UI and `/add` in Telegram with confirm card | Corpus of ~80 UK-phrased examples with expected parses |
| 18 | **Workload smoothing + effort-aware leads** | Stagger heads-ups across days; propose lead time from effort | Planner tests for clustered windows |
| 19 | **History-based suggestions** | Activity analytics (lateness, snoozes, fairness); suggestions inbox in UI + Telegram; accept → updates task | Tests with synthetic histories |

### Milestone 1.0: hardening

| # | PR | Scope |
|---|----|-------|
| 20 | **Backups + restore docs** | `backup` sidecar, retention, `docs/backup-restore.md` |
| 21 | **E2E + release pipeline** | Fuller Playwright suite against compose in CI; versioned images pushed to GHCR; `CHANGELOG` |

### Backlog (post-1.0)
- Two-way Google Calendar sync via the Calendar API (OAuth); create events in a dedicated calendar for near-real-time updates.
- Optional personal Telegram DMs for private tasks (e.g. gift buying you don't want the group to see).
- Private tasks hidden from other members in the UI and feeds.
- Web Push notifications (PWA) as a second channel next to Telegram.
- Points/streaks for chores; weekly fairness report.
- Shopping list / pantry as a task type.
- Home Assistant integration (sensors for "overdue chores", trigger tasks from automations).
- Attachments (e.g. insurance documents) and per-task links.

---

## 9. Worked example: car insurance

1. Alex types `/add Car insurance renews 1/11 every year, sort it a month before` in the house group.
2. The parser reads "1/11" day-first as 1 November and matches the car insurance template.
   The bot replies with a confirmation card: yearly on 1 Nov, all-day, lead 30d, milestones
   *Get quotes* (−30d), *Decide* (−14d), *Renew* (−7d), profile `standard`, assignee Alex.
   Alex taps [Save].
3. The worker materialises the 1 Nov occurrence (horizon ≥ lead + 30d) and plans the reminders:
   - 2 Oct 19:00: heads-up + *Get quotes* milestone
   - 18 Oct 19:00: *Decide* milestone
   - 25 Oct 19:00: *Renew* milestone
   - nudges at 19:00 at about 50% / 75% / 90% of the window if not Started, then 1 Nov due-day, then daily overdue
4. At 19:00 on 2 Oct the group's "Tonight's jobs" message includes: *"🚗 @Alex Car insurance renews in 30 days (1 Nov). Time to get
   quotes."* [✅ Done] [▶️ Started] [⏰ Snooze] [🔁 Reassign]. Alex taps **Started**. The message
   updates to "▶️ Started by Alex", and the planner turns the nudges down a level but keeps the milestones.
5. Google Calendar shows "🔔 Start: Car insurance" on 2 Oct and "Car insurance renewal" on 1 Nov.
6. Alex taps **Done** on 20 Oct. Remaining reminders are cancelled and next year's occurrence is
   already planned. If it keeps getting done late, PR 19 suggests a longer lead time.

---

## 10. Settled details

- Public calendar hostname: **`calendar.kallum.uk`**. It needs `kallum.uk` on Cloudflare so the tunnel can create the DNS record.
- Bank holidays: **England & Wales** (`england-and-wales` in the gov.uk feed).
- Reminder slots: **08:00** morning digest, **19:00** evening "Tonight's jobs" (the main slot).
  Quiet hours 21:30–07:30. All of these can be changed in Settings.
