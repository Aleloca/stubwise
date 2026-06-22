# Installazione dipendenze nel worktree — Piano di implementazione

> **Per Claude:** SOTTO-SKILL RICHIESTA: usa superpowers:subagent-driven-development per eseguire questo piano task per task.

**Goal:** Installare le dipendenze nel worktree effimero prima dell'agente e del loop di self-repair, così i test del repo non falliscono più con exit 127.

**Architecture:** Speculare a `resolveTestCommand`: un nuovo `resolveInstallCommand` (override `projects.install_command` → auto-detect dal lockfile) risolve il comando; `runInstallCommand` lo esegue nel worktree (execa, reject:false, timeout) una volta nel callback di `withWorktree`, prima del primo run dell'agente (saltato in plan-only). L'immagine runtime del worker ottiene pnpm/yarn via `corepack enable`. Campo configurabile esposto da server e web.

**Tech Stack:** TypeScript NodeNext strict, Drizzle, Fastify+zod, execa, vitest, React (TanStack), Docker.

---

## Fase 1 — DB: campo `install_command`

### Task 1: Migrazione + schema `projects.install_command`

**Files:**
- Modify: `packages/db/src/schema.ts:218` (accanto a `testCommand`)
- Create: `packages/db/drizzle/0024_*.sql` (generata da drizzle-kit)
- Test: `packages/db/src/schema.test.ts`

**Step 1 (test prima):** in `schema.test.ts`, accanto al test esistente su `test_command`,
aggiungi un test che inserisce un progetto con `installCommand: "pnpm install"` e uno con
`null` e verifica la persistenza (`toBe("pnpm install")` / `toBeNull()`). Esegui: deve
FALLIRE (colonna assente).

**Step 2:** in `schema.ts`, sotto `testCommand: text("test_command"),` aggiungi:
```ts
  installCommand: text("install_command"),
```

**Step 3:** genera la migrazione additiva:
```bash
pnpm --filter @stubwise/db drizzle-kit generate
```
Verifica che il file `0024_*.sql` contenga solo `ALTER TABLE "projects" ADD COLUMN "install_command" text;` (additiva, nessun drop).

**Step 4:** esegui i test del package db:
```bash
pnpm --filter @stubwise/db test
```
Atteso: il nuovo test PASSA (lo schema applica la colonna nel testcontainer).

**Step 5:** commit.
```bash
git add packages/db/src/schema.ts packages/db/drizzle && git commit -m "feat(db): aggiungi projects.install_command (migrazione 0024)"
```

---

## Fase 2 — Worker: risoluzione del comando di install

### Task 2: `resolveInstallCommand`

**Files:**
- Create: `apps/worker/src/pipeline/install-command.ts`
- Test: `apps/worker/src/pipeline/install-command.test.ts`

**Step 1 (test prima):** scrivi `install-command.test.ts` (modella su `test-command.test.ts`).
Casi:
- override `installCommand: "pnpm install --frozen-lockfile"` → `{ cmd:"pnpm", args:["install","--frozen-lockfile"] }`, anche senza package.json nel worktree.
- override con spazi multipli → split corretto.
- niente override, `pnpm-lock.yaml` presente → `{ cmd:"pnpm", args:["install","--frozen-lockfile"] }`.
- niente override, `yarn.lock` presente → `{ cmd:"yarn", args:["install","--frozen-lockfile"] }`.
- niente override, `package-lock.json` presente → `{ cmd:"npm", args:["ci"] }`.
- niente override, `package.json` presente ma **nessun** lockfile → `{ cmd:"npm", args:["install"] }`.
- niente override, **nessun** `package.json` → `null`.
- precedenza pnpm > yarn quando entrambi i lockfile esistono.

Usa `mkdtemp`/`writeFile`/`rm` come in `test-command.test.ts`. Esegui: FALLISCE (modulo assente).

