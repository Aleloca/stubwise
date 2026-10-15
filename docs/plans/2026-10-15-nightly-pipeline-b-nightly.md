# Giro notturno — Piano B: riassunti dei commit, daily report, note di rilascio, Docs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** un solo processo notturno legge ogni commit una volta (Haiku 5.5), scrive i daily report dai riassunti, una nota di rilascio per repository dai commit entrati nel branch di default (Sonnet 5.5) e aggiorna o crea le pagine dei Docs toccate (Sonnet 5.5), senza tetti sul lavoro ma sotto la soglia di quota degli abbonamenti; sostituisce l'aggiornamento Docs a ogni push.

**Architecture:** una coda persistente di elementi di lavoro (`nightly_items`, con una lease) per repository e fase, consumata da un orchestratore che parte a `NIGHTLY_START` e alterna i repository. I riassunti dei commit stanno in `commit_summaries` e alimentano tutte le fasi. Il punto di partenza dei Docs è il `commit_sha` della generazione corrente (come oggi): avanza a fine fase Docs, indipendentemente dalla nota, nella stessa transazione che marca `documented_at` sui riassunti documentati (da cui si deriva l'avviso «superata»). Ogni run passa da `runWithProviders` del Piano A con `workClass: "background"`. Ogni accesso al mirror (fetch, apertura dei worktree) sta dentro il serializer per-progetto; i run stanno fuori.

**Tech Stack:** Node 22, TypeScript, drizzle + postgres.js, Fastify + Zod 4, React, Vitest + testcontainers, `@stubwise/docs-engine`.

**Spec:** `docs/plans/2026-10-15-nightly-pipeline-design.md`. Prerequisiti: Piano A (`docs/plans/2026-10-15-nightly-pipeline-a-quota.md`) completo, PR #103 (`DAILY_REPORT_MODEL`) mergiata (il Piano A la mergia allo Step 0 del Task A5).

## Global Constraints

- Migrazione **0089** (tabelle e colonne) e **0090** (`ALTER TYPE notification_kind ADD VALUE 'docs.nightly_attention'`, DA SOLA: il valore non può essere usato nella transazione del batch in cui nasce). `when` 0089 = `1792108800000`, 0090 = `1792195200000`. Le due girano nello stesso batch all'avvio del server: il valore non si usa in nessuna migrazione.
- Modelli configurabili, alias del CLI: `COMMIT_SUMMARY_MODEL` (default `haiku`), `RELEASE_NOTES_MODEL` (default `sonnet`), `DOCS_NIGHTLY_MODEL` (default `sonnet`). Il daily report resta su `DAILY_REPORT_MODEL` (PR #103), la generazione Docs completa su `DOC_GENERATION_MODEL`.
- Nessun tetto sul numero di pagine aggiornate o create. Freno: la soglia di quota del Piano A. Allarme a `NIGHTLY_ALERT_RUNS` (default 50) run Sonnet pianificati **per un repository** in una notte (nota + pagine da aggiornare + pagine da creare; orient e audit non contano).
- Altre env: `NIGHTLY_START` (default **`02:00`**, formato `HH:MM`, fuso `Europe/Rome`: alle 02:00 di Roma il giorno UTC precedente è chiuso tutto l'anno — 00:00 UTC d'estate, 01:00 UTC d'inverno), `COMMIT_SUMMARY_WINDOW_DAYS` (default 30), `COMMIT_DIFF_MAX_CHARS` (default 20000).
- La **notte** (`nightly_items.night`, `last_failed_night`) è la data di calendario `Europe/Rome` di `now` all'avvio del giro (`Intl.DateTimeFormat`, come `NIGHTLY_START`).
- Tutte le fasi sono idempotenti e riprendono dalla coda; nessuno stato del giro tiene solo in memoria, salvo i worktree e il flag «un giro alla volta».
- **Chiavi della coda** (unique `(repository_id, phase, key)`): `summary` = sha; `daily_report` = data UTC del report; `release` = `<fromSha>..<toSha>`; `page_update` = `<pageId>@<toSha>`; `page_create` = `<areaKey>@<toSha>`. `summary` e `daily_report` sono una-tantum per costruzione; gli altri si rinnovano a ogni bersaglio nuovo.
- Il segnalibro dei Docs (`doc_generations.commit_sha` della generazione corrente) **non dipende dalla nota di rilascio**. Avanza quando non resta nessun `page_update`/`page_create` `pending` del repository; un elemento che fallisce resta `pending` e il segnalibro aspetta al massimo 3 notti, poi l'elemento va `escalated` (card in inbox) e il segnalibro avanza.
- La nota di rilascio ha il SUO punto di partenza: il `toSha` dell'ultimo elemento `release` del repository (qualunque stato), altrimenti il segnalibro dei Docs. Così una nota già scritta non si riscrive quando il segnalibro dei Docs aspetta.
- Il giorno di un commit nel daily report è il **giorno UTC** della committer date (la spec è allineata: §3.1).
- **Serializer**: fetch del mirror (`ensureMirror`), elenchi dei commit e apertura/chiusura dei worktree stanno dentro `serializer.run(projectId, …)`; diff con `skipFetch: true`; i run `claude` stanno FUORI dal serializer (worktree detached, nessun ref `stubwise/*` da potare).
- **Stop per quota**: `unavailable` con motivo di quota (`isQuotaWait` del Piano A: `all_limited`, `all_over_threshold`, `all_limited_now`) ferma TUTTO il giro (gli abbonamenti sono condivisi); `exclusive_unavailable`/`no_usable_provider` saltano solo quel progetto per la notte, con una riga di log. In entrambi i casi l'elemento torna `pending` senza contare un fallimento.
- Un repository con una generazione Docs completa `running`/`paused` salta le fasi Docs (nota e pagine) per la notte; riassunti e daily report proseguono.
- I campi nuovi letti da web/app nascono `.nullable().default(null)` e il web li difende al punto di lettura.
- Il webhook push NON accoda più lavoro Docs. Il recount dei report e la build del grafo restano.

## Review Focus

1. **Branch vecchio mergiato**: commit con data di 20 giorni fa entrano oggi nel branch di default. Attesi: riassunti (se non c'erano, anche fuori dalla finestra di 30 giorni: li accoda `planDocs`), assegnati al loro giorno UTC, nessun daily report passato rigenerato, inclusi nella nota di rilascio e nei Docs di stanotte, avviso «superata» acceso sulle loro pagine fino all'avanzamento del segnalibro (non dipende dalla data del commit). Test in Task B2/B6/B10.
2. **Force-push del branch di default** (il commit del segnalibro non esiste più): atteso un ripiego esplicito (commit del branch di default entro la finestra) con una riga di log, mai un errore che blocca il repository per sempre. Test in Task B2.
3. **Limite di quota a metà della fase Docs**: attesi gli elementi fatti marcati `done`, i restanti `pending`, il segnalibro NON avanzato, ripresa la notte dopo (o prima, se il margine torna) dal punto giusto, nessun riassunto rifatto. Test in Task B7/B9.
4. **Commit di solo rumore o gigante**: atteso un riassunto deterministico senza modello per il rumore (lockfile, documentazione e piani, codice generato o vendorizzato); diff tagliato a `COMMIT_DIFF_MAX_CHARS` col numstat completo per il gigante. Test in Task B3.
5. **Pagina toccata ma «nessun cambiamento»**: attesa la pagina invariata, l'elemento `done`, l'avviso «superata» sparito dopo l'avanzamento del segnalibro. Test in Task B7/B10.
6. **Una pagina che fallisce tre notti di fila**: attesi segnalibro fermo per due notti, alla terza `escalated` con card in inbox e segnalibro avanzato; la notte dopo nessun nuovo tentativo su quell'elemento. Test in Task B2/B7/B9.

## Decisioni del preflight (15 ott 2026)

Il preflight (`.superpowers/sdd/2026-10-15-nightly-pipeline-b-nightly/preflight.md`, D1–D30) ha verificato il piano contro il codice. Decisioni, già riportate nei task:

| # | Decisione | Dove |
|---|---|---|
| D1 | Chiavi `<pageId>@<toSha>`, `<area>@<toSha>`, release `<fromSha>..<toSha>`; `summary` (sha) e `daily_report` (data) restano una-tantum. Un `page_update`/`page_create` ancora `pending` per la stessa pagina o area si **riallinea** al bersaglio nuovo (stessa riga: conserva `failed_nights`) | Global Constraints, B2, B6–B8 |
| D2 | Niente `runAgentText` dentro `runWithProviders`: `runAgentTextRaw` (Piano A) per riassunti e nota, `runner.run` per le pagine (servono `allowedTools`); testo del limite con `limitTextOfRun`, testo con `textFromRun`, costo da `usage.totalCostUsd` | B3, B4, B6–B8 |
| D3 | `planDocs` (commit in produzione, `fromSha`/`toSha`, mappa dei file) va in testa al task della nota; dopo la nota `planPages(plan, notes)` calcola le candidate (mappa ∪ `affectedSlugs`), accoda gli elementi e valuta l'allarme | B6 |
| D4 | `commit_summaries.documented_at` (in 0089), scritta nella stessa transazione che avanza il segnalibro; avviso = `on_default_branch AND documented_at IS NULL AND files ∩ pagina` | B1, B7, B10 |
| D5 | La nota fallita si riprova sul SUO intervallo (payload `{ fromSha, toSha, commits }`), con il suo punto di partenza separato dal segnalibro dei Docs | Global Constraints, B6 |
| D6 | Fetch ed elenchi dentro il serializer, diff con `skipFetch`, worktree a handle (`openWorktreeAtSha`) aperto e chiuso dentro, run fuori | Global Constraints, B2, B7, B9 |
| D7 | L'orchestratore inserisce solo le righe `activity_reports` `queued`; le consuma il poller del daily report, che perde il gate notturno (dentro `pollDailyReportsOnce`, non in `index.ts`) | B4, B9 |
| D8 | Stop globale solo per i motivi di quota; `exclusive_unavailable`/`no_usable_provider` saltano il progetto | Global Constraints, B9 |
| D9 | Lease sul claim: `claimed_at`, un elemento reclamato da meno di `NIGHTLY_ITEM_LEASE_MS` (60 minuti, costante) non si reclama di nuovo | B1, B2 |
| D10 | Un elemento fallito non escalato resta `pending`; il segnalibro aspetta al massimo 3 notti, poi escalation e il segnalibro avanza | Global Constraints, B2, B7 |
| D11 (maintainer) | `NIGHTLY_START` default `02:00` `Europe/Rome` | Global Constraints, B9, spec §3 |
| D12 | `page_create` = un'area aggregata (`aggregateNewAreas`), un mini-orient per area, stessa allowlist chiusa sui file dell'area, nessun tetto | B8 |
| D13 | File leggibili da una pagina: i file cambiati coperti dal suo `sourcePath`; per un genitore-overview l'unione dei figli toccati; per una pagina che entra solo dalla nota tutti i file cambiati del piano. Il prompt di refresh non dice più «leggi tutto il codice sotto il percorso» | B7 |
| D14 | `docs.nightly_attention` usa l'interruttore esistente `notifyDocsLimitPaused` (nessuna colonna nuova) | B5 |
| D15 | PR #103 mergiata prima del Piano A, Task A5: B4 usa `DAILY_REPORT_MODEL` | B4 |
| D16 (maintainer) | `docs/` e `plans/` restano rumore come oggi (riassunto deterministico). La regola si allarga a codice generato o vendorizzato con una lista conservativa dichiarata (sotto) | B3, spec §3.1 |
| D17 | Golden `nightly` con testcontainers dentro lo script: preparato, NON lanciato in questo piano | B11 |
| D18–D30 | Meccaniche: `commitExists`; numstat per file; parità enum sul letterale di `schema.ts`; evento in `format.ts` e tutti i Record esaustivi; `auto-update.ts` compila fino alla rimozione; tipi in `nightly/types.ts`; riassunti dei commit fuori finestra; `toPage` e `LIKE` con escape (qui `starts_with`); deploy-log in un solo passo per il server; tetto di 200 righe nei prompt dichiarato; fuso della `night`; repository con generazione completa in corso saltati; allarme per repository | Global Constraints e task |

**Regola del rumore (D16), conservativa e dichiarata.** Un file è rumore se:
1. il basename è un lockfile (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`: come oggi);
2. il percorso inizia con una cartella di processo (`plans/`, `docs/`, `manual/`, `guides/`, `.github/`: come oggi);
3. il percorso contiene un segmento di cartella `vendor/`, `node_modules/` o `dist/` a qualunque profondità (codice vendorizzato o generato);
4. il basename finisce con `.min.js`, `.min.css`, `.map` o `.snap`.

NON entrano: `build/` (in troppi repository è codice sorgente, script di build) e un controllo d'intestazione «generated» (chiederebbe di leggere il contenuto: il gate resta una funzione pura del percorso, testabile e uguale per i Docs). Allargare la lista è una modifica esplicita con un test.

## Cose trovate nel codice

Una smentisce la spec ed è stata riportata lì: il giorno del daily report è UTC, non «il fuso del progetto».

- Il daily report usa i **giorni UTC** (`previousUtcDay`, `activity_reports.date`); i progetti non hanno un fuso. La spec diceva «nel fuso del progetto»: si resta su UTC, coerente coi report esistenti, e la spec (§3.1) è corretta di conseguenza.
- La rigenerazione manuale (`POST /api/activity/generate`) inserisce righe `activity_reports` `queued` che il poller del daily report consuma (fase «queued» di `pollDailyReportsOnce`, per qualunque data entro la retention). La creazione automatica del giorno precedente sta DENTRO `pollDailyReportsOnce` (il ciclo sui progetti con `daily_report_enabled`), non nel cablaggio di `index.ts`. Il poller fa anche recovery degli orfani `running` (supponendo di essere l'unico consumatore), recount, rollup per sviluppatore, retention.
- Il punto di partenza dei Docs è già `doc_generations.commit_sha` della generazione corrente (`repositories.current_doc_generation_id`): non serve una colonna nuova, serve che avanzi alla fine della fase Docs invece che dopo la nota.
- `docPageSchema` ha già `commitSha` (della GENERAZIONE) e `updatedAt`: «aggiornata al commit X, il giorno Y» è già disponibile. Serve solo l'avviso «superata».
- La punta del branch di default è spesso un merge, mai riassunto (`--no-merges`): l'avviso non può confrontare date col commit del segnalibro. Da qui `documented_at` (D4).
- `RangeCommit` (`git/mirrors.ts`) ha solo `additions`/`deletions` sommati, nessun elenco di file; `MirrorManager` non ha `commitExists`; `getCommitDiff` taglia già a 150000 caratteri e accetta `skipFetch`.
- Le funzioni di `auto-update.ts` (`refreshAffectedPagesInWorktree`, `growNewAreaPages`, …) prendono `AutoUpdateRunDeps`, girano in plan mode su UN provider e ciclano su tutte le pagine: per elementi singoli con `runWithProviders` e allowlist chiusa vanno **riscritte** nei moduli `nightly/`, non spostate. `auto-update.ts` resta intatto fino al Task B11.
- `growNewAreaPages` aggrega i file in aree (`aggregateNewAreas`, `packages/docs-engine/src/grow.ts`), fa UN mini-orient su tutte e taglia a `maxNewPages`.
- `buildRefreshPagePrompt` dice di leggere il codice corrente sotto il `sourcePath`: con l'allowlist sui soli file cambiati quel testo va cambiato.
- `ReleaseNotes` restituisce `affectedSlugs`, non le aree nuove: le aree nuove vengono dalla mappa deterministica (`mapAffectedPages(...).newAreas`). `releases.ts` e `refresh-page.ts` tagliano i contesti a 200 righe (`MAX_FILES`/`MAX_COMMITS`).
- Le notifiche: i Record su `NotificationKind` sono esaustivi (`dispatch.ts` `TOGGLE_FOR_KIND`, `routing.ts`, `format.ts`, `actions.ts`, `push/payload.ts`, web `inbox-item.tsx`, `notifications-section.tsx`); gli eventi stanno in `packages/notifications/src/format.ts`; il test di parità degli enum (`packages/db/src/enum-parity.test.ts`) confronta i `pgEnum` di `schema.ts` con Postgres.
- L'harness golden (`scripts/golden/run.ts`) richiede `--plugin` e non ha DB.
- L'avviso «superata» si può derivare solo dai commit già riassunti: un commit mergiato oggi e non ancora visto dal giro non lo accende. È coerente con «entro un giorno».

---

## File structure

| File | Responsabilità |
|---|---|
| `packages/db/drizzle/0089_nightly.sql`, `0090_nightly_notification.sql`, `schema.ts`, `testing.ts` | `commit_summaries` (con `documented_at`), `nightly_items` (con `claimed_at`, `last_failed_night`); valore `docs.nightly_attention` |
| `packages/shared/src/schemas/notification.ts` | valore `docs.nightly_attention` (B1) |
| `apps/worker/src/git/mirrors.ts` | `listRecentCommits`, `listDefaultBranchCommitsSince`, `getCommitWithFiles`, `openWorktreeAtSha`, `commitExists`; numstat per file |
| `apps/worker/src/nightly/types.ts` | `NightlyRepo`, `NightlyConfig`, `NightlyDeps`, `CommitSummaryDeps`, `NightResult` |
| `apps/worker/src/nightly/queue.ts` | elementi di lavoro: accoda, riallinea, reclama con lease, chiude, rilascia, fallisce, escalation a 3 notti |
| `apps/worker/src/nightly/noise.ts` | regola del rumore (allargata), usata anche da `auto-update.ts` finché esiste |
| `apps/worker/src/nightly/commit-summary.ts` | prompt, parser, riassunto deterministico, `summarizeCommit` |
| `apps/worker/src/reports/daily-report-poller.ts` | descrizioni dai riassunti; niente più gate notturno |
| `packages/notifications`, `packages/i18n`, web, app | evento `docs.nightly_attention` |
| `apps/worker/src/nightly/plan.ts` | `planDocs`, `planPages` |
| `apps/worker/src/nightly/release.ts`, `release-page.ts` | fase 3 (helper di slug e link spostati da `auto-update.ts`) |
| `apps/worker/src/nightly/page-update.ts` | fase 4, pagine esistenti; avanzamento del segnalibro |
| `apps/worker/src/nightly/page-create.ts` | fase 4, pagine nuove |
| `apps/worker/src/agent/read-scope.ts` | `scopedFileReadTools(dir, files)` |
| `apps/worker/src/nightly/orchestrator.ts` | orario, giro dei repository, fasi, quota, allarme, ripresa |
| `packages/docs-engine/src/{refresh-page,releases}.ts` | campo additivo `commitSummaries` nei prompt; testo di lettura del refresh |
| `apps/server/src/routes/docs.ts`, `packages/shared/src/schemas/docs.ts`, web Docs | avviso «superata» derivato a lettura |
| `apps/server/src/routes/webhooks.ts`, `apps/worker/src/docs/auto-update*.ts`, `index.ts`, `config.ts`, compose, `.env.example` | rimozioni e cablaggio |
| `apps/worker/scripts/golden/nightly.ts` | scenario `nightly` (testcontainers) |

## Interfacce (CONTRATTO)

```ts
// packages/db (Task B1)
commitSummaries: { repositoryId, sha (PK con repositoryId), committedAt, authorName, authorEmail, subject, summary (text), files (text[]), areas (text[]), noise (boolean), onDefaultBranch (boolean), documentedAt (timestamptz|null), model (text|null), costUsd (numeric|null), createdAt }
nightlyItems: { id, repositoryId, projectId, phase ("summary"|"daily_report"|"release"|"page_update"|"page_create"), key (text), status ("pending"|"done"|"escalated"), failedNights (int), lastFailedNight (date|null), lastError (text|null), payload (jsonb), night (date), claimedAt (timestamptz|null), createdAt, updatedAt }  // unique (repositoryId, phase, key)

// apps/worker/src/git/mirrors.ts (Task B2)
export interface CommitFile { path: string; additions: number; deletions: number }   // rename «a => b» normalizzato al percorso nuovo; binari 0/0
export interface CommitWithFiles extends RangeCommit { files: CommitFile[] }
listRecentCommits(project: MirrorProject, since: Date, opts?: { skipFetch?: boolean }): Promise<CommitWithFiles[]>;   // tutti i branch, niente merge
getCommitWithFiles(project: MirrorProject, sha: string, opts?: { skipFetch?: boolean }): Promise<CommitWithFiles>;     // un commit fuori finestra
listDefaultBranchCommitsSince(project: MirrorProject, fromSha: string | null, since: Date, opts?: { skipFetch?: boolean }): Promise<{ commits: string[]; headSha: string; fallback: boolean }>;
openWorktreeAtSha(project: MirrorProject, sha: string, opts?: { skipFetch?: boolean }): Promise<{ dir: string; remove: () => Promise<void> }>;   // detached, remove() idempotente

// apps/worker/src/nightly/types.ts (Task B2, completato da B3/B9)
export interface NightlyRepo {
  repositoryId: string; repositoryName: string;
  projectId: string; projectName: string;
  project: MirrorProject;              // configurazione git con le credenziali decifrate
  dailyReport: boolean;                // projects.daily_report_enabled
  docsNightly: boolean;                // projects.doc_auto_update («Docs aggiornati ogni notte»)
  currentGenerationId: string | null;  // repositories.current_doc_generation_id
}
export interface NightlyConfig {
  start: string;                       // NIGHTLY_START, "HH:MM" Europe/Rome
  alertRuns: number;                   // NIGHTLY_ALERT_RUNS
  summaryWindowDays: number;           // COMMIT_SUMMARY_WINDOW_DAYS
  diffMaxChars: number;                // COMMIT_DIFF_MAX_CHARS
  commitSummaryModel: string; releaseNotesModel: string; docsNightlyModel: string;
  docAgentTimeoutMs: number;           // DOC_AGENT_TIMEOUT_MS esistente
  docModuleMaxTurns: number;           // esistente, per i run delle pagine
}
/** Il sottoinsieme che serve a riassumere un commit: lo usano il giro E il poller del daily report. */
export interface CommitSummaryDeps { db: Db; mirrors: MirrorManager; runner: AgentRunner; select: SelectDeps; model: string; diffMaxChars: number; log: (m: string) => void }
export interface NightlyDeps {
  db: Db; mirrors: MirrorManager; runner: AgentRunner; serializer: ProjectSerializer;
  select: SelectDeps;                  // Piano A (contiene encryptionKey)
  embeddingClient: EmbeddingClient;
  publish?: PublishFn;                 // `pipeline/notify.ts`, iniettabile nei test; si pubblica con `notify(...)` come node-dispatch per docs.limit_paused
  publicUrl: string;
  config: NightlyConfig;
  log: (m: string) => void;
  now?: () => Date;
}
export interface NightResult {
  night: string;                       // YYYY-MM-DD Europe/Rome
  repositories: number;
  itemsDone: number;
  itemsPending: number;
  stoppedForQuota: boolean;
  skipped: { repositoryId: string; reason: "unreachable" | "provider_config" | "generation_running" }[];
}

// apps/worker/src/nightly/queue.ts (Task B2)
export type NightlyPhase = "summary" | "daily_report" | "release" | "page_update" | "page_create";
export const NIGHTLY_ITEM_LEASE_MS = 60 * 60_000;
export async function enqueueItems(db: Db, items: { repositoryId: string; projectId: string; phase: NightlyPhase; key: string; payload?: Record<string, unknown> }[], night: string): Promise<number>;   // ON CONFLICT DO NOTHING; righe nuove inserite
/** page_update/page_create: se esiste un pending con lo stesso prefisso («<id>@»), aggiorna key e payload (conserva failed_nights); altrimenti inserisce. */
export async function upsertTargetItems(db: Db, items: { repositoryId: string; projectId: string; phase: "page_update" | "page_create"; target: string; toSha: string; payload: Record<string, unknown> }[], night: string): Promise<number>;
export async function claimNext(db: Db, repositoryId: string, phase: NightlyPhase, now: Date): Promise<NightlyItem | null>;   // lease
export async function completeItem(db: Db, id: string): Promise<void>;
export async function releaseItem(db: Db, id: string): Promise<void>;   // quota o config: claimed_at = null, nessun fallimento contato
export async function failItem(db: Db, id: string, error: string, night: string): Promise<"retry" | "escalated">;   // resta pending; 3 notti diverse → escalated
export async function pendingCount(db: Db, repositoryId: string, phase?: NightlyPhase): Promise<number>;

// apps/worker/src/nightly/commit-summary.ts (Task B3)
export function buildCommitSummaryPrompt(input: { subject: string; files: CommitFile[]; diff: string; diffTruncated: boolean }): string;
export function parseCommitSummary(output: string): { summary: string; areas: string[] } | null;
export function noiseSummary(files: string[]): { summary: string; areas: string[] };
/** Non tocca la coda: lo stato dell'elemento lo decide il chiamante. */
export async function summarizeCommit(deps: CommitSummaryDeps, repo: Pick<NightlyRepo, "repositoryId" | "projectId" | "project">, commit: CommitWithFiles): Promise<{ status: "done" } | { status: "unavailable"; reason: EmptyReason | "all_limited_now" } | { status: "failed"; error: string }>;

// apps/worker/src/nightly/plan.ts (Task B6)
export interface DocsPlan { generationId: string; fromSha: string | null; toSha: string; commits: string[]; changedFiles: string[]; mapped: PageRef[]; newAreas: string[]; missingSummaries: string[] }
export async function planDocs(deps: NightlyDeps, repo: NightlyRepo): Promise<DocsPlan | null>;   // null = nessuna generazione corrente o generazione completa in corso
export async function planPages(deps: NightlyDeps, repo: NightlyRepo, plan: DocsPlan, notes: ReleaseNotes | null, night: string): Promise<{ candidates: number; newAreas: number; alarm: boolean }>;

// apps/worker/src/nightly/release.ts (Task B6)
export async function runReleaseItem(deps: NightlyDeps, repo: NightlyRepo, item: NightlyItem): Promise<{ status: "done"; notes: ReleaseNotes; pageId: string } | { status: "unavailable"; reason: EmptyReason | "all_limited_now" } | { status: "failed"; error: string }>;

// apps/worker/src/nightly/page-update.ts (Task B7)
export async function runPageUpdateItem(deps: NightlyDeps, repo: NightlyRepo, worktreeDir: string, item: NightlyItem): Promise<"updated" | "unchanged" | { unavailable: EmptyReason | "all_limited_now" } | { failed: string }>;
export async function advanceBookmarkIfDone(deps: NightlyDeps, repo: NightlyRepo, plan: DocsPlan): Promise<boolean>;

// apps/worker/src/nightly/page-create.ts (Task B8)
export async function runPageCreateItem(deps: NightlyDeps, repo: NightlyRepo, worktreeDir: string, item: NightlyItem): Promise<"created" | { unavailable: EmptyReason | "all_limited_now" } | { failed: string }>;

// apps/worker/src/nightly/orchestrator.ts (Task B9)
export async function runNight(deps: NightlyDeps, now: Date, opts?: { repositoryId?: string }): Promise<NightResult>;
export function startNightlyScheduler(deps: NightlyDeps & { signal: AbortSignal }): () => void;
```

`EmptyReason`, `isQuotaWait`, `runWithProviders`, `limitTextOfRun`, `SelectDeps` sono del Piano A (`providers/select.ts`); `runAgentTextRaw` del Piano A (`agent/text.ts`).

---

### Task B1: Migrazioni 0089/0090 e tabelle

**Files:** `packages/db/drizzle/0089_nightly.sql`, `0090_nightly_notification.sql`, `_journal.json`, `schema.ts`, `testing.ts` (helper `seedCommitSummary`), `packages/shared/src/schemas/notification.ts`; test `packages/db/src/migration-0089.test.ts`.

- `commit_summaries`: PK `(repository_id, sha)`, FK `repository_id` → `repositories` CASCADE; `files text[] NOT NULL DEFAULT '{}'`, `areas text[] NOT NULL DEFAULT '{}'`, `noise boolean NOT NULL DEFAULT false`, `on_default_branch boolean NOT NULL DEFAULT false`, `documented_at timestamptz` (null = non ancora documentato dal giro; docblock: «la scrive la stessa transazione che avanza il segnalibro dei Docs; l'avviso "superata" la legge»); indice `(repository_id, committed_at)` e indice parziale `(repository_id) WHERE on_default_branch AND documented_at IS NULL`.
- `nightly_items`: CHECK su `phase` e su `status IN ('pending','done','escalated')`, `failed_nights int NOT NULL DEFAULT 0`, `last_failed_night date`, `claimed_at timestamptz`, unique `(repository_id, phase, key)`, indice parziale `(repository_id, phase, created_at) WHERE status = 'pending'`; FK `repository_id` e `project_id` CASCADE.
- 0090: SOLO `ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'docs.nightly_attention';`. Il valore va aggiunto IN CODA al letterale `notificationKind` di `packages/db/src/schema.ts` (`ADD VALUE` appende, e `enum-parity.test.ts` confronta l'ordine: il test non si tocca) e in `packages/shared/src/schemas/notification.ts`. La forma dell'evento e i Record esaustivi sono del Task B5.

Test: vincoli (CHECK, unique, cascade), default dei campi (`documented_at` e `claimed_at` null), il valore d'enum presente; `enum-parity.test.ts` verde senza modifiche. Commit `feat(db): 0089-0090, riassunti dei commit e coda del giro notturno`.

---

### Task B2: Scoperta dei commit e coda

**Files:** `apps/worker/src/git/mirrors.ts` (+ test con upstream finti come `withProjectWorktrees`), `apps/worker/src/nightly/queue.ts` (+ test Postgres), `apps/worker/src/nightly/types.ts` (tipi del contratto; `NightlyDeps` si completa in B9).

Mirror:
- `commitExists(mirrorDir, sha)` (nuovo, privato): sha validato con `SHA_RE`, poi `git cat-file -e <sha>^{commit}`; false su errore.
- Numstat per file: `listRecentCommits(project, since, opts)` come `getCommitsInRange` ma senza `--until`, con `--no-merges`, `--branches` e `--numstat` per file (`files: CommitFile[]`; un rename `a => b` o `dir/{a => b}` si normalizza al percorso nuovo; un binario `-\t-` vale 0/0). `getCommitWithFiles(project, sha, opts)`: lo stesso per un solo commit (`git show --numstat --format=…`), per i commit fuori finestra.
- `openWorktreeAtSha(project, sha, opts)`: variante a handle di `withWorktreeAtSha` (stesso schema di path, `worktree add --force --detach`), `remove()` idempotente — sul modello di `openProjectWorktrees`.
- Tutte accettano `skipFetch` come `getCommitDiff`: il chiamante fa UN `ensureMirror` dentro il serializer e poi le chiama con `skipFetch: true`.

`listDefaultBranchCommitsSince(project, fromSha, since, opts)`:

```ts
// Commit raggiungibili dal branch di default e non da fromSha. Se fromSha non
// esiste più nel mirror (force-push, mirror ricreato) si ripiega sui commit del
// default branch entro la finestra, con fallback=true: il chiamante lo logga.
const cwd = opts?.skipFetch ? this.mirrorDirFor(project) : await this.ensureMirror(project);
const head = (await this.git(["rev-parse", `refs/heads/${project.defaultBranch}`], { cwd })).trim();
if (fromSha !== null && (await this.commitExists(cwd, fromSha))) {
  const out = await this.git(["rev-list", "--no-merges", `${fromSha}..${head}`], { cwd });
  return { commits: lines(out), headSha: head, fallback: false };
}
const out = await this.git(["rev-list", "--no-merges", `--since=${since.toISOString()}`, head], { cwd });
return { commits: lines(out), headSha: head, fallback: fromSha !== null };
```

Coda:
- `claimNext` reclama con lease: `UPDATE nightly_items SET claimed_at = now(), updated_at = now() WHERE id = (SELECT id FROM nightly_items WHERE status = 'pending' AND repository_id = $1 AND phase = $2 AND (claimed_at IS NULL OR claimed_at < $now - NIGHTLY_ITEM_LEASE_MS) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`. Lo stato resta `pending` finché non è chiuso: un riavvio non perde niente, e dopo la lease (60 minuti, più lunga di ogni run singolo) l'elemento è di nuovo reclamabile.
- `completeItem` → `done`, `claimed_at = null`. `releaseItem` → `claimed_at = null`, nient'altro.
- `failItem` → resta `pending`, `claimed_at = null`, `last_error`; incrementa `failed_nights` solo se `night` differisce da `last_failed_night` (e la scrive); a 3 → `escalated` e ritorna `"escalated"`.
- `enqueueItems` è `ON CONFLICT DO NOTHING` (idempotenza: rieseguire la pianificazione non duplica) e restituisce le righe inserite.
- `upsertTargetItems` (per `page_update`/`page_create`, chiave `<target>@<toSha>`): nella stessa transazione cerca un `pending` dello stesso repository e fase con `key LIKE <target>@%` (target escapato, o `starts_with`); se c'è e ha un `toSha` diverso, gli aggiorna `key`, `payload` e `night` conservando `failed_nights`/`last_failed_night` (così le 3 notti contano per la pagina, non per il bersaglio); altrimenti inserisce `ON CONFLICT DO NOTHING`. Un `done` di un bersaglio vecchio non si tocca (storia).

Test (Review Focus #1, #2, #6): branch vecchio mergiato compare in `listDefaultBranchCommitsSince`; `fromSha` inesistente → `fallback: true`; merge esclusi; numstat per file con un rename e un binario; `openWorktreeAtSha` + `remove()` due volte; coda: due claim di seguito non restituiscono lo stesso elemento (lease), dopo la lease sì; `failItem` 3 notti diverse → escalated, 2 volte la stessa notte → `failed_nights` 1; `upsertTargetItems` riallinea un pending conservando `failed_nights` e non tocca un `done`. Commit `feat(worker): scoperta dei commit e coda del giro notturno`.

---

### Task B3: Fase 1 — riassunti dei commit

**Files:** `apps/worker/src/nightly/noise.ts` (+ test), `apps/worker/src/nightly/commit-summary.ts` (+ test), `apps/worker/src/docs/auto-update.ts` (importa `isNoise` da `nightly/noise.ts`; nient'altro). Prompt in inglese, come i prompt Docs.

- Rumore: `isNoise(path)` si sposta in `nightly/noise.ts` con la regola allargata delle «Decisioni del preflight» (lockfile, cartelle di processo come oggi; segmenti `vendor/`, `node_modules/`, `dist/`; suffissi `.min.js`, `.min.css`, `.map`, `.snap`). Docblock con la lista e il perché di ciò che resta fuori (`build/`, intestazioni «generated»). `auto-update.ts` lo importa finché esiste.
- Un commit i cui file sono tutti rumore → `noiseSummary(files)` deterministico, che nomina la categoria invece di un generico «dipendenze/file generati»: «Documentazione e piani: …», «Lockfile: …», «Codice generato o vendorizzato: …», «Configurazione CI: …» (una riga per categoria presente, al più 5 file per riga, poi «e altri N»); `areas` = le cartelle di primo livello; `noise = true`, nessun run. È il testo che il daily report mostra per quel commit (oggi un commit di soli piani ha una descrizione dal modello: è la scelta del maintainer).
- Diff: `getCommitDiff(project, sha, { skipFetch: true })` esistente (già tagliato a 150000), tagliato di nuovo a `COMMIT_DIFF_MAX_CHARS` con marcatore; nel prompt sempre il numstat completo (`files`).
- Contratto d'uscita a marcatori: `===SUMMARY===` … `===END SUMMARY===` (2–5 frasi, cosa cambia per chi usa e per chi sviluppa) e `===AREAS===` … `===END AREAS===` (un percorso o modulo per riga, max 10). Parser tollerante agli spazi; output senza marcatori → `null` → `{ status: "failed" }`.
- Run: `runWithProviders(deps.select, { projectId, workClass: "background" }, (p) => runAgentTextRaw(deps.runner, { model: deps.model, maxTurns: 3, provider: p, … }), limitTextOfRun)`; testo con `textFromRun(result)`, costo da `result.usage?.totalCostUsd`. `unavailable` → `{ status: "unavailable", reason }` (lo stato dell'elemento lo decide il chiamante: B9 chiama `releaseItem`, il poller del daily report rimette il report `queued`).
- Salvataggio: `insert … on conflict do nothing` su `commit_summaries` con `files` = tutti i percorsi del numstat (rumore compreso: l'avviso e la mappa filtrano dopo), `model`, `cost_usd`. Un riassunto non si riscrive mai.

Test: `isNoise` su ogni regola e sui casi che NON sono rumore (`src/build/x.ts`, `lib/distance.ts`, `app.mapper.ts`); prompt con subject, numstat completo e marcatore di taglio quando serve; parser (ok, senza marcatori, aree oltre 10 troncate); commit di solo rumore → nessun run, `noise = true`, testo per categoria; limite → `unavailable` col motivo; output non valido → `failed`; secondo `summarizeCommit` sullo stesso sha → nessun run. Commit `feat(worker): riassunto di ogni commit, una volta sola`.

---

### Task B4: Fase 2 — daily report dai riassunti

**Files:** `apps/worker/src/reports/daily-report-poller.ts` (+ test), `apps/worker/src/index.ts` (deps del poller).

- La descrizione di ogni commit (`activity_commits.ai_description`) è il `summary` di `commit_summaries`; se manca, `summarizeCommit` lo crea (stessa funzione della fase 1: un solo modo di riassumere). Il poller riceve un `CommitSummaryDeps` (`model: config.commitSummaryModel`). Spariscono i run «descrizione del commit».
- Riassunto di progetto e per sviluppatore: invariati nella forma, su `DAILY_REPORT_MODEL` (PR #103, già mergiata) e con `runWithProviders` `background` (già così dopo il Piano A, Task A5).
- **Il gate notturno sparisce da `pollDailyReportsOnce`**: il ciclo sui progetti con `daily_report_enabled` che genera il giorno precedente (oggi dentro la funzione, non in `index.ts`) si toglie. La riga del giorno la inserisce il giro (Task B9: `activity_reports` `queued`); il poller resta l'UNICO consumatore delle righe `queued` (giro e rigenerazione manuale), quindi la sua recovery degli orfani `running` resta corretta (un solo processo che genera). Restano recount, rollup per sviluppatore e retention.
- Un report in cui un riassunto è mancato per `unavailable` NON va a `done`: torna `queued` (come il Piano A, Task A5) e la fase «queued» lo riprende al tick dopo, per qualunque data entro la retention (fine dei report vuoti per sempre del 12-13 ott).

Test: report con 3 commit già riassunti → nessun run di descrizione, descrizioni = riassunti; commit senza riassunto → creato; quota non disponibile → report `queued`, non `done`; rigenerazione manuale (`queued`) ancora processata; un tick senza righe `queued` non genera il giorno precedente (il gate non c'è più). Commit `feat(worker): il daily report si scrive dai riassunti dei commit`.

---

### Task B5: Notifica `docs.nightly_attention`

**Files:** `packages/notifications/src/format.ts` (evento `DocsNightlyAttentionEvent` accanto a `DocsLimitPausedEvent`: `{ kind: "docs.nightly_attention"; reason: "plan_oversized" | "item_failing"; repositoryId; repositoryName; projectId; projectName; night; counts?: { commits; candidates; newAreas }; phase?; key?; lastError? }`, unione `NotificationKind`, formattazione), `packages/notifications/src/{dispatch,routing,actions}.ts`, `packages/notifications/src/push/payload.ts`, `packages/i18n/src/catalog.ts` (it/en), web `apps/web/src/components/{inbox-item,notifications-section}.tsx`, app `apps/mobile/src/i18n/{en,it}.json` (la card generica `InfoCard.tsx` legge titolo e testo; nessuna azione decisionale).

- `routing.ts`: `"docs.nightly_attention": "admins"` (come `docs.limit_paused`).
- `dispatch.ts` `TOGGLE_FOR_KIND`: `"docs.nightly_attention": "notifyDocsLimitPaused"` — riusa l'interruttore esistente (D14), nessuna colonna nuova in `notification_settings`; un commento lo dice.
- Tutti gli altri Record esaustivi su `NotificationKind` (`format.ts`, `actions.ts`, `push/payload.ts`, `inbox-item.tsx`, `notifications-section.tsx`) ricevono la voce: il compilatore li trova, la lista qui serve a non scoprirli uno per volta.
- Testi da template i18n con i numeri (mai prosa generata): per `plan_oversized` «Il giro notturno di <repository> ha pianificato <N> run (soglia <S>): <commit> commit, <candidate> pagine da aggiornare, <aree> pagine nuove. Si esegue comunque.»; per `item_failing` «<fase> <chiave> fallisce da 3 notti in <repository>: non si riprova più da solo. Ultimo errore: …».

Test: evento pubblicato solo agli admin; interruttore `notifyDocsLimitPaused` spento → nessuna consegna webhook; testo da template con i numeri; un client vecchio (app) riceve `UNKNOWN` e non crasha (test di `readerSchema`); il web mostra la card. Commit `feat: avviso in inbox quando il giro notturno esce di scala o un elemento fallisce 3 notti`.

---

### Task B6: Fase 3 — piano dei Docs e nota di rilascio

**Files:** `apps/worker/src/nightly/plan.ts` (+ test), `apps/worker/src/nightly/release.ts` (+ test), `apps/worker/src/nightly/release-page.ts` (spostamento immutato di `uniqueReleaseSlug`, `buildRelatedLinks`, `timestampForSlug` da `auto-update.ts`, che li importa da lì), `packages/docs-engine/src/releases.ts` (campo additivo).

**`planDocs(deps, repo)`** (in testa, D3) — chiamato dall'orchestratore dentro il serializer, dopo l'`ensureMirror`:
- generazione corrente del repository; nessuna → `null` (il repository salta nota e pagine); generazione completa `running`/`paused` sul repository → `null` con motivo `generation_running` (D29).
- `fromSha` = `commit_sha` della generazione; `listDefaultBranchCommitsSince(…, { skipFetch: true })`; `fallback` → riga di log.
- marca `on_default_branch = true` sui riassunti di quei commit; i commit senza riassunto (fuori finestra: branch vecchi mergiati tardi) finiscono in `missingSummaries` e l'orchestratore accoda per loro elementi `summary` (D24), che la fase 1 consuma prima della nota (ordine delle fasi).
- `changedFiles` = unione dei `files` non rumore dei riassunti; `mapped` = `mapAffectedPages(changedFiles, pages, Number.MAX_SAFE_INTEGER).affected`, `newAreas` = la sua `newAreas`.

**Nota di rilascio** — un elemento `release` per intervallo: chiave `<releaseFrom>..<toSha>`, dove `releaseFrom` è il `toSha` dell'ultimo elemento `release` del repository (qualunque stato), altrimenti `plan.fromSha` (Global Constraints: la nota ha il suo punto di partenza, così una nota scritta non si riscrive se il segnalibro dei Docs aspetta). Payload `{ fromSha: releaseFrom, toSha, commits }` con i SOLI commit dell'intervallo della nota: un elemento fallito si riprova la notte dopo su quell'intervallo, non su quello nuovo (D5). Nessun commit nell'intervallo → nessun elemento.
- `ReleaseInput` guadagna `commitSummaries?: { sha: string; subject: string; summary: string }[]` (additivo: assente → prompt invariato, `releases.test.ts` verde). Con i riassunti, `changedFiles` e `commitSubjects` restano come contesto; `newAreas` dalla mappa. Il tetto di 200 righe dei prompt resta (D27): oltre, il prompt dice «e altri N commit non elencati»; «nessun tetto» vale per i run, non per le righe di contesto di un prompt.
- Run: `runWithProviders` `background`, `runAgentTextRaw` + `limitTextOfRun`, modello `RELEASE_NOTES_MODEL`, nessun tool di scrittura (la nota si scrive dai riassunti, non legge codice).
- Inserimento della pagina `releases` come oggi (slug unico, `generationId` null). L'ordine cambia rispetto a oggi: la nota si scrive PRIMA delle pagine per orientarle, e i link «related» alle pagine aggiornate/create si completano a fine fase 4 con un UPDATE (Task B7).
- Fallimento della nota: `failItem` (resta `pending`, regola delle 3 notti); la fase Docs procede con le sole pagine della mappa.

**`planPages(deps, repo, plan, notes, night)`** — dopo il tentativo della nota (riuscito, fallito o assente):
- candidate = `plan.mapped` ∪ pagine degli `notes.affectedSlugs` (se c'è la nota);
- aree nuove = `aggregateNewAreas(plan.newAreas)` (`packages/docs-engine/src/grow.ts`), una per elemento;
- `upsertTargetItems`: un `page_update` per candidata (`target` = page id, payload `{ fromSha, toSha, files, commits, via: "map" | "note" | "parent" }`, con i file e i commit calcolati come in B7), un `page_create` per area (`target` = chiave normalizzata dell'area, payload `{ toSha, area, files }`);
- allarme: se gli elementi inseriti o riallineati in QUESTA chiamata sono > 0 e (1 se c'è un elemento `release` della notte) + candidate + aree > `NIGHTLY_ALERT_RUNS` → `publish` `docs.nightly_attention` `{ reason: "plan_oversized", counts }` e si procede. Rieseguire `planPages` nella stessa notte non inserisce niente, quindi non ripubblica.

Test: commit in produzione con branch vecchio mergiato; `missingSummaries` per un commit fuori finestra; nota con 2 commit (subject + riassunto nel prompt); nessun commit nell'intervallo della nota → nessun run; nota fallita → elemento `pending` col suo intervallo, la notte dopo riprovata su QUELL'intervallo e una seconda nota per i commit nuovi; output non valido → failed e `planPages` procede con la sola mappa; candidate = mappa ∪ nota; allarme sopra soglia pubblicato una volta sola per notte. Commit `feat(worker): piano dei Docs notturni e una nota di rilascio dai riassunti`.

---

### Task B7: Fase 4 — aggiornamento delle pagine e segnalibro

**Files:** `apps/worker/src/nightly/page-update.ts` (+ test), `apps/worker/src/agent/read-scope.ts` (`scopedFileReadTools`), `packages/docs-engine/src/refresh-page.ts` (campo additivo e testo di lettura). Le funzioni di `auto-update.ts` (`refreshAffectedPagesInWorktree`, `guardRefreshedProductBody`, `loadPagesWithRefs`, `loadConfidentialFacts`) si **riscrivono** qui per un elemento singolo, con `runWithProviders` e l'allowlist chiusa; `auto-update.ts` non si tocca (lo rimuove B11) e continua a compilare.

- **File leggibili da una pagina** (D13), calcolati in `planPages` e salvati nel payload:
  - pagina con `sourcePath`: i file cambiati che il suo `sourcePath` copre (`pathCovers`);
  - genitore-overview promosso da `mapAffectedPages` (`sourcePath` null): l'unione dei file dei figli toccati;
  - pagina che entra solo dalla nota e non copre nessun file cambiato: tutti i file cambiati del piano.
  I commit passati al prompt sono quelli che toccano quei file (per la pagina della nota: tutti i commit del piano), tetto di 200 righe come per la nota.
- **Allowlist chiusa**: `permissionMode: "default"`, NON la plan mode (il golden `refine-read-plan` ha misurato che in plan mode la restrizione di lettura non regge). `allowedTools` = `scopedFileReadTools(dir, files)`, helper nuovo in `agent/read-scope.ts`: per ogni file `Read(//<dir>/<file>)`, `Grep(//<dir>/<file>)`, senza `/**` (`underRule` lo aggiunge: serve una regola per file). `disallowedTools` = `sensitiveReadDenyRules()`. Nessun `Read` nudo, nessun tool di scrittura: l'output è il corpo a marcatori.
- **Prompt**: `buildRefreshPagePrompt` guadagna `commitSummaries?` (additivo) e, quando è valorizzato, `readableFiles: string[]`; le righe che oggi dicono di leggere il codice corrente sotto il `sourcePath` diventano, in quel caso, «leggi SOLO questi file, al commit documentato»; senza i campi nuovi il prompt è invariato (test esistenti verdi).
- **Run**: worktree al `toSha` aperto dall'orchestratore con `openWorktreeAtSha` dentro il serializer (uno per repository per notte, riusato da tutte le pagine e chiuso dentro il serializer a fine fase); `runWithProviders` `background`, `runner.run` (servono `allowedTools`/`disallowedTools`/`permissionMode`, che `runAgentText` non espone), `limitTextOfRun`, modello `DOCS_NIGHTLY_MODEL`, `maxTurns: docModuleMaxTurns`, timeout `docAgentTimeoutMs`. Esito `unchanged` → `done` senza scritture; `updated` → guardia `product` (audit dei segreti come oggi), salvataggio, re-embed (`embedAndStoreChunks`, `apps/worker/src/docs/embed.ts`).
- **Segnalibro** (`advanceBookmarkIfDone`): quando il repository non ha più `page_update`/`page_create` `pending` (gli `escalated` non contano), in UNA transazione: `UPDATE doc_generations SET commit_sha = toSha` e `UPDATE commit_summaries SET documented_at = now() WHERE repository_id = $repo AND on_default_branch AND documented_at IS NULL AND sha = ANY($plan.commits)`; poi completa i link «related» della nota della notte (UPDATE della pagina `releases`). Con elementi pendenti (limite, o un fallimento della notte) il segnalibro resta e l'orchestratore lo riprova al prossimo giro. Una pagina `escalated` perde l'avviso «superata» quando il segnalibro avanza: limite dichiarato, la card in inbox la nomina.

Test: allowlist per file (nessun `Read` nudo, nessun `/**`); file della pagina, del genitore e della pagina della nota come sopra; «nessun cambiamento» → nessuna scrittura, elemento `done`; aggiornata → corpo e chunk nuovi; segnalibro e `documented_at` avanzano insieme a fine fase anche con la nota fallita; limite a metà → segnalibro fermo, restanti `pending`; una pagina che fallisce → segnalibro fermo, alla terza notte `escalated` e segnalibro avanzato (Review Focus #6); prompt invariato senza i campi nuovi. Commit `feat(worker): Docs aggiornati di notte dai riassunti, senza tetti`.

---

### Task B8: Fase 4 — pagine nuove

Diviso da B7 perché `growNewAreaPages` non si può chiamare per area (D12): aggrega, fa un orient unico e taglia a `maxNewPages`.

**Files:** `apps/worker/src/nightly/page-create.ts` (+ test). Riscrive per un'area sola la sequenza di `growNewAreaPages`/`applyGrowStats` di `auto-update.ts` (che non si tocca).

- Un elemento `page_create` = un'area aggregata (`aggregateNewAreas`), payload `{ toSha, area, files }`.
- Mini-orient **per area** e poi la pagina, sullo stesso worktree della notte, con la stessa allowlist chiusa di B7 sui file dell'area (`scopedFileReadTools`), `permissionMode: "default"`, `runWithProviders` `background`, modello `DOCS_NIGHTLY_MODEL`. Nessun tetto: niente `slice(maxNewPages)`, prompt senza `maxPages`.
- Pagina creata nella generazione corrente, sotto il genitore che l'orient indica, guardia `product`, re-embed; l'elemento `done`. Una volta creata, la pagina copre l'area: la notte dopo `mapAffectedPages` non la rimette fra le aree nuove.

Test: area nuova → pagina creata e chunk scritti; due aree → due orient, due pagine; allowlist sui soli file dell'area; limite → elemento `pending`, nessuna pagina parziale; la notte dopo l'area non è più nuova. Commit `feat(worker): le aree nuove diventano pagine, una per area`.

---

### Task B9: Orchestratore, orario, ripresa

**Files:** `apps/worker/src/nightly/orchestrator.ts` (+ test con runner finto e Postgres), `apps/worker/src/nightly/types.ts` (completa `NightlyDeps`), `apps/worker/src/index.ts` (cablaggio), `apps/worker/src/config.ts` (+ compose, `.env.example`, test).

```ts
/**
 * Una notte (design 2026-10-15 §3). Per i repository dei progetti con almeno
 * uno dei due interruttori accesi, a turno (un elemento per repository per
 * giro, così un progetto attivo non si prende tutto il margine):
 *  1. pianifica (enqueue idempotente), DENTRO serializer.run(projectId): un
 *     ensureMirror, riassunti dei commit nuovi; un elemento daily_report per
 *     il giorno UTC appena chiuso (progetti col report acceso); planDocs
 *     (progetti coi Docs notturni) e i summary dei commit fuori finestra;
 *  2. consuma la coda in ordine di fase per repository: summary → daily_report
 *     → release (poi planPages) → page_update/page_create → segnalibro;
 *  3. su `unavailable` di quota (isQuotaWait) si ferma TUTTO il giro e lo
 *     scheduler riprova ogni 15 minuti finché c'è lavoro della notte e la quota
 *     lo permette; su un motivo di configurazione salta solo il progetto.
 * Ogni repository in try/catch isolato: un repository rotto non ferma gli altri.
 * Serializer per-progetto per fetch, elenchi e worktree; i run stanno fuori.
 */
export async function runNight(deps: NightlyDeps, now: Date, opts?: { repositoryId?: string }): Promise<NightResult> { /* … */ }
```

- **Daily report** (D7): l'elemento `daily_report` (chiave = data UTC di `previousUtcDay(now)`) si accoda su UN repository per progetto (il primo per `created_at`); consumarlo = `insert into activity_reports (project_id, date, status) values (…, 'queued') on conflict do nothing`, poi `completeItem`. Il report lo scrive il poller del daily report (unico consumatore). Un report già presente (manuale o generato) non si tocca.
- **Docs**: dopo che gli elementi `summary` del piano sono chiusi, l'elemento `release` della notte (o uno pendente di notti prima) si consuma, poi `planPages`, poi le pagine sul worktree della notte, poi `advanceBookmarkIfDone`. Repository con generazione completa `running`/`paused`: fasi Docs saltate (`generation_running`).
- **Esiti**: `unavailable` di quota → `releaseItem`, stop del giro, `stoppedForQuota: true`; motivo di configurazione → `releaseItem`, progetto saltato per la notte (`provider_config`); `failed` → `failItem`, e se `"escalated"` → `publish` `docs.nightly_attention` `{ reason: "item_failing", phase, key, lastError }`. Repository irraggiungibile (credenziali, mirror) → saltato (`unreachable`), una riga di log.
- **Scheduler**: un timer che a `NIGHTLY_START` (fuso `Europe/Rome`, calcolato con `Intl.DateTimeFormat`) avvia `runNight`; se una notte termina con lavoro pendente per quota, riprova ogni 15 minuti fino al prossimo `NIGHTLY_START`. Mai due `runNight` insieme (flag in memoria: il worker è UN processo; la lease della coda copre comunque un doppio claim).
- **Riavvio del worker**: nessun recupero speciale; la coda è in tabella, gli elementi reclamati tornano disponibili alla scadenza della lease e lo scheduler riparte all'orario o al primo tick di ripresa; il worktree della notte si riapre.
- `opts.repositoryId`: un giro su un solo repository, per lo script di rollout del Task B11.
- Rimuovere dal cablaggio di `index.ts` il poller `doc_auto_update` (B11 rimuove il codice). Il poller del daily report resta cablato (consuma le `queued`); il suo gate notturno lo ha già tolto B4.

Test: due repository, uno con molti commit → alternanza; quota non disponibile al secondo elemento → giro fermo, ripresa riparte dal terzo; `exclusive_unavailable` su un progetto → quel progetto saltato, l'altro completato; riavvio simulato (nuovo orchestratore) → nessun elemento rifatto; repository con credenziali rotte saltato, gli altri completati; repository con generazione completa in corso → riassunti sì, Docs no; elemento `daily_report` → una riga `activity_reports` `queued`, una sola anche rieseguendo; escalation → card pubblicata; un solo `runNight` alla volta. Config: `NIGHTLY_START` accetta `H:MM` e `HH:MM` (00:00–23:59, **default `02:00`**), rifiuta «25:00» e «1pm»; `NIGHTLY_ALERT_RUNS` intero ≥ 1 (default 50); `COMMIT_SUMMARY_WINDOW_DAYS` intero ≥ 1 (default 30); `COMMIT_DIFF_MAX_CHARS` intero ≥ 1000 (default 20000); i tre modelli stringhe non vuote coi loro default; tutte elencate nel compose del worker (niente `env_file`). Commit `feat(worker): il giro notturno, a turno fra i repository e con ripresa`.

---

### Task B10: Pagine dei Docs oneste e impostazioni

**Files:** `packages/shared/src/schemas/docs.ts` (`docPageSchema.staleSince: z.array(z.object({ sha, subject, summary, committedAt })).nullable().default(null)`), `apps/server/src/routes/docs.ts` (calcolo a lettura; `toPage` valorizza `staleSince: null` per le tre rotte che restituiscono `docPageSchema`, il dettaglio lo calcola), web `apps/web/src/routes/docs/*` (avviso), `apps/web/src/components/project-form.tsx` e i18n (etichetta «Docs aggiornati ogni notte»).

Calcolo a lettura (una query per pagina letta; il dettaglio pagina è una lettura singola), sulla marcatura esplicita di B7 (D4), non sulle date:

```sql
select cs.sha, cs.subject, cs.summary, cs.committed_at
from commit_summaries cs
where cs.repository_id = $repo
  and cs.on_default_branch
  and cs.documented_at is null
  and exists (select 1 from unnest(cs.files) f where f = $sourcePath or starts_with(f, $sourcePath || '/'))
order by cs.committed_at desc limit 20
```

(`starts_with` invece di `LIKE`, così `%` e `_` in un percorso non contano. Pagine senza `sourcePath`: `staleSince = null`.) Il web mostra «Il codice è cambiato dopo questa pagina» con i commit (subject e riassunto) solo se `(page.staleSince ?? []).length > 0`; la fixture del test resta SENZA il campo.

Test: pagina toccata da un commit in produzione non ancora documentato → avviso; commit di un branch vecchio mergiato (data anteriore al segnalibro) → avviso (Review Focus #1); dopo l'avanzamento del segnalibro (`documented_at` scritta) → nessun avviso (Review Focus #5); commit non sul branch di default → nessun avviso; pagina senza `sourcePath` → null; le rotte di elenco restituiscono `staleSince: null`. Commit `feat: le pagine dei Docs dicono quando il codice è cambiato dopo di loro`.

---

### Task B11: Rimozioni, golden, documentazione

- Rimuovere: il ramo push che accoda `doc_auto_update_jobs` in `webhooks.ts` (restano recount e grafo, con i loro test); `apps/worker/src/docs/auto-update.ts`, `auto-update-poller.ts` e i test (gli unici importatori sono `auto-update-poller.ts` e `index.ts`); `DOCS_AUTOUPDATE_*` (compresa `DOCS_AUTOUPDATE_POLL_SECONDS`) da `config.ts`, compose, `.env.example`. La tabella `doc_auto_update_jobs` resta (una migrazione che la droppa è un passo a parte, dopo che il nuovo giro è in produzione).
- Script di rollout `pnpm --filter @stubwise/worker nightly:once -- --repository <id>` (chiama `runNight` con `opts.repositoryId`, stampa `NightResult` e il costo dei run dai riassunti e dagli elementi).
- **Golden `nightly`, preparato e NON lanciato in questo piano** (D17): `apps/worker/scripts/golden/nightly.ts`, entry separata (`pnpm --filter @stubwise/worker golden:nightly -- --claude <path>`) perché l'harness esistente richiede `--plugin` e non ha DB. Avvia un Postgres con testcontainers dentro lo script, applica le migrazioni, crea un repo fixture con 5 commit (uno solo rumore, uno con un'area nuova) e una generazione Docs minima finta, embeddings finti deterministici; checks: 4 riassunti con modello + 1 deterministico, solo le pagine toccate aggiornate, la pagina dell'area nuova creata, una nota, segnalibro e `documented_at` avanzati, costo stampato. Il README di `scripts/golden/` lo elenca come opt-in; si lancia al rollout con il CLI pinnato.
- `docs/operations/deploy-log.md`: voce «Giro notturno». Ordine: server (0089 e 0090 nello stesso avvio: le migrazioni pendenti girano in un unico batch, e 0090 non usa il valore) → worker col controllo d'inattività → caddy. Gli interruttori restano spenti; rollout su un progetto piccolo con `nightly:once`, costo reale letto, poi gli altri. Rollback: il valore d'enum nuovo rende non sicuro scendere col server finché ne esistono righe → `delete from notifications where kind = 'docs.nightly_attention';` prima; il worker vecchio riprende l'aggiornamento a ogni push solo con gli interruttori accesi: tenerli spenti prima di scendere.
- `CLAUDE.md`: indice della voce, sezione «Architettura runtime» con il giro notturno al posto dell'aggiornamento a ogni push; invariante `docs/invariants/nightly.md` e la sua riga nell'elenco (il segnalibro non dipende dalla nota e avanza con `documented_at` nella stessa transazione; la nota ha il suo punto di partenza; nessun tetto, freno = quota; un commit si riassume una volta; il webhook non accoda Docs; mirror e worktree solo dentro il serializer; la regola del rumore è una lista dichiarata).
- Verifica finale: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`.
