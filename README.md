# Intelligent Tracker

A self-hosted shared to-do list and chore helper. It supports repeating jobs and assignable
people, and it sends **anticipatory reminders**, such as "car insurance renews in 30 days, start
getting quotes". It talks to you over Telegram and publishes a calendar feed that Google Calendar can subscribe to.

Runs locally with Docker Compose, with a Vue web UI.

> Status: Milestone 0.1 in progress. Planning is done (decisions agreed: TypeScript, per-member
> login, Cloudflare Tunnel for the calendar feed, one house Telegram group, rule-based smarts,
> UK defaults). In place so far: the monorepo and CI, the Docker Compose stack, the database
> schema, the recurrence engine, per-member auth, the tasks & occurrences API with a worker
> that materialises occurrences, and the web app shell (first-run setup, login, invites, people
> and account pages; the task views come next). See [docs/PLAN.md](docs/PLAN.md) for the
> architecture, data model, reminder design and the PR-by-PR implementation plan.

## Repository layout

```
apps/
  api/        Fastify HTTP API: auth, tasks, occurrences, OpenAPI document
  worker/     scheduler tick: materialises occurrences, plans and queues reminders, delivers in-app notifications
  bot/        Telegram bot (grammY, long polling): links the house group and members, delivers reminders with buttons, commands and digests
  web/        Vue 3 SPA (Vite, Pinia, Vue Router, PrimeVue) with a typed API client
packages/
  core/       pure domain logic: recurrence, rotation, reminder planning
  db/         Drizzle schema, SQL migrations, migration runner, seed data
  shared/     schemas, types and defaults shared across apps
deploy/       Caddyfile and Docker Compose files
e2e/          Playwright end-to-end tests (run against a running stack)
scripts/      build and local-run helpers
docs/         design and implementation plan
Dockerfile    one backend image (api/worker/bot) and the Caddy web image
compose.yaml  root entry point that includes deploy/docker-compose.yml
```

It is a pnpm workspace; every package is named `@tracker/<name>` and is consumed from source
(`exports` points at `src/index.ts`), so no build step is needed for typechecking or tests.

## Prerequisites

- Node.js 22 (see `.nvmrc`)
- pnpm 10, via Corepack: `corepack enable` (the version is pinned by `packageManager` in `package.json`)

## Development

```sh
pnpm install            # install all workspace dependencies
pnpm test               # run every package's tests once (Vitest)
pnpm test:watch         # Vitest in watch mode
pnpm test:coverage      # tests with coverage; the recurrence engine, rotation and reminder planner must stay at 100%
pnpm typecheck          # tsc --noEmit in every package
pnpm lint               # ESLint (zero warnings allowed)
pnpm format             # Prettier, write
pnpm format:check       # Prettier, check only
```

`packages/core` is pure domain logic with no I/O. Its recurrence engine (`src/recurrence`) expands
RFC 5545 rules in the household time zone (Europe/London by default, so "every day at 08:00" survives
BST/GMT changes), handles all-day vs timed dues and "N days after completion" tasks, and decides
which occurrences to materialise ahead of time. See `packages/core/src/recurrence/index.ts` for the API.
The reminder planner (`src/reminders`) is a pure `planReminders` function that turns one occurrence, its task and the
household settings into the heads-up, milestone, nudge, due and overdue reminders to send (see its doc comment for the rules).
The quick-add parser (`src/quick-add`) turns a line such as "Car insurance renews 1/11 every year, sort it a
month before" into a task: `chrono.en.GB` dates (day-first), a small recurrence grammar ("every other Tuesday",
"last Friday of the month", "every 6 weeks after done"), lead-time and "night before" phrases, `@Sam` / "for Sam"
assignees and template matching for anything left unsaid. Words it does not understand stay in the title.
`src/quick-add/corpus.test.ts` holds the UK-phrased examples it must keep parsing. The web app's quick-add bar
(Today and All tasks) and the bot's `/add` both show its result as a preview to confirm before saving.

`pnpm build` bundles each backend app into `apps/<name>/dist/main.js` (esbuild) and builds the SPA
with Vite. Outside Docker you can run `pnpm --filter @tracker/api dev` (tsx watch) and
`pnpm --filter @tracker/web dev` (Vite on :5173, proxying `/api` and `/ical` to
`VITE_API_PROXY_TARGET`, default `http://localhost:3000`).

