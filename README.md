# Intelligent Tracker

A self-hosted shared to-do list and chore helper. It supports repeating jobs and assignable
people, and it sends **anticipatory reminders**, such as "car insurance renews in 30 days, start
getting quotes". It talks to you over Telegram and publishes a calendar feed that Google Calendar can subscribe to.

Runs locally with Docker Compose, with a Vue web UI.

> Status: scaffolding in progress. Planning is done (decisions agreed: TypeScript, per-member
> login, Cloudflare Tunnel for the calendar feed, one house Telegram group, rule-based smarts,
> UK defaults) and PR 1 (monorepo + CI) is in place: the workspace packages are empty
> placeholders. See [docs/PLAN.md](docs/PLAN.md) for the architecture, data model, reminder
> design and the PR-by-PR implementation plan.

## Repository layout

```
apps/
  api/        HTTP API (placeholder)
  worker/     scheduler tick and reminder delivery (placeholder)
  bot/        Telegram bot (placeholder)
  web/        Vue 3 SPA (placeholder, browser-flavoured tsconfig)
packages/
  core/       pure domain logic: recurrence, rotation, reminder planning
  db/         database schema, migrations, repositories
  shared/     schemas, types and defaults shared across apps
docs/         design and implementation plan
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
pnpm typecheck          # tsc --noEmit in every package
pnpm lint               # ESLint (zero warnings allowed)
pnpm format             # Prettier, write
pnpm format:check       # Prettier, check only
```

CI (`.github/workflows/ci.yml`) runs `format:check`, `lint`, `typecheck` and `test` on pushes to
`main` and on every pull request.
