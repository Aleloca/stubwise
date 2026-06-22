# File d'ambiente per progetto — Piano di implementazione

> **Per Claude:** SOTTO-SKILL RICHIESTA: usa superpowers:subagent-driven-development per eseguire questo piano task per task.

**Goal:** Configurare per progetto uno o più file d'ambiente con variabili cifrate, materializzati nel worktree (file + process env) prima di install/test, con import smart (upload/incolla → parse → cifra).

**Architecture:** Due tabelle (`project_env_files`, `project_env_vars`); parser dotenv condiviso; CRUD server admin-only con valori mascherati; modulo worker che carica/decifra/serializza e scrive i file + inietta la process env in install/test, escludendo i file dal commit; sezione UI nelle impostazioni progetto.

**Tech Stack:** TypeScript NodeNext strict, Drizzle, Fastify+zod, AES-256-GCM (`@stubwise/db` encrypt/decrypt), execa, vitest, React (TanStack).

---

## Fase 1 — DB

### Task 1: Tabelle `project_env_files` + `project_env_vars` (migrazione 0025)

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/0025_*.sql` (drizzle-kit generate)
- Test: `packages/db/src/schema.test.ts`

**Step 1 (test prima):** test che inserisce un progetto, un `project_env_files` (`path: ".env"`) e due `project_env_vars` (key+value_encrypted), e verifica: persistenza, FK cascade (eliminando il file spariscono le var; eliminando il progetto sparisce tutto), unique `(project_id, path)` e `(file_id, key)` (violazione → errore). FALLISCE.

**Step 2:** in `schema.ts` aggiungi le due tabelle speculari allo stile esistente (uuid pk `gen_random_uuid()`, timestamptz `created_at`/`updated_at`, FK con `onDelete: "cascade"`, indici unique). Esporta i tipi.

**Step 3:** `pnpm exec drizzle-kit generate` (in packages/db). Verifica che `0025_*.sql` contenga SOLO le due `CREATE TABLE` + indici/FK (additivo, nessun drop/alter su tabelle esistenti). Se c'è drift, fermati e segnala.

**Step 4:** `pnpm --filter @stubwise/db test` verde. Typecheck db pulito.

**Step 5:** commit.

---

## Fase 2 — Parser/serializer dotenv

### Task 2: `parseDotenv` + `serializeDotenv` (+ validazioni)

**Files:**
- Create: `packages/shared/src/env/dotenv.ts` (o in apps/server se preferito condividere meno; preferisci `@stubwise/shared` se già usato da server e web)
- Test: accanto al modulo

**Step 1 (test prima):** test del parser su:
- righe `KEY=value`, spazi attorno, righe vuote, commenti `#`;
- prefisso `export KEY=value`;
- valori tra apici doppi (`KEY="a b"`) e singoli (`KEY='a b'`);
- `=` dentro il valore (`URL=postgres://u:p@h/db?x=1`);
- valore vuoto (`KEY=`);
- multiline tra apici doppi (`KEY="riga1\nriga2"`);
- chiavi non valide ignorate o segnalate.
Test del serializer: `serializeDotenv([{key,value}])` → stringa; round-trip `parseDotenv(serializeDotenv(x)) === x` per valori con spazi, newline, apici, `#`, `=`.
Test validazioni: `isValidEnvKey` (`^[A-Za-z_][A-Za-z0-9_]*$`), `isSafeRelPath` (relativo, no `..`, no leading `/`, normalizzato).
FALLISCE.

