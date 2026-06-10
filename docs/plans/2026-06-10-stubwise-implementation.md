# Stubwise — Piano di Implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Costruire Stubwise: issue tracker self-hostable (monorepo TypeScript) con SDK di cattura errori/feedback e pipeline AI che analizza i ticket con Claude Code e apre PR con fix documentati.

**Architecture:** Monorepo pnpm con `apps/server` (Fastify + PostgreSQL), `apps/web` (React/Vite), `apps/worker` (job AI: mirror git bare → worktree effimero → `claude -p` → PR), `apps/docs` (Starlight), `packages/sdk` e `packages/shared` (Zod). Coda job su Postgres con `FOR UPDATE SKIP LOCKED`. Design completo in `docs/plans/2026-06-10-stubwise-design.md` — **leggerlo prima di iniziare**.

**Tech Stack:** Node 22, pnpm, TypeScript 5, Fastify 5, Zod, Drizzle ORM + postgres-js, fastify-type-provider-zod (OpenAPI), argon2, React 18 + Vite + TanStack Query + dnd-kit + Tailwind, Vitest + @testcontainers/postgresql + Playwright, execa (git CLI), Starlight, Docker Compose + Caddy.

**Convenzioni per tutto il piano:**
- TDD sempre: test che fallisce → implementazione minima → test verde → commit. Skill di riferimento: superpowers:test-driven-development.
- Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`).
- Ogni feature con superficie utente o API include la sua pagina in `apps/docs` (può essere nello stesso commit o in un commit `docs:` immediatamente successivo).
- I test di integrazione che toccano Postgres usano testcontainers (helper del Task 5); i test unit non devono richiedere Docker.
- Comando test globale: `pnpm test` (root, ricorsivo); per package: `pnpm --filter <pkg> test`.

---

## Fase 0 — Fondamenta del monorepo

### Task 1: Scaffold del monorepo

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.env.example`, `.nvmrc`, `eslint.config.js`, `.prettierrc`

**Step 1: Crea i file di base**

`package.json` (root):
```json
{
  "name": "stubwise",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.9.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "pnpm -r test",
    "build": "pnpm -r build",
    "lint": "eslint .",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "eslint": "^9.0.0",
    "typescript-eslint": "^8.0.0",
    "prettier": "^3.3.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

`.gitignore`: `node_modules/`, `dist/`, `.env`, `coverage/`, `*.tsbuildinfo`, `.astro/`
`.env.example`: vedi Task 4 (verrà popolato man mano; crearlo ora vuoto con commento di intestazione).
`.nvmrc`: `22`

**Step 2: Verifica**

Run: `pnpm install && pnpm lint`
Expected: install ok, lint senza errori (nessun sorgente ancora).

**Step 3: Commit**

```bash
git add -A && git commit -m "chore: scaffold monorepo pnpm"
```

### Task 2: `packages/shared` — schemi Zod di dominio

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`, `packages/shared/src/schemas/ticket.ts`, `packages/shared/src/schemas/project.ts`, `packages/shared/src/schemas/ingest.ts`
- Test: `packages/shared/src/schemas/ingest.test.ts`

**Step 1: Scaffold del package** — `package.json` con `name: "@stubwise/shared"`, `exports` su `dist/index.js`, script `build: tsc`, `test: vitest run`, `typecheck: tsc --noEmit`. Dipendenza: `zod`.

**Step 2: Scrivi il test che fallisce** — `ingest.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { errorEventSchema } from "./ingest.js";

describe("errorEventSchema", () => {
  it("accetta un evento errore valido", () => {
    const ev = {
      kind: "error",
      message: "Cannot read properties of undefined",
      errorType: "TypeError",
      stack: "TypeError: ...\n  at fn (app.js:10:5)",
      url: "https://shop.example.com/cart",
      release: "1.4.2",
      environment: "production",
      breadcrumbs: [{ type: "click", message: "button#buy", timestamp: "2026-06-10T10:00:00Z" }],
      timestamp: "2026-06-10T10:00:01Z",
    };
    expect(errorEventSchema.parse(ev)).toMatchObject({ kind: "error" });
  });
  it("rifiuta un evento senza message", () => {
    expect(() => errorEventSchema.parse({ kind: "error" })).toThrow();
  });
});
```

**Step 3: Run** `pnpm --filter @stubwise/shared test` → FAIL (modulo inesistente).

