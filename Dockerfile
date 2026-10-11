# syntax=docker/dockerfile:1
#
# Targets:
#   backend  one image for api / worker / bot (default CMD runs the api; compose overrides it)
#   web      Caddy serving the built SPA and proxying /api and /ical to the api
#   dev      full source + dev dependencies, used by deploy/docker-compose.dev.yml

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# pnpm version comes from "packageManager" in package.json
RUN corepack enable
WORKDIR /app

# Dependencies: only manifests and the lockfile are copied, so this layer is reused
# until dependencies actually change.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch
COPY e2e/package.json e2e/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/bot/package.json apps/bot/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline

# Dev image: dependencies plus the full source (compose bind-mounts src over it for hot reload).
FROM deps AS dev
COPY . .
CMD ["pnpm", "--filter", "@tracker/api", "dev"]

# Each backend app is bundled by esbuild into a single self-contained apps/<name>/dist/main.js.
FROM dev AS build-backend
RUN pnpm --filter @tracker/api --filter @tracker/worker --filter @tracker/bot build

FROM dev AS build-web
RUN pnpm --filter @tracker/web build

FROM node:${NODE_VERSION}-alpine AS backend
ENV NODE_ENV=production
# The api applies these on start. The esbuild bundle can't find them relative to its own file,
# so the runner reads the folder from MIGRATIONS_DIR.
ENV MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build-backend --chown=node:node /app/apps/api/dist apps/api/dist
COPY --from=build-backend --chown=node:node /app/apps/worker/dist apps/worker/dist
COPY --from=build-backend --chown=node:node /app/apps/bot/dist apps/bot/dist
COPY --from=build-backend --chown=node:node /app/packages/db/migrations migrations
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]

FROM caddy:2-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build-web /app/apps/web/dist /srv
EXPOSE 80
