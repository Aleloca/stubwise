# App desktop, area 8a: avvisi, rilasci, PR, supporto — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Costruire nel prototipo `apps/desktop` la prima metà dell'area 8:
iscrizioni agli avvisi per progetto con destinatari calcolati a lettura;
sezione Releases (PR aperte con l'analisi e coda di rilascio in una lista sola a due gruppi, stato del
rilascio dopo il merge, rilascio fallito e «Fai sistemare a Claude»,
ambienti); analisi e correzione di tutte le PR (anche dei colleghi); sezione
Support con le richieste dei clienti; il bug «Salvato» del compositore della
Posta.

**Architecture:** Tre famiglie di regole pure in `domain/` — `alerts/`
(catalogo dei tipi e calcolo dei destinatari), `releases/` (stato del
rilascio, stato e correggibilità di una PR: **un motore solo** per le PR di
Stubwise e dei colleghi), `support/` (stato della conversazione e stato in
parole per il cliente) — e tre moduli dati `data/{alerts,releases,support}/*`
con la visibilità in un file, letture e scritture separate, `gate()`,
`storeGeneration`, `failNext` e `resetApi` come nelle aree 5–7. Gli avvisi
non portano più destinatari fissi: `listNotifications` li calcola a lettura
per i tipi del catalogo. Le pagine leggono solo da `data/queries.ts`.

**Tech Stack:** quello delle aree 1–7; nessuna dipendenza nuova.

**Spec:** `docs/plans/2026-10-28-desktop-area8-releases-support-servers-design.md`
(approvato 28 ott 2026, commit 5ab30c2c), solo ciò che la sezione «Due piani:
8a e 8b» assegna a 8a. Contesto: ossatura, area 3 (sessioni, conversazioni
con contesto), area 6 (Posta: compositore, bozza di Claude, proposte), area 7
(`docs/plans/2026-10-26-desktop-area7-automations-plan.md`, forma di questo
piano), `apps/desktop/DESIGN.md`.

## Global Constraints