**Step 4: Implementa gli schemi.** In `ingest.ts`: `breadcrumbSchema` (`type` enum `click|navigation|fetch|log`, `message`, `timestamp` ISO), `errorEventSchema` (`kind: "error"`, `message`, `errorType?`, `stack?`, `url?`, `release?`, `environment?`, `breadcrumbs` max 30, `timestamp`), `feedbackEventSchema` (`kind: "feedback"`, `message`, `email?`, `url?`, `release?`), `ticketCreateEventSchema` (`kind: "ticket"`, `title`, `body?`, `type` enum, `priority` enum), `ingestBatchSchema = z.object({ events: z.array(z.discriminatedUnion("kind", [...])).max(100) })`. In `ticket.ts`: enum `ticketStatus` (`open|triaged|in_progress|in_review|done|closed`), `ticketType` (`bug|feature|task|feedback`), `ticketPriority` (`low|medium|high|urgent`), `ticketSource` (`manual|sdk_error|sdk_feedback|api`). In `project.ts`: `gitProvider` enum (`bitbucket|github`), schema progetto. Esporta tutto da `index.ts`.

**Step 5: Run di nuovo** → PASS.

**Step 6: Commit** — `feat(shared): schemi Zod di dominio e ingestion`

---

## Fase 1 — Server core

### Task 3: Scaffold `apps/server` con healthcheck