The web app's API client is typed from the OpenAPI document. After running `pnpm openapi` (or
otherwise changing `apps/api/openapi.json`), run `pnpm --filter @tracker/web api:generate` to
refresh `apps/web/src/api/schema.d.ts`; a test fails if it is out of date. On a fresh database the
first visit to the web app starts the setup wizard, which creates the household and its admin; the
admin then invites everyone else from the People page.

CI (`.github/workflows/ci.yml`) runs `format:check`, `lint`, `typecheck`, `test`, `test:coverage` and `build` on
pushes to `main` and on every pull request. A `db` job checks the schema against the migrations,
applies them to a Postgres 16 service container and runs the database and auth API integration tests, and a
`docker` job builds the images once from the PR's code, starts the stack with a faster worker
tick, smoke-tests it (including that the api migrated and seeded the database) and runs the
Playwright tests against it (see below).

## End-to-end tests

Browser tests live in `e2e/` (`@tracker/e2e`, Playwright with Chromium) and drive a running stack
through its real UI; they are not part of `pnpm test`. They need a **fresh database**, because the
first spec walks the first-run setup wizard, which only works while no household exists.

```sh
# 1. Start the stack on an empty database, with the worker ticking every 2 seconds
docker compose -f compose.yaml -f deploy/docker-compose.build.yml -f deploy/docker-compose.e2e.yml up -d --build --wait

# 2. One-off: install the browser (CI does this with --with-deps)
pnpm --filter @tracker/e2e exec playwright install chromium

# 3. Run the tests against http://localhost:8080 (override with E2E_BASE_URL)
pnpm test:e2e

# 4. Reset the database (also needed before running them a second time)
docker compose -f compose.yaml -f deploy/docker-compose.build.yml -f deploy/docker-compose.e2e.yml down -v
```

Without Docker, `scripts/e2e-local.sh up` starts a throwaway Postgres 16 (binaries from
`/usr/lib/postgresql/16/bin`, override with `PG_BIN`), the api, the worker and the built SPA on
<http://localhost:8080>, always from an empty database; `scripts/e2e-local.sh down` stops it and
deletes the data. Failed runs leave traces in `e2e/test-results` (open one with
`pnpm --filter @tracker/e2e exec playwright show-trace <trace.zip>`); local runs also write an
HTML report to `e2e/playwright-report`. Tests run in en-GB with the Europe/London time zone.

## Database

The schema lives in `packages/db/src/schema` (Drizzle ORM, Postgres 16) and the generated SQL
migrations are committed in `packages/db/migrations`. The `api` applies pending migrations (guarded
by a Postgres advisory lock) and seeds reference data (bank holidays) every time it starts, if
`DATABASE_URL` is set. To work on the database from the host, point `DATABASE_URL` at a running
Postgres (for example the dev compose `db` on `localhost:5432`, see `.env.example`; the scripts
read the repo-root `.env`):

```sh
pnpm db:migrate             # apply pending migrations
pnpm db:seed                # upsert reference data (England & Wales bank holidays)
pnpm db:seed -- --demo      # ...and create a "Home" household with UK defaults if none exists
pnpm db:generate --name add_thing   # after editing the schema: write a new migration to commit
pnpm db:check               # fail if the schema has changes that no migration covers
```

The integration tests need a Postgres server and are skipped without one. Give them a connection
string for any database on the server; each run creates (and drops) its own throwaway database:

```sh
TEST_DATABASE_URL=postgres://tracker:tracker@localhost:5432/postgres pnpm test
```

## Authentication

Every member has their own login (no shared account). The first visit to a fresh install creates
the household and its admin (`GET`/`POST /api/setup`, only while no household exists); the admin
then invites the others (`POST /api/invites`), which returns a one-time link where the invitee
chooses their own password. Admins can issue a password-reset link for any member
(`POST /api/members/:id/password-reset`), which also signs that member out everywhere. Links
expire (invites after 7 days, resets after 1 day) and work once.

- Passwords are hashed with Argon2id (`hash-wasm`, WebAssembly, so it works in the single-file
  production bundle) and stored as PHC strings.
- A login sets an HTTP-only, `SameSite=Lax` session cookie holding a random token; only its
  SHA-256 hash is stored in the `session` table. Sessions last a day, or 30 days with "remember
  me". Logout deletes the row.