**Step 2:** implementa `parseDotenv(text): {key,value}[]`, `serializeDotenv(vars): string` (quota con apici doppi ed escapa `"`/`\`/newline quando il valore contiene spazi/newline/speciali; altrimenti `KEY=value` nudo), `isValidEnvKey`, `isSafeRelPath`. Robusto e senza dipendenze esterne (o usa `dotenv` se aggiunto come dep — preferisci parser interno per controllo totale del round-trip).

**Step 3:** test verde. Typecheck pulito.

**Step 4:** commit.

---

## Fase 3 — Server: CRUD + import

### Task 3: rotte `project-env-files` (admin-only)

**Files:**
- Create: `apps/server/src/routes/project-env-files.ts`
- Modify: registrazione rotte (dove sono montate le altre rotte progetto)
- Test: `apps/server/src/routes/project-env-files.test.ts`

**Step 1 (test prima):** test su (requireAdmin):
- `POST /api/projects/:id/env-files` `{ path: ".env" }` → crea, ritorna file con `path` e `vars: []`; path non valido (`../x`, `/abs`) → 400.
- `POST /api/projects/:id/env-files/:fileId/import` `{ content: "A=1\nB=2\n# c\nexport C=3" }` → upsert 3 var cifrate; ritorna le chiavi `[A,B,C]`, MAI i valori; re-import con `A=9` aggiorna A (upsert), aggiunge/lascia le altre.
- `GET /api/projects/:id/env-files` → file + chiavi con `valueSet: true`, **nessun valore** in risposta.
- `PUT .../vars/:key` `{ value }` → sostituisce (cifra); key non valida → 400.
- `DELETE` var e file → 204/200; cascade coerente.
- I valori in DB sono cifrati (decrypt con la chiave di test → valore originale); la risposta non contiene il valore.
FALLISCE.

**Step 2:** implementa il router speculare allo stile delle rotte progetto esistenti (zod schema, `requireAdmin`, `apiError`, `encrypt` con `app.encryptionKey`). `import` usa `parseDotenv` + `isValidEnvKey` (scarta/!400 chiavi invalide — decidi: scarta con conteggio o 400; preferisci scartare le righe non parsabili e ritornare le chiavi valide importate). Proiezione pubblica senza valori. Verifica `isSafeRelPath` sul `path`. Registra la rotta.

**Step 3:** `pnpm --filter @stubwise/server exec vitest run src/routes/project-env-files.test.ts` verde. Typecheck server pulito.

**Step 4:** commit.

---

## Fase 4 — Worker: materializzazione

### Task 4: modulo `env-files.ts` (load/decrypt/serialize/materialize)

**Files:**
- Create: `apps/worker/src/pipeline/env-files.ts`
- Test: `apps/worker/src/pipeline/env-files.test.ts`

**Step 1 (test prima):** test di:
- `loadProjectEnvFiles(db, projectId, encryptionKey)` → `[{ path, vars: {KEY:value} }]` con valori decifrati; var corrotta/non decifrabile → saltata (best-effort, log senza valore).
- `materializeEnvFiles(dir, files)`: scrive ogni file in `join(dir, path)` con contenuto serializzato (round-trip via parseDotenv), crea dir genitrici; **path traversal** (`../escape`) → NON scrive fuori, rifiutato; ritorna la lista dei path scritti e la mappa unificata `{KEY:value}` (last-wins per collisioni, ordine per path).
FALLISCE.

**Step 2:** implementa. Usa `decrypt` da `@stubwise/db`, `parseDotenv`/`serializeDotenv`/`isSafeRelPath` dal modulo condiviso, `mkdir`/`writeFile`. Anti-traversal: `resolve(join(dir, path))` deve iniziare con `resolve(dir) + sep`. Non lanciare mai sui singoli errori (best-effort, come gli altri moduli pipeline): logga path + conteggio, mai valori.

**Step 3:** test verde. Typecheck worker pulito.

**Step 4:** commit.

### Task 5: wiring in `fix.ts` (scrittura + esclusione commit + process env)

**Files:**
- Modify: `apps/worker/src/pipeline/fix.ts`
- Test: `apps/worker/src/pipeline/fix.test.ts`

**Step 1 (test prima):** test (iniettando fake per load/materialize via `FixDeps`):
- i file env vengono materializzati PRIMA dell'install (ordine: env → install → agente);
- saltati in plan-only;
- i path materializzati sono ESCLUSI dallo staging del commit (verifica che `git add`/status li escludano: estendi i fake/asserzioni del self-repair; almeno asserisci che la lista di esclusione passata a gitIn includa i path env oltre a STUBWISE_REPORT.md);
- la mappa unificata è passata a `runInstallCommand`/`runTestCommand` come process env;
- nessun file env → comportamento invariato.
FALLISCE.

**Step 2:** implementa:
- nuove `FixDeps`: `loadEnvFilesFn?` (default da env-files.ts) + l'eventuale `materializeEnvFilesFn?`;
- nel callback `withWorktree`, dopo l'heartbeat e **prima dell'install** (guardia `fixMode !== "plan-only"`): carica + materializza, ottieni `writtenPaths` + `envMap`; logga `[fix] file d'ambiente materializzati (N file)`;
- estendi lo staging del fix (oggi `git add -A -- . :(exclude)REPORT_FILENAME`, e lo status check) per escludere ANCHE i `writtenPaths` (pathspec `:(exclude)<path>` per ciascuno);
- passa `envMap` a `runInstallCommand` e `runTestCommand`: estendi `runCommandCaptured` per accettare un env extra opzionale, mergiandolo nell'`env` di execa insieme a `NODE_ENV: undefined` (i valori utente NON sovrascrivono la neutralizzazione di NODE_ENV per l'install — definisci precedenza: `{ ...userVars, NODE_ENV: undefined }`).