**Files:**
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/src/app.ts`, `apps/server/src/index.ts`, `apps/server/src/config.ts`
- Test: `apps/server/src/app.test.ts`

**Step 1:** Test che fallisce: `buildApp()` restituisce un'istanza Fastify; `GET /health` → `200 {"status":"ok"}` (usare `app.inject`, niente porta reale).

**Step 2:** Run `pnpm --filter @stubwise/server test` → FAIL.

**Step 3:** Implementa: `config.ts` valida `process.env` con Zod (`DATABASE_URL`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `PORT` default 3000, `PUBLIC_URL`) — fallisce subito all'avvio se manca qualcosa, con messaggio chiaro (esperienza self-hosting). `app.ts` esporta `buildApp(opts)` che registra plugin e route; `index.ts` fa il listen. Aggiungi le variabili a `.env.example` con commenti.

**Step 4:** Run → PASS. **Step 5:** Commit `feat(server): scaffold Fastify con healthcheck e config validata`

### Task 4: Database — Drizzle ORM, schema e migrazioni

**Files:**
- Create: `apps/server/src/db/schema.ts`, `apps/server/src/db/client.ts`, `apps/server/drizzle.config.ts`, migrazioni generate in `apps/server/drizzle/`

**Step 1:** Definisci in `schema.ts` tutte le tabelle dal design: `users` (id uuid, email unique, passwordHash, role, createdAt), `invites` (token, email, expiresAt), `sessions` (id, userId, expiresAt), `projects` (id, name, slug unique, provider, repoUrl, defaultBranch, encryptedCredentials, ingestionKey unique, createdAt), `tickets` (id, projectId FK, number serial-per-project via trigger o contatore su projects, title, body, type, priority, status, source, assigneeId?, labels text[], technicalPayload jsonb?, occurrences int default 1, lastSeenAt, createdAt, updatedAt), `errorGroups` (id, projectId, fingerprint, ticketId FK, unique(projectId, fingerprint)), `comments` (id, ticketId, authorType `user|ai`, authorId?, body, createdAt), `aiJobs` (id, ticketId, status, log text, prUrl?, error?, createdAt, startedAt?, finishedAt?).

**Step 2:** `pnpm --filter @stubwise/server exec drizzle-kit generate` → migrazione SQL generata. Verifica a occhio la migrazione.

**Step 3:** `client.ts`: factory `createDb(databaseUrl)` con postgres-js; funzione `runMigrations(db)` con drizzle migrator (chiamata all'avvio del server: il self-hoster non lancia migrazioni a mano).

**Step 4:** Commit `feat(server): schema database Drizzle e migrazioni`

### Task 5: Helper testcontainers + primo test di integrazione

**Files:**
- Create: `apps/server/src/test/db.ts`
- Test: `apps/server/src/db/schema.test.ts`

**Step 1:** `test/db.ts` esporta `startTestDb()`: avvia `PostgreSqlContainer`, crea il client, esegue le migrazioni, restituisce `{ db, container }`. Container condiviso per file di test via `beforeAll`/`afterAll`.

**Step 2:** Test: inserisci un project, poi due ticket → i `number` sono 1 e 2 (contatore per-progetto); inserisci due `errorGroups` con stessa `(projectId, fingerprint)` → il secondo viola il vincolo unique.

**Step 3:** Run → PASS (iterare sull'implementazione del contatore finché passa). **Step 4:** Commit `test(server): helper testcontainers e test schema`

### Task 6: Autenticazione (setup admin, login, sessioni, inviti)

**Files:**
- Create: `apps/server/src/routes/auth.ts`, `apps/server/src/auth/session.ts`, `apps/server/src/auth/password.ts`
- Test: `apps/server/src/routes/auth.test.ts`

**Step 1:** Test (integrazione, app + testDb): (a) primo avvio senza utenti → `POST /api/auth/setup` crea l'admin, le chiamate successive a setup → 403; (b) `POST /api/auth/login` con credenziali corrette setta cookie di sessione httpOnly e `GET /api/auth/me` risponde con l'utente; password errata → 401; (c) admin crea invito → `POST /api/auth/register` con token valido crea un `member`, token riusato → 410.

**Step 2:** Run → FAIL. **Step 3:** Implementa: argon2id per le password; sessioni opache in tabella `sessions` (cookie = id firmato con `SESSION_SECRET` via `@fastify/cookie`); decorator `requireAuth` / `requireAdmin` come preHandler Fastify riusabili.

**Step 4:** Run → PASS. **Step 5:** Commit `feat(server): autenticazione con sessioni, setup admin e inviti`

### Task 7: CRUD Project con credenziali cifrate

**Files:**
- Create: `apps/server/src/routes/projects.ts`, `apps/server/src/crypto/secrets.ts`
- Test: `apps/server/src/crypto/secrets.test.ts`, `apps/server/src/routes/projects.test.ts`

**Step 1:** Test unit `secrets.test.ts`: `encrypt(plaintext, key)` → `decrypt(ciphertext, key)` round-trip; ciphertext diverso a ogni chiamata (IV casuale); decrypt con chiave sbagliata → throw.

**Step 2:** Implementa `secrets.ts`: AES-256-GCM con `node:crypto`, chiave da `ENCRYPTION_KEY` (32 byte base64), formato `iv.authTag.ciphertext` base64.

**Step 3:** Test integrazione routes: create project (solo admin) genera `ingestionKey` casuale (32 hex) e slug; le credenziali git inviate vengono salvate cifrate (verifica che in DB **non** compaia il plaintext); `GET /api/projects/:slug` **non** restituisce mai le credenziali; update e list funzionano; member può leggere ma non creare.

**Step 4:** Implementa → PASS. **Step 5:** Commit `feat(server): CRUD progetti con credenziali cifrate AES-256-GCM`

### Task 8: CRUD Ticket, commenti e transizioni di stato

**Files:**
- Create: `apps/server/src/routes/tickets.ts`, `apps/server/src/routes/comments.ts`
- Test: `apps/server/src/routes/tickets.test.ts`

**Step 1:** Test: create ticket manuale (source `manual`, status `open`); list con filtri (`status`, `type`, `priority`, `assignee`, `q` su titolo) e paginazione cursor; `PATCH` per stato/priorità/assegnatario/label; commenti: create + list ordinati; transizione verso stato inesistente → 400.

**Step 2:** Run → FAIL. **Step 3:** Implementa con `fastify-type-provider-zod` (gli schemi di route alimenteranno OpenAPI nel Task 9). **Step 4:** PASS. **Step 5:** Commit `feat(server): CRUD ticket e commenti con filtri`

### Task 9: OpenAPI auto-generata

**Files:**
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/src/openapi.test.ts`

**Step 1:** Test: `GET /api/openapi.json` → spec valida che contiene i path `/api/tickets` e `/api/projects` con schemi derivati da Zod.

**Step 2:** Implementa con `@fastify/swagger` + transform di `fastify-type-provider-zod`. **Step 3:** PASS. **Step 4:** Commit `feat(server): spec OpenAPI generata dagli schemi Zod`

---

## Fase 2 — Ingestion e SDK

### Task 10: Fingerprinting e dedup ErrorGroup

**Files:**
- Create: `apps/server/src/ingest/fingerprint.ts`, `apps/server/src/ingest/processor.ts`
- Test: `apps/server/src/ingest/fingerprint.test.ts`, `apps/server/src/ingest/processor.test.ts`

