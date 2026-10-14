# Sessioni di refinement del backlog — Piano A: shared, DB, worker, server

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** su una voce di backlog si avvia una sessione dell'agente `backlog_refine`, continua nel tempo, in cui chiunque possa lavorare sul backlog conversa con Claude Code in streaming; l'agente legge tutte le repository del progetto in sola lettura e scrive design, piano e metadati della voce con tre tool.

**Architecture:** il server scrive solo gli input (come per ogni intervento) e apre/chiude la sessione; nel worker il relay, per le sessioni «a turni», non marca mai `undelivered` un input senza processo vivo: lo passa a uno `RefineScheduler` che avvia un turno (`runRefineTurn`) con quell'input come messaggio d'apertura, riprendendo la conversazione CLI con `--resume`. I tool di scrittura sono un server MCP stdio bundlato che parla con un ponte HTTP su loopback nel worker (segreto per turno); le regole di scrittura sono un modulo condiviso con le rotte del server.

**Tech Stack:** Node 22, TypeScript, execa, drizzle + postgres.js, Fastify + Zod, `@modelcontextprotocol/sdk`, Vitest + testcontainers.

**Spec:** `docs/plans/2026-10-14-backlog-refine-sessions-design.md`. Piano B (web e app): `docs/plans/2026-10-14-backlog-refine-sessions-b-ui.md`.

## Global Constraints

- CLI fissato a `2.1.287` (`ARG CLAUDE_CODE_VERSION`, `apps/worker/Dockerfile`): non si tocca.
- L'argv e il comportamento del runner per OGNI segmento esistente non cambiano: i test di `streaming-cli.test.ts` restano verdi senza modifiche.
- Le regole del relay cambiano SOLO per i kind in `TURN_BASED_SESSION_KINDS` (= `backlog_refine`); per ogni altro kind i test di `relay.test.ts` restano verdi senza modifiche.
- Scrivere in una sessione resta **solo admin** per ogni kind fuori da `MEMBER_WRITABLE_SESSION_KINDS` (= `backlog_refine`): controllo nel SERVIZIO (`sendAgentMessage`), test negativi a due ruoli che asseriscono sulle righe.
- I due divieti dell'operatore non si toccano: nessun file di questo piano modifica `resolvePlan`/`preApprovePlan`/`revokePlanApproval`, la riga del gate in `jobs.ts` o `releasePullRequest`.
- Migrazione **0087** a mano (SQL + voce `_journal.json`, `idx` 87, `when` = `1791936000000`, tag `0087_backlog_refine_sessions`), nessun `ALTER TYPE`, CHECK al posto dei pgEnum.
- Ogni campo di risposta nuovo letto dall'app nasce `.default()`/`.nullable()`, con un test che parsa una risposta SENZA quel campo.
- Rotte letterali registrate PRIMA di quelle parametriche sullo stesso prefisso.
- Testi automatici (messaggi di sistema, motivi) da **template i18n**, mai AI.
- Nomi dei canali `NOTIFY` definiti UNA volta in `@stubwise/shared`, mai letterali.
- Il turno di refinement: `permissionMode: "default"`, `allowedTools` CHIUSO = `["Read","Grep","Glob", ...GRAPHIFY_AGENT_ALLOWED_TOOLS, ...REFINE_TOOL_NAMES]`. Mai `Edit`, `Write`, `Bash`, `WebFetch`, `NotebookEdit`.
- Il server MCP dei tool non riceve MAI `DATABASE_URL`, `ENCRYPTION_KEY`, `SESSION_SECRET` né credenziali: solo `REFINE_BRIDGE_URL` e `REFINE_BRIDGE_SECRET`.
- Il worker è UN processo: registro dei worktree, scheduler e relay sono in memoria e lo presuppongono.
- Env nuove del worker (in `config.ts`, nel blocco `worker` di `docker-compose.yml` e in `.env.example`): `BACKLOG_REFINE_MAX_CONCURRENT` (default 2, min 1), `BACKLOG_REFINE_IDLE_MINUTES` (default 30, min 1), `BACKLOG_REFINE_TURN_TIMEOUT_MS` (default 900000).
- Percorso della cartella dei worktree di una sessione: `join(tmpdir(), "stubwise-refine", <agentSessionId>)`, deterministico (il CLI indicizza le sessioni per cwd: `--resume` dopo un riavvio funziona solo se la cwd è la stessa).

