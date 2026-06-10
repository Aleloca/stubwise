# syntax=docker/dockerfile:1

# Build del bundle statico Vite della web app (intent del piano: "build
# statici"). In produzione i file statici li serve Caddy: l'immagine web vera è
# Dockerfile.caddy alla radice, che ribuilda la dist e la copia in /srv/web
# (vedi docker-compose.yml, dove il servizio `caddy` fa da web server + reverse
# proxy). Questo Dockerfile resta come build autonoma della dist: utile per
# verificare il bundle in isolamento (`docker build -f apps/web/Dockerfile .`).

FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/git/package.json packages/git/package.json
COPY packages/sdk/package.json packages/sdk/package.json

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages packages
COPY apps/web apps/web
# La web dipende da @stubwise/shared (build con `...`).
# La dist risultante è in /repo/apps/web/dist (la serve Caddy in produzione).
RUN pnpm --filter @stubwise/web... build
