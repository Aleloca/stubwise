# syntax=docker/dockerfile:1

# Build multi-stage del server Fastify in un monorepo pnpm.
# - stage "base": dipendenze di TUTTO il workspace (lockfile + tutti i
#   package.json) installate una volta, poi sorgenti e `pnpm -r build`.
# - stage "deploy": `pnpm deploy` estrae un node_modules pulito di sola
#   produzione per @stubwise/server (con le workspace deps copiate dentro
#   node_modules/@stubwise/*), incluso packages/db/drizzle che runMigrations
#   risolve relativo al package a runtime.
# - stage finale: solo Node + l'output di deploy. Niente toolchain di build.

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /repo

# Manifest del workspace: copiati prima dei sorgenti così il layer di install
# viene messo in cache finché lockfile/package.json non cambiano.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/git/package.json packages/git/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/notifications/package.json packages/notifications/package.json
COPY packages/i18n/package.json packages/i18n/package.json

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Sorgenti + build di tutti i package (tsc per package).
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/server apps/server
RUN pnpm --filter @stubwise/server... build

# node_modules di sola produzione, autoconsistente, per il solo server.
# --legacy: pnpm 10 senza inject-workspace-packages usa il deploy "legacy"
# che copia le workspace deps risolte (con il loro dist e, per @stubwise/db,
# la cartella drizzle delle migrazioni) dentro node_modules/@stubwise/*.
RUN pnpm --filter @stubwise/server deploy --prod --legacy /app

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Utente non-root.
RUN useradd --create-home --uid 10001 stubwise
COPY --from=base --chown=stubwise:stubwise /app /app
USER stubwise

EXPOSE 3000
# Healthcheck: il server espone /health. Node nativo, niente curl nell'immagine.
HEALTHCHECK --interval=10s --timeout=5s --start-period=40s --retries=10 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