## Review Focus

1. **Messaggio scritto mentre il turno finisce**: l'input arriva nei ~2 s di grazia dopo il `result`. Atteso: non diventa mai `undelivered`; diventa il turno successivo, che parte appena il processo esce. Test in Task 5 (relay) e Task 10 (scheduler).
2. **Due messaggi in fila a sessione ferma**: due input `pending` arrivano insieme. Atteso: UN turno parte col più vecchio, il secondo entra come intervento quando il processo si registra (o, se il turno è già finito, diventa il turno dopo). Mai due processi sulla stessa sessione. Test in Task 10.
3. **«Chiudi» a metà turno**: Atteso: il processo si chiude entro pochi secondi, nessuna scrittura successiva del ponte è accettata (segreto revocato), gli input `pending` diventano `undelivered`. Test in Task 4 (signal) e Task 10.
4. **Un member su una sessione `ai_job`**: Atteso: 403 e nessuna riga in `agent_session_inputs`; sulla `backlog_refine` dello stesso progetto la riga nasce. Test in Task 12.
5. **Riavvio del worker fra due turni**: Atteso: il turno dopo riapre i worktree nello STESSO percorso e prova `--resume`; se il CLI lo rifiuta, riparte col prompt d'avvio e riscrive `cli_session_id`. Test in Task 9.
6. **Voce convertita in ticket con una sessione aperta**: Atteso: sessione `closed` (`item_closed`), turno in corso annullato, scritture del ponte rifiutate, e un messaggio successivo riceve 409. Test in Task 6 (ponte), Task 11 (server).

---

## File structure

| File | Responsabilità |
|---|---|
| `packages/shared/src/schemas/agent-session.ts` | kind `backlog_refine`, segmento `refine`, stato `idle`, motivi `turn_failed`/`budget_exceeded`, `TURN_BASED_SESSION_KINDS`, `MEMBER_WRITABLE_SESSION_KINDS`, `canClose`, `BACKLOG_REFINE_CLOSED_CHANNEL` |
| `packages/shared/src/schemas/backlog-refine.ts` | schemi delle rotte di avvio/chiusura, `refineSessionViewSchema`, schemi dei tre tool (`refineSetDocInputSchema`, `refineUpdateItemInputSchema`) |
| `packages/db/drizzle/0087_backlog_refine_sessions.sql` + `schema.ts` | tabelle `backlog_refine_sessions`, `backlog_item_revisions`; CHECK dei kind allargato |
| `packages/notifications/src/backlog-item-writes.ts` | regole UNICHE di scrittura di design, piano e metadati di una voce, con revisione facoltativa |
| `apps/worker/src/agent/runner.ts`, `streaming-cli.ts` | opzioni `openingInput` e `signal`; deliverable `conversation` |
| `apps/worker/src/sessions/relay.ts` | regole dei kind a turni; `TurnStarter` |
| `apps/worker/src/refine-mcp/{server,index}.ts` | server MCP stdio dei tre tool |
| `apps/worker/src/backlog/refine/bridge.ts` | ponte HTTP su loopback: segreti per turno, validazione, scrittura |
| `apps/worker/src/backlog/refine/worktrees.ts` | registro in memoria dei worktree multi-repo per sessione |
| `apps/worker/src/git/mirrors.ts` | `openProjectWorktrees` (apertura lunga di N worktree) |
| `apps/worker/src/backlog/refine/prompts.ts` | prompt d'avvio e mandato |
| `apps/worker/src/backlog/refine/turn.ts` | `runRefineTurn` |
| `apps/worker/src/backlog/refine/scheduler.ts` | `RefineScheduler`: avvio dei turni, tetto, chiusura, sweep d'inattività |
| `apps/worker/src/sessions/owners.ts` | `backlogRefineSession` |
| `apps/worker/src/index.ts`, `config.ts` | cablaggio ed env |
| `apps/worker/plugins/stubwise-base/…` | una riga del contratto |
| `apps/server/src/services/backlog-refine.ts` | avvio, chiusura, riapertura, chiusura per voce chiusa, vista |
| `apps/server/src/routes/backlog.ts` | `POST`/`DELETE /api/backlog/:id/refine-session`, `refineSession` nel dettaglio della voce |
| `apps/server/src/services/agent-sessions.ts`, `routes/agent-sessions.ts` | permesso per kind, stato `idle`/`queued`, `canWrite`/`canClose` |
| `packages/api-client/src/…` | gruppo `backlogRefine` |
| `apps/worker/scripts/golden/` | scenario `refine` |