**Step 2:** implementa `resolveInstallCommand(project: { installCommand: string | null }, worktreeDir: string): Promise<TestCommand | null>`
riusando il tipo `TestCommand` (import da `./test-command.js`) e l'helper `fileExists`
(estrai `fileExists` in un punto condiviso oppure duplica la funzione locale — preferisci
estrarla in `install-command.ts` ed importarla in `test-command.ts`, oppure tieni una copia
locale se l'estrazione tocca troppo). Logica:
1. override trimmato non vuoto → split `/\s+/`, primo token cmd, resto args.
2. nessun `package.json` (no readFile o non esiste) → `null`. **Nota:** a differenza di
   `resolveTestCommand`, qui basta l'esistenza di `package.json` (non serve `scripts.test`).
3. `pnpm-lock.yaml` → pnpm install --frozen-lockfile; `yarn.lock` → yarn install
   --frozen-lockfile; `package-lock.json` → npm ci; altrimenti npm install.

**Step 3:** esegui i test del file:
```bash
pnpm --filter @stubwise/worker exec vitest run src/pipeline/install-command.test.ts
```
Atteso: verde.

**Step 4:** typecheck worker (`pnpm --filter @stubwise/worker typecheck`) pulito.

**Step 5:** commit.

---

## Fase 3 — Worker: config del timeout di install

### Task 3: `INSTALL_TIMEOUT_MS` + invariante di staleness

**Files:**
- Modify: `apps/worker/src/config.ts` (env + tipo `WorkerConfig`)
- Modify: `apps/worker/src/index.ts:32-58` (`assertStaleInvariant` + chiamata)
- Test: `apps/worker/src/config.test.ts`

**Step 1 (test prima):** in `config.test.ts`, aggiungi un test che `INSTALL_TIMEOUT_MS`
default sia `600000` e che un override venga rispettato (sul modello dei test
`selfRepairTestTimeoutMs`). Esegui: FALLISCE.

**Step 2:** in `config.ts`, aggiungi lo schema env `INSTALL_TIMEOUT_MS` (default 600_000,
coercizione numerica come gli altri timeout) e il campo `installTimeoutMs: number` in
`WorkerConfig`, popolato in fondo come gli altri. Aggiorna il commento dell'invariante che
menziona la composizione del tempo massimo (aggiungi "+ install 10'").

**Step 3:** in `index.ts`, estendi `assertStaleInvariant` con un parametro
`installTimeoutMs` e sommalo **una volta** a `minRequiredMs` (l'install gira una sola volta,
non per tentativo). Aggiorna il messaggio d'errore e il commento (install incluso). Passa
`config.installTimeoutMs` alla chiamata.

**Step 4:** esegui `pnpm --filter @stubwise/worker test` (config + invariante). Verde.
Verifica a mano che con i default l'invariante NON scatti (min ~129' < 150').

**Step 5:** commit.

---

## Fase 4 — Worker: esecuzione dell'install nel worktree

### Task 4: `runInstallCommand` + wiring in `fix.ts`

**Files:**
- Modify: `apps/worker/src/pipeline/fix.ts` (nuovo `defaultRunInstallCommand`, deps
  iniettabili, wiring nel callback `withWorktree`)
- Test: `apps/worker/src/pipeline/fix.test.ts`

**Step 1 (test prima):** in `fix.test.ts`, aggiungi test (inietta `resolveInstallCommandFn`
e `runInstallCommand` via `FixDeps`, come già per test):
- **install eseguito prima dell'agente**: con un progetto che risolve un install command,
  un fake `runInstallCommand` registra l'ordine; asserisci che sia stato chiamato PRIMA del
  primo `runner.run` di execute.
- **install saltato in plan-only**: in modalità plan-only il `runInstallCommand` NON è
  chiamato.
- **install che fallisce non aborta la run**: `runInstallCommand` → exit non-zero; la run
  prosegue (l'agente viene comunque invocato) e il log contiene la riga di fallimento install.
- **install `null` (nessun package.json)**: `resolveInstallCommandFn` → null; nessuna
  chiamata a `runInstallCommand`, run normale.

Esegui: FALLISCE.

**Step 2:** implementa:
- `defaultRunInstallCommand(cmd: TestCommand, dir: string, timeoutMs: number): Promise<TestRunResult>`
  speculare a `defaultRunTestCommand` (execa, `reject:false`, `all:true`, troncamento
  `TEST_RUN_OUTPUT_MAX_CHARS`).
- in `FixDeps`: `resolveInstallCommandFn?` (default `resolveInstallCommand`) e
  `runInstallCommand?` (default `defaultRunInstallCommand`); `installTimeoutMs` passato da
  `runFix` (default `DEFAULT_INSTALL_TIMEOUT_MS = 600_000`).
- nel callback `withWorktree`, **dopo** l'heartbeat e **prima** del blocco dei run, ma
  **saltando se `fixMode === "plan-only"`**: risolvi il comando di install; se non null,
  esegui `runInstallCommand`; logga `[fix] install dipendenze (<cmd>)…` e l'esito
  (`ok`/`fallito exit N`), con output troncato sul fallimento. Un install fallito **non**
  lancia: prosegue. Usa `appendJobLog`/il meccanismo di log già usato dal fix per scrivere
  nel log del job (riusa lo stesso helper con cui si scrivono le righe `[fix] self-repair …`).

**Step 3:** esegui `pnpm --filter @stubwise/worker exec vitest run src/pipeline/fix.test.ts`. Verde.

**Step 4:** typecheck worker pulito.

**Step 5:** commit.

---

## Fase 5 — Immagine worker: pnpm/yarn a runtime

### Task 5: `corepack enable` nello stage runtime

**Files:**
- Modify: `apps/worker/Dockerfile:55-65` (stage `runtime`)

**Step 1:** nello stage `FROM node:22-slim AS runtime`, aggiungi `corepack enable` (Node 22
include corepack; fornisce gli shim `pnpm`/`yarn`). Es. estendi il `RUN` esistente o
aggiungine uno prima di `USER worker`. Commenta il perché (auto-detect può risolvere
pnpm/yarn; npm è già presente).

**Step 2 (verifica build locale):**
```bash
docker build -f apps/worker/Dockerfile -t stubwise-worker-test . \
  && docker run --rm --entrypoint sh stubwise-worker-test -c "pnpm --version && yarn --version && npm --version"
```
Atteso: le tre versioni stampate, exit 0.

**Step 3:** commit.

---

## Fase 6 — Server: campo `installCommand`

### Task 6: zod + persistenza + proiezione in `routes/projects.ts`

**Files:**
- Modify: `apps/server/src/routes/projects.ts`
- Test: `apps/server/src/routes/projects.test.ts`

**Step 1 (test prima):** estendi `projects.test.ts` sul modello dei test di `testCommand`:
- POST con `installCommand: "pnpm install --frozen-lockfile"` → persistito e restituito
  dalla proiezione pubblica.
- PATCH che aggiorna `installCommand` (e che lo azzera a `null`).
- la proiezione pubblica include `installCommand`.

Esegui: FALLISCE.

**Step 2:** aggiungi `installCommand` (string nullable/optional, trim, stesso trattamento
di `testCommand`) negli schema zod di create/update, nella persistenza (insert/update) e
nella proiezione pubblica del progetto. Stessa semantica di `testCommand` (vuoto → null).

**Step 3:** `pnpm --filter @stubwise/server exec vitest run src/routes/projects.test.ts`. Verde.

**Step 4:** typecheck server pulito.

**Step 5:** commit.

---

## Fase 7 — Web: campo nel form progetto

### Task 7: campo "Comando di installazione"

**Files:**
- Modify: `apps/web/src/components/project-form.tsx`
- Modify: `apps/web/src/lib/api.ts` (tipo Project + payload create/update)
- Modify: `apps/web/src/i18n/locales/it.json`, `apps/web/src/i18n/locales/en.json`
- Test: `apps/web/src/components/project-form.test.tsx`

**Step 1 (test prima):** estendi `project-form.test.tsx` sul modello del campo `testCommand`:
il form mostra il campo "Comando di installazione", il valore iniziale è popolato dal
progetto, e il submit include `installCommand` nel payload. Esegui: FALLISCE.

**Step 2:** aggiungi il campo accanto a quello del comando di test: input opzionale con
label da i18n (`it.json`/`en.json`, chiavi sul modello di quelle del test command) e
placeholder esplicativo (es. "auto-rilevato dal lockfile se vuoto"). Aggiorna il tipo
`Project` e i payload in `lib/api.ts` con `installCommand: string | null`.

**Step 3:** `pnpm --filter @stubwise/web exec vitest run src/components/project-form.test.tsx`. Verde.

**Step 4:** typecheck web pulito.

**Step 5:** commit.

---

## Fase 8 — Docs

### Task 8: documentare il campo install

**Files:**
- Modify: la pagina di `apps/docs` che descrive la configurazione di un progetto / il
  comando di test (cerca dove è documentato `test_command`).

**Step 1:** aggiungi un paragrafo sul campo "comando di installazione": override opzionale,
auto-detect dal lockfile (pnpm/yarn/npm), eseguito nel worktree prima del fix e dei test.

**Step 2:** build docs per sicurezza (`pnpm --filter @stubwise/docs build`) se rapido; almeno
verifica che non rompa il prebuild. Commit.

---

## Fase 9 — Compose + chiusura

### Task 9: commento invariante in compose + verifica finale

**Files:**
- Modify: `docker-compose.yml` (commento del blocco `WORKER_STALE_MINUTES`: includi
  l'addendo install; opzionale esporre `INSTALL_TIMEOUT_MS` come gli altri timeout in forma
  lista pass-through con default).

**Step 1:** aggiorna il commento dell'invariante (install 10' incluso una volta). Se utile,
aggiungi `- INSTALL_TIMEOUT_MS=${INSTALL_TIMEOUT_MS:-600000}` nel blocco environment del worker.

**Step 2 (verifica complessiva, pre-merge):**
```bash
pnpm -r typecheck
pnpm lint
pnpm -r test   # nota: i test E2E Playwright girano solo in CI
```
Tutto verde.

**Step 3:** commit finale. Poi review finale dell'intera implementazione e deploy
(server per la migrazione + worker per la pipeline e l'immagine) con backup DB.
