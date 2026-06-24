# Auto-aggiornamento Docs — Fase 1 (Changelog automatico) — Piano

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Ad ogni push sul branch di produzione (se il progetto ha il toggle on),
con debounce e skip del rumore, un agente analizza il diff e crea una **entry
release** in una nuova sezione `releases`, con filtro di significatività. NIENTE
refresh dei docs in questa fase (è la Fase 2).

**Design:** `docs/plans/2026-06-24-docs-auto-update-design.md`.

**Tech Stack:** Drizzle/Postgres, Fastify+Zod, `@stubwise/git` (provider webhook),
worker (poller + agente claude CLI), React+TanStack, Vitest.

---

## Task 1: DB — toggle, provider auto, tabella debounce, kind `releases`

**Files:** `packages/db/src/schema.ts` + migrazioni in `packages/db/drizzle/`.

**Step 1.** In `projects` (schema.ts ~233-273) aggiungi:
```ts
docAutoUpdate: boolean("doc_auto_update").notNull().default(false),
docAutoUpdateProviderId: uuid("doc_auto_update_provider_id").references(() => aiProviders.id, { onDelete: "set null" }),
```

**Step 2.** Nuova tabella (vicino a `docGenerations`):
```ts
export const docAutoUpdateJobs = pgTable("doc_auto_update_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  fromSha: text("from_sha").notNull(),
  toSha: text("to_sha").notNull(),
  notBefore: timestamp("not_before", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [uniqueIndex("doc_auto_update_jobs_project_unique").on(t.projectId)]);
```
Un pending per progetto (unique) → il webhook fa upsert.

**Step 3.** Enum: aggiungi `"releases"` a `docPageKind`. In Postgres l'enum si
estende con `ALTER TYPE "doc_page_kind" ADD VALUE 'releases'`. Aggiorna ANCHE lo
Zod `docPageKindSchema` in `packages/shared/src/schemas/docs.ts:9`. Genera la
migrazione con `pnpm --filter @stubwise/db exec drizzle-kit generate` e VERIFICA
che produca l'ADD VALUE (drizzle a volte non lo genera da solo: se manca,
scrivi a mano il file SQL della migrazione con l'`ALTER TYPE ... ADD VALUE` —
fuori da una transazione se necessario). Verifica che il resto sia solo additivo.

**Step 4.** `pnpm --filter @stubwise/db typecheck && pnpm --filter @stubwise/db build` e `pnpm --filter @stubwise/shared build`.

**Step 5.** Commit: `feat(db): toggle auto-update, provider auto, doc_auto_update_jobs, kind releases`.

---

## Task 2: `@stubwise/git` — parsing dell'evento push

**Files:** `packages/git/src/provider.ts` (tipi + interface), `github.ts`,
`bitbucket.ts`, e i rispettivi `*.test.ts`.

**Contesto:** oggi `WebhookEvent = { kind: "merged"|"closed_unmerged", branch, prUrl }`
e `parseWebhook` gestisce solo le PR. NON toccare quel percorso.

**Step 1.** Nuovo tipo:
```ts
export interface PushWebhookEvent {
  branch: string;        // nome del branch (es. "main"), senza refs/heads/
  beforeSha: string;     // commit precedente (può essere "0000…" su nuovo branch)
  afterSha: string;      // nuovo HEAD
  commits: { sha: string; message: string }[];
}
```
e un nuovo metodo sull'interface `GitProvider`:
`parsePushEvent(headers: Record<string,string>, body: unknown): PushWebhookEvent | null;`
(ritorna null se il payload NON è un push, es. è una PR o altro evento).

**Step 2 — GitHub (`github.ts`).** Il push webhook ha header `x-github-event: push`,
e body `{ ref: "refs/heads/main", before, after, commits: [{ id, message }] }`.
Estrai `branch` da `ref` (strip `refs/heads/`), `beforeSha=before`, `afterSha=after`,
`commits` da `commits[]` (`sha=id`, `message`). Ritorna null se l'evento non è push
o il ref non è un branch.