## Interfacce condivise fra i task (CONTRATTO — i nomi sono questi, in ogni task)

```ts
// packages/shared/src/schemas/agent-session.ts (Task 1)
agentSessionKindSchema        // + "backlog_refine"
agentSegmentLabelSchema       // + "refine"; INTERACTIVE_SEGMENTS.has("refine") === true
agentSessionStateSchema       // + "idle"
agentInputReasonSchema        // + "turn_failed", "budget_exceeded"
export const TURN_BASED_SESSION_KINDS: ReadonlySet<AgentSessionKind>;      // { "backlog_refine" }
export const MEMBER_WRITABLE_SESSION_KINDS: ReadonlySet<AgentSessionKind>; // { "backlog_refine" }
export const BACKLOG_REFINE_CLOSED_CHANNEL = "backlog_refine_closed";     // payload JSON { agentSessionId }
agentSessionDetailSchema      // + canClose: z.boolean().default(false)

// packages/shared/src/schemas/backlog-refine.ts (Task 1)
export const refineSessionStatusSchema = z.enum(["active", "closed"]);
export const refineCloseReasonSchema = z.enum(["user", "idle", "item_closed"]);
export const refineSessionViewSchema = z.object({
  agentSessionId: z.string().uuid(),
  status: refineSessionStatusSchema,
  closedReason: refineCloseReasonSchema.nullable().default(null),
  lastActivityAt: z.string().datetime(),
});
export const startRefineSessionInputSchema = z.object({ message: z.string().trim().min(1).max(20_000).optional() });
export const startRefineSessionResultSchema = z.object({ agentSessionId: z.string().uuid(), inputId: z.string().uuid().nullable() });
// backlogItemDetailSchema (dove sta oggi) + refineSession: refineSessionViewSchema.nullable().default(null)
export const REFINE_DOC_MAX_CHARS = 200_000;
export const refineSetDocInputSchema = z.object({ markdown: z.string().min(1).max(REFINE_DOC_MAX_CHARS) });
export const refineUpdateItemInputSchema = z.object({ title, effort, risk, riskNote, urgency } /* tutti opzionali, gli stessi validatori di PATCH /api/backlog/:id */)
  .refine((v) => Object.keys(v).length > 0);
export const REFINE_TOOL_NAMES = ["mcp__stubwise_refine__set_design", "mcp__stubwise_refine__set_plan", "mcp__stubwise_refine__update_item"] as const;

// packages/db (Task 2)
backlogRefineSessions: { id, itemId (unique), agentSessionId (unique, FK agent_sessions cascade), status, cliSessionId, startedByUserId, lastActivityAt, closedAt, closedReason, createdAt }
backlogItemRevisions:  { id, itemId (FK cascade), field ("document"|"implementation_plan"|"metadata"), previous (jsonb), agentSessionId (FK set null), createdAt }

// packages/notifications/src/backlog-item-writes.ts (Task 3)
export type BacklogItemRevisionSource = { agentSessionId: string };
export async function setBacklogItemDesign(tx: DbOrTx, itemId: string, markdown: string, revision?: BacklogItemRevisionSource): Promise<"ok" | "not_found">;
export async function setBacklogItemPlan(tx: DbOrTx, itemId: string, markdown: string, revision?: BacklogItemRevisionSource): Promise<"ok" | "not_found">;
export async function updateBacklogItemMetadata(tx: DbOrTx, itemId: string, patch: BacklogItemMetadataPatch, revision?: BacklogItemRevisionSource): Promise<"ok" | "not_found">;

// apps/worker/src/agent/runner.ts (Task 4)
AgentRunOptions.openingInput?: { inputId: string; text: string; authorUserId: string | null };
AgentRunOptions.signal?: AbortSignal;  // abort → stdin chiuso, processo terminato, il run lancia AgentRunCancelledError
// streaming-cli.ts: SEGMENT_DELIVERABLE.refine = "conversation"

// apps/worker/src/sessions/relay.ts (Task 5)
export interface TurnStarter { requestTurn(sessionId: string): void }
SessionInputRelay deps + turnStarter?: TurnStarter;  // + kindOf cache interno

// apps/worker/src/backlog/refine/bridge.ts (Task 6)
export interface RefineTurnGrant { secret: string; revoke(): void }
export interface RefineBridge {
  readonly url: string;                                   // http://127.0.0.1:<porta>
  grant(turn: { agentSessionId: string; itemId: string }): RefineTurnGrant;
  revokeSession(agentSessionId: string): void;
  close(): Promise<void>;
}
export async function startRefineBridge(deps: { db: Db; log?: (m: string) => void }): Promise<RefineBridge>;
// apps/worker/src/refine-mcp/: buildRefineMcpConfig(bridge: RefineBridge, grant: RefineTurnGrant): { mcpConfig: AgentMcpConfig; tools: readonly string[] } | null  (null se il bundle non esiste)

// apps/worker/src/git/mirrors.ts + backlog/refine/worktrees.ts (Task 7)
MirrorManager.openProjectWorktrees(repos: MirrorProject[], branch: string, parentDir: string): Promise<{ dirs: { repositoryId: string; name: string; dir: string }[]; remove(): Promise<void> }>;
export interface RefineWorktreeEntry { agentSessionId: string; parentDir: string; repos: { repositoryId: string; name: string; dir: string }[]; remove(): Promise<void> }
export function createRefineWorktreeRegistry(): { get(id): RefineWorktreeEntry | undefined; set(e): void; remove(id): Promise<void>; ids(): string[]; closeAll(): Promise<void> };
export function refineParentDir(agentSessionId: string): string;

// apps/worker/src/backlog/refine/prompts.ts (Task 8)
export function buildRefinePrimingPrompt(ctx: RefinePromptContext, openingText: string): string;
export function buildRefineResumePrompt(openingText: string): string;   // = openingText
// RefinePromptContext: { language, item: { title, document, implementationPlan, originContent, effort, risk, riskNote, urgency }, repos: { name, dir }[], decisions: { text, createdAt }[], recentTranscript: { role: "user"|"agent", text }[] }

// apps/worker/src/backlog/refine/turn.ts (Task 9)
export interface RefineTurnDeps { db; runner: AgentRunner; mirrors: MirrorManager; serializer: ProjectSerializer; worktrees; bridge: RefineBridge; config: { turnTimeoutMs: number }; log }
export type RefineTurnOutcome = "completed" | "cancelled" | "failed" | "skipped";
export async function runRefineTurn(deps: RefineTurnDeps, input: { agentSessionId: string; inputId: string; signal: AbortSignal }): Promise<RefineTurnOutcome>;

// apps/worker/src/backlog/refine/scheduler.ts (Task 10)
export class RefineScheduler implements TurnStarter { requestTurn(id); closeSession(id); sweepIdle(now?: Date): Promise<void>; shutdown(): Promise<void> }

// apps/server/src/services/backlog-refine.ts (Task 11)
export async function startRefineSession(db, actor, itemId, message?): Promise<{ ok: true; agentSessionId; inputId: string | null } | { ok: false; error: "not_found" | "item_closed" }>;
export async function closeRefineSession(db, actor, itemId): Promise<{ ok: true } | { ok: false; error: "not_found" }>;
export async function closeRefineSessionForItem(tx, itemId): Promise<void>;   // chiamata da conversione/archiviazione
export async function reopenRefineSessionIfClosed(tx, agentSessionId): Promise<"active" | "item_closed" | "not_refine">;
export async function loadRefineSessionView(db, itemId): Promise<RefineSessionView | null>;

// packages/api-client (Task 13)
client.backlogRefine.start(itemId, { message? }) → StartRefineSessionResult
client.backlogRefine.close(itemId) → void
```

