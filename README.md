# Intelligent Tracker

A self-hosted shared to-do list and chore helper. It supports repeating jobs and assignable
people, and it sends **anticipatory reminders**, such as "car insurance renews in 30 days, start
getting quotes". It talks to you over Telegram and publishes a calendar feed that Google Calendar can subscribe to.

Runs locally with Docker Compose, with a Vue web UI.

> Status: scaffolding in progress. Planning is done (decisions agreed: TypeScript, per-member
> login, Cloudflare Tunnel for the calendar feed, one house Telegram group, rule-based smarts,
> UK defaults), PR 1 (monorepo + CI) is in place, PR 2 (Docker Compose skeleton) adds a
> runnable stack with a "hello" SPA and PR 3 adds the database schema and migrations; the other
> workspace packages are still placeholders. See [docs/PLAN.md](docs/PLAN.md) for the architecture, data model, reminder
> design and the PR-by-PR implementation plan.

## Repository layout

```
apps/
  api/        Fastify HTTP API (just GET /api/health so far)
  worker/     scheduler tick and reminder delivery (idles with a heartbeat)
  bot/        Telegram bot (idles with a heartbeat)
  web/        Vite SPA (a "hello" page for now; Vue 3 arrives later)
packages/
  core/       pure domain logic: recurrence, rotation, reminder planning
  db/         Drizzle schema, SQL migrations, migration runner, seed data
  shared/     schemas, types and defaults shared across apps
deploy/       Caddyfile and Docker Compose files
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
pnpm test:coverage      # tests with coverage; the recurrence engine must stay at 100%
pnpm typecheck          # tsc --noEmit in every package
pnpm lint               # ESLint (zero warnings allowed)
pnpm format             # Prettier, write
pnpm format:check       # Prettier, check only
```

`packages/core` is pure domain logic with no I/O. Its recurrence engine (`src/recurrence`) expands
RFC 5545 rules in the household time zone (Europe/London by default, so "every day at 08:00" survives
BST/GMT changes), handles all-day vs timed dues and "N days after completion" tasks, and decides
which occurrences to materialise ahead of time. See `packages/core/src/recurrence/index.ts` for the API.

`pnpm build` bundles each backend app into `apps/<name>/dist/main.js` (esbuild) and builds the SPA
with Vite. Outside Docker you can run `pnpm --filter @tracker/api dev` (tsx watch) and
`pnpm --filter @tracker/web dev` (Vite on :5173, proxying `/api` and `/ical` to
`VITE_API_PROXY_TARGET`, default `http://localhost:3000`).

CI (`.github/workflows/ci.yml`) runs `format:check`, `lint`, `typecheck`, `test`, `test:coverage` and `build` on
pushes to `main` and on every pull request. A `db` job checks the schema against the migrations,
applies them to a Postgres 16 service container and runs the database integration tests, and a
`docker` job builds the images, starts the stack and smoke-tests it (including that the api
migrated and seeded the database).

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

## Running with Docker

All commands run from the repo root. No `.env` is needed to try it out; to customise, copy
`.env.example` to `.env` (ports, Postgres credentials, secrets, timezone).

```sh
docker compose up -d --build --wait   # or: pnpm docker:up
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