**Step 3 — Bitbucket (`bitbucket.ts`).** Header `x-event-key: repo:push`, body
`{ push: { changes: [{ old, new, commits: [...] }] }}`. Prendi il primo change con
`new.type === "branch"`; `branch = new.name`, `afterSha = new.target.hash`,
`beforeSha = old?.target?.hash ?? "0".repeat(40)`, `commits` da `change.commits`
(o vuoto). Null se non è un push di branch.

**Step 4 — test.** Per ciascun provider: un payload push valido → `PushWebhookEvent`
corretto; un payload PR (quello già testato per parseWebhook) → `parsePushEvent`
ritorna null; un payload di delete branch / tag → null. Riusa i fixture esistenti
dei test webhook dove possibile.

**Step 5.** `pnpm --filter @stubwise/git typecheck && pnpm --filter @stubwise/git test && pnpm --filter @stubwise/git build`.

**Step 6.** Commit: `feat(git): parsePushEvent per GitHub e Bitbucket`.

---

## Task 3: MirrorManager — file cambiati + commit del range

**Files:** `apps/worker/src/git/mirrors.ts` + test.

**Contesto:** `MirrorManager` ha `runGit()` (riga ~187) e gestisce il mirror per
progetto. Manca un wrapper diff.

**Step 1.** Aggiungi:
```ts
/** File cambiati tra due commit (git diff --name-only fromSha..toSha) nel mirror. */
async getChangedFiles(project, fromSha: string, toSha: string): Promise<string[]>
/** Messaggi dei commit nel range (git log --format=%H%x00%s fromSha..toSha). */
async getCommitMessages(project, fromSha: string, toSha: string): Promise<{ sha: string; subject: string }[]>
```
Entrambi: `ensureMirror(project)` poi `runGit(...)` nel mirror; parse dell'output
per riga (filtra righe vuote). Gestisci il caso `fromSha` non presente
(es. shallow): in tal caso ritorna lista vuota / fallback documentato. Robustezza:
errori → throw con messaggio chiaro (il chiamante decide).

**Step 2 — test.** Riusa il pattern dei test di `mirrors.ts` (se creano un repo
git temporaneo con commit). Crea 2 commit, verifica `getChangedFiles` ritorni i
file modificati tra essi, e `getCommitMessages` i subject. Se i test esistenti non
fanno repo reali, crea un repo bare/temp minimale nel test.

**Step 3.** `pnpm --filter @stubwise/worker typecheck && pnpm --filter @stubwise/worker test mirrors`.

**Step 4.** Commit: `feat(worker): getChangedFiles/getCommitMessages nel MirrorManager`.

---

## Task 4: Server — webhook push (debounce) + impostazioni progetto

**Files:** `apps/server/src/routes/webhooks.ts`, la route di update progetto
(cerca `apps/server/src/routes/projects.ts` per il PATCH/update), `docAutoUpdateJobs`
import; test relativi.

**Step 1 — webhook push.** In `webhookRoutes`, nell'handler (dopo la verifica
firma, PRIMA o in alternativa al `parseWebhook` delle PR): prova
`provider.parsePushEvent(headers, request.body)`. Se è un push:
- carica il progetto (`defaultBranch`, `docAutoUpdate`, `currentDocGenerationId`).
- **Gate**: se `push.branch !== project.defaultBranch` OR `!project.docAutoUpdate`
  → `reply.code(204)` no-op.
- altrimenti **upsert** in `doc_auto_update_jobs` su `projectId`:
  - `toSha = push.afterSha`;
  - `notBefore = now + DEBOUNCE` (costante, es. 5 min; valuta env `DOCS_AUTOUPDATE_DEBOUNCE_MINUTES`);
  - `fromSha`: su INSERT = il commit della generazione corrente
    (`doc_generations.commitSha` della `currentDocGenerationId`) se esiste,
    altrimenti `push.beforeSha`; su CONFLICT (pending già presente) NON cambiare
    `fromSha` (accumula), aggiorna solo `toSha` e `notBefore`.
  Usa `onConflictDoUpdate` target `projectId`.
- `reply.code(204)`.
Se NON è un push, prosegui col flusso PR esistente (parseWebhook) INVARIATO.