---

> **BOZZA (14 ott 2026).** Sopra: intestazione, vincoli, Review Focus, struttura
> dei file e contratto delle interfacce, già decisi. Sotto: l'elenco dei task
> con il perimetro di ciascuno e quello che la lettura del codice ha già
> trovato. Va trasformato in task completi (formato writing-plans: Files,
> Interfaces, passi TDD con codice e comandi, commit), da leggere SUL CODICE
> VERO prima di scriverli. Il Piano B (web e app) va scritto in un file a sé:
> `docs/plans/2026-10-14-backlog-refine-sessions-b-ui.md`.

## Task (da sviluppare)

### Task 1: Schemi condivisi
- `agent-session.ts`: kind `backlog_refine`; segmento `refine` in `agentSegmentLabelSchema` e `INTERACTIVE_SEGMENTS`; stato `idle`; motivi `turn_failed`/`budget_exceeded`; `TURN_BASED_SESSION_KINDS`, `MEMBER_WRITABLE_SESSION_KINDS`, `BACKLOG_REFINE_CLOSED_CHANNEL`; `canClose` `.default(false)`.
- ⚠️ Un test del worker pretende che le chiavi di `SEGMENT_DELIVERABLE` (`apps/worker/src/agent/streaming-cli.ts`) coincidano con `INTERACTIVE_SEGMENTS`: questo task aggiunge anche `refine: "conversation"` e allarga il tipo del valore; fino al Task 4 `"conversation"` si comporta come `"files"`.
- Cercare `Record<AgentSessionKind,…>`, mappe di etichette i18n e switch esaustivi su kind/segmento/stato/motivo in server, web, app e worker, e completarli qui, così `pnpm typecheck` resta verde.
- File nuovo `schemas/backlog-refine.ts` esportato dall'indice, senza cicli (`load-isolated.test.ts`); `refineSession` nel dettaglio della voce di backlog (trovare dove sta lo schema); `refineUpdateItemInputSchema` riusa i validatori del `PATCH /api/backlog/:id` (`apps/server/src/routes/backlog.ts` ~L148): se stanno nel server, spostare la parte condivisa in shared senza cambiare comportamento.
- Test: risposte SENZA i campi nuovi; changeset `@stubwise/shared` minor.