**Step 3:** `pnpm --filter @stubwise/worker exec vitest run src/pipeline/fix.test.ts src/pipeline/env-files.test.ts` verde. Typecheck worker pulito.

**Step 4:** commit.

---

## Fase 5 — Web

### Task 6: sezione "File d'ambiente" + tipi + i18n

**Files:**
- Create: `apps/web/src/components/project-env-files-section.tsx`
- Modify: `apps/web/src/lib/api.ts` (tipi + chiamate), il punto dove si rende la pagina/route progetto (es. `routes/projects/$slug.tsx`), `i18n/locales/{it,en}.json`
- Test: `project-env-files-section.test.tsx`

**Step 1 (test prima):** test componente (testing-library + mock api):
- mostra la lista dei file e, per file, le chiavi mascherate (mai valori);
- **import via incolla**: incolla `A=1\nB=2` → chiama l'endpoint import → mostra A,B;
- **import via upload**: simula un File drag/drop → legge il contenuto → import;
- aggiungi file (path) con validazione client basilare; elimina file/variabile; sostituisci valore.
FALLISCE.

**Step 2:** implementa la sezione (stile coerente con `ai-providers-section.tsx`/le altre sezioni admin), i tipi `ProjectEnvFile { path; vars: { key: string; valueSet: true }[] }` e le funzioni api in `lib/api.ts`, le chiavi i18n in ENTRAMBE le lingue, e l'inserimento nella pagina progetto. Drag&drop: leggi `File.text()` e riempi la textarea/azione import.

**Step 3:** `pnpm --filter @stubwise/web exec vitest run src/components/project-env-files-section.test.tsx` verde + parità i18n. Typecheck web pulito.

**Step 4:** commit.

---

## Fase 6 — Docs + chiusura

### Task 7: docs + verifica complessiva

**Files:**
- Modify: pagina `apps/docs` sulla configurazione progetto (accanto a comando install/test).

**Step 1:** documenta la feature: file d'ambiente per progetto, valori cifrati e mascherati, import smart (upload/incolla), materializzazione nel worktree (file + process env) prima di install/test, esclusione dal commit. Build docs ok.

**Step 2 (verifica pre-merge):**
```
pnpm -r typecheck
pnpm lint
pnpm -r test   # E2E Playwright solo in CI
```
Tutto verde.

**Step 3:** commit. Poi review finale dell'intera implementazione e deploy (server per migrazione+API, worker per pipeline, caddy/web per UI) con backup DB.
