# syntax=docker/dockerfile:1

# Build del bundle statico Vite della web app. L'ultimo stage ("dist") contiene
# SOLO i file statici sotto /dist: lo serve Caddy (vedi Dockerfile.caddy alla
# radice, che copia da questo build, e docker-compose.yml).

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
RUN pnpm --filter @stubwise/web... build

# Stage finale: solo i file statici. Usato come sorgente da Dockerfile.caddy.
FROM scratch AS dist
COPY --from=build /repo/apps/web/dist /dist