**Step 2 — impostazioni progetto.** Nella route di update del progetto aggiungi i
campi opzionali `docAutoUpdate?: boolean` e `docAutoUpdateProviderId?: string|null`
(valida che, se non null, il provider esista; non serve enabled qui — è scelta di
configurazione, il worker validerà al run). Aggiorna lo schema di risposta del
progetto per includerli (così la UI li legge).

**Step 3 — test.** webhook: push sul `defaultBranch` con toggle ON → crea/aggiorna
il pending (verifica `to_sha`, `not_before` futuro, `from_sha` dalla generazione);
secondo push → stesso pending aggiornato (no duplicati), `from_sha` invariato;
push su branch diverso → no-op (nessun pending); toggle OFF → no-op; HMAC errato →
401 (invariato); evento PR → comportamento PR invariato. settings: update con
`docAutoUpdate=true` persiste; provider inesistente → 400.

**Step 4.** `pnpm --filter @stubwise/server typecheck && pnpm --filter @stubwise/server test && pnpm lint`.

**Step 5.** Commit: `feat(server): webhook push → debounce auto-update + impostazioni progetto`.

---

## Task 5: Worker — poller di debounce + handler auto-update (release entry)

**Files:** nuovo `apps/worker/src/docs/auto-update.ts` (handler) + poller (mirroring
`apps/worker/src/agent/usage-poller.ts`), wiring in `apps/worker/src/index.ts`,
prompt agente in `packages/docs-engine/src/` (nuovo `releases.ts` o simile), test.

**Step 1 — poller.** Un task periodico (come `startUsagePoller`) che ogni ~60s
fa: `select * from doc_auto_update_jobs where not_before <= now()`. Per ciascuno,
esegue l'handler nella **catena per-progetto** (riusa il `serializer` condiviso,
così non si sovrappone a fix/generazioni). Claim sicuro: cancella/segna la riga
prima di processare (o dopo, con guard) — evita doppi processi. Intervallo
configurabile (env, default 60s; 0 = disabilitato).

**Step 2 — handler `runAutoUpdate(deps, job)`.**
1. Carica progetto (`defaultBranch`, `docAutoUpdateProviderId`, `currentDocGenerationId`).
2. `mirrors.getChangedFiles(project, job.fromSha, job.toSha)` + `getCommitMessages`.
3. **Gate rumore (deterministico)**: filtra i file di rumore (lockfile:
   `pnpm-lock.yaml`/`package-lock.json`/`yarn.lock`; cartelle escluse —
   riusa/duplica la lista di esclusione dell'orientamento, es. `plans/`, `docs/`,
   `.github/` se già escluse; vedi `packages/docs-engine/src/recursive/orient.ts`).
   Se DOPO il filtro non resta nulla → niente agente, niente entry, avanza
   `fromSha`: cancella il pending. Fine.
4. **Provider**: se `docAutoUpdateProviderId` set → `loadProviderById`; se null
   (disabilitato) → fallisci il job con log chiaro (NIENTE fallback, coerente con
   il "provider bloccato"); altrimenti `chain[0]` (come la generazione normale).
5. **Agente di analisi** (1 run read-only, worktree al `toSha`): prompt che riceve
   i file cambiati + i commit + (opzionale) un estratto del diff, e produce output
   strutturato (contratto a marcatori come gli altri agenti del motore):
   `{ significant: boolean, title: string, body: string (markdown), affectedSlugs: string[] }`.
   Aiuta l'agente passandogli l'elenco delle pagine esistenti (slug+title+sourcePath)
   così può citare quelle impattate.
