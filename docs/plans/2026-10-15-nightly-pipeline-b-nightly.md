# Giro notturno — Piano B: riassunti dei commit, daily report, note di rilascio, Docs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** un solo processo notturno legge ogni commit una volta (Haiku 5.5), scrive i daily report dai riassunti, una nota di rilascio per progetto dai commit entrati nel branch di default (Sonnet 5.5) e aggiorna o crea le pagine dei Docs toccate (Sonnet 5.5), senza tetti sul lavoro ma sotto la soglia di quota degli abbonamenti; sostituisce l'aggiornamento Docs a ogni push.

**Architecture:** una coda persistente di elementi di lavoro (`nightly_items`) per repository e fase, consumata da un orchestratore che parte a `NIGHTLY_START` e alterna i repository. I riassunti dei commit stanno in `commit_summaries` e alimentano tutte le fasi. Il punto di partenza dei Docs è il `commit_sha` della generazione corrente (come oggi), che ora avanza a fine fase Docs indipendentemente dalla nota. Ogni run passa da `runWithProviders` del Piano A con `workClass: "background"`.

**Tech Stack:** Node 22, TypeScript, drizzle + postgres.js, Fastify + Zod 4, React, Vitest + testcontainers, `@stubwise/docs-engine`.

**Spec:** `docs/plans/2026-10-15-nightly-pipeline-design.md`. Prerequisito: Piano A (`docs/plans/2026-10-15-nightly-pipeline-a-quota.md`) completo.

## Global Constraints

- Migrazione **0089** (tabelle) e **0090** (`ALTER TYPE notification_kind ADD VALUE 'docs.nightly_attention'`, DA SOLA: il valore non può essere usato nella transazione del batch in cui nasce). `when` 0089 = `1792108800000`, 0090 = `1792195200000`.
- Modelli configurabili, alias del CLI: `COMMIT_SUMMARY_MODEL` (default `haiku`), `RELEASE_NOTES_MODEL` (default `sonnet`), `DOCS_NIGHTLY_MODEL` (default `sonnet`). La generazione Docs completa resta su `DOC_GENERATION_MODEL`.
- Nessun tetto sul numero di pagine aggiornate o create. Freno: la soglia di quota del Piano A. Allarme a `NIGHTLY_ALERT_RUNS` (default 50) run Sonnet pianificati per un repository in una notte.
- Altre env: `NIGHTLY_START` (default `01:00`, formato `HH:MM`, fuso `Europe/Rome`), `COMMIT_SUMMARY_WINDOW_DAYS` (default 30), `COMMIT_DIFF_MAX_CHARS` (default 20000).
- Tutte le fasi sono idempotenti e riprendono dalla coda; nessuno stato del giro tiene solo in memoria, salvo i worktree.
- Il segnalibro dei Docs (`doc_generations.commit_sha` della generazione corrente) **non dipende dalla nota di rilascio**.
- Il giorno di un commit nel daily report è il **giorno UTC** della committer date (vedi «Cose trovate»).
- I campi nuovi letti da web/app nascono `.nullable().default(null)` e il web li difende al punto di lettura.
- Il webhook push NON accoda più lavoro Docs. Il recount dei report e la build del grafo restano.

## Review Focus

