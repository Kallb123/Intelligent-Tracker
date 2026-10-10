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
- **Telegram:** reminders with one-tap actions (Done / Snooze / Started / Reassign),
  quick-add from chat, and daily digests to individuals or a household group.
- **Google Calendar:** a read-only iCalendar (ICS) feed per person and per household.
- **Local-first:** `docker compose up`, data in a local Postgres volume, no required cloud services.

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
| NL dates | `chrono-node` | Parses "every Monday", "1 Nov", "in 2 weeks" |
| Web UI | Vue 3 + Vite + Pinia + Vue Router + PrimeVue (or Vuetify) | Component library speeds up forms/calendars |
| Tests | Vitest (unit/integration), Playwright (e2e) | Playwright is already usable in CI |
| Reverse proxy | Caddy | Serves the SPA, proxies `/api` and `/ical`, simple config |
| CI | GitHub Actions | lint, typecheck, test, docker build |

> If you'd rather use Python for the backend (FastAPI + SQLAlchemy + python-telegram-bot +
> `dateutil.rrule` + `icalendar`), the architecture, data model and PR plan stay the same.
> Only the tech table changes.

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
household (id, name, timezone, default_reminder_profile)
member    (id, household_id, name, role[admin|member], password_hash,
           telegram_chat_id?, telegram_link_code?, preferred_reminder_times[],
           quiet_hours{start,end}, digest_time, away_until?, ical_token)

task  (the definition / "series")
  id, household_id, title, notes, category, tags[], priority,
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
               fire_at, status[planned|sent|cancelled], channel[telegram|in_app])
