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
# `pnpm install` del workspace compila le dipendenze native in onlyBuiltDependencies
# (root package.json), tra cui node-pty del worker — che non ha prebuild Linux e
# ricade su `node-gyp rebuild` (richiede python3/make/g++). La toolchain serve quindi
# anche qui (stage base) perché l'install dell'intero workspace non fallisca; resta
# fuori dal runtime finale (lo stage `runtime` copia solo /app via `pnpm deploy`, che
# per il server non include node-pty).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
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
# `@stubwise/agent` è un devDependency del server (solo per il test d'integrazione
# monitor-agent, che gira in CI/locale, non qui) e NON serve al runtime del server.
# Il `...` lo tirerebbe nel grafo di build, ma il suo package.json non è tra i
# manifest copiati sopra → le sue deps non sono installate e `tsc` fallirebbe.
# Lo escludiamo esplicitamente; `deploy --prod` più sotto già lo omette dall'output.
RUN pnpm --filter "@stubwise/server..." --filter "!@stubwise/agent" build

# node_modules di sola produzione, autoconsistente, per il solo server.
# --legacy: pnpm 10 senza inject-workspace-packages usa il deploy "legacy"
# che copia le workspace deps risolte (con il loro dist e, per @stubwise/db,
# la cartella drizzle delle migrazioni) dentro node_modules/@stubwise/*.
RUN pnpm --filter @stubwise/server deploy --prod --legacy /app

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# git CLI: il retrieval dal grafo nelle chat (apps/server/src/graph-chat) legge
# gli snippet di codice dai mirror bare del worker, montati READ-ONLY nel
# compose (`git --git-dir=<MIRRORS_DIR>/<slug> show <sha>:<path>`). Serve nel
# RUNTIME, non solo in build. Il server non clona nulla: legge e basta.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*
# Utente non-root.
RUN useradd --create-home --uid 10001 stubwise
COPY --from=base --chown=stubwise:stubwise /app /app
USER stubwise

EXPOSE 3000
# Healthcheck: il server espone /health. Node nativo, niente curl nell'immagine.
HEALTHCHECK --interval=10s --timeout=5s --start-period=40s --retries=10 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