- Mutating requests on a session need an `X-CSRF-Token` header (returned by login, setup and
  `GET /api/auth/me`). Cross-origin `Origin` headers are refused and only JSON bodies are accepted.
- Failed logins are rate limited in memory: 5 per username and 10 per IP per 15 minutes, then 429.

Settings (see `.env.example`): `PUBLIC_BASE_URL` (used to build invite links), `COOKIE_SECURE`
(defaults to on when `PUBLIC_BASE_URL` is https) and `TRUST_PROXY` (set in the Docker compose file,
since the api sits behind Caddy).

## Tasks and occurrences

A **task** is the definition (title, schedule, lead time, assignees, milestones); its
**occurrences** are the concrete dated instances people complete. Every member sees and edits
everything in their household. All routes need a session (and the CSRF header on mutations):

- `GET/POST /api/tasks`, `GET/PATCH/DELETE /api/tasks/:id`: CRUD. `PATCH` with `archived: true`
  archives; changing the schedule replaces the future open occurrences.
- `GET /api/occurrences?view=today|upcoming|overdue&memberId=&taskId=&days=`: open, unsnoozed
  occurrences. "Today" is the household's local day; `today` includes overdue ones (listed first),
  ones whose lead time has started, and undated ones.
- `POST /api/occurrences/:id/complete|skip|snooze|start`. Completing or skipping an
  `after_completion` task creates (and returns as `next`) its next occurrence.

Occurrences are materialised when a task is saved and on every worker tick (each minute,
`TICK_INTERVAL_MS`): fixed schedules are kept `max(90, lead time + 30)` days ahead, and
`upcoming` ones become `active` when their start arrives. Ticks are idempotent (inserts dedupe on
task + due) and serialised across workers by a Postgres advisory lock.

The same tick keeps reminders in step with the planner: it queues the `planned` reminders that are
due as `in_app` rows in the notification outbox (one per recipient, deduplicated by `dedupe_key`;
reminders more than a day late are cancelled instead), then re-plans occurrences so edits,
snoozes and completions take effect within a minute. An occurrence is only re-planned when
something the planner reads has changed (a fingerprint of its inputs is kept in
`occurrence.reminder_plan_hash`); otherwise the tick only adds the overdue reminders that are
missing (none on a day that already has a reminder), which rolls the overdue horizon forward.
That is what lets a snooze or away period hold a reminder back to a later time and still have it
sent then, after the snooze or away period has ended. A due reminder whose occurrence was edited
since the last tick is first checked against the planner, and only sent if it still has it at
that time. It goes to the occurrence's current assignee, or to every
household member when it has none. After the transaction commits it delivers the outbox (retries
with exponential backoff, gives up after 8 attempts), deletes notifications past their retention
(in-app ones read over 30 days ago, and delivered or failed ones over 90 days old; pending ones
never) at most once an hour, and records the worker's `service_heartbeat`. It also queues one
`telegram_group` notification per due reminder for a household with a linked group; the bot delivers those.

The Telegram bot (`apps/bot`, grammY, long polling) needs `TELEGRAM_BOT_TOKEN` and `DATABASE_URL`;
without either it idles. Leave BotFather's group privacy mode on: the bot only reacts to commands
and button presses. An admin links the house group by sending `/linkgroup <code>` in it, and each
member links their Telegram with `t.me/<bot>?start=<code>`; both codes come from the web app. Every
`DELIVERY_INTERVAL_MS` (default 10 seconds) the bot sends the group reminders that are due as one
message per household, with a mention for each assignee and ✅ Done / ▶️ Started / ⏰ Snooze / ⏭ Skip
buttons. A press is attributed to the member behind the Telegram user, and the message is edited in
place to show the result. Long titles and names are cut with "…" so a message always fits Telegram's
4096 characters, and reminders that were due more than 24 hours ago (the bot was down) are given up
instead of posted late. A Telegram account that is already connected to a member is never moved by
someone else's link: it has to be disconnected in the app first, and a `/linkgroup` code is used up
even when the group is refused.

The bot also answers these commands in the house group (in a private chat it points you there, and
in any other group it stays silent):