### Task 2: Migrazione 0087 e tabelle
- SQL + voce `_journal.json` + `schema.ts`: `backlog_refine_sessions`, `backlog_item_revisions` (CHECK su status, closed_reason, field), indici unici su `item_id` e `agent_session_id`, indice `(item_id, created_at)` sulle revisioni; `agent_sessions_kind_chk` riscritto (drop + add) con `backlog_refine`.
- Verificato: `active_segment_label` e `agent_session_inputs.reason` sono `text` SENZA CHECK; `agent_session_inputs.status` ha un CHECK (non si tocca). Modello di test: la 0086 e il suo test in `packages/db`.

### Task 3: Regole di scrittura condivise
- `packages/notifications/src/backlog-item-writes.ts`: estrarre PUT/DELETE design, PUT piano, PATCH metadati da `apps/server/src/routes/backlog.ts` (~L687-930; design: `origin_content` preservato UNA volta; DELETE design ripristina l'origine), con revisione facoltativa nella stessa transazione. Riscrivere le rotte sul modulo: i loro test esistenti non cambiano.

### Task 4: Runner — `openingInput`, `signal`, deliverable `conversation`
- `openingInput`: il prompt iniziale va su stdin con `uuid = inputId` (`userMessage(opts.prompt, uuid)`), registrato in `awaitingEcho` col SOLO testo dell'utente: l'evento `input` mostra quello, non il contesto d'avvio. Senza eco a fine segmento → `inputsNotEchoed`.
- `signal`: abort → stdin chiuso, processo terminato, il run rifiuta con `AgentRunCancelledError`; già abortito → rifiuta senza lanciare. Il runner oggi non ha nessun supporto di abort.
- `"conversation"`: un `result` riuscito NON chiude gli input (a differenza di `"output"`, `streaming-cli.ts` ~L545-555); grazia come `"files"`; `deliver()` NON accoda `DELIVERABLE_REMINDER` (~L487).
- I test esistenti di `streaming-cli.test.ts` restano invariati.

### Task 5: Relay — sessioni a turni
- `relay.ts`: `TurnStarter`, `deps.turnStarter` facoltativo, cache del kind per sessione. Solo per `TURN_BASED_SESSION_KINDS`: (1) nessun handle → input resta `pending` + `requestTurn(sessionId)` (una volta per passata e sessione) invece di `markUndelivered(session_not_live)` (~L129); (2) `deliver()` false → da `delivered` torna `pending` + `requestTurn` (~L141); (3) `inputsNotEchoed` → `pending` invece di `undelivered` + `requestTurn`. Senza `turnStarter` configurato: comportamento di oggi. Nessun commento su ticket (queste sessioni non hanno ticket).
- Test su Postgres vero come `relay.test.ts`; quelli esistenti invariati. Review Focus #1.

### Task 6: Ponte HTTP e server MCP dei tool
- `apps/worker/src/refine-mcp/{server,index}.ts`, copiato da `ask-user-mcp/` (server `stubwise_refine`, tool `set_design`/`set_plan`/`update_item`, SENZA `readOnlyHint`: il turno non è in plan mode). Il build è `tsc` sull'intero worker: `dist/refine-mcp/index.js` esce da sé.
- `backlog/refine/bridge.ts`: `node:http` su `127.0.0.1:0`, `POST /tools/:name`, `Authorization: Bearer <segreto>`, confronto a tempo costante, limite del body; in transazione: sessione `active` + voce aperta, scrittura via Task 3 con revisione, `last_activity_at`, `pg_notify` sul canale degli eventi della sessione. `buildRefineMcpConfig` sul modello di `buildAskUserRunConfig` (`pipeline/ask-user.ts:147-180`).
- Test: segreto sbagliato/revocato → 401; sessione chiusa / voce chiusa rifiutate; revisione scritta; regola di `origin_content`. Review Focus #3 e #6.

### Task 7: Worktree multi-repo lunghi
- `MirrorManager.openProjectWorktrees` costruito su `openWorktree(project, branch, { dir })` (`mirrors.ts` ~L536); su errore parziale smonta ciò che ha aperto. `withProjectWorktrees` (~L661) è a callback e non va bene.
- `backlog/refine/worktrees.ts`: registro + `refineParentDir` (percorso deterministico: il CLI indicizza le sessioni per cwd).

### Task 8: Prompt d'avvio e contratto del plugin base
- `backlog/refine/prompts.ts`: voce (titolo, testo, design, piano, metadati), repository con percorsi, ultime decisioni, ultimi messaggi della trascrizione, mandato (domande in chat e non `ask_user`; salvare coi tool; non chiudere il lavoro da solo). Lingua: come `backlog/prompts.ts`.
- Una riga nel contratto di `stubwise-base` (`apps/worker/plugins/`): in una sessione di refinement design e piano si salvano coi tool, non come file. Controllare se golden o test asseriscono quel testo.

### Task 9: `runRefineTurn` e `backlogRefineSession`
- Claim dell'input d'apertura (perso → `skipped`); voce o sessione chiusa → input `undelivered` `session_not_live`; budget (come `fix.ts`/`correction.ts` con `monthlyCostUsd`: autore admin passa, member → `budget_exceeded`); provider come `chat-turn.ts` (`resolveBacklogProvider`); worktree dal registro o aperti dentro `serializer.run(projectId)` solo per l'apertura; plugin (`openRunPlugins`) e grafo (`GRAPHIFY_AGENT_ALLOWED_TOOLS`) come `chat-turn.ts`; ponte + MCP; run con `permissionMode: "default"`, `allowedTools` chiuso, `resumeSessionId`, `openingInput`, `signal`, `timeoutMs`.
- `--resume` fallito → un solo nuovo tentativo col prompt d'avvio (stesso `openingInput`: il primo processo non l'ha preso), e `cli_session_id` riscritto. Successo → `cli_session_id` + `last_activity_at`. `AgentRunCancelledError` → `cancelled`; altri errori → input `turn_failed` se mai ripreso, `failed`. Segreto revocato nel `finally`.
- Test con runner finto, Postgres vero, mirror finti. Review Focus #5.

