# syntax=docker/dockerfile:1

# Build multi-stage del worker AI in un monorepo pnpm (stesso schema del
# server). Il runtime in più richiede:
#  - git CLI: il worker clona/aggiorna i mirror ed esegue worktree effimere.
#  - claude CLI (@anthropic-ai/claude-code): l'AgentRunner lo invoca per
#    triage e fix.
#  - graphify CLI (pacchetto Python graphifyy): costruisce il grafo delle
#    dipendenze del repo (job graph_build), installato in un venv dedicato.
#  - una HOME scrivibile per l'utente: il login OAuth/MAX di claude scrive
#    ~/.claude (montata come volume nel compose, vedi CLAUDE_CONFIG_DIR).

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /repo

# Toolchain di build per gli addon nativi. node-pty (usato per leggere /usage
# via PTY) NON pubblica prebuild per Linux (solo darwin/win32): su node:22-slim
# il suo install script ricade su `node-gyp rebuild`, che richiede python3/make/
# g++. Senza, l'addon nativo non compila e l'usage abbonamento resta disattivo.
# Resta confinata allo stage `base`: il runtime copia solo /app con il .node già
# compilato, quindi questi pacchetti NON finiscono nell'immagine finale.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

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

# Su Linux node-pty usa forkpty direttamente e NON produce uno spawn-helper
# (è una via specifica di macOS), quindi su questa immagine il find non matcha
# nulla. Lo teniamo come safeguard difensivo a costo zero: se una futura versione
# emettesse build/Release/spawn-helper, unixTerminal.js lo invoca come eseguibile
# (native.dir + '/spawn-helper') e un file senza +x farebbe fallire lo spawn.
RUN find /app -path '*/node-pty/build/Release/spawn-helper' -exec chmod +x {} +

FROM node:22-slim AS runtime
ENV NODE_ENV=production
# corepack enable crea solo gli shim: il binario reale di pnpm/yarn viene
# scaricato al PRIMO uso a runtime e il notice di download finirebbe su stderr,
# che l'install nel worktree CATTURA (alimenta log e prompt di riparazione
# dell'agente). Lo silenziamo: niente prompt interattivo né rumore nei log.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Cache corepack CONDIVISA fra utenti: la cache e il default ("lastKnownGood")
# sono per-HOME, quindi un pre-pull fatto da root non sarebbe visibile a worker
# (HOME diverso) e il primo `pnpm` ricadrebbe sul default bundled scaricandolo a
# runtime. Con un COREPACK_HOME unico e world-readable il binario pre-scaricato
# in build e la versione di default sono condivisi anche con l'utente worker.
ENV COREPACK_HOME=/opt/corepack
WORKDIR /app

# git per i mirror; claude CLI installato globalmente. ca-certificates per le
# connessioni HTTPS (clone su provider git, API Anthropic). python3 + python3-venv
# per il CLI graphify (installato nel venv dallo step successivo): il venv ha
# bisogno di ensurepip, che su Debian sta nel pacchetto python3-venv separato.
# corepack enable crea gli shim pnpm/yarn sul PATH: la pipeline di fix
# auto-rileva il package manager dal lockfile del repo per installare le
# dipendenze nel worktree; npm è già presente, corepack fornisce pnpm/yarn.
# Eseguito da root (prima di USER worker) così gli shim, installati in una dir
# di sistema sul PATH, sono disponibili anche all'utente worker.
# corepack install -g pre-scarica in build i PM con versioni PINNATE (no @latest,
# per determinismo) E li imposta come default globale: pnpm@10.9.0 = stesso
# `packageManager` del package.json root, yarn@1.22.22 = yarn classic. Così il
# primo install è offline-safe e a latenza prevedibile, senza pagare il download
# nel percorso critico del job; il notice è comunque silenziato via
# COREPACK_ENABLE_DOWNLOAD_PROMPT. Il chmod rende la cache leggibile a worker.
# NB: un repo target con un proprio campo `packageManager` farà comunque
# scaricare quella versione a runtime (richiede egress) — il pre-pull copre il
# caso comune (repo senza pin o pinnati alla stessa versione del default).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates python3 python3-venv \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @anthropic-ai/claude-code \
  && npm cache clean --force \
  && corepack enable \
  && corepack install -g pnpm@10.9.0 yarn@1.22.22 \
  && chmod -R a+rX /opt/corepack

# CLI graphify in un venv DEDICATO (niente pip nel Python di sistema, che su
# Debian bookworm è "externally managed"), con versione PINNATA per build
# riproducibili. L'extra [sql] aggiunge il parser SQL: i file di migrazione .sql
# del repo target entrano nel grafo. Un solo symlink in /usr/local/bin espone
# `graphify` sul PATH (GRAPHIFY_BIN di default) SENZA anteporre il venv al PATH:
# così il `python3`/`node` di sistema e il claude CLI restano quelli attesi.
RUN python3 -m venv /opt/graphify \
  && /opt/graphify/bin/pip install --no-cache-dir "graphifyy[sql]==0.9.28" \
  && ln -s /opt/graphify/bin/graphify /usr/local/bin/graphify

# Utente non-root con HOME: claude vi scrive le credenziali del login.
RUN useradd --create-home --uid 10001 worker
COPY --from=base --chown=worker:worker /app /app

# Directory dei mirror git persistenti (montata come volume nel compose).
RUN mkdir -p /var/stubwise/mirrors && chown -R worker:worker /var/stubwise
ENV MIRRORS_DIR=/var/stubwise/mirrors

# Directory dei grafi graphify (volume `graphs` nel compose, che il server monta
# in sola lettura per servire report/html/json). Come per .claude qui sotto, va
# creata con ownership worker PRIMA di USER: un volume nominato vuoto eredita
# l'ownership della dir dell'immagine al primo mount, altrimenti Docker la crea
# root-owned e il worker (uid 10001) non può scriverci l'output di graphify.
RUN mkdir -p /graphs && chown worker:worker /graphs
ENV GRAPHS_DIR=/graphs

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