| Command        | What it does                                                                              |
| -------------- | ----------------------------------------------------------------------------------------- |
| `/today`       | Today's jobs: overdue, due today and starting soon, plus coming bank holidays             |
| `/week`        | The next 7 days, a block per day, overdue jobs first                                      |
| `/mine`        | Your own jobs for the next 7 days (you must have connected Telegram)                      |
| `/digest`      | The morning digest on demand (the same text as `/today`)                                  |
| `/away <date>` | Away until that date, as `24/12` or `24/12/2026`; `/away off` clears it, `/away` shows it |
| `/add <text>`  | Quick-add a job, e.g. `/add MOT due 14/03, remind me a month before`; confirm with Save   |

`/add` runs the rule-based quick-add parser (below) and replies with a confirmation card showing
what it understood, with ✅ Save, ✏️ Edit in app (opens the web app's quick-add preview) and ✖️ Cancel.
Nothing is saved until the member who sent it taps Save; an unsaved card goes out of date after a day.

The bot posts a morning digest at the household's morning slot every day and a "week ahead" at the
evening slot on Sundays (each at most once a day, and only when there is something on; a digest
more than 2 hours late is skipped). Reminders that fire at the evening slot are posted as
"Tonight's jobs", quickest first, and an overdue reminder on a `persistent` task that is still not
done after 3 days is marked 🚨. Its tests use a mocked Telegram API (`pnpm exec vitest run --project @tracker/bot`
with `TEST_DATABASE_URL` set).

The OpenAPI document is served at `GET /api/openapi.json` and committed as `apps/api/openapi.json`
(the web app's typed client is generated from it). After changing a route, run `pnpm openapi`;
a test fails while the committed file is out of date.

## Running with Docker

All commands run from the repo root. No `.env` is needed to try it out; to customise, copy
`.env.example` to `.env` (ports, Postgres credentials, secrets, timezone).

`deploy/docker-compose.yml` (what a plain `docker compose` uses) is the production setup and runs
the [published images](#published-images). To build and run the checked-out code instead, add
`deploy/docker-compose.build.yml`, which builds the images under local names:

```sh
docker compose -f compose.yaml -f deploy/docker-compose.build.yml up -d --build --wait   # or: pnpm docker:up
```

Then open <http://localhost:8080> (`WEB_PORT` changes the port). Caddy serves the SPA, which
calls `/api/health`, and proxies `/api/*` and `/ical/*` to the `api` container. Services: `db`
(Postgres 16, data in the `db-data` volume), `api`, `worker`, `bot` (the same backend image with
different commands) and `web` (Caddy). Each has a healthcheck; check with `docker compose ps`.
Stop with `docker compose down` (add `-v` to also delete the database volume). The Cloudflare
tunnel and backup services come in later PRs.

For development with hot reload (`tsx watch` for the backend, the Vite dev server for the web):

```sh
docker compose -f compose.yaml -f deploy/docker-compose.dev.yml up --build   # or: pnpm docker:dev
```

The web UI is at <http://localhost:5173>, the API at <http://localhost:3000> and Postgres at
`localhost:5432` (all bound to loopback except the web port). Only `src` directories are
mounted, so rebuild (`--build`) after changing dependencies or config files.

### Published images

CI's `docker` job builds the two images once and runs the smoke and end-to-end tests against them.
On a push to `main` it also saves them as a short-lived `images` artifact, and when CI passes,
`.github/workflows/publish-images.yml` pushes those exact images (no rebuild) to the GitHub
Container Registry:

- `ghcr.io/kallb123/intelligent-tracker-backend` (api, worker and bot)
- `ghcr.io/kallb123/intelligent-tracker-web` (Caddy and the SPA)

Each is tagged with the app version and `latest`. The app version is the `version` field in the
root `package.json` (semver); it is the one version for the whole app, and the `version` fields in
the workspace packages are not used. Version tags are never overwritten: if the version is already
published, the workflow skips the push, so bump the version in any PR that changes what ships in
the images. A failed publish can be retried by re-running it within a day, while the `images`
artifact is kept; after that, re-run CI on `main` (or push a new commit) to produce a fresh one.

`deploy/docker-compose.yml` (the production compose file) uses these images. Set
`TRACKER_VERSION` in `.env` to pin a version (default `latest`), then:

```sh
docker compose pull
docker compose up -d --wait
```

GHCR packages start out private: either make them public in the package settings on GitHub, or
run `docker login ghcr.io` on the server with a token that has `read:packages`. The production
file has no `build` section, so a failed pull is an error rather than a silent build from source.