**Step 1:** Test unit fingerprint (la parte più critica del sistema — copertura fitta):

```ts
import { fingerprint } from "./fingerprint.js";

it("stesso errore da release diverse → stesso fingerprint", () => {
  const a = fingerprint({ errorType: "TypeError", message: "x is undefined",
    stack: "TypeError: x is undefined\n  at buy (https://cdn.app/assets/app-a1b2c3.js:10:5)" });
  const b = fingerprint({ errorType: "TypeError", message: "x is undefined",
    stack: "TypeError: x is undefined\n  at buy (https://cdn.app/assets/app-d4e5f6.js:99:1)" });
  expect(a).toBe(b);
});
it("errori con tipo diverso → fingerprint diverso", () => { /* TypeError vs RangeError */ });
it("messaggi con valori dinamici vengono normalizzati", () => {
  // "User 12345 not found" e "User 67890 not found" → stesso fingerprint
});
it("senza stack usa tipo+messaggio normalizzato", () => { /* ... */ });
```

**Step 2:** FAIL. **Step 3:** Implementa: normalizza lo stack (per ogni frame tieni solo nome funzione + basename del file senza hash di build né riga/colonna; primi 8 frame), normalizza il messaggio (numeri → `<n>`, uuid → `<uuid>`, stringhe quotate → `<str>`), `sha256(errorType + frames || normalizedMessage)`. **Step 4:** PASS.

**Step 5:** Test integrazione `processor.test.ts`: `processEvents(db, project, events)` — primo evento errore crea ErrorGroup + ticket (`source: sdk_error`, type `bug`, payload tecnico salvato, titolo = `errorType: message` troncato); secondo evento identico **non** crea ticket ma incrementa `occurrences` e aggiorna `lastSeenAt`; evento feedback crea sempre ticket `source: sdk_feedback` type `feedback`; evento `ticket` crea ticket `source: api`. Per i ticket nuovi viene inserito un `aiJobs` con status `queued`. Gestire la race sul vincolo unique (insert con `onConflictDoNothing` + retry come update).

**Step 6:** Implementa → PASS. **Step 7:** Commit `feat(server): fingerprinting, dedup ErrorGroup e processor ingestion`

### Task 11: Endpoint di ingestion con rate limiting

**Files:**
- Create: `apps/server/src/routes/ingest.ts`
- Test: `apps/server/src/routes/ingest.test.ts`