1. **Branch vecchio mergiato**: commit con data di 20 giorni fa entrano oggi nel branch di default. Attesi: riassunti (se non c'erano), assegnati al loro giorno UTC, nessun daily report passato rigenerato, inclusi nella nota di rilascio e nei Docs di stanotte. Test in Task B2/B5.
2. **Force-push del branch di default** (il commit del segnalibro non esiste più): atteso un ripiego esplicito (commit del branch di default entro la finestra) con una riga di log, mai un errore che blocca il repository per sempre. Test in Task B2.
3. **Limite di quota a metà della fase Docs**: attesi gli elementi fatti marcati `done`, i restanti `pending`, il segnalibro NON avanzato, ripresa la notte dopo (o prima, se il margine torna) dal punto giusto, nessun riassunto rifatto. Test in Task B7.
4. **Commit di solo rumore o gigante**: atteso un riassunto deterministico senza modello per il rumore; diff tagliato a `COMMIT_DIFF_MAX_CHARS` col numstat completo per il gigante. Test in Task B3.
5. **Pagina toccata ma «nessun cambiamento»**: attesa la pagina invariata, l'elemento `done`, l'avviso «superata» sparito dopo l'avanzamento del segnalibro. Test in Task B6/B9.

## Cose trovate nel codice (nessuna smentisce la spec)

- Il daily report usa i **giorni UTC** (`previousUtcDay`, `activity_reports.date`); i progetti non hanno un fuso. La spec dice «nel fuso del progetto»: si resta su UTC, coerente coi report esistenti.
- La rigenerazione manuale (`POST /api/activity/generate`) inserisce righe `activity_reports` `queued` che il poller del daily report consuma: il poller resta per questo, perde solo la creazione automatica del giorno precedente (la fa il giro) e le descrizioni per commit (diventano i riassunti).
- Il punto di partenza dei Docs è già `doc_generations.commit_sha` della generazione corrente: non serve una colonna nuova, serve che avanzi alla fine della fase Docs invece che dopo la nota.
- `docPageSchema` ha già `commitSha` e `updatedAt`: «aggiornata al commit X, il giorno Y» è già disponibile. Serve solo l'avviso «superata».
- L'avviso «superata» si può derivare solo dai commit già riassunti: un commit mergiato oggi e non ancora visto dal giro non lo accende. È coerente con «entro un giorno».

---

## File structure

| File | Responsabilità |
|---|---|
| `packages/db/drizzle/0089_nightly.sql`, `0090_nightly_notification.sql`, `schema.ts` | `commit_summaries`, `nightly_items`; valore `docs.nightly_attention` |
| `apps/worker/src/git/mirrors.ts` | `listRecentCommits`, `listDefaultBranchCommitsSince`, `getCommitDiff` (esistente) |
| `apps/worker/src/nightly/queue.ts` | elementi di lavoro: crea, reclama, chiude, fallisce, escalation a 3 notti |
| `apps/worker/src/nightly/commit-summary.ts` | prompt, parser, gate del rumore, fase 1 |
| `apps/worker/src/reports/daily-report-poller.ts` | descrizioni dai riassunti; niente più creazione automatica del giorno |
| `apps/worker/src/nightly/release.ts` | fase 3 (riusa `buildReleasePrompt`, slug e link da `auto-update.ts`) |
| `apps/worker/src/nightly/docs.ts` | fase 4 (riusa refresh, guardia `product`, grow, embed) |
| `apps/worker/src/nightly/orchestrator.ts` | orario, giro dei repository, fasi, quota, allarme, ripresa |
| `packages/docs-engine/src/{refresh-page,releases}.ts` | campo additivo `commitSummaries` nei prompt |
| `packages/shared`, `packages/notifications`, `packages/i18n` | evento `docs.nightly_attention`, template |
| `apps/server/src/routes/docs.ts`, `packages/shared/src/schemas/docs.ts`, web Docs | avviso «superata» derivato a lettura |
| `apps/server/src/routes/webhooks.ts`, `apps/worker/src/docs/auto-update*.ts`, `index.ts`, `config.ts`, compose | rimozioni e cablaggio |
| `apps/worker/scripts/golden/` | scenario `nightly` |

## Interfacce (CONTRATTO)

```ts
// packages/db (Task B1)
commitSummaries: { repositoryId, sha (PK con repositoryId), committedAt, authorName, authorEmail, subject, summary (text), files (text[]), areas (text[]), noise (boolean), onDefaultBranch (boolean), model (text|null), costUsd (numeric|null), createdAt }
nightlyItems: { id, repositoryId, projectId, phase ("summary"|"daily_report"|"release"|"page_update"|"page_create"), key (text), status ("pending"|"done"|"failed"|"escalated"), failedNights (int), lastError (text|null), payload (jsonb), night (date), createdAt, updatedAt }  // unique (repositoryId, phase, key)

// apps/worker/src/git/mirrors.ts (Task B2)
listRecentCommits(project: MirrorProject, since: Date): Promise<RangeCommit[]>;                  // tutti i branch, niente merge
listDefaultBranchCommitsSince(project: MirrorProject, fromSha: string | null, since: Date): Promise<{ commits: string[]; headSha: string; fallback: boolean }>;

// apps/worker/src/nightly/queue.ts (Task B2)
export type NightlyPhase = "summary" | "daily_report" | "release" | "page_update" | "page_create";
export async function enqueueItems(db: Db, items: { repositoryId: string; projectId: string; phase: NightlyPhase; key: string; payload?: Record<string, unknown> }[], night: string): Promise<number>;
export async function claimNext(db: Db, repositoryId: string, phase: NightlyPhase): Promise<NightlyItem | null>;
export async function completeItem(db: Db, id: string): Promise<void>;
export async function failItem(db: Db, id: string, error: string, night: string): Promise<"retry" | "escalated">;  // 3 notti consecutive → escalated
export async function releaseItem(db: Db, id: string): Promise<void>;   // limite di quota: torna pending senza contare un fallimento
export async function pendingCount(db: Db, repositoryId: string, phase?: NightlyPhase): Promise<number>;

// apps/worker/src/nightly/commit-summary.ts (Task B3)
export function buildCommitSummaryPrompt(input: { subject: string; files: { path: string; additions: number; deletions: number }[]; diff: string; diffTruncated: boolean }): string;
export function parseCommitSummary(output: string): { summary: string; areas: string[] } | null;
export function noiseSummary(commit: RangeCommit, files: string[]): { summary: string; areas: string[] };
export async function summarizeCommit(deps: NightlyDeps, repo: NightlyRepo, sha: string): Promise<"done" | "unavailable" | "failed">;

// apps/worker/src/nightly/release.ts (Task B5)
export async function runReleasePhase(deps: NightlyDeps, repo: NightlyRepo, plan: DocsPlan): Promise<{ status: "done" | "unavailable" | "failed"; notes: ReleaseNotes | null }>;

// apps/worker/src/nightly/docs.ts (Task B6)
export interface DocsPlan { generationId: string; fromSha: string | null; toSha: string; commits: string[]; candidates: PageRef[]; newAreas: string[] }
export async function planDocs(deps: NightlyDeps, repo: NightlyRepo): Promise<DocsPlan | null>;   // null = nessuna generazione corrente
export async function runDocsPhase(deps: NightlyDeps, repo: NightlyRepo, plan: DocsPlan, notes: ReleaseNotes | null): Promise<"done" | "unavailable" | "partial">;

// apps/worker/src/nightly/orchestrator.ts (Task B7)
export interface NightlyDeps { db; mirrors: MirrorManager; runner: AgentRunner; serializer: ProjectSerializer; select: SelectDeps; embeddingClient; config: NightlyConfig; log }
export async function runNight(deps: NightlyDeps, now: Date): Promise<NightResult>;
export function startNightlyScheduler(deps: NightlyDeps & { signal: AbortSignal }): () => void;
```

---

### Task B1: Migrazioni 0089/0090 e tabelle

**Files:** `packages/db/drizzle/0089_nightly.sql`, `0090_nightly_notification.sql`, `_journal.json`, `schema.ts`, `testing.ts` (helper `seedCommitSummary`); test `packages/db/src/migration-0089.test.ts`.

- `commit_summaries`: PK `(repository_id, sha)`, FK `repository_id` → `repositories` CASCADE; `files text[] NOT NULL DEFAULT '{}'`, `areas text[] NOT NULL DEFAULT '{}'`, `noise boolean NOT NULL DEFAULT false`, `on_default_branch boolean NOT NULL DEFAULT false`; indice `(repository_id, committed_at)` e indice parziale `(repository_id) WHERE on_default_branch`.
- `nightly_items`: CHECK su `phase` e `status`, `failed_nights int NOT NULL DEFAULT 0`, unique `(repository_id, phase, key)`, indice parziale `(repository_id, phase, created_at) WHERE status = 'pending'`; FK `repository_id` e `project_id` CASCADE.
- 0090: SOLO `ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'docs.nightly_attention';`. Aggiornare il test di parità degli enum (`packages/db/src/enum-parity.test.ts`) se confronta `notificationKindSchema` col tipo Postgres: il valore va aggiunto anche in `packages/shared/src/schemas/notification.ts` (Task B8 ne scrive l'evento).

Test: vincoli (CHECK, unique, cascade), default dei campi, il valore d'enum presente. Commit `feat(db): 0089-0090, riassunti dei commit e coda del giro notturno`.

---

### Task B2: Scoperta dei commit e coda

**Files:** `apps/worker/src/git/mirrors.ts` (+ test con upstream finti come `withProjectWorktrees`), `apps/worker/src/nightly/queue.ts` (+ test Postgres).

`listRecentCommits(project, since)`: come `getCommitsInRange` ma senza `--until`, con `--no-merges` e `--branches`. `listDefaultBranchCommitsSince(project, fromSha, since)`:

```ts
// Commit raggiungibili dal branch di default e non da fromSha. Se fromSha non
// esiste più nel mirror (force-push, mirror ricreato) si ripiega sui commit del
// default branch entro la finestra, con fallback=true: il chiamante lo logga.
const head = (await this.git(["rev-parse", `refs/heads/${project.defaultBranch}`], { cwd })).trim();
if (fromSha !== null && (await this.commitExists(cwd, fromSha))) {
  const out = await this.git(["rev-list", "--no-merges", `${fromSha}..${head}`], { cwd });
  return { commits: lines(out), headSha: head, fallback: false };
}
const out = await this.git(["rev-list", "--no-merges", `--since=${since.toISOString()}`, head], { cwd });
return { commits: lines(out), headSha: head, fallback: fromSha !== null };
```

Coda: `claimNext` reclama con `UPDATE … SET updated_at = now() WHERE id = (SELECT id … WHERE status='pending' AND repository_id=$1 AND phase=$2 ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *` (lo stato resta `pending` finché non è chiuso: un riavvio non perde niente). `failItem` incrementa `failed_nights` solo se `night` differisce dall'ultima notte registrata (in `payload.lastFailedNight`); a 3 → `escalated` e ritorna `"escalated"`. `enqueueItems` è `ON CONFLICT DO NOTHING` (idempotenza: rieseguire la pianificazione non duplica).

Test (Review Focus #1, #2): branch vecchio mergiato compare in `listDefaultBranchCommitsSince`; `fromSha` inesistente → `fallback: true`; merge esclusi; coda: claim concorrente non restituisce lo stesso elemento, `failItem` 3 notti diverse → escalated, 2 volte la stessa notte → resta 1. Commit `feat(worker): scoperta dei commit e coda del giro notturno`.

---

### Task B3: Fase 1 — riassunti dei commit

**Files:** `apps/worker/src/nightly/commit-summary.ts` (+ test), prompt in italiano/inglese coerente coi prompt del worker (inglese, come i prompt Docs).

- Gate del rumore: `isNoise` di `auto-update.ts` va spostato in `apps/worker/src/nightly/noise.ts` (e `auto-update.ts` lo importa finché esiste). Un commit i cui file sono tutti rumore → `noiseSummary` (deterministico: «Aggiornamento di dipendenze/file generati: <file>»), `noise = true`, nessun run.
- Diff: `getCommitDiff` esistente, tagliato a `COMMIT_DIFF_MAX_CHARS` con marcatore; nel prompt sempre il numstat completo.
- Contratto d'uscita a marcatori: `===SUMMARY===` … `===END SUMMARY===` (2–5 frasi, cosa cambia per chi usa e per chi sviluppa) e `===AREAS===` … `===END AREAS===` (un percorso o modulo per riga, max 10). Parser tollerante agli spazi; output senza marcatori → `null` → elemento `failed`.
- Run: `runWithProviders(deps.select, { projectId, workClass: "background" }, (p) => runAgentText({ model: COMMIT_SUMMARY_MODEL, maxTurns: 3, provider: p, … }), limitTextOfRun)`; `unavailable` → `releaseItem` e ritorna `"unavailable"`.
- Salvataggio: `insert … on conflict do nothing` su `commit_summaries` (un riassunto non si riscrive mai).

Test: prompt contiene subject, numstat completo e marcatore di taglio quando serve; parser (ok, senza marcatori, aree oltre 10 troncate); commit di solo rumore → nessun run e `noise=true`; limite → `unavailable`, elemento ancora `pending`; output non valido → `failed`. Commit `feat(worker): riassunto di ogni commit, una volta sola`.

---

### Task B4: Fase 2 — daily report dai riassunti

**Files:** `apps/worker/src/reports/daily-report-poller.ts` (+ test).

- La descrizione di ogni commit (`activity_commits.ai_description`) è il `summary` di `commit_summaries`; se manca, `summarizeCommit` lo crea (stessa funzione della fase 1: un solo modo di riassumere). Spariscono i run «descrizione del commit».
- Riassunto di progetto e per sviluppatore: invariati nella forma, su `DAILY_REPORT_MODEL` (default `haiku`, PR #103) e con `runWithProviders` `background`.
- La creazione automatica della riga del giorno precedente passa all'orchestratore (Task B7: inserisce `activity_reports` `queued` per ieri per i progetti col report acceso, poi chiama `pollDailyReportsOnce`). Il poller continua a consumare le righe `queued` create dalla rigenerazione manuale.
- Un report in cui un riassunto è mancato per `unavailable` NON va a `done`: resta `queued` e si riprova (fine dei report vuoti per sempre del 12-13 ott).

Test: report con 3 commit già riassunti → nessun run di descrizione, descrizioni = riassunti; commit senza riassunto → creato; quota non disponibile → report non `done`; rigenerazione manuale (`queued`) ancora processata. Commit `feat(worker): il daily report si scrive dai riassunti dei commit`.

---

### Task B5: Fase 3 — nota di rilascio

**Files:** `apps/worker/src/nightly/release.ts` (+ test), `packages/docs-engine/src/releases.ts` (campo additivo), spostamento di `uniqueReleaseSlug`, `buildRelatedLinks`, `timestampForSlug` da `auto-update.ts` a `apps/worker/src/nightly/release-page.ts` (immutati).

- `ReleaseInput` guadagna `commitSummaries?: { sha: string; subject: string; summary: string }[]` (additivo: assente → prompt invariato, i test di `releases.test.ts` restano verdi). Con i riassunti, `changedFiles` e `commitSubjects` restano come contesto.
- Insieme: i `DocsPlan.commits` (dal Task B6, `planDocs` lo calcola prima); marca `on_default_branch = true` sui loro riassunti.
- Inserimento della pagina `releases` come oggi (slug unico, link «related» alle pagine aggiornate/create dalla fase 4: la nota si scrive PRIMA dei Docs per orientarli, poi i link si completano a fine fase 4 con un UPDATE).
- Fallimento della nota: elemento `failed` (regola delle 3 notti); la fase Docs procede comunque con le sole pagine della mappa file.

Test: nota con 2 commit (subject + riassunto nel prompt); nessun commit in produzione → nessun run; output non valido → failed e Docs procede; link completati dopo la fase 4. Commit `feat(worker): una nota di rilascio per notte dai riassunti`.

---

### Task B6: Fase 4 — Docs

**Files:** `apps/worker/src/nightly/docs.ts` (+ test), `packages/docs-engine/src/refresh-page.ts` (campo additivo `commitSummaries`), spostamento da `auto-update.ts` a `apps/worker/src/nightly/page-updates.ts` di `refreshAffectedPagesInWorktree`, `guardRefreshedProductBody`, `growNewAreaPages`, `applyGrowStats`, `loadPagesWithRefs`, `loadConfidentialFacts` (firma: al posto di `commitSubjects` ricevono `commitContext: { subject: string; summary: string }[]`).

- `planDocs`: generazione corrente del repository (nessuna → `null`, il repository salta la fase 4); `fromSha` = `commit_sha` della generazione; `listDefaultBranchCommitsSince`; file cambiati = unione dei `files` dei riassunti dei commit (riassunti mancanti creati prima: fase 1); `mapAffectedPages(material, pages, Number.MAX_SAFE_INTEGER)`; candidate = affected ∪ pagine degli `affectedSlugs` della nota (passati da B5).
- Allarme: se `candidates.length + newAreaGroups.length > NIGHTLY_ALERT_RUNS` → evento `docs.nightly_attention` `{ reason: "plan_oversized", … }` (Task B8), e si procede.
- Un elemento `page_update` per candidata (`key` = page id), uno `page_create` per area nuova (`key` = area normalizzata). `payload` = `{ toSha, fromSha }`: se la notte dopo `toSha` è cambiato, gli elementi pendenti vengono rigenerati sul piano nuovo (si chiudono quelli vecchi come `done` senza run se la pagina è già stata aggiornata a un `toSha` successivo).
- Run di aggiornamento: worktree al `toSha` (`withWorktreeAtSha` esistente, uno per repository per notte, riusato da tutte le pagine), `runWithProviders` `background`, modello `DOCS_NIGHTLY_MODEL`. **`permissionMode: "default"` con allowlist CHIUSA**, non la plan mode: il golden `refine-read-plan` ha misurato che in plan mode la restrizione di lettura NON regge. Allowlist = `Read`/`Grep`/`Glob` ristretti ai file cambiati della pagina (un pattern `Read(//<worktree>/<file>)` per file, sul modello di `scopedReadTools` in `agent/read-scope.ts`; aggiungere lì un helper `scopedFileReadTools(dir, files)`), più `disallowedTools` = `sensitiveReadDenyRules()`. Nessun tool di scrittura: l'output è il corpo a marcatori. Prompt `buildRefreshPagePrompt` con `commitSummaries`. Esito `unchanged` → `done` senza scritture; `updated` → guardia `product`, salvataggio, re-embed (`embedAndStoreChunks`).
- Aree nuove: `growNewAreaPages` per ogni elemento `page_create`, senza tetto.
- Fine fase: SOLO se non restano elementi `pending` della fase per quel `toSha` → `UPDATE doc_generations SET commit_sha = toSha` (segnalibro). Con elementi pendenti per limite → `unavailable` e il segnalibro resta (Review Focus #3).

Test: candidate = mappa ∪ nota; «nessun cambiamento» → nessuna scrittura, elemento done; aggiornata → corpo e chunk nuovi; il run riceve un'allowlist senza `Read` nudo; segnalibro avanza a fine fase anche con la nota fallita; limite a metà → segnalibro fermo, restanti pending; area nuova → pagina creata; allarme sopra soglia (si procede). Commit `feat(worker): Docs aggiornati di notte dai riassunti, senza tetti`.

---

### Task B7: Orchestratore, orario, ripresa

**Files:** `apps/worker/src/nightly/orchestrator.ts` (+ test con runner finto e Postgres), `apps/worker/src/index.ts` (cablaggio), `apps/worker/src/config.ts` (+ compose, `.env.example`, test).

```ts
/**
 * Una notte (design 2026-10-15 §3). Per i repository dei progetti con almeno
 * uno dei due interruttori accesi, a turno (un elemento per repository per
 * giro, così un progetto attivo non si prende tutto il margine):
 *  1. pianifica le fasi (enqueue idempotente): riassunti dei commit nuovi;
 *     righe `queued` del daily report di ieri; piano Docs (nota + pagine);
 *  2. consuma la coda in ordine di fase per repository: summary → daily_report
 *     → release → page_update/page_create;
 *  3. su `unavailable` (quota) si ferma TUTTO il giro (gli abbonamenti sono
 *     condivisi) e lo scheduler riprova ogni 15 minuti finché c'è lavoro della
 *     notte e la quota lo permette; alla notte dopo si ripianifica comunque.
 * Ogni repository in try/catch isolato: un repository rotto non ferma gli altri.
 * Serializer per-progetto solo per aprire i worktree (come il refinement).
 */
export async function runNight(deps: NightlyDeps, now: Date): Promise<NightResult> { /* … */ }
```

- Scheduler: un timer che a `NIGHTLY_START` (fuso `Europe/Rome`, calcolato con `Intl.DateTimeFormat`) avvia `runNight`; se una notte termina con lavoro pendente per quota, riprova ogni 15 minuti fino al prossimo `NIGHTLY_START`. Mai due `runNight` insieme (flag in memoria: il worker è UN processo).
- Escalation: `failItem` → `escalated` pubblica `docs.nightly_attention` `{ reason: "item_failing", phase, key }`.
- Riavvio del worker: nessun recupero speciale; la coda è in tabella e lo scheduler riparte all'orario o al primo tick di ripresa.
- Rimuovere dal cablaggio di `index.ts` lo scheduling automatico del giorno precedente del daily report (resta il poller per le righe `queued`) e il poller `doc_auto_update` (Task B10 rimuove il codice).

Test: due repository, uno con molti commit → alternanza; quota non disponibile al secondo elemento → giro fermo, ripresa riparte dal terzo; riavvio simulato (nuovo orchestratore) → nessun elemento rifatto; repository con credenziali rotte saltato, gli altri completati; un solo `runNight` alla volta. Config: `NIGHTLY_START` accetta `H:MM` e `HH:MM` (00:00–23:59, default `01:00`), rifiuta «25:00» e «1pm»; `NIGHTLY_ALERT_RUNS` intero ≥ 1 (default 50); `COMMIT_SUMMARY_WINDOW_DAYS` intero ≥ 1 (default 30); `COMMIT_DIFF_MAX_CHARS` intero ≥ 1000 (default 20000); i tre modelli stringhe non vuote coi loro default. Commit `feat(worker): il giro notturno, a turno fra i repository e con ripresa`.

---

### Task B8: Notifica `docs.nightly_attention`

**Files:** `packages/shared/src/schemas/notification.ts` (valore e forma dell'evento: `{ reason: "plan_oversized" | "item_failing"; repositoryId; repositoryName; projectName; counts?: { commits; candidates; newAreas }; phase?; key? }`), `packages/notifications` (pubblicazione per i maintainer, template i18n), `packages/i18n/src/catalog.ts`, web (card d'inbox) e app (la card generica legge titolo e testo; nessuna azione decisionale).

Test: evento pubblicato solo agli admin; testo da template con i numeri; un client vecchio (app) riceve `UNKNOWN` e non crasha (test di `readerSchema`); il web mostra la card. Commit `feat: avviso in inbox quando il giro notturno esce di scala o un elemento fallisce 3 notti`.

---

### Task B9: Pagine dei Docs oneste e impostazioni

**Files:** `packages/shared/src/schemas/docs.ts` (`docPageSchema.staleSince: z.array(z.object({ sha, subject, summary, committedAt })).nullable().default(null)`), `apps/server/src/routes/docs.ts` (calcolo a lettura), web `apps/web/src/routes/docs/*` (avviso), `apps/web/src/components/project-form.tsx` e i18n (etichetta «Docs aggiornati ogni notte»).

Calcolo a lettura (una query per pagina letta; il dettaglio pagina è una lettura singola):

```sql
select cs.sha, cs.subject, cs.summary, cs.committed_at
from commit_summaries cs
where cs.repository_id = $repo and cs.on_default_branch
  and cs.committed_at > (select created_at from … /* istante del segnalibro: committed_at del riassunto di generation.commit_sha, o generation.finished_at */)
  and exists (select 1 from unnest(cs.files) f where f = $sourcePath or f like $sourcePath || '/%')
order by cs.committed_at desc limit 20
```

(Pagine senza `sourcePath`: `staleSince = null`. L'istante del segnalibro: `committed_at` del riassunto del commit `generation.commit_sha` se esiste, altrimenti `generation.finished_at`.) Il web mostra «Il codice è cambiato dopo questa pagina» con i commit (subject e riassunto) solo se `(page.staleSince ?? []).length > 0`; la fixture del test resta SENZA il campo.

Test: pagina toccata da un commit in produzione dopo il segnalibro → avviso; dopo l'avanzamento del segnalibro → nessun avviso (Review Focus #5); commit non sul branch di default → nessun avviso; pagina senza `sourcePath` → null. Commit `feat: le pagine dei Docs dicono quando il codice è cambiato dopo di loro`.

---

### Task B10: Rimozioni, golden, documentazione

- Rimuovere: il ramo push che accoda `doc_auto_update_jobs` in `webhooks.ts` (restano recount e grafo, con i loro test); `apps/worker/src/docs/auto-update.ts`, `auto-update-poller.ts` e i test; `DOCS_AUTOUPDATE_*` da `config.ts`, compose, `.env.example`. La tabella `doc_auto_update_jobs` resta (una migrazione che la droppa è un passo a parte, dopo che il nuovo giro è in produzione).
- Golden `nightly` (`apps/worker/scripts/golden/`, opt-in): repo fixture con 5 commit (uno solo rumore, uno con un'area nuova), una generazione Docs minima finta; checks: 4 riassunti con modello + 1 deterministico, solo le pagine toccate aggiornate, la pagina dell'area nuova creata, una nota, segnalibro avanzato, costo stampato. 1 lancio.
- `docs/operations/deploy-log.md`: voce «Giro notturno» (ordine: server 0089 → verifica → 0090 → worker; gli interruttori restano spenti; rollout su un progetto piccolo con giro lanciato a mano — script `pnpm --filter @stubwise/worker nightly:once -- --repository <id>` da aggiungere in questo task —, poi gli altri; rollback: il valore d'enum nuovo rende non sicuro scendere col server finché ne esistono righe → `delete from notifications where kind = 'docs.nightly_attention';` prima).
- `CLAUDE.md`: indice della voce, sezione «Architettura runtime» con il giro notturno al posto dell'aggiornamento a ogni push; invariante `docs/invariants/nightly.md` (il segnalibro non dipende dalla nota; nessun tetto, freno = quota; un commit si riassume una volta; il webhook non accoda Docs).
- Verifica finale: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`.
