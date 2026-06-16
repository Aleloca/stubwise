# syntax=docker/dockerfile:1

# Build multi-stage del worker AI in un monorepo pnpm (stesso schema del
# server). Il runtime in più richiede:
#  - git CLI: il worker clona/aggiorna i mirror ed esegue worktree effimere.
#  - claude CLI (@anthropic-ai/claude-code): l'AgentRunner lo invoca per
#    triage e fix.
#  - una HOME scrivibile per l'utente: il login OAuth/MAX di claude scrive
#    ~/.claude (montata come volume nel compose, vedi CLAUDE_CONFIG_DIR).

FROM node:22-slim AS base
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
COPY packages/notifications/package.json packages/notifications/package.json
COPY packages/i18n/package.json packages/i18n/package.json

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages packages
COPY apps/worker apps/worker
RUN pnpm --filter @stubwise/worker... build

RUN pnpm --filter @stubwise/worker deploy --prod --legacy /app

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# git per i mirror; claude CLI installato globalmente. ca-certificates per le
# connessioni HTTPS (clone su provider git, API Anthropic).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @anthropic-ai/claude-code \
  && npm cache clean --force

# Utente non-root con HOME: claude vi scrive le credenziali del login.
RUN useradd --create-home --uid 10001 worker
COPY --from=base --chown=worker:worker /app /app

# Directory dei mirror git persistenti (montata come volume nel compose).
RUN mkdir -p /var/stubwise/mirrors && chown -R worker:worker /var/stubwise
ENV MIRRORS_DIR=/var/stubwise/mirrors

# Directory di config di claude (montata come volume claude-config nel compose).
# Va creata con ownership worker PRIMA che USER cambi: un volume nominato vuoto
# eredita l'ownership della dir dell'immagine al primo mount, altrimenti Docker
# la crea root-owned e claude (uid 10001) non può scrivervi la session-env
# (EACCES) — il che gli impedisce di eseguire la shell e quindi i test.
RUN mkdir -p /home/worker/.claude && chown -R worker:worker /home/worker/.claude

USER worker
ENV HOME=/home/worker
# CLAUDE_CONFIG_DIR persiste il login OAuth/MAX nel volume montato qui.
ENV CLAUDE_CONFIG_DIR=/home/worker/.claude

CMD ["node", "dist/index.js"]