6. **Entry release**: inserisci una `doc_pages` con `kind="releases"`,
   `generationId: null` (persistente), `isManual: false`, slug
   `release-<YYYYMMDD-HHmm>-<shortSha>` (unico), `title` = (significant ? title : `[minore] ${title}`),
   `body` = markdown dell'agente, `position` decrescente nel tempo (es. `-epoch`)
   così le più recenti sono in cima, `sourcePath: null`, `links` = i cross-link
   alle `affectedSlugs` esistenti (tipo "related"). Re-embedda la pagina release se
   gli altri doc vengono embeddati (riusa il path di embed; se complica, in Fase 1
   si può saltare l'embed della release — documentalo).
7. Aggiorna `doc_generations.commitSha` della generazione corrente a `job.toSha`
   (i docs sono "visti fino a" toSha). Cancella il pending.

Best-effort/idempotente: un errore non deve lasciare il pending in loop infinito
(dopo N tentativi, log e drop o backoff).

**Step 3 — test (runner fake).** Riusa i fake (`FakeAgentRunner`) dei test docs.
Casi: diff di solo rumore → nessuna entry, pending rimosso, fromSha avanzato; diff
sostanziale → l'agente è invocato, viene creata una pagina `kind=releases`
persistente con i campi giusti; agente che marca `significant=false` → titolo
"[minore]"; provider auto disabilitato → job fallito senza entry; poller reclama
solo i `not_before` scaduti.

**Step 4.** `pnpm --filter @stubwise/worker typecheck && pnpm --filter @stubwise/worker test && pnpm lint`.

**Step 5.** Commit: `feat(worker): poller debounce + handler auto-update con entry release`.

---

## Task 6: Web — gruppo "Releases" + impostazioni progetto

**Files:** `apps/web/src/components/docs-tree.tsx`, i18n `it/en.json`, la pagina/
form impostazioni progetto (cerca dove si modifica il progetto, es.
`apps/web/src/routes/projects/...` o un settings), client API progetto.

**Step 1 — DocsTree.** Aggiungi `"releases"` a `GROUP_ORDER` (in coda o dopo
manual) e una entry in `GROUP_LABEL_KEY` → `docs:space.groupReleases`. Aggiungi le
chiavi i18n `groupReleases` ("Releases" / "Rilasci"? usa "Releases" in entrambe se
preferisci il termine inglese — valuta). Nessun'altra modifica: l'albero,
collassabile e con la command palette, funziona già per qualsiasi kind. Aggiorna i
test di `docs-tree` se asseriscono l'insieme esatto dei gruppi.

**Step 2 — impostazioni progetto.** Aggiungi alla UI di modifica progetto: un
toggle "Auto-aggiorna la documentazione ad ogni push" (`docAutoUpdate`) e un select
opzionale del provider (riusa `listAiProviders`, come nel pannello di generazione)
per `docAutoUpdateProviderId`. Collega al client API di update progetto (estendi il
tipo del progetto con i due campi). i18n per le label.

**Step 3 — test.** docs-tree: il gruppo Releases compare con le pagine `kind=releases`.
settings: il toggle e il select inviano i campi giusti all'update.

**Step 4.** `pnpm --filter @stubwise/web typecheck && pnpm --filter @stubwise/web test && pnpm lint`.

**Step 5.** Commit: `feat(web): sezione Releases nella sidebar + impostazioni auto-update`.

---

## Task 7: Verifica finale + deploy (Fase 1)

**Step 1.** Dalla radice del worktree: `pnpm typecheck && pnpm lint`, poi i test
per-package toccati (db/git/server/worker/web). `-r test` è flaky con testcontainers
concorrenti → per-package.

**Step 2.** REQUIRED SUB-SKILL: superpowers:finishing-a-development-branch (merge su main).

**Step 3.** Deploy: `server` (webhook + migrazioni) + `worker` (poller + agente) +
`caddy` (UI). Worker ricostruito a generazioni ferme. Verifica colonne/enum,
health, e che il poller parta nel log.

**Step 4 — verifica reale (manuale).** Configura il webhook push sul repo di prova
(GitHub/Bitbucket), abilita il toggle sul progetto, fai un push sul branch di
produzione, attendi il debounce e verifica che compaia la entry in "Releases".

---

## Note trasversali

- **Niente refresh dei docs in Fase 1**: solo la entry release. Il refresh mirato è
  Fase 2 (`affectedSlugs` qui serve solo per i cross-link della entry).
- **Default off**: senza toggle, zero comportamento nuovo. Il webhook PR resta intatto.
- **Riuso**: provider bloccato (`loadProviderById`), serializer per-progetto,
  pattern poller, rendering doc_pages/DocsTree. YAGNI: niente UI nuove se riusabili.
- **Debounce sicuro**: un pending per progetto (unique), il poller claima e rimuove
  in modo idempotente.