notification  (outbox: id, member_id, channel, payload, dedupe_key UNIQUE,
               sent_at?, attempts, last_error)
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
the due day, then during overdue. Every nudge is snapped to the member's preferred times
(e.g. 08:30 / 18:30), and nudges are always at least 1 day apart.
- Tapping **Started** turns the next nudges down a level (you're on it).
- **Done** cancels everything. **Snooze** shifts the next reminder only.
- `silent` (digest only), `gentle` (heads-up + due day), and `persistent` (daily when overdue,
  and the household group is told after N days overdue) cover the rest.

### 4.4 Event-anchored ("the night before") tasks
Some jobs happen *before* an event. "Bins are collected Tuesday morning" means
"put bins out Monday 19:00". The planner supports a negative `remind_offset` relative to
the event, so the reminder fires the evening before instead of on the due day.

### 4.5 Delivery hygiene
- **Quiet hours** and per-member reminder times. Nothing fires at 03:00.
- **Digest batching:** if more than N reminders land in the same slot, they're combined into
  one message. There is also an optional morning digest: *Today*, *Starting soon*, *Overdue*.
- **Workload smoothing:** when several prep windows open the same week, the planner
  staggers heads-ups across days so one person doesn't get a wall of reminders on the 1st.
- **Away mode:** reminders for an away member go to the next person in a rotation, or are
  held until they're back.

### 4.6 Smart defaults (anticipation without effort)
- **Template library** with sensible lead times and milestones, for example: car insurance (30d),
  vehicle inspection/MOT (30d), home insurance (30d), passport renewal (3 months),
  tax return (6 weeks), boiler service (21d), birthdays/anniversaries (gift: 14d),
  subscription renewals (7d), bin night (evening-before).
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

### 4.8 Optional LLM assist (off by default)
A pluggable `Assistant` interface handles natural-language quick-add ("car insurance renews 1 Nov
every year, sort it a month before" → task + rrule + lead time + milestones) and lead-time
suggestions for things the template library doesn't cover. There are two providers: the Claude API
(model configurable via env var) or a local Ollama model for fully offline use. The rule-based
parser (`chrono-node` + templates) is always the fallback, so the app works fully without an LLM.

---

## 5. Integrations

### 5.1 Telegram
- **Setup:** create a bot with @BotFather and put `TELEGRAM_BOT_TOKEN` in `.env`.
- **Linking:** in the web UI a member clicks "Connect Telegram", which opens
  `t.me/<bot>?start=<one-time code>`. The bot stores their `chat_id`. The bot ignores
  unlinked chats except for `/start`.
- **Household group (optional):** add the bot to a group and run `/linkgroup` (admin only). Group
  digests and overdue escalations post there. Personal reminders always go by direct message.
- **Commands:** `/today`, `/week`, `/mine`, `/add <text>`, `/done`, `/snooze`, `/away <date>`, `/digest`.
- **Inline buttons on every reminder:** ✅ Done · ▶️ Started · ⏰ Snooze (1h / tonight / tomorrow / 3d) ·
  🔁 Reassign · ⏭ Skip this one.
- **Free text** to the bot goes through quick-add (rule-based, or the LLM if enabled), followed by a confirmation card.

### 5.2 Google Calendar (ICS feed)
- `GET /ical/{token}/me.ics`: the member's assigned occurrences.
- `GET /ical/{token}/household.ics`: everything.
- Each **occurrence** is emitted as its own VEVENT with a stable `UID` (`occ-<id>@intelligent-tracker`)
  instead of an RRULE, so rotations, skips and completions show correctly. Window: −30d … +365d.
- All-day dues become all-day events. Optional **"🔔 Start: …"** events mark the start of prep windows.
  Done items get a ✅ prefix (or are hidden, per feed setting).
- Tokens are 32+ random bytes, can be regenerated from the UI, and the feeds are read-only.
- Docs explain the tunnel options (Cloudflare Tunnel or Tailscale Funnel) and include a Caddy rule
  that exposes **only** `/ical/*` publicly.

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
- **Settings:** household time zone, digest times, quiet hours, calendar feed URLs (copy/regenerate),
  LLM provider toggle.
- **Suggestions inbox:** history-based suggestions to accept or dismiss.
- **Auth:** per-member username + password with an HTTP-only session cookie (argon2).
  A shared **kiosk mode** for a kitchen tablet uses a "who are you?" picker with an optional PIN.
- **PWA** manifest so it installs to phone home screens.

---

## 7. Deployment and operations

- `docker compose up -d` brings up `db`, `api`, `worker`, `bot`, `web`. Run `--profile tunnel` to add `cloudflared`.
- `.env.example` documents: `DATABASE_URL`, `SESSION_SECRET`, `PUBLIC_BASE_URL`, `TZ`,
  `TELEGRAM_BOT_TOKEN`, `ASSISTANT_PROVIDER` (`none|claude|ollama`), `ANTHROPIC_API_KEY`, `OLLAMA_URL`.
- Migrations run automatically on `api` start (guarded by an advisory lock).
- Healthchecks on every service. The worker writes a heartbeat row, and `/api/health` reports
  whether it is stale.
- **Backups:** a `backup` sidecar runs `pg_dump` nightly to a mounted volume and keeps N days.
- Logs: pino JSON to stdout.
- First run: a setup wizard in the UI creates the household and the first admin.

---

## 8. Implementation plan (PRs)

Each PR is small enough to review in one sitting, ships with tests, and leaves `main`
deployable. Milestones mark points where the app is usable.

### Milestone 0.1: usable shared to-do list (web only)

| # | PR | Scope | Done when |
|---|----|-------|-----------|
| 1 | **Scaffold monorepo + CI** | pnpm workspaces, TS configs, ESLint/Prettier, Vitest, empty `api`/`web`/`core`/`db`/`shared` packages, GitHub Actions (lint, typecheck, test), `README` | CI green on an empty project |
| 2 | **Docker Compose skeleton** | Multi-stage Dockerfile (one backend image, three commands), web build served by Caddy, Postgres with volume + healthchecks, `.env.example`, dev compose with hot reload | `docker compose up` serves a "hello" SPA calling `/api/health` |
| 3 | **DB schema + migrations** | Drizzle schema for household, member, task, task_milestone, occurrence, activity; migration runner with advisory lock; seed script | Migrations apply cleanly in CI against a Postgres service container |
| 4 | **Core: recurrence engine** | `packages/core`: RRULE expansion in household TZ, all-day vs timed, `after_completion`, materialisation horizon; property-style tests incl. DST and month-end edge cases | 100% branch coverage on the recurrence module |
| 5 | **Auth + setup wizard (API)** | Sessions, argon2, first-run household/admin creation, member CRUD (admin), role checks | Integration tests for login/logout/permissions |
| 6 | **Tasks & occurrences API** | CRUD for tasks; list occurrences (today/upcoming/overdue/by member); complete/skip/snooze/start; worker skeleton that materialises occurrences on a tick; OpenAPI output | API integration tests; worker tick is idempotent |
| 7 | **Vue app shell + auth** | Vite/Vue 3/Pinia/Router/PrimeVue, typed API client generated from OpenAPI, login + setup wizard, layout/nav, PWA manifest | Can log in and see an empty Today page |
| 8 | **Vue task views + editor** | Today / Coming up / All tasks; task editor with recurrence builder and "next 5 dates" preview; complete/snooze from list | Playwright smoke test: create a weekly task and complete it |

### Milestone 0.2: people and reminders over Telegram

| # | PR | Scope | Done when |
|---|----|-------|-----------|
| 9 | **Assignment modes + rotation** | fixed / any / rotation in core + API + UI; away mode; People page; per-person filters | Unit tests for rotation with skips/away; UI shows next assignee |
| 10 | **Reminder planner v1 (core)** | Pure `planReminders`: lead time / start_at, milestones, profiles, escalation, preferred times, quiet hours, evening-before offsets | Table-driven tests, incl. the car-insurance and bin-night examples |
| 11 | **Worker: reminder scheduling + outbox** | Persist planned reminders; re-plan on change; outbox with `dedupe_key`, retries, backoff; in-app notifications channel + UI bell; worker heartbeat | Kill/restart the worker mid-run → no duplicate or lost reminders |
| 12 | **Telegram bot: linking + outbound** | `bot` service (grammY, long polling); deep-link account linking; deliver outbox items with inline buttons; handle Done/Started/Snooze/Skip/Reassign callbacks | Tested with a mocked Telegram API; manual test with a real bot |
| 13 | **Telegram commands + digests + group** | `/today` `/week` `/mine` `/add` `/away` `/digest`; morning digest; batching; household group linking and overdue escalation | Digest snapshot tests |

### Milestone 0.3: Google Calendar

| # | PR | Scope | Done when |
|---|----|-------|-----------|
| 14 | **ICS feeds** | `/ical/{token}/me.ics` and `household.ics`, per-occurrence VEVENTs, prep-window events, token regenerate UI | Feed validates (icalendar validator) and imports into Google Calendar |
| 15 | **Public exposure profile + docs** | `tunnel` compose profile (cloudflared), Caddy rule exposing only `/ical/*`, rate limiting, `docs/google-calendar.md` | Step-by-step guide verified end to end |

### Milestone 0.4: the "intelligent" part

| # | PR | Scope | Done when |
|---|----|-------|-----------|
| 16 | **Template library + keyword suggestions** | Built-in templates (insurance, MOT, passport, tax, boiler, birthdays, bins…), user templates, keyword → template suggestions in the editor | Suggestion unit tests; "Apply template" in UI |
| 17 | **Natural-language quick-add** | `chrono-node` + template parser in core; quick-add bar in UI and free-text in Telegram with confirm card | Corpus of ~50 example phrases with expected parses |
| 18 | **Workload smoothing + effort-aware leads** | Stagger heads-ups across days; propose lead time from effort | Planner tests for clustered windows |
| 19 | **History-based suggestions** | Activity analytics (lateness, snoozes, fairness); suggestions inbox in UI + Telegram; accept → updates task | Tests with synthetic histories |
| 20 | **Optional LLM assistant** | `Assistant` interface; Claude API and Ollama providers; used for quick-add and lead-time suggestions; strict JSON-schema output validated with Zod; rule-based fallback; off by default | Works with `ASSISTANT_PROVIDER=none` unchanged; provider tests with recorded fixtures |

### Milestone 1.0: hardening

| # | PR | Scope |
|---|----|-------|
| 21 | **Backups + restore docs** | `backup` sidecar, retention, `docs/backup-restore.md` |
| 22 | **Kiosk mode** | Shared-tablet "who are you?" picker with PIN |
| 23 | **E2E + release pipeline** | Fuller Playwright suite against compose in CI; versioned images pushed to GHCR; `CHANGELOG` |

### Backlog (post-1.0)
- Two-way Google Calendar sync via the Calendar API (OAuth); create events in a dedicated calendar for near-real-time updates.
- Web Push notifications (PWA) as a second channel next to Telegram.
- Points/streaks for chores; weekly fairness report.
- Shopping list / pantry as a task type.
- Home Assistant integration (sensors for "overdue chores", trigger tasks from automations).
- Attachments (e.g. insurance documents) and per-task links.
- Multiple households per instance.

---

## 9. Worked example: car insurance

1. A member types *"Car insurance renews 1 Nov every year, sort it a month before"* in quick-add.
2. The parser plus the insurance template propose: yearly on 1 Nov, all-day, lead 30d, milestones
   *Get quotes* (−30d), *Decide* (−14d), *Pay/renew* (−7d), profile `standard`, assignee = whoever typed it.
3. The worker materialises the 1 Nov occurrence (horizon ≥ lead + 30d) and plans the reminders:
   - 2 Oct 08:30: heads-up + *Get quotes* milestone
   - 18 Oct 08:30: *Decide* milestone
   - 25 Oct 08:30: *Pay/renew* milestone
   - nudges at about 50% / 75% / 90% of the window if not Started, then 1 Nov due-day, then daily overdue
4. On 2 Oct the Telegram message arrives. The member taps **Started**, so the planner turns
   the nudges down a level and keeps the milestones.
5. Google Calendar shows "🔔 Start: Car insurance" on 2 Oct and "Car insurance renewal" on 1 Nov.
6. The member taps **Done** on 20 Oct. Remaining reminders are cancelled and next year's occurrence is
   already planned. If it keeps getting done late, PR 19 suggests a longer lead time.

---

## 10. Open questions

1. **Backend language:** TypeScript (recommended, shared types with Vue) or Python?
2. **Household size and auth:** is per-member login needed, or is a single shared login with a
   "who are you" picker enough?
3. **Calendar exposure:** is it OK to expose `/ical/*` through Cloudflare Tunnel or Tailscale Funnel?
   If not, Google Calendar can't subscribe, and the alternative is the Calendar API push (backlog).
4. **Telegram:** personal DMs, a household group, or both?
5. **LLM assist:** should the Claude API / Ollama option be built at all, or should it stay purely rule-based?
6. **Locale defaults:** which country's templates should be built in (e.g. MOT, TV licence, tax deadlines)?