### Task 10: `RefineScheduler`, sweep, chiusura, cablaggio, env
- Stato per sessione in memoria (in avvio o in corso, con `AbortController`); `requestTurn`: già attiva → niente (gli input entrano come interventi alla registrazione del processo); tetto globale pieno → niente (il poll del relay riprova); altrimenti l'input `pending` più vecchio → `runRefineTurn`; a fine turno `relay.deliverPending(sessionId)`.
- `closeSession`: abort, input `pending` → `undelivered`, worktree smontati, segreti revocati; `LISTEN BACKLOG_REFINE_CLOSED_CHANNEL`. `sweepIdle` ogni 60 s. `shutdown`.
- Cablaggio in `index.ts` solo con `config.agentStreaming` (il relay esiste solo lì, ~L196-200; sweep della chat CODE ~L521-563 come modello); env in `config.ts`, compose (`${VAR:-default}`), `.env.example`.
- Review Focus #1, #2, #3 (`runRefineTurn` iniettabile nei test).

### Task 11: Server — avvio e chiusura
- `services/backlog-refine.ts` come da contratto; `POST`/`DELETE /api/backlog/:id/refine-session` (requireAuth, member ammessi come la chat); `refineSession` nel dettaglio della voce (~L640 di `routes/backlog.ts`, dove si carica `codeSession`).
- `closeRefineSessionForItem` in OGNI punto che oggi chiude la sessione CODE quando la voce si chiude (`services/backlog.ts` ~L120 conversione; cercare archiviazione, fusione e cancellazione: `grep backlogCodeSessions`).
- Test di rotta (404, 409 `item_closed`, idempotenza della chiusura, riapertura).