**Step 1:** Test: `POST /ingest/:slug` con header `X-Stubwise-Key` valida → 202 e ticket creati; chiave errata → 401; payload non valido → 422; oltre il rate limit (es. 300 eventi/min per chiave) → 429; CORS aperto su questo solo endpoint (l'SDK browser chiama cross-origin).

**Step 2:** FAIL → implementa (`@fastify/rate-limit` con keyGenerator = ingestion key, `@fastify/cors` scoped) → PASS.

**Nota (review Task 6):** il rate limiting deve coprire anche `POST /api/auth/login` e `POST /api/auth/register`: il costo deliberatamente alto di argon2 li rende un vettore di DoS se non limitati (es. per IP).

**Step 3:** Commit `feat(server): endpoint ingestion con rate limiting e CORS`

### Task 12: SDK — core transport

**Files:**
- Create: `packages/sdk/package.json` (name `@stubwise/sdk`, exports `./browser` e `./node`, `sideEffects: false`), `packages/sdk/src/core/client.ts`, `packages/sdk/src/core/transport.ts`, `packages/sdk/src/core/breadcrumbs.ts`
- Test: `packages/sdk/src/core/transport.test.ts`

**Step 1:** Test (fetch mockato con `vi.fn()`): gli eventi si accumulano e partono in un singolo batch dopo `flushInterval` (usare `vi.useFakeTimers`); su 5xx/network error il batch viene ritentato con backoff (max 3, poi scartato); coda cap a 100 eventi (drop dei più vecchi); `flush()` manuale invia subito; **nessuna eccezione esce mai dal transport** (l'SDK non deve mai rompere l'app ospite: ogni invio è avvolto in try/catch).

**Step 2:** FAIL → implementa `Transport` (parse del DSN `https://KEY@host/p/slug` → endpoint + header) e `Client` (`captureError`, `captureFeedback`, `createTicket`, ring buffer breadcrumbs max 30) → PASS. **Step 3:** Commit `feat(sdk): core client e transport con batching e retry`

### Task 13: SDK browser

**Files:**
- Create: `packages/sdk/src/browser/index.ts`
- Test: `packages/sdk/src/browser/index.test.ts` (environment: `happy-dom`)

**Step 1:** Test: `init()` aggancia `window.onerror` e `unhandledrejection` e gli eventi arrivano al transport con stack/url/userAgent; i click su elementi con tag/id finiscono nei breadcrumbs; `init` chiamato due volte non duplica i listener.

**Step 2:** FAIL → implementa (instrumenta anche `fetch` per breadcrumb su risposte ≥400; mai throw) → PASS. **Step 3:** Commit `feat(sdk): entry point browser con cattura errori automatica`

### Task 14: SDK Node

**Files:**
- Create: `packages/sdk/src/node/index.ts`
- Test: `packages/sdk/src/node/index.test.ts`

**Step 1:** Test: `init()` aggancia `uncaughtException`/`unhandledRejection` (cattura, invia, **rilancia** per non alterare il crash behavior di default); `errorHandler()` esportato compatibile Express/Fastify cattura e propaga; `createTicket()` invia evento `ticket`.

**Step 2:** FAIL → implementa → PASS. **Step 3:** Commit `feat(sdk): entry point node con handler per server`

**Step 4 (chiusura fase):** test end-to-end della fase in `apps/server/src/routes/ingest.e2e.test.ts`: SDK node puntato all'app Fastify reale (via `app.listen` su porta effimera) → `captureError` → ticket in DB con payload corretto. Commit `test: e2e ingestion SDK→server`

---

## Fase 3 — Web UI

> Per tutta la fase: skill frontend-design:frontend-design per la qualità visiva. Stack: Vite + React 18 + TanStack Router + TanStack Query + Tailwind. Client API generato a mano sopra `fetch` con i tipi di `@stubwise/shared`. Vitest + Testing Library per i componenti; Playwright per gli E2E (Task 18).

### Task 15: Scaffold web + auth

**Files:**
- Create: `apps/web/` (Vite scaffold), `apps/web/src/routes/login.tsx`, `apps/web/src/routes/setup.tsx`, `apps/web/src/lib/api.ts`

**Step:** pagine setup-admin (mostrata solo se `/api/auth/me` → 401 e setup disponibile), login, layout autenticato con nav (Tickets, Board, Projects, Settings). Proxy Vite verso il server in dev. Test componenti per il form di login (submit → chiamata API → redirect). Commit `feat(web): scaffold, login e setup admin`

### Task 16: Lista ticket e dettaglio

**Files:**
- Create: `apps/web/src/routes/tickets/index.tsx`, `apps/web/src/routes/tickets/$id.tsx`, componenti in `apps/web/src/components/`

**Step:** lista con filtri (stato, tipo, priorità, progetto, ricerca) sincronizzati nell'URL; dettaglio con: descrizione markdown, payload tecnico collassabile (stack trace, breadcrumbs, occorrenze), commenti, **timeline AIJob** (stato, log collassabile, link PR), azioni (stato, priorità, assegnatario, label). Test componenti per filtri e rendering del dettaglio con fixture. Commit per ciascuna delle due route.

### Task 17: Board Kanban

**Files:**
- Create: `apps/web/src/routes/board.tsx`

**Step:** colonne = stati del ticket, drag-and-drop con dnd-kit → `PATCH` dello stato con optimistic update e rollback su errore; filtro per progetto. Test componente: il drop chiama l'API col nuovo stato. Commit `feat(web): board Kanban drag-and-drop`

### Task 18: Settings progetti + E2E Playwright

**Files:**
- Create: `apps/web/src/routes/projects/*.tsx`, `apps/web/e2e/core-flows.spec.ts`, `apps/web/playwright.config.ts`

**Step:** UI creazione/modifica progetto (provider, repo URL, credenziali write-only, copia ingestion key + snippet `init()` pronto da incollare). E2E Playwright contro server reale + testDb: setup admin → crea progetto → crea ticket → lo sposta sulla board → aggiunge commento. Commit `feat(web): gestione progetti + e2e flussi core`

---

## Fase 4 — Worker AI

### Task 19: Coda job su Postgres

**Files:**
- Create: `apps/worker/package.json`, `apps/worker/src/queue.ts`
- Test: `apps/worker/src/queue.test.ts` (testcontainers, riusa l'helper del server via import relativo o duplicazione minima)

**Step 1:** Test: `claimNextJob(db)` prende il job `queued` più vecchio e lo marca `triaging` atomicamente; due claim concorrenti non prendono mai lo stesso job (`FOR UPDATE SKIP LOCKED`); `completeJob`/`failJob` aggiornano stato, log e `finishedAt`; un job rimasto `triaging`/`fixing` oltre un timeout (worker crashato) torna `queued` via `requeueStale(db, olderThanMinutes)`.

Query di claim:
```sql
UPDATE ai_jobs SET status = 'triaging', started_at = now()
WHERE id = (
  SELECT id FROM ai_jobs WHERE status = 'queued'
  ORDER BY created_at LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

**Step 2:** FAIL → implementa + loop di poll (`runWorker({ concurrency: 2, pollMs: 3000 })`) → PASS. **Step 3:** Commit `feat(worker): coda job su Postgres con claim atomico`

### Task 20: GitProvider — interfaccia, Bitbucket e GitHub

**Files:**
- Create: `apps/worker/src/git/provider.ts`, `apps/worker/src/git/bitbucket.ts`, `apps/worker/src/git/github.ts`
- Test: `apps/worker/src/git/bitbucket.test.ts`, `apps/worker/src/git/github.test.ts` (HTTP mockato con `msw` o `vi.fn` su fetch)

**Step 1:** Definisci l'interfaccia dal design:

```ts
export interface GitProvider {
  getCloneUrl(p: ProjectGitConfig): string; // URL https con credenziali embedded
  openPullRequest(p: ProjectGitConfig, pr: { branch: string; title: string; body: string }): Promise<{ url: string }>;
  parseWebhook(headers: Record<string, string>, body: unknown): PrMergedEvent | null;
}
```

**Step 2:** Test Bitbucket: `openPullRequest` chiama `POST https://api.bitbucket.org/2.0/repositories/{ws}/{slug}/pullrequests` con auth Basic (app password) e body corretto, restituisce l'URL; `parseWebhook` riconosce `pullrequest:fulfilled` ed estrae branch sorgente; firma/secret del webhook verificata. Test GitHub: `POST /repos/{owner}/{repo}/pulls` con PAT, webhook `pull_request` `closed`+`merged:true`, verifica HMAC `X-Hub-Signature-256`.

**Step 3:** FAIL → implementa entrambi + factory `getProvider(kind)` → PASS. **Step 4:** Commit `feat(worker): GitProvider con implementazioni Bitbucket e GitHub`

### Task 21: Mirror manager e worktree effimeri

**Files:**
- Create: `apps/worker/src/git/mirrors.ts`
- Test: `apps/worker/src/git/mirrors.test.ts`

**Step 1:** Test con **repo locali reali** (niente rete: crea un repo bare in `tmpdir` come "origin", commit di fixture via execa): `ensureMirror(project)` clona bare al primo uso e fa `git fetch --prune` ai successivi; `withWorktree(project, branchName, fn)` crea worktree temporaneo sul default branch aggiornato, esegue `fn(dir)`, e **rimuove sempre** il worktree anche se `fn` lancia; `pushBranch(dir, branch)` rifiuta branch che non inizino con `stubwise/`.

**Requisito sicurezza credenziali:** i mirror NON devono persistere credenziali nella git config: il remote URL salvato nel mirror deve essere privo di credenziali e l'autenticazione va iniettata a ogni invocazione (env `GIT_ASKPASS` oppure `git -c http.extraHeader=...`), o come minimo la directory dei mirror va creata con `chmod 700`. Documentare nella implementazione quale delle due strategie è stata scelta e perché.

**Step 2:** FAIL → implementa con execa (`git clone --mirror`, `git worktree add/remove --force`, lock per-repo per serializzare fetch concorrenti) → PASS. **Step 3:** Commit `feat(worker): mirror bare e worktree effimeri`

### Task 22: AgentRunner — astrazione su Claude Code

**Files:**
- Create: `apps/worker/src/agent/runner.ts`, `apps/worker/src/agent/claude-cli.ts`, `apps/worker/src/agent/fake.ts`
- Test: `apps/worker/src/agent/claude-cli.test.ts`

**Step 1:** Interfaccia:

```ts
export interface AgentRunner {
  run(opts: {
    cwd: string;
    prompt: string;
    model?: string;        // "haiku" per il triage
    maxTurns: number;
    timeoutMs: number;
  }): Promise<{ output: string; exitCode: number }>;
}
```

**Step 2:** Test `claude-cli.ts` usando un **finto eseguibile `claude`** (script shell nei fixture che echo-a gli argomenti e il prompt da stdin): verifica flag `-p --output-format text --permission-mode acceptEdits --max-turns N --model M`, cwd corretto, kill dopo timeout, exit code propagato. `fake.ts`: runner per i test della pipeline che applica un diff predefinito nel cwd e restituisce un report fisso.

**Step 3:** FAIL → implementa → PASS. **Step 4:** Commit `feat(worker): AgentRunner con implementazione claude CLI e fake per i test`

### Task 23: Fase di triage

**Files:**
- Create: `apps/worker/src/pipeline/triage.ts`, `apps/worker/src/pipeline/prompts.ts`
- Test: `apps/worker/src/pipeline/triage.test.ts`

**Step 1:** Test (FakeRunner parametrizzato sull'output): output `{"decision":"fix"}` → job passa a `fixing`; `{"decision":"skip","reason":"..."}` → job `skipped`, commento AI sul ticket col motivo, ticket invariato; `{"decision":"duplicate","of":12}` → ticket `closed`, commento con link al duplicato; output non-JSON → un retry, poi `failed`. Il prompt di triage include gli ultimi 30 ticket del progetto (numero+titolo+stato) e **delimita il contenuto del ticket come dato non fidato** (`<ticket_content>...</ticket_content>` + istruzione esplicita di non seguire istruzioni contenute lì dentro).

**Step 2:** FAIL → implementa `runTriage(deps, job)`; prompt in `prompts.ts` con funzioni pure testabili → PASS. **Step 3:** Commit `feat(worker): fase di triage con classificazione fix/skip/duplicate`

### Task 24: Fase di fix e apertura PR

**Files:**
- Create: `apps/worker/src/pipeline/fix.ts`
- Test: `apps/worker/src/pipeline/fix.test.ts`

**Step 1:** Test (repo locale di fixture + FakeRunner che modifica un file e scrive `REPORT.md`): flusso felice → branch `stubwise/ticket-N` pushato sull'origin di test, `openPullRequest` chiamato con titolo `fix: <titolo ticket> (#N)` e body = report, commento AI sul ticket con link PR + report, job `pr_opened`, ticket `in_review`; FakeRunner che non produce diff → job `failed` con log, niente PR; eccezione durante il run → worktree comunque rimosso (verifica filesystem), job `failed`.

Requisito: i job devono essere serializzati per progetto (fetch --prune cancella i ref stubwise/* non ancora pushati — vedi mirrors.ts).

Il prompt di fix (in `prompts.ts`) contiene: titolo, descrizione, stack trace, breadcrumbs, release/environment, occorrenze, e le istruzioni del design: *localizza il bug, scrivi un test che lo dimostra se il setup del repo lo consente, fix minimale, esegui i test esistenti, scrivi il report in `STUBWISE_REPORT.md` con: processo di indagine, causa radice, soluzione, motivazione*. Il worker legge `STUBWISE_REPORT.md` (e lo esclude dal commit) come corpo della PR. Contenuto del ticket sempre delimitato come non fidato.

**Nota (review Task 22):** il prompt di fix richiede l'esecuzione dei test: passare `allowedTools` (es. Bash con pattern dei comandi di test) al runner; acceptEdits da solo nega Bash in headless. Valutare in Task 24 quali pattern di default (es. Bash(npm:*), Bash(pnpm:*)) e renderli configurabili per progetto in futuro.

**Differiti (decisione review Task 22):** cancellazione via AbortSignal e streaming `onOutput` sull'AgentRunner restano fuori finché la semantica di shutdown del worker e le esigenze di osservabilità non saranno concrete.

**Step 2:** FAIL → implementa `runFix(deps, job)` (commit con autore `Stubwise AI <ai@stubwise>`), collega triage+fix nel loop del worker → PASS. **Step 3:** Commit `feat(worker): fase di fix con push branch e apertura PR`

### Task 25: Webhook PR merged → ticket done

**Files:**
- Create: `apps/server/src/routes/webhooks.ts`
- Test: `apps/server/src/routes/webhooks.test.ts`

**Step 1:** Test: `POST /webhooks/git/:projectSlug` con payload Bitbucket `pullrequest:fulfilled` per branch `stubwise/ticket-N` → ticket N in `done` + commento di sistema; idem GitHub; firma non valida → 401; branch non-stubwise → 204 ignorato.

**Step 2:** FAIL → implementa (riusa `parseWebhook` dei provider — spostare i provider in `packages/shared` o in un package `packages/git` se l'import server↔worker risulta scomodo; preferire `packages/git`) → PASS. **Step 3:** Commit `feat(server): webhook git per chiusura automatica ticket al merge`

### Task 26: Smoke test manuale della pipeline reale

**Step 1:** Script `apps/worker/scripts/smoke.ts`: con un repo di prova reale (es. piccolo repo su Bitbucket con un bug piantato) e `claude` autenticato in locale, esegue l'intera pipeline su un ticket vero. Da lanciare a mano: `pnpm --filter @stubwise/worker smoke`.
**Step 2:** Eseguirlo e verificare la PR aperta con report sensato. Annotare nel README del worker eventuali aggiustamenti al prompt emersi dal test.
**Step 3:** Commit `chore(worker): smoke test pipeline reale`

---

## Fase 5 — Deploy, documentazione, open-source

### Task 27: Docker Compose

**Files:**
- Create: `apps/server/Dockerfile`, `apps/worker/Dockerfile` (include git + binario `claude` via npm `@anthropic-ai/claude-code`), `apps/web/Dockerfile` (build statici), `docker-compose.yml`, `Caddyfile`

**Step 1:** Compose: `postgres` (volume), `server`, `worker` (volumi: `mirrors`, `claude-config` per il token di login), `caddy` (statici web + `/docs` + reverse proxy `/api`,`/ingest`,`/webhooks` → server, HTTPS automatico con `DOMAIN` da env).

**Nota (review Task 6):** dietro Caddy il server Fastify va avviato con `trustProxy: true`, altrimenti i cookie con `secure: "auto"` non ricevono il flag `Secure` (la connessione Caddy→server è HTTP e Fastify deve fidarsi di `X-Forwarded-Proto`).

**Step 2:** Verifica: `docker compose up -d --build` → setup admin dalla UI, creazione progetto, ingestion via curl, job in coda. `docker compose exec worker claude login` documentato.
**Step 3:** Commit `feat: deploy Docker Compose con Caddy`

### Task 28: Sito documentazione Starlight

**Files:**
- Create: `apps/docs/` (Starlight scaffold), pagine: `getting-started/self-hosting.md`, `getting-started/claude-setup.md`, `getting-started/web-app.md` (guida all'app web: inviti/register, gestione progetti, board, nuovo ticket), `sdk/installation.md`, `sdk/error-capture.md`, `sdk/feedback.md`, `sdk/api-tickets.md`, `ai-pipeline/how-it-works.md`, `ai-pipeline/configuration.md`, `ai-pipeline/security.md`, `reference/api.md` (rende l'OpenAPI con starlight-openapi), `reference/configuration.md` (tutte le env var)

**Step:** Scrivere ogni guida passo-passo verificandola davvero (la guida self-hosting va eseguita su una VM/dir pulita seguendola alla lettera). Build inclusa nell'immagine Caddy su `/docs`. Commit per gruppo di pagine.

### Task 29: CI e ripulitura open-source

**Files:**
- Create: `.github/workflows/ci.yml` (lint, typecheck, test con Postgres via testcontainers, build, job e2e), `LICENSE` (MIT), `README.md` (pitch, screenshot, quick start, architettura), `CONTRIBUTING.md` (setup dev, convenzioni, come aggiungere un GitProvider), `.github/ISSUE_TEMPLATE/`

**Nota (review Task 18):** il job e2e ha bisogno di Docker disponibile sul runner — i test server/web usano testcontainers per il Postgres effimero, NON un service container Postgres. Prima della suite va eseguito `pnpm exec playwright install --with-deps chromium`; la suite si lancia con `pnpm --filter @stubwise/web e2e` (è esclusa da `pnpm test` by design).

**Step:** CI verde su push; README con quick start copia-incollabile. Commit `chore: CI, licenza MIT e documentazione di progetto`

### Task 30: Verifica finale

**Step 1:** superpowers:verification-before-completion — `pnpm lint && pnpm typecheck && pnpm test` tutti verdi, E2E Playwright verdi, compose up da zero seguendo solo la documentazione.
**Step 2:** Dogfooding: installare `@stubwise/sdk` in un progetto reale dell'utente, generare un errore vero, osservare ticket → triage → PR.