- Tutte le Global Constraints delle aree 2–7 restano (nessuna rete; en/it con parità; temi; niente monospace salvo logo, codice e **log/comandi**; colore mai unico segnale; movimento 150–250 ms con reduced-motion; pagine solo via `data/queries.ts`; stati completi — caricamento, vuoto, errore con «Riprova», pieno, senza permessi; lint/typecheck/test verdi a ogni commit; orologio `now()` di `data/store.ts`, mai `Date.now()`; Impeccable obbligatorio con shape approvati vincolanti; R-G5: nascosto e inesistente identici).
- **Anti-obiettivo 1**: nessun bottone, funzione del livello dati o passo d'automazione **avvia, rilancia o promuove** un rilascio o una pipeline. Il merge resta l'unica azione; lo stato del rilascio **legge**. Nessun «Deploy», nessun «Riprova la pipeline».
- **Anti-obiettivo 4**: una correzione sul ramo di un collega è un commit sopra, push in avanti; mai force push, rebase, push su fork, ramo protetto (`isProtectedBranch` di `@stubwise/shared`), ramo di default, ramo di destinazione, ramo `stubwise/…` di un'altra task.
- **Anti-obiettivo 5**: nessun avviso su ciò che non si può vedere; i permessi contano **adesso**, l'iscrizione conta **al momento dell'avviso**.
- **Nessuna email automatica al cliente**, nemmeno di solo avviso; Claude prepara solo bozze; ogni risposta parte dal clic di chi ha `support.reply`.
- **Una richiesta non nasce MAI da un'email**, né in automatico né a mano (decisione del maintainer, 28 ott 2026): nessuna azione «Crea richiesta» nella Posta, nessuna funzione dati che la crei da un thread, nessun canale «Email» in Support; le richieste nascono solo dai canali col triage (widget, plugin/MCP).
- **Codici**: rilascio `<PRJ>-V<n>` per progetto; conversazione di Support `<PRJ>-S<n>`; PR `owner/repo#<n>` (`PrRef`); mai riusati; codici scritti a mano diventano link solo se visibili.
- **Permessi** (`data/viewer.ts`): nuovo `support.reply` (progetto, locale: Project Lead, Developer, Legacy Member; non Contributor né Viewer), nella stessa forma di `automations.manage`; esistenti invariati: `release.merge` (Rilascia), `repos.view` (log della run), `environments.manage`, `repos.manage` (modo PR dei colleghi, pipeline e ramo di rilascio), `prs.adopt` («Gestire le correzioni sulle PR di altri»: «Solo analisi» su una PR altrui, «Chiedi modifiche» su una PR altrui entro il tetto), `plans.approve` (l'unico che scavalca il tetto delle correzioni, come l'invariante «Il budget di una correzione lo scavalca solo chi ha plans.approve»), `tickets.create` + `runs.start` («Fai sistemare a Claude»), `widget.manage`, `backlog.create` (aprire a mano la richiesta da una conversazione non conclusa), `backlog.edit` (refine).
- **Un solo tetto delle correzioni** (scelta del controller, 28 ott): `correctionCap` del progetto (assente = 3; STW 3), per tutte le PR, di Stubwise e dei colleghi; le automatiche si fermano lì; i commit dell'autore non azzerano il conto; un giro scartato per push concorrente non conta; oltre il tetto solo una persona con `plans.approve`. Nessun tetto fisso separato.
- **Stato del rilascio**: con run → `running` se una gira, `failed` se una fallisce, `succeeded` se tutte riuscite; senza run lette entro `NO_PIPELINE_AFTER_MIN = 30` minuti dal merge → senza pipeline: `not_in_production` / `in_production` (con l'ora) secondo `sameCommit` (prefisso ≥ 7, come `apps/server/src/services/release.ts:79`) fra lo sha del merge e il commit dell'ambiente di produzione; senza ambiente di produzione con server → `unavailable` col perché.
- **Comandi**: un file `pnpm --filter @stubwise/desktop test -- <file>`; prima di ogni commit suite desktop, `pnpm --filter @stubwise/desktop typecheck` e `pnpm lint` dalla radice. Trailer dei commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` e `Claude-Session: https://claude.ai/code/session_01C9DcEFDJAasjVWKkutyVLm`.
- **Prototipo**: ogni «Simula …» (esito della run, comparsa sul server, push dell'autore, messaggio del cliente) esiste solo nel prototipo e lo dice; «Telefono» si salva e un'etichetta dice che sul prototipo non parte nulla; nessuna notifica di sistema di Electron in 8a (solo pannello).

## Review Focus

1. **Destinatari a lettura**: permesso revocato dopo l'avviso (sparisce), riacquistato (torna), iscrizione spenta dopo l'avviso (resta), progetto diventato invisibile, avviso obbligatorio con iscrizione spenta, merge fatto fuori da Stubwise da un'identità git non collegata (→ autore della task collegata, o nessuno). → test in Task 3.
2. **Correzioni sulle PR dei colleghi**: push dell'autore durante la correzione (scartata, non conta), automatica oltre `correctionCap` (bloccata anche dopo commit nuovi; oltre il tetto solo chi ha `plans.approve`), «Solo analisi» acceso con una correzione in volo (si ferma prima del push), ramo vietato per ognuno dei motivi, repository «Spento» con PR «Solo analisi» (non si riaccende). → test in Task 4 e Task 5.
3. **Stato del rilascio ai bordi**: due run di cui una fallita e una in corso, nessuna run entro la soglia, ambiente di produzione senza server, sha corto o in maiuscolo, doppio clic su «Fai sistemare a Claude» (una sola task). → test in Task 4 e Task 5.
4. **Il cliente vede solo il suo**: anteprima del cliente senza commenti interni, persone, stime né bozze; nessuna risposta senza clic di `support.reply`; nessun messaggio in `state.mailMessages` dopo una risposta o «Scrivigli anche per email» non inviato; cliente che se ne va → «non conclusa», nessuna richiesta. → test in Task 6.
5. **Contenuti estremi**: log da 5000 righe, PR con titolo lunghissimo e 40 problemi, conversazione di Support da 200 messaggi, Preferenze con 50 progetti. → test in Task 7, 8 e 9.

---

### Task 0 (controller): shape di Impeccable

Brief `shape`, approvati dal maintainer, in `apps/desktop/.impeccable/shape/`: `alerts.md` (Preferenze con la cornice e la sola sezione Notifiche: progetti fissati prima, una riga per tipo con App/Telefono, stati accesa/spenta/sospesa/obbligatoria, azioni in blocco; popover «Avvisi» nella testata del progetto; «Non avvisarmi più di questo in <progetto>» con Annulla nel pannello), `releases.md` (forma della sezione: una lista di PR aperte a due gruppi, «Pronte per il rilascio» con conferma a due tempi ed errori e «Non ancora pronte», poi Rilasci, Ambienti; dettaglio di un rilascio con run, passo fallito, log lungo con «vedi tutto», «Chiedi a Claude di spiegarlo», «Fai sistemare a Claude», «Simula …»; impostazioni del repository; blocco Home «Rilasci»), `support.md` (elenco conversazioni con stati, dettaglio con conversazione, richiesta nata, compositore con «Bozza di Claude», «Anteprima del cliente», «Scrivigli anche per email», «Apri la richiesta» su una non conclusa; Widget per `widget.manage`; blocco Home «Clienti in attesa»). Nessun codice.

### Task 1: Bug «Salvato» del compositore della Posta

**Files:** Modify `pages/mail/useComposerDraft.ts:95-109` (`saveNow`), `:124-132` (`setFields`); Test `pages/mail/Compose.test.tsx` (nuovo `describe("«Salvato» solo a bozza salvata (area 8)")`).

- [ ] Tests (scrivili prima, devono fallire): «modifica dopo un salvataggio: niente «Salvato» finché il nuovo salvataggio non finisce» (scrivi → aspetta `DRAFT_SAVE_MS` → «Salvato» → scrivi ancora → `queryByText(saved)` null fino al nuovo salvataggio); «modifica durante un salvataggio: niente «Salvato» al suo termine» (con `setLatency` > 0 si scrive mentre `mail.saveDraft` è in volo → al termine nessun «Salvato», e il salvataggio successivo lo rimette).
- [ ] `setFields` porta `status` a `"idle"` (nessuna etichetta: scelta del costruttore registrata qui); `saveNow` mette `"saved"` solo se `dirty.current` è ancora falso a fine mutazione, altrimenti `"idle"` (il timer già programmato salva).
- [ ] Commit `fix(desktop): «Salvato» nel compositore solo a bozza salvata`.

### Task 2: Modello, permessi e seme

**Files:** Modify `data/model.ts` (`AppNotification` :42-68, `Repository` :878-884, `ProjectRequest` :332-370, `Task` :155-163, `HomeBlockKind` :424-435), `data/types.ts:51-58` (`LocalProjectPermission`), `data/viewer.ts:66-79` (`LOCAL_PROJECT_PERMISSIONS`), `data/seed/projects.ts:91-104` (membri in più), `data/seed/docs/repositories.ts`, `data/store.ts` (State :507-620, `freshState`, `ApiFnName`); Create `data/seed/releases/{prs.ts,releases.ts,environments.ts}`, `data/seed/support/{conversations.ts,widgets.ts}`, `data/seed/alerts.ts`; Test `data/seed.test.ts`, `data/viewer.test.ts`.

**Interfaces — Produces (`model.ts`):**
```ts
export interface AppNotification { /* …come oggi */ recipientIds: string[] /* solo per i kind FUORI dal catalogo */;
  /** Kind del catalogo: chi lo riceve senza iscrizione, col perché (chiave i18n). */ mandatory?: { personId: string; reason: MandatoryReason }[] }
export type MandatoryReason = "merged" | "pr_author" | "follows_conversation" | "task_author";
export type ColleaguePrMode = "analyze_and_fix" | "analyze_only" | "off";
export interface Repository { /* …come oggi */ fullName?: string /* owner/repo */; colleaguePrs?: ColleaguePrMode; releaseBranch?: string; releasePipeline?: { mode: "auto" } | { mode: "named"; names: string[] }; ciProvider?: "github_actions" | "bitbucket_pipelines" | null }
export interface PrAnalysis { sha: string; status: "running" | "done"; summary: string; risk: "low" | "medium" | "high"; issues: { title: string; file: string | null }[]; at: string }
export interface PrAutoCorrection { id: string; trigger: "auto" | "person"; byId: string | null; fromSha: string; state: "running" | "pushed" | "discarded" | "stopped"; commitSha: string | null; why: string; at: string }
export interface OpenPullRequest extends PrRef { id: string; projectId: string; repositoryId: string; title: string; authorId: string | null; authorName: string; origin: "stubwise" | "colleague"; taskId: string | null; branch: string; baseBranch: string; headSha: string; fromFork: boolean; branchProtected: boolean; analysisOnly: { byId: string; at: string } | null; analysis: PrAnalysis | null; corrections: PrAutoCorrection[] /* solo colleghi: per quelle di Stubwise valgono le sessioni della task */; checks: "passing" | "failing" | "pending" | "unreadable"; mergeable: boolean; state: "open" | "merged" | "closed"; openedAt: string }
export interface CiRun { id: string; name: string; status: "running" | "success" | "failed"; url: string; failedStep: string | null; log: string | null; startedAt: string; endedAt: string | null }
export interface Release { id: string; code: string /* AUD-V3 */; projectId: string; repositoryId: string; pr: PrRef; title: string; mergeSha: string; mergedAt: string; mergedById: string | null; mergedGitName: string; viaStubwise: boolean; runs: CiRun[]; seenInProductionAt: string | null; fixTaskId: string | null }
export interface ProjectEnvironment { id: string; projectId: string; name: string; kind: "test" | "staging" | "production"; url: string | null; serverCode: string | null /* SRV-<n> */; reportedSha: string | null; reportedAt: string | null }
export interface AlertSubscription { personId: string; projectId: string; type: string; history: { at: string; app: boolean; phone: boolean }[] /* l'ultima è lo stato di adesso */ }
export interface SupportMessage { id: string; from: "customer" | "triage" | "team"; authorId: string | null; body: string; at: string }
export interface SupportConversation { id: string; code: string /* ACQ-S1 */; projectId: string; channel: "widget" | "mcp"; widgetId: string | null; customer: { name: string; email: string | null }; messages: SupportMessage[]; rewrittenWish: string | null; requestId: string | null; leftAt: string | null; followerIds: string[]; claudeDraft: string | null }
export interface SupportWidget { id: string; projectId: string; name: string; origins: string[]; greeting: string; createdAt: string }
// ProjectRequest: + origin?: { kind: "support"; conversationId: string }  (mai da un'email)
// Task: + releaseRef?: { releaseId: string }   HomeBlockKind: + "releases" | "waitingCustomers"
```
- `types.ts`: `LocalProjectPermission` + `"support.reply"`; `viewer.ts`: in `project_lead`, `developer`, `legacy_member`. Store: `openPrs`, `releases`, `environments`, `alertSubscriptions`, `notificationMarks: Map<chatKey(persona, notifica), { read?; archived?; snoozedUntil? }>`, `supportConversations`, `supportWidgets`, `releaseCodeSeq`, `supportCodeSeq`.
- Seme (spec «Dati finti»): AUD — PR di Stubwise pronta (task collegata, checks verdi), rilascio **riuscito** con GitHub Actions (2 run), rilascio **fallito** mergiato da Laura (passo, log di ~5000 righe, avviso `release.failed`), PR di **Marco** fuori da Stubwise con problemi e una correzione `pushed`, PR da **fork** analizzata, PR del collega con `correctionCap` (3) correzioni già fatte (tetto raggiunto); un repository AUD in più (`audin/audin-admin`, «Solo analisi») e uno «Spento» (`audin/audin-scripts`). STW — `ciProvider: null`, un rilascio «non ancora in produzione» e uno «in produzione»; ambienti di STW e AUD (produzione con `serverCode`, staging senza). ACQ — ambiente di produzione con `SRV-1`; `support`: conversazione del widget in triage, una con richiesta aperta che aspetta noi (con `claudeDraft`), una non conclusa, una nata dal server MCP con la conversazione allegata alla richiesta; un widget. Membri in più (spec G): ACQ += `p-sara` (Contributor, senza `support.reply`) e `p-matteo` (Project Lead, per gli avvisi), via una tabella `EXTRA_MEMBERS` accanto a `REFERENCE_MEMBERS` (non sostituisce i membri calcolati). Iscrizioni: nessuna riga = default del catalogo (Task 3); il seme ne scrive solo di diverse dal default (Matteo con «Nuova PR» accesa su AUD; Giulia con «Rilascio fallito» spenta su AUD dopo l'avviso del seme).
- I kind nuovi sono locali (`LOCAL_NOTIFICATION_KINDS` in `data/seed/notifications.ts:30`): `pr.opened`, `pr.analysis_issues`, `pr.corrected`, `release.merged`, `release.succeeded`, `release.failed`, `docs.release_note`, `task.created`, `support.request`, `support.customer_replied`; ognuno compare almeno una volta nel seme (lo pretende `seed.test.ts:471-473`).
- [ ] Tests (seme): ogni caso sopra; codici unici nel formato; preset di `support.reply` (Laura, Marco, Legacy Member sì; Sara, Viewer no); Sara e Matteo membri di ACQ senza perdere i membri di prima; i test delle aree 2–7 restano verdi (suite intera).
- [ ] Commit `feat(desktop): modello e seme dell'area 8a`.

### Task 3: Avvisi — catalogo, iscrizioni, destinatari a lettura

**Files:** Create `domain/alerts/{catalog.ts,recipients.ts}` (+test), `data/alerts/{visibility.ts,reads.ts,writes.ts,publish.ts,index.ts}` (+`data/alerts/alerts.test.ts`); Modify `data/api.ts:478-500` (`listNotifications`, `markNotification`), `data/api.ts:112` (`export * as alerts`), `data/queries.ts`, `data/store.ts` (`ApiFnName`).

**Interfaces — Produces:**
- `catalog.ts`: `interface AlertType { type: string; group: "prs" | "releases" | "docs" | "tasks" | "support" | "monitor" | "claude"; labelKey: string; subscribe: { perm: Permission | "member" }; defaultOn: (perms: (p: Permission) => boolean) => boolean; defaultPhone: boolean; mandatory: MandatoryReason[] }`; `const ALERT_TYPES: AlertType[]` con le righe della tabella dello spec (8a) più i kind esistenti `job.pr_opened`, `review.completed`, `job.failed`, `project.brief`, `docs.nightly_attention`, `monitor.alert`/`monitor.recovered` (e gli altri `monitor.*` del seme), `ticket.created`, `request.created` con default = regola di oggi (membri); **`registerAlertTypes(rows: AlertType[])`** è il punto d'estensione per 8b (server in difficoltà, diagnosi pronta); `security.alert` e `DECISION_NOTIFICATION_KINDS` fuori dal catalogo; `isCatalogKind(kind): boolean`.
- `recipients.ts` (puro): `subscriptionAt(sub: AlertSubscription | undefined, def: AlertType, perms, at: string): { app: boolean; phone: boolean }`; `recipientsOf(n: AppNotification, ctx: { members: string[]; subs: AlertSubscription[]; permsOf(personId): (p: Permission) => boolean; seesProject(personId): boolean }): { personId: string; why: "subscribed" | MandatoryReason }[]` — obbligatori sempre (se vedono il progetto), iscritti secondo lo stato **al momento dell'avviso**, tutti filtrati da permesso e visibilità **di adesso**.
- `subscriptionRows(personId)` → per progetto visibile (fissati prima), per tipo: `{ type, app, phone, state: "on" | "off" | "suspended" | "mandatory", suspendedReason? }`.
- Writes: `setSubscription(projectId, type, { app?, phone? })` (solo chi può iscriversi; sospesa non modificabile), `copySubscriptions(fromProjectId, toProjectId)`, `muteProject(projectId)`, `muteFromNotification(notificationId)` → `{ undo(): Promise<void> }` (non per gli obbligatori: `forbidden`).
- `publish.ts`: `publishAlert(input: { kind; projectId; objectCode; title; body; link; mandatory? }): void` — l'unico modo in cui `data/releases` e `data/support` creano un avviso; `recipientIds: []`.
- `listNotifications` usa `recipientsOf` per i kind del catalogo e `recipientIds` per gli altri; `read/archived/snoozedUntil` per persona da `notificationMarks` (fallback ai flag della riga del seme).
- [ ] Tests: Review Focus 1 (ognuno dei sei casi, asserendo su `listNotifications` della persona); default per preset (Laura riceve «Rilascio fallito» di AUD senza righe, Matteo no; Marco riceve «Analisi con problemi» della sua PR come obbligatorio); `muteFromNotification` lascia l'avviso cliccato e spegne i futuri, «Annulla» ripristina; i kind fuori catalogo (`security.alert`, chat, automazioni) invariati; read di Laura non segna letto per Marco; `registerAlertTypes` aggiunge una riga che compare in `subscriptionRows`; R-G5; `resetApi` ripulisce.
- [ ] Commit `feat(desktop): iscrizioni agli avvisi con destinatari a lettura`.

### Task 4: Rilasci e PR — regole pure

**Files:** Create `domain/releases/{releaseStatus.ts,prState.ts,customerStatus.ts}` (+test).

**Interfaces — Produces:**
- `releaseStatus(r: Release, ctx: { now: string; production: ProjectEnvironment | null; pipeline: Repository["releasePipeline"] }): { kind: "running" | "succeeded" | "failed" | "not_in_production" | "in_production" | "unavailable"; since: string | null; reason?: "no_production_env" | "no_server" }` — run filtrate per nome se `mode: "named"`; `sameCommit` copiato nella forma di `release.ts:79` (prefisso ≥ 7).
- `prState(input: PrStateInput): { state: "analyzing" | "clean" | "issues" | "correcting" | "corrected" | "discarded" | "capped" | "analysis_only" | "analysis_off" | "not_fixable"; notFixable?: "fork" | "protected" | "default_branch" | "target_branch" | "other_task_branch"; autoRound: number; canAutoCorrect: boolean }` con `PrStateInput = { origin; analysis; corrections: { trigger; state }[]; cap: number /* correctionCap del progetto */; repoMode: ColleaguePrMode; prAnalysisOnly: boolean; branch; baseBranch; defaultBranch; fromFork; branchProtected; ownTaskCode: string | null }` — **un motore solo**: le PR di Stubwise ci arrivano con le correzioni lette dalle sessioni della task (`correctionsOf`, `domain/claude/taskWork.ts:356`), quelle dei colleghi da `OpenPullRequest.corrections`. il tetto è `cap` (nessuna costante a parte); `capped` quando le correzioni non scartate sono ≥ `cap`; i `discarded` non contano; `repoMode` vale solo per `origin: "colleague"`.
- `customerStatus(req: ProjectRequest | null, tasks: Task[], releases: ReleaseStatusKind[]): "received" | "evaluating" | "planned" | "in_progress" | "released" | "not_proceeding"`.
- [ ] Tests: Review Focus 2 sulla parte pura (ogni ramo vietato; con `cap` 3, la quarta automatica non parte (`capped`) anche dopo un `fromSha` nuovo, e con `cap` 2 si ferma alla terza (il numero viene dal progetto, non da una costante); scartata non conta; «Spento» + PR «Solo analisi» = `analysis_off`); Review Focus 3 sulla parte pura (una fallita + una in corso → `failed`; nessuna run e `now − mergedAt` < 30 min → `running`, oltre → senza pipeline; sha di 6 caratteri non combacia, maiuscole sì; ambiente senza server → `unavailable`/`no_server`); `customerStatus` per ogni stato.
- [ ] Commit `feat(desktop): regole pure di rilasci e PR`.

### Task 5: Rilasci e PR — livello dati

**Files:** Create `data/releases/{visibility.ts,reads.ts,writes.ts,simulate.ts,index.ts}` (+`data/releases/releases.test.ts`); Modify `data/api.ts`, `data/queries.ts`, `data/store.ts`, `data/api-mutations.ts:240` (`createTask` riusato da «Fai sistemare»), `:1575` (`createConversation` accetta `context?: { kind: "release"; releaseId: string }`).

**Interfaces — Produces:**
- Visibilità: PR, rilasci e ambienti li vedono i membri del progetto; `log` di una run solo con `repos.view` (altrimenti `null` e `logHidden: true`).
- Reads: `listOpenPrs(projectId)` (stessa forma per tutte: `OpenPullRequest & { prState; taskCode: string | null }`), `listReleaseQueue(projectId)` (pronte: checks verdi, mergeable, aperte; `canMerge`), `listReleases(projectId)`, `getRelease(code)` (con `status`, run, `fixTask`), `listEnvironments(projectId)`, `listMyReleases()` (blocco Home: pronte dove ho `release.merge` + falliti che mi riguardano), `getRepositorySettings(projectId)`, `searchReleases(q)` (⌘K per codice).
- Writes: `mergePr(prId)` → `{ ok: true; release } | { ok: false; error: "forbidden" | "not_found" | "already_closed" | "checks_failed" | "checks_unreadable" | "not_mergeable" | "merge_forbidden" }` (nuovo `Release` `<PRJ>-V<n>`, `publishAlert("release.merged")`); `setRepoPrMode(repositoryId, mode)` (`repos.manage`), `setReleasePipeline(repositoryId, pipeline, branch)` (`repos.manage`), `setPrAnalysisOnly(prId, on)` (autore persona o `prs.adopt`; mai accende su repo «Spento»), `requestPrCorrection(prId, text)` (`prs.adopt` sulle PR altrui; al tetto `correctionCap` → `{ error: "needs_maintainer" }` senza `plans.approve`, con `plans.approve` scavalca), `fixRelease(code)` → `Task` (`tickets.create`; task `bug`, `releaseRef`, collegamento `relates` alla task della PR, errore della run nella descrizione; se c'è già una task aperta la restituisce; con `runs.start` parte Claude col percorso normale `startRun`), `explainRelease(code)` → `Conversation` libera con il rilascio come contesto (privacy area 3); ambienti `createEnvironment`/`updateEnvironment`/`deleteEnvironment` (`environments.manage`).
- `simulate.ts` (solo prototipo): `simulateRunOutcome(code, runId, "success" | "failed")`, `simulateSeenOnServer(code)` (scrive `reportedSha` dell'ambiente di produzione), `simulateAuthorPush(prId)` (nuova testa: correzione in volo `discarded`, analisi `running` sulla nuova testa), `advancePrWork(prId)` (passo dell'analisi/correzione automatica: analisi → se `canAutoCorrect` correzione `running` → **ricontrolla modo e testa al momento del push** → `pushed` + `publishAlert("pr.corrected", mandatory pr_author)` o `stopped`/`discarded`). Gli avvisi `release.failed` (mandatory: chi ha fatto il merge; fuori da Stubwise: la persona collegata a `mergedGitName` via `state.commitAuthorLinks`, altrimenti l'autore della task della PR), `release.succeeded`, `pr.opened`, `pr.analysis_issues` (mandatory: autore) passano da `publishAlert`.
- [ ] Tests: Review Focus 2 e 3 sul livello dati (asserendo su `state.openPrs[*].corrections` e sul numero di task create); al tetto Marco (Developer) riceve `needs_maintainer` e nessuna correzione nasce, Laura (`plans.approve`) la fa partire; ogni errore di `mergePr`; Developer (Marco) senza `release.merge` → `forbidden` e nessun `Release`; «Fai sistemare» con solo `tickets.create` crea la task senza sessione, con `runs.start` passa dal gate per chi non ha `plans.approve`; log nascosto senza `repos.view`; **anti-obiettivo 1**: l'insieme delle funzioni esportate da `api.releases` è esattamente quello elencato sopra (nessun `deploy`/`rerun`/`retryPipeline`); R-G5 su `getRelease` e su un codice di un progetto invisibile; `failNext`, `storeGeneration` (un `advancePrWork` dopo `resetApi` non scrive); `resetApi` ripulisce.
- [ ] Commit `feat(desktop): dati di rilasci, PR e ambienti`.

### Task 6: Support — livello dati

**Files:** Create `domain/support/state.ts` (+test), `data/support/{visibility.ts,reads.ts,writes.ts,simulate.ts,index.ts}` (+`data/support/support.test.ts`); Modify `data/api.ts`, `data/queries.ts`, `data/store.ts`, `data/api-mutations.ts:639` (`createRequest` accetta `origin: { kind: "support" }`).

**Interfaces — Produces:**
- `supportState(c: SupportConversation): "triage" | "request_open" | "waiting_us" | "reply_sent" | "not_concluded"` (puro).
- Visibilità: membri del progetto vedono conversazioni e richiesta; `claudeDraft` e compositore solo con `support.reply`; widget con `widget.manage`.
- Reads: `listSupportConversations(projectId, { state? })`, `getSupportConversation(code)`, `customerPreview(code)` → `{ status: CustomerStatus; messages: { from: "customer" | "us"; body; at }[] }` (mai autori, commenti interni, stime, bozze), `listWaitingCustomers()` (blocco Home: `waiting_us` dove ho `support.reply`), `listWidgets(projectId)`, `myRequestStatus(requestId)` (forma di `my_requests`), `searchSupport(q)`.
- Writes: `replyToCustomer(code, body)` (`support.reply`; aggiunge un `team` message, `publishAlert` nessuno; **nessuna email**), `draftReply(code)` (rigenera la bozza di Claude, testo deterministico), `openRequestFrom(code, { title, description })` (su una «non conclusa»: `backlog.create`, `origin: support`), `followConversation(code, on)`, `emailDraftFor(code)` → `{ threadId: string | null; draft }` (bozza nel compositore dell'area 6 se c'è `customer.email`; non invia), widget `createWidget`/`updateWidget`/`deleteWidget` (`widget.manage`); `simulate.ts`: `simulateCustomerMessage(code, body)` (`publishAlert("support.customer_replied", mandatory follows_conversation)`), `simulateCustomerLeaves(code)`, `simulateTriageDone(code)` (desiderio riscritto confermato → richiesta con la conversazione allegata, `publishAlert("support.request")`).
- [ ] Tests: Review Focus 4 (anteprima: nessun `team.authorId`, nessuna bozza né commento; Sara → `replyToCustomer` `forbidden` e nessun messaggio; dopo risposta ed `emailDraftFor` `state.mailMessages` invariato; `simulateCustomerLeaves` in triage → `not_concluded` e nessuna `ProjectRequest`); `customerStatus` segue richiesta → task → rilascio riuscito; la richiesta dal server MCP ha la conversazione;  nessuna funzione esportata da `api.support` crea una richiesta da un'email (l'insieme esportato è esattamente quello elencato sopra); R-G5; `failNext`; `resetApi`.
- [ ] Commit `feat(desktop): dati di Support`.

### Task 7: Avvisi — UI (Preferenze, popover, pannello)

**Files:** Create `pages/preferences/{PreferencesPage.tsx,NotificationsSection.tsx,SubscriptionRow.tsx}` (+test), `layout/ProjectAlerts.tsx` (+test); Modify `router.tsx:312` (`preferences` → `PreferencesPage`, route `/preferences/notifications`, `/preferences` vi rimanda), `layout/ProjectColumn.tsx:46` (controllo «Avvisi» nella testata), `notifications/NotificationItem.tsx` («Non avvisarmi più…» / «Ricevi questo perché…»), i18n.

Da shape `alerts.md`.
- [ ] Tests: Review Focus 5 (50 progetti: fissati prima, nessuna riga persa, navigazione da tastiera fra i gruppi); stati sospesa (perde `repos.view` → riga «sospesa: non vedi più …», non modificabile) e obbligatoria; «come questo progetto» e «spegni tutto»; popover dal progetto coerente con la pagina; «Non avvisarmi più» con Annulla, assente sugli obbligatori; etichetta «sul prototipo non parte nulla» accanto a Telefono; cambio di persona con la pagina aperta; caricamento/errore.
- [ ] Commit `feat(desktop): preferenze degli avvisi`.

### Task 8: Releases — UI

**Files:** Create `pages/releases/{ReleasesPage.tsx,PrList.tsx /* una lista, due gruppi: «Pronte per il rilascio» (la coda, con «Rilascia») e «Non ancora pronte» */,PrRow.tsx,ReleaseList.tsx,ReleaseDetail.tsx,RunLog.tsx,Environments.tsx}` (+test), `pages/settings/RepositorySettings.tsx` (+test), `pages/home/blocks/ReleasesBlock.tsx`; Modify `router.tsx:526-537` (sezione `releases` e figlia `/p/$code/releases/$release`), `pages/settings/ProjectSettingsPage.tsx:24` (sezione repository prima di «Altro»), `pages/home/blocks/registry.ts:48-92` (`releases`, disponibile con `release.merge` in almeno un progetto), `palette/CommandPalette.tsx` (rilasci per codice), i18n; **rinomina della scheda «Releases» dei Docs in «Note di rilascio» / «Release notes»** (decisione del maintainer, 28 ott 2026, `releases.md` [R 25]): `pages/docs/DocReleases.tsx` (titolo, ricerca) e le chiavi `docs.space.releases`/`docs.releases.title`/`docs.releases.search` in `i18n/locales/en.json` e `it.json` (≈ righe 3096, 3226 e 3228) e il rimando in `pages/docs/DocSpace.tsx:490`, con `pages/docs/DocsTools.test.tsx:152-153` (heading e `list` chiamati «Releases»).

Da shape `releases.md`.
- [ ] Tests: Review Focus 5 (log da 5000 righe: si apre troncato, «vedi tutto» non blocca; titolo lunghissimo e 40 problemi leggibili); PR del collega con solo «di <nome>» e nessun «Adotta»; conferma a due tempi e ogni errore della coda in parole; Marco non vede «Rilascia»; «stato non disponibile» col link agli ambienti solo per `environments.manage`; «Fai sistemare» due volte apre la stessa task; ogni «Simula …» marcato prototipo; **nessun elemento con testo o nome accessibile «Deploy» o «Riprova la pipeline»** in tutta la sezione; R-G5 su `/p/AUD/releases/AUD-V99`.
- [ ] Commit `feat(desktop): sezione Releases`.

### Task 9: Support — UI

**Files:** Create `pages/support/{SupportPage.tsx,ConversationList.tsx,ConversationDetail.tsx,ReplyComposer.tsx,CustomerPreview.tsx,Widgets.tsx}` (+test), `pages/home/blocks/WaitingCustomersBlock.tsx`; Modify `router.tsx:526-537` (sezione `support` e figlia `/p/$code/support/$conversation`), `registry.ts` (`waitingCustomers`, con `support.reply`), `palette/CommandPalette.tsx` (conversazioni per codice), i18n.

Da shape `support.md`.
- [ ] Tests: Review Focus 5 (200 messaggi); Sara vede la conversazione ma nessun compositore né bozza; la bozza di Claude si rilegge e non parte senza «Invia»; «Anteprima del cliente» mostra solo lo stato in parole e i messaggi; «Scrivigli anche per email» apre il compositore dell'area 6 con la bozza e senza indirizzo è assente con il perché; «Apri la richiesta» su una non conclusa; widget per `widget.manage`; cambio di persona con un dettaglio aperto; vuoto/errore/caricamento.
- [ ] Commit `feat(desktop): sezione Support`.

### Task 10: Documenti, screenshot, follow-up

`apps/desktop/docs/area8-parity.md` (forma di `area6-parity.md`) per la parte 8a: coda di rilascio con tutti gli esiti, ambienti, widget, conversazioni del widget; fra i «non portati di proposito» l'adozione delle PR e il DM Slack; ogni voce 8a dello spec con dove vive e il test che la copre (nome fra virgolette); le righe dei server restano «area 8b». `capture.mjs`: scatti `a8-*` (Preferenze → Notifiche, popover Avvisi, Releases, rilascio fallito con log, coda con conferma, Support con bozza, anteprima del cliente) light/dark, en/it a 1440 e uno a 1024; vite ucciso. «Area 8a — minori aperti» in `ossatura-follow-ups.md` (esclusi di proposito da 8a: la notifica di sistema di Electron — solo il pannello — e la nuova etichetta di `prs.adopt`, che il desktop non mostra; poi invarianti del CLAUDE.md da riscrivere prima del motore — spec «Invarianti … cambia DELIBERATAMENTE» §3–5). Suite, typecheck, lint, build verdi. Commit `docs(desktop): note dell'area 8a`.

Dopo il Task 10: revisione finale del branch (area 8a) e revisione visiva di Impeccable; poi il piano 8b.