### Task 12: Server — permessi per kind e stato
- Rotta `POST /api/agent-sessions/:id/messages`: togliere `preHandler: requireAdmin` (`routes/agent-sessions.ts` ~L79-82). In `sendAgentMessage` (`services/agent-sessions.ts` ~L801): kind in `MEMBER_WRITABLE_SESSION_KINDS` → chi vede la sessione; per `backlog_refine` niente controllo `!live`, invece `reopenRefineSessionIfClosed` nella transazione dell'insert (`item_closed` → 409); altri kind: admin come oggi.
- `deriveAgentSessionState` (~L79): per refine `working` se viva, `queued` se c'è un input `pending` senza processo, `idle` se attiva, `ended` se chiusa; join su `backlog_refine_sessions` + EXISTS sugli input pending; `possiblyActiveSql` (~L353) d'accordo. `canWrite`/`canIntervene` per refine indipendenti da `live`; `canClose`.
- Test negativi a due ruoli sulle righe (Review Focus #4) e dello stato.

### Task 13: Client, golden, documentazione
- Gruppo `backlogRefine` in `packages/api-client`, riuso di `isAgentSessionsUnavailable` per il 404 senza `code`.
- Scenario golden `refine` (`apps/worker/scripts/golden/`): ponte finto; `set_design` e `set_plan` chiamati, nessun `Write`/`Edit`, nessun file scritto nel repo fixture, risposta rivolta alla persona, messaggio a metà turno assorbito; 3 lanci.
- CLAUDE.md: voce di deploy «Sessioni di refinement del backlog» (ordine: server, verifica della 0087, poi worker + caddy col controllo d'inattività; env; rollback: server vecchio → 500 sull'intero `/api/agent-sessions` se prima non si fa `delete from agent_sessions where kind='backlog_refine'`; worker vecchio → input pending marcati undelivered, chiudere prima le sessioni); invarianti (regole a turni solo per `TURN_BASED_SESSION_KINDS`, scrittura dei member solo per `MEMBER_WRITABLE_SESSION_KINDS`, sola lettura via `allowedTools`, segreto per turno, revisioni); `refine` fra gli scenari golden e fra i run col perimetro plugin.

## Piano B (web e app) — da scrivere in un file a sé
- Web, pagina della voce: «Inizia/Riprendi sessione» con un primo messaggio facoltativo → `/agents/$id`; con sessione attiva: stato + link. `refineSession ?? null`, fixture SENZA il campo.
- Web, `/agents/$id`: composer con `canWrite` anche in `idle`; «Chiudi sessione» con conferma (`canClose`); riquadro della voce (design, piano, metadati) aggiornato a ogni notifica; testo dello stato `idle`; testi dei motivi `turn_failed`/`budget_exceeded`; 409 `item_closed` all'invio.
- App, `BacklogItemScreen`: bottone → `openAgentSession`; nascosto col 404 senza `code`. `AgentSessionScreen`: le stesse aggiunte del web. Trappole dell'app: `await render`, doppio del client completo prima dei test, fixture complete.
- Guida utente in `apps/docs` (pagina delle sessioni e del backlog).
- Modelli: `docs/plans/2026-10-09-agent-sessions-b-web.md` e `docs/plans/2026-10-09-agent-sessions-c-app.md`.
