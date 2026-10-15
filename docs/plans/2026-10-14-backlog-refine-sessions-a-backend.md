# Sessioni di refinement del backlog — Piano A: shared, DB, worker, server

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** su una voce di backlog si avvia una sessione dell'agente `backlog_refine`, continua nel tempo, in cui chiunque possa lavorare sul backlog conversa con Claude Code in streaming; l'agente legge tutte le repository del progetto in sola lettura e scrive design, piano e metadati della voce con tre tool.

**Architecture:** il server scrive solo gli input (come per ogni intervento) e apre/chiude la sessione; nel worker il relay, per le sessioni «a turni», non marca mai `undelivered` un input senza processo vivo: lo passa a uno `RefineScheduler` che avvia un turno (`runRefineTurn`) con quell'input come messaggio d'apertura, riprendendo la conversazione CLI con `--resume`. I tool di scrittura sono un server MCP stdio bundlato che parla con un ponte HTTP su loopback nel worker (segreto per turno); le regole di scrittura sono un modulo condiviso con le rotte del server.

**Tech Stack:** Node 22, TypeScript, execa, drizzle + postgres.js, Fastify + Zod (v4: `z.uuid()`, `z.iso.datetime()`), `@modelcontextprotocol/sdk`, Vitest + testcontainers.

**Spec:** `docs/plans/2026-10-14-backlog-refine-sessions-design.md`. Piano B (web e app): `docs/plans/2026-10-14-backlog-refine-sessions-b-ui.md`.

## Global Constraints

- CLI fissato a `2.1.287` (`ARG CLAUDE_CODE_VERSION`, `apps/worker/Dockerfile`): non si tocca.
- L'argv e il comportamento del runner per OGNI segmento esistente non cambiano: i test di `streaming-cli.test.ts` restano verdi senza modifiche (se ne aggiungono, non se ne cambiano).
- Le regole del relay cambiano SOLO per i kind in `TURN_BASED_SESSION_KINDS` (= `backlog_refine`); per ogni altro kind i test di `relay.test.ts` restano verdi senza modifiche.
- Scrivere in una sessione resta **solo admin** per ogni kind fuori da `MEMBER_WRITABLE_SESSION_KINDS` (= `backlog_refine`): controllo nel SERVIZIO (`sendAgentMessage`), test negativi a due ruoli che asseriscono sulle righe.
- I due divieti dell'operatore non si toccano: nessun file di questo piano modifica `resolvePlan`/`preApprovePlan`/`revokePlanApproval`, la riga del gate in `jobs.ts` o `releasePullRequest`.
- Migrazione **0087** a mano (SQL + voce `_journal.json`, `idx` 87, `when` = `1791936000000`, tag `0087_backlog_refine_sessions`; nessuno snapshot, le migrazioni a mano non ne hanno dalla 0061), nessun `ALTER TYPE`, CHECK al posto dei pgEnum.
- Ogni campo di risposta nuovo letto dall'app nasce `.default()`/`.nullable()`, con un test che parsa una risposta SENZA quel campo.
- Rotte letterali registrate PRIMA di quelle parametriche sullo stesso prefisso.
- Testi automatici (messaggi di sistema, motivi, titoli) da **template i18n**, mai AI.
- Nomi dei canali `NOTIFY` definiti UNA volta in `@stubwise/shared`, mai letterali.
- Il turno di refinement: `permissionMode: "default"`, `allowedTools` CHIUSO = `["Read","Grep","Glob", ...GRAPHIFY_AGENT_ALLOWED_TOOLS (solo se c'è almeno un grafo), ...REFINE_TOOL_NAMES]`. Mai `Edit`, `Write`, `Bash` nudo, `WebFetch`, `NotebookEdit` (i pattern `Bash(graphify …:*)` del grafo sono gli unici `Bash(`).
- Il server MCP dei tool non riceve MAI `DATABASE_URL`, `ENCRYPTION_KEY`, `SESSION_SECRET` né credenziali: solo `REFINE_BRIDGE_URL` e `REFINE_BRIDGE_SECRET`.
- Il worker è UN processo: registro dei worktree, scheduler e relay sono in memoria e lo presuppongono.
- Env nuove del worker (in `config.ts`, nel blocco `worker` di `docker-compose.yml` come `${VAR:-default}` e in `.env.example` vuote): `BACKLOG_REFINE_MAX_CONCURRENT` (default 2, min 1), `BACKLOG_REFINE_IDLE_MINUTES` (default 30, min 1), `BACKLOG_REFINE_TURN_TIMEOUT_MS` (default 900000, min 60000). I turni massimi riusano `BACKLOG_CHAT_TURN_MAX_TURNS` (una manopola in meno).
- Percorso della cartella dei worktree di una sessione: `join(tmpdir(), "stubwise-refine", <agentSessionId>)`, deterministico (il CLI indicizza le sessioni per cwd: `--resume` dopo un riavvio funziona solo se la cwd è la stessa).

## Review Focus

1. **Messaggio scritto mentre il turno finisce**: l'input arriva nei ~2 s di grazia dopo il `result`. Atteso: non diventa mai `undelivered`; diventa il turno successivo, che parte appena il processo esce. Test in Task 5 (relay) e Task 10 (scheduler).
2. **Due messaggi in fila a sessione ferma**: due input `pending` arrivano insieme. Atteso: UN turno parte col più vecchio, il secondo entra come intervento quando il processo si registra (o, se il turno è già finito, diventa il turno dopo). Mai due processi sulla stessa sessione. Test in Task 10.
3. **«Chiudi» a metà turno**: Atteso: il processo si chiude entro pochi secondi, nessuna scrittura successiva del ponte è accettata (segreto revocato), gli input `pending` diventano `undelivered`. Test in Task 4 (signal), Task 6 (ponte) e Task 10.
4. **Un member su una sessione `ai_job`**: Atteso: 403 e nessuna riga in `agent_session_inputs`; sulla `backlog_refine` dello stesso progetto la riga nasce. Test in Task 12.
5. **Riavvio del worker fra due turni**: Atteso: il turno dopo riapre i worktree nello STESSO percorso e prova `--resume`; se il CLI lo rifiuta, riparte col prompt d'avvio e riscrive `cli_session_id`. Test in Task 9.
6. **Voce convertita in ticket con una sessione aperta**: Atteso: sessione `closed` (`item_closed`), turno in corso annullato, scritture del ponte rifiutate, e un messaggio successivo riceve 409. Test in Task 6 (ponte), Task 11 (server), Task 12 (messaggio).

## Cose trovate nel codice durante la stesura (nessuna smentisce la spec)

- `agent_sessions.backlog_item_id` è oggi valorizzato SOLO dalle sessioni `backlog_item` (`backlogItemSession`; `backlogJobSession` non lo usa). Una sessione `backlog_refine` lo valorizza anch'essa (titolo, cascata), quindi due letture che oggi lo usano come «è la chat della voce» vanno ristrette a `kind = 'backlog_item'`: `openBacklogQuestionSql` e le domande del dettaglio (`loadAgentSession`). Senza, una domanda aperta della chat CODE metterebbe la sessione di refinement in `waiting_input`. Comportamento identico per gli altri kind (Task 12).
- Il contratto del plugin base dice «ask_user è l'unico canale verso una persona» e «brainstorming: ogni domanda passa da ask_user»: nella sessione di refinement il canale è la chat (spec §4.1). La riga aggiunta al contratto (Task 8) lo dice esplicitamente, e deve stare nei 120 caratteri che restano sotto il tetto dei 400 token del test `base.test.ts`.
- I run di backlog non scrivono `agent_runs` (il costo dei turni di chat CODE non entra in `monthlyCostUsd`), e una fase nuova vorrebbe un `ALTER TYPE` (`agent_run_phase`), escluso dalla spec. I turni di refinement seguono i run di backlog: il controllo del budget (§5.5) li FERMA quando il mese è sforato, ma il loro costo non entra nel conto. Limite noto, scritto nella voce di deploy (Task 13).
- Lo «Ferma» senza testo arrivato quando il processo è già uscito non ha niente da fermare: per i kind a turni NON avvia un turno (Task 5, resta `undelivered`/`session_not_live` come oggi).

---

## File structure

| File | Responsabilità |
|---|---|
| `packages/shared/src/schemas/agent-session.ts` | kind `backlog_refine`, segmento `refine`, stato `idle`, motivi `turn_failed`/`budget_exceeded`, `TURN_BASED_SESSION_KINDS`, `MEMBER_WRITABLE_SESSION_KINDS`, `canClose`, `BACKLOG_REFINE_CLOSED_CHANNEL` |
| `packages/shared/src/schemas/backlog.ts` | `refineSessionStatusSchema`, `refineCloseReasonSchema`, `refineSessionViewSchema`, `refineSession` nel dettaglio della voce |
| `packages/shared/src/schemas/backlog-refine.ts` | schemi delle rotte di avvio, schemi dei tre tool, `REFINE_TOOL_NAMES` (importa da `backlog.ts`, mai il contrario) |
| `packages/db/drizzle/0087_backlog_refine_sessions.sql` + `schema.ts` + `testing.ts` | tabelle `backlog_refine_sessions`, `backlog_item_revisions`; CHECK dei kind allargato; `seedBacklogItem` |
| `packages/notifications/src/backlog-item-writes.ts` | regole UNICHE di scrittura di design, piano e metadati di una voce, con revisione facoltativa |
| `apps/worker/src/agent/runner.ts`, `streaming-cli.ts` | opzioni `openingInput` e `signal`; deliverable `conversation` |
| `apps/worker/src/sessions/relay.ts` | regole dei kind a turni; `TurnStarter` |
| `apps/worker/src/refine-mcp/{server,index}.ts` | server MCP stdio dei tre tool |
| `apps/worker/src/backlog/refine/bridge.ts` | ponte HTTP su loopback: segreti per turno, validazione, scrittura; `buildRefineMcpConfig` |
| `apps/worker/src/git/mirrors.ts` | `openProjectWorktrees` (apertura lunga di N worktree) |
| `apps/worker/src/backlog/refine/worktrees.ts` | registro in memoria dei worktree multi-repo per sessione, `refineParentDir` |
| `apps/worker/src/backlog/refine/prompts.ts` | prompt d'avvio e mandato |
| `apps/worker/src/backlog/refine/turn.ts` | `runRefineTurn` |
| `apps/worker/src/backlog/refine/scheduler.ts` | `RefineScheduler`: avvio dei turni, tetto, chiusura, sweep d'inattività |
| `apps/worker/src/sessions/owners.ts` | `backlogRefineSession` |
| `apps/worker/src/index.ts`, `config.ts` | cablaggio ed env |
| `apps/worker/plugins/stubwise-base/hooks/session-start.sh` | una riga del contratto |
| `apps/server/src/services/backlog-refine.ts` | avvio, chiusura, riapertura, chiusura per voce chiusa, vista |
| `apps/server/src/routes/backlog.ts`, `services/backlog.ts` | `POST`/`DELETE /api/backlog/:id/refine-session`, `refineSession` nel dettaglio, chiusure per voce chiusa, rotte riscritte sul modulo condiviso |
| `apps/server/src/services/agent-sessions.ts`, `routes/agent-sessions.ts` | permesso per kind, stato `idle`/`queued`, `canWrite`/`canClose` |
| `packages/i18n/src/catalog.ts` | titolo della sessione |
| `packages/api-client/src/endpoints/backlog-refine.ts` | gruppo `backlogRefine` |
| `apps/worker/scripts/golden/` | scenario `refine` |

## Interfacce condivise fra i task (CONTRATTO — i nomi sono questi, in ogni task)

```ts
// packages/shared/src/schemas/agent-session.ts (Task 1)
agentSessionKindSchema        // + "backlog_refine"
agentSegmentLabelSchema       // + "refine"; INTERACTIVE_SEGMENTS.has("refine") === true
INTERVENABLE_SESSION_KINDS    // + "backlog_refine"
agentSessionStateSchema       // + "idle"
agentInputReasonSchema        // + "turn_failed", "budget_exceeded"
export const TURN_BASED_SESSION_KINDS: ReadonlySet<AgentSessionKind>;      // { "backlog_refine" }
export const MEMBER_WRITABLE_SESSION_KINDS: ReadonlySet<AgentSessionKind>; // { "backlog_refine" }
export const BACKLOG_REFINE_CLOSED_CHANNEL = "backlog_refine_closed";     // payload JSON { agentSessionId }
agentSessionDetailSchema      // + canClose: z.boolean().default(false)

// packages/shared/src/schemas/backlog.ts (Task 1)
export const refineSessionStatusSchema = z.enum(["active", "closed"]);
export const refineCloseReasonSchema = z.enum(["user", "idle", "item_closed"]);
export const refineSessionViewSchema = z.object({
  agentSessionId: z.uuid(),
  status: refineSessionStatusSchema,
  closedReason: refineCloseReasonSchema.nullable().default(null),
  lastActivityAt: z.iso.datetime(),
});
// backlogItemDetailSchema + refineSession: refineSessionViewSchema.nullable().default(null)

// packages/shared/src/schemas/backlog-refine.ts (Task 1)
export const startRefineSessionInputSchema = z.object({ message: z.string().trim().min(1).max(4000).optional() });
export const startRefineSessionResultSchema = z.object({ agentSessionId: z.uuid(), inputId: z.uuid().nullable() });
export const REFINE_DOC_MAX_CHARS = 200_000;
export const refineSetDocInputSchema = z.object({ markdown: z.string().min(1).max(REFINE_DOC_MAX_CHARS) });
export const refineUpdateItemInputSchema = updateBacklogItemSchema.omit({ status: true }).refine(…almeno un campo…);
export type RefineUpdateItemInput = z.infer<typeof refineUpdateItemInputSchema>;
export const REFINE_MCP_SERVER_NAME = "stubwise_refine";
export const REFINE_TOOLS = ["set_design", "set_plan", "update_item"] as const;
export type RefineToolName = (typeof REFINE_TOOLS)[number];
export const REFINE_TOOL_NAMES: readonly string[]; // "mcp__stubwise_refine__<tool>" per ognuno

// packages/db (Task 2)
backlogRefineSessions: { id, itemId (unique), agentSessionId (unique, FK agent_sessions cascade), status, cliSessionId, startedByUserId, lastActivityAt, closedAt, closedReason, createdAt }
backlogItemRevisions:  { id, itemId (FK cascade), field ("document"|"implementation_plan"|"metadata"), previous (jsonb), agentSessionId (FK set null), createdAt }
// packages/db/src/testing.ts
export async function seedBacklogItem(db: Db, opts?: { projectId?: string; title?: string; status?: BacklogItemStatus }): Promise<{ projectId: string; repositoryId: string | null; itemId: string }>;

// packages/notifications/src/backlog-item-writes.ts (Task 3)
export type BacklogItemRevisionSource = { agentSessionId: string };
export type BacklogItemMetadataPatch = Omit<UpdateBacklogItemInput, "status">;
export async function setBacklogItemDesign(tx: DbOrTx, itemId: string, markdown: string, revision?: BacklogItemRevisionSource): Promise<"ok" | "not_found">;
export async function removeBacklogItemDesign(tx: DbOrTx, itemId: string): Promise<"ok" | "not_found" | "no_design">;
export async function setBacklogItemPlan(tx: DbOrTx, itemId: string, markdown: string | null, revision?: BacklogItemRevisionSource): Promise<"ok" | "not_found">;
export async function updateBacklogItemMetadata(tx: DbOrTx, itemId: string, patch: BacklogItemMetadataPatch, opts?: { status?: BacklogItemStatus; revision?: BacklogItemRevisionSource; onArchive?: (tx: Tx) => Promise<void> }): Promise<"ok" | "not_found">;
export function hasActionableSuggested(s: BacklogSuggested): boolean;

// apps/worker/src/agent/runner.ts (Task 4)
AgentRunOptions.openingInput?: { inputId: string; text: string; authorUserId: string | null };
AgentRunOptions.signal?: AbortSignal;  // abort → stdin chiuso, processo terminato, il run lancia AgentRunCancelledError
// streaming-cli.ts: SEGMENT_DELIVERABLE: Partial<Record<AgentSegmentLabel, "output" | "files" | "conversation">>; refine = "conversation"

// apps/worker/src/sessions/relay.ts (Task 5)
export interface TurnStarter { requestTurn(sessionId: string): void }
SessionInputRelay deps + turnStarter?: TurnStarter;  // + cache interno del kind per sessione

// apps/worker/src/backlog/refine/bridge.ts (Task 6)
export interface RefineTurnGrant { secret: string; revoke(): void }
export interface RefineBridge {
  readonly url: string;                                   // http://127.0.0.1:<porta>
  grant(turn: { agentSessionId: string; itemId: string }): RefineTurnGrant;
  revokeSession(agentSessionId: string): void;
  close(): Promise<void>;
}
export async function startRefineBridge(deps: { db: Db; log?: (m: string) => void }): Promise<RefineBridge>;
export function refineServerPath(): string;   // dist/refine-mcp/index.js accanto al modulo
export function buildRefineMcpConfig(bridge: RefineBridge, grant: RefineTurnGrant, serverPath: string): { mcpConfig: AgentMcpConfig; tools: readonly string[] } | null;  // null se l'entry non esiste

// apps/worker/src/git/mirrors.ts + backlog/refine/worktrees.ts (Task 7)
MirrorManager.openProjectWorktrees(repos: ProjectWorktreeRepo[], branchName: string, parentDir: string): Promise<{ dirs: { repositoryId: string; name: string; dir: string }[]; remove(): Promise<void> }>;
export interface ProjectWorktreeRepo { repositoryId: string; name: string; project: MirrorProject }
export interface RefineWorktreeEntry { agentSessionId: string; parentDir: string; repos: { repositoryId: string; name: string; dir: string }[]; remove(): Promise<void> }
export interface RefineWorktreeRegistry { get(id: string): RefineWorktreeEntry | undefined; set(e: RefineWorktreeEntry): void; remove(id: string): Promise<void>; ids(): string[]; closeAll(): Promise<void> }
export function createRefineWorktreeRegistry(): RefineWorktreeRegistry;
export function refineParentDir(agentSessionId: string): string;

// apps/worker/src/backlog/refine/prompts.ts (Task 8)
export interface RefinePromptContext {
  language: Language;
  item: { title: string; document: string; implementationPlan: string | null; originContent: string | null; effort: number | null; risk: string | null; riskNote: string | null; urgency: string | null };
  repos: { name: string; dir: string }[];
  graphHint: string;                                     // renderGraphHint(..., "it"), "" senza grafi
  decisions: { title: string; decision: string; decidedAt: Date }[];
  recentTranscript: { role: "user" | "agent"; text: string }[];
}
export function buildRefinePrimingPrompt(ctx: RefinePromptContext, openingText: string): string;
export function buildRefineResumePrompt(openingText: string): string;   // = openingText

// apps/worker/src/backlog/refine/turn.ts (Task 9)
export interface RefineTurnDeps { db; runner: AgentRunner; mirrors: Pick<MirrorManager, "openProjectWorktrees">; serializer: ProjectSerializer; worktrees: RefineWorktreeRegistry; bridge: RefineBridge; encryptionKey: Buffer; graphsDir?: string; pluginsDir?: string; model?: string; maxTurns: number; turnTimeoutMs: number; refineServerPath?: string; monthlyCostUsdFn?: (db: Db) => Promise<number>; loadProviderByIdFn?; loadProviderChainFn?; loadMirrorProjectsFn?: (db: Db, projectId: string) => Promise<ProjectWorktreeRepo[]>; log: (m: string) => void }
export type RefineTurnOutcome = "completed" | "cancelled" | "failed" | "skipped";
export async function runRefineTurn(deps: RefineTurnDeps, input: { agentSessionId: string; inputId: string; signal: AbortSignal }): Promise<RefineTurnOutcome>;

// apps/worker/src/backlog/refine/scheduler.ts (Task 10)
export class RefineScheduler implements TurnStarter { constructor(deps: RefineSchedulerDeps); start(): Promise<void>; requestTurn(id: string): void; closeSession(id: string): Promise<void>; sweepIdle(now?: Date): Promise<void>; shutdown(): Promise<void> }

// apps/server/src/services/backlog-refine.ts (Task 11)
export async function startRefineSession(db: Db, actor: Actor, itemId: string, message?: string): Promise<{ ok: true; agentSessionId: string; inputId: string | null } | { ok: false; error: "not_found" | "item_closed" }>;
export async function closeRefineSession(db: Db, actor: Actor, itemId: string): Promise<{ ok: true } | { ok: false; error: "not_found" }>;
export async function closeRefineSessionForItem(tx: DbOrTx, itemId: string): Promise<void>;
export async function reopenRefineSessionIfClosed(tx: DbOrTx, agentSessionId: string): Promise<"active" | "item_closed" | "not_refine">;
export async function loadRefineSessionView(db: Db, itemId: string): Promise<RefineSessionView | null>;

// apps/server/src/services/agent-sessions.ts (Task 12)
SessionDerivationInput + refineStatus: "active" | "closed" | null; pendingInput: boolean;
SendAgentMessageResult error + "item_closed";

// packages/api-client (Task 13)
client.backlogRefine.start(itemId, { message? }) → StartRefineSessionResult
client.backlogRefine.close(itemId) → void
```

---

### Task 1: Schemi condivisi

**Files:**
- Modify: `packages/shared/src/schemas/agent-session.ts:17-100,140-160,200-203,256-295`
- Modify: `packages/shared/src/schemas/backlog.ts:300-357` (accanto a `backlogCodeSessionSchema` e nel dettaglio)
- Create: `packages/shared/src/schemas/backlog-refine.ts`
- Modify: `packages/shared/src/index.ts` (una riga `export * from "./schemas/backlog-refine.js";`)
- Modify: `apps/worker/src/agent/streaming-cli.ts:133-142` (tipo e voce `refine`)
- Test: `packages/shared/src/schemas/agent-session.test.ts`, `packages/shared/src/schemas/backlog-refine.test.ts` (nuovo), `packages/shared/src/schemas/backlog.test.ts`
- Create: `.changeset/shared-backlog-refine-sessions.md`

**Interfaces:**
- Consumes: niente.
- Produces: tutto il blocco «Task 1» del contratto.

Note per chi implementa:
- `backlog-refine.ts` importa da `backlog.ts` (per `updateBacklogItemSchema`); per questo gli schemi della VISTA (`refineSessionViewSchema` e i due enum) stanno in `backlog.ts`, che non deve importare `backlog-refine.ts`: un ciclo farebbe fallire `load-isolated.test.ts`.
- `refineUpdateItemInputSchema` NON ridefinisce i validatori: è `updateBacklogItemSchema` (già in shared, è il body di `PATCH /api/backlog/:id`) senza `status`. Una voce non si archivia né si converte da un tool.
- Nessuna mappa esaustiva da completare: l'unico `switch` sui kind (`displayTitle`, server) ha il ripiego e lo completa il Task 12; web e app traducono con chiavi i18n che hanno il ramo `unknown` (le chiavi nuove le aggiunge il Piano B).
- Il test di `streaming-cli.test.ts` che pretende chiavi di `SEGMENT_DELIVERABLE` = `INTERACTIVE_SEGMENTS` resta com'è e torna verde perché qui si aggiunge `refine: "conversation"`. Fino al Task 4 `"conversation"` si comporta come `"files"` (l'unico confronto nel runner è `=== "output"`).

- [ ] **Step 1: test che falliscono — `agent-session.test.ts`**

```ts
import {
  BACKLOG_REFINE_CLOSED_CHANNEL,
  INTERACTIVE_SEGMENTS,
  INTERVENABLE_SESSION_KINDS,
  MEMBER_WRITABLE_SESSION_KINDS,
  TURN_BASED_SESSION_KINDS,
  agentInputReasonSchema,
  agentSessionDetailSchema,
  agentSessionKindSchema,
  agentSessionStateSchema,
} from "./agent-session.js";

describe("sessioni di refinement (2026-10-14)", () => {
  it("backlog_refine è un kind, refine un segmento interattivo, idle uno stato", () => {
    expect(agentSessionKindSchema.parse("backlog_refine")).toBe("backlog_refine");
    expect(INTERACTIVE_SEGMENTS.has("refine")).toBe(true);
    expect(agentSessionStateSchema.parse("idle")).toBe("idle");
    expect(agentInputReasonSchema.parse("turn_failed")).toBe("turn_failed");
    expect(agentInputReasonSchema.parse("budget_exceeded")).toBe("budget_exceeded");
  });

  it("le regole a turni e la scrittura dei member valgono SOLO per backlog_refine (elenchi espliciti)", () => {
    expect([...TURN_BASED_SESSION_KINDS]).toEqual(["backlog_refine"]);
    expect([...MEMBER_WRITABLE_SESSION_KINDS]).toEqual(["backlog_refine"]);
    expect(INTERVENABLE_SESSION_KINDS.has("backlog_refine")).toBe(true);
    expect(BACKLOG_REFINE_CLOSED_CHANNEL).toBe("backlog_refine_closed");
  });

  it("un dettaglio senza canClose (server più vecchio) lo legge false", () => {
    const detail = agentSessionDetailSchema.parse({
      id: "7f1c2a1e-0000-4000-8000-000000000001",
      kind: "ai_job",
      title: "t",
      projectId: null,
      projectName: null,
      ticketId: null,
      ticketNumber: null,
      startedAt: "2026-10-14T10:00:00.000Z",
      lastEventAt: null,
      state: "working",
    });
    expect(detail.canClose).toBe(false);
  });
});
```

(Se il dettaglio minimo di sopra non parsa per un campo obbligatorio di `agentSessionSummarySchema` che manca, copiare `OLD_DETAIL` da `packages/api-client/src/endpoints/agent-sessions.test.ts`, che è già la forma «server più vecchio».)

- [ ] **Step 2: test che falliscono — `backlog-refine.test.ts` (nuovo) e `backlog.test.ts`**

```ts
// packages/shared/src/schemas/backlog-refine.test.ts
import { describe, expect, it } from "vitest";
import {
  REFINE_DOC_MAX_CHARS,
  REFINE_TOOL_NAMES,
  refineSetDocInputSchema,
  refineUpdateItemInputSchema,
  startRefineSessionInputSchema,
} from "./backlog-refine.js";

describe("backlog-refine", () => {
  it("i nomi dei tool sono quelli che il CLI vede (mcp__<server>__<tool>)", () => {
    expect(REFINE_TOOL_NAMES).toEqual([
      "mcp__stubwise_refine__set_design",
      "mcp__stubwise_refine__set_plan",
      "mcp__stubwise_refine__update_item",
    ]);
  });

  it("set_design/set_plan: markdown non vuoto, entro il tetto", () => {
    expect(refineSetDocInputSchema.safeParse({ markdown: "" }).success).toBe(false);
    expect(refineSetDocInputSchema.safeParse({ markdown: "x".repeat(REFINE_DOC_MAX_CHARS + 1) }).success).toBe(false);
    expect(refineSetDocInputSchema.parse({ markdown: "# D" }).markdown).toBe("# D");
  });

  it("update_item: gli stessi validatori del PATCH, senza status, almeno un campo", () => {
    expect(refineUpdateItemInputSchema.safeParse({}).success).toBe(false);
    expect(refineUpdateItemInputSchema.safeParse({ effort: 9 }).success).toBe(false);
    expect(refineUpdateItemInputSchema.safeParse({ risk: "enorme" }).success).toBe(false);
    expect(refineUpdateItemInputSchema.parse({ status: "archived", title: "T" })).toEqual({ title: "T" });
    expect(refineUpdateItemInputSchema.parse({ riskNote: null })).toEqual({ riskNote: null });
  });

  it("avvio: messaggio facoltativo, trim, mai vuoto", () => {
    expect(startRefineSessionInputSchema.parse({})).toEqual({});
    expect(startRefineSessionInputSchema.safeParse({ message: "   " }).success).toBe(false);
    expect(startRefineSessionInputSchema.parse({ message: " ciao " }).message).toBe("ciao");
  });
});
```

Nota: `updateBacklogItemSchema.omit({ status: true })` di Zod 4 SCARTA le chiavi ignote (non è `.strict()`), da cui l'attesa `{ title: "T" }` col `status` passato. Il controllo «almeno un campo» va fatto sulle chiavi DEFINITE dopo il parse: `Object.values(v).some((x) => x !== undefined)`.

In `backlog.test.ts`, accanto ai test di `backlogItemDetailSchema`:

```ts
it("dettaglio della voce senza refineSession (server più vecchio): null", () => {
  const parsed = backlogItemDetailSchema.parse({ ...DETAIL_FIXTURE_SENZA_REFINE });
  expect(parsed.refineSession).toBeNull();
});
it("refineSession senza closedReason: null", () => {
  expect(
    refineSessionViewSchema.parse({
      agentSessionId: "7f1c2a1e-0000-4000-8000-000000000001",
      status: "active",
      lastActivityAt: "2026-10-14T10:00:00.000Z",
    }).closedReason,
  ).toBeNull();
});
```

`DETAIL_FIXTURE_SENZA_REFINE`: la fixture di dettaglio già presente nel file (cercarla con `grep -n "backlogItemDetailSchema" packages/shared/src/schemas/backlog.test.ts`); se non c'è, costruirla dai campi obbligatori di `backlogItemBaseSchema` più `tickets: [], messages: [], deepDivePending: false, codeSession: null, pendingTurn: false`.

- [ ] **Step 3: verificare che falliscano**

Run: `pnpm --filter @stubwise/shared test -- agent-session backlog`
Expected: FAIL (export mancanti, `refineSession` assente).

- [ ] **Step 4: implementazione — `agent-session.ts`**

Aggiunte, ciascuna nel punto dell'elenco esistente:

```ts
// agentSessionKindSchema: in coda
  "backlog_refine",
// agentSegmentLabelSchema: in coda
  "refine",
// INTERACTIVE_SEGMENTS: in coda, con una riga di docblock:
// `refine` (sessione di refinement): il deliverable è la conversazione stessa.
  "refine",
// INTERVENABLE_SESSION_KINDS: in coda
  "backlog_refine",
// agentSessionStateSchema: dopo "held"
  "idle",
// agentInputReasonSchema
export const agentInputReasonSchema = z.enum([
  "session_not_live",
  "stdin_closed",
  /** Sessione a turni: il turno non è riuscito a partire (worktree, provider, CLI). */
  "turn_failed",
  /** Sessione a turni: budget mensile sforato, e chi scrive non è un maintainer. */
  "budget_exceeded",
]);
```

Dopo `INTERVENABLE_SESSION_KINDS`:

```ts
/**
 * Sessioni A TURNI (design 2026-10-14 §3.2): nessun processo sempre acceso,
 * ogni messaggio a sessione ferma diventa un turno nuovo. Il relay del worker
 * cambia tre regole SOLO per questi kind (mai `undelivered` per tempismo).
 * Elenco ESPLICITO: un kind nuovo non le eredita per default.
 */
export const TURN_BASED_SESSION_KINDS: ReadonlySet<AgentSessionKind> = new Set<AgentSessionKind>([
  "backlog_refine",
]);

/**
 * Kind in cui SCRIVE anche un `member` (design 2026-10-14 §5.2). Per ogni altro
 * kind scrivere resta solo da maintainer. La legge SOLO il server
 * (`sendAgentMessage`, `loadAgentSession`): i client leggono `canWrite`.
 */
export const MEMBER_WRITABLE_SESSION_KINDS: ReadonlySet<AgentSessionKind> = new Set<AgentSessionKind>([
  "backlog_refine",
]);
```

Accanto agli altri canali (aggiornare anche il docblock dei canali con la riga «- refinement chiuso: payload `{ agentSessionId }`, dal server al worker»):

```ts
export const BACKLOG_REFINE_CLOSED_CHANNEL = "backlog_refine_closed";
```

Nel docblock di `agentSessionStateSchema` aggiungere: «- idle: sessione di refinement aperta ma ferma, nessun turno in coda: scrivere la fa ripartire.». In `agentSessionDetailSchema`, dopo `canInterrupt`:

```ts
  /**
   * «Chiudi sessione» (refinement): sessione attiva e chi guarda può scriverci.
   * Calcolato dal server. Additivo: un server più vecchio non lo manda.
   */
  canClose: z.boolean().default(false),
```

- [ ] **Step 5: implementazione — `backlog.ts` e `backlog-refine.ts`**

In `backlog.ts`, subito dopo `backlogCodeSessionSchema`:

```ts
/**
 * Sessione di refinement di una voce (design 2026-10-14): UNA per voce, continua
 * nel tempo (si chiude per inattività o a mano, e si riprende). La sessione vera
 * è quella dell'agente (`agentSessionId`): qui solo ciò che serve alla pagina
 * della voce per mostrare «Inizia / Riprendi / pronta / al lavoro».
 */
export const refineSessionStatusSchema = z.enum(["active", "closed"]);
export type RefineSessionStatus = z.infer<typeof refineSessionStatusSchema>;
export const refineCloseReasonSchema = z.enum(["user", "idle", "item_closed"]);
export type RefineCloseReason = z.infer<typeof refineCloseReasonSchema>;
export const refineSessionViewSchema = z.object({
  agentSessionId: z.uuid(),
  status: refineSessionStatusSchema,
  closedReason: refineCloseReasonSchema.nullable().default(null),
  lastActivityAt: z.iso.datetime(),
});
export type RefineSessionView = z.infer<typeof refineSessionViewSchema>;
```

In `backlogItemDetailSchema`, dopo `openQuestion`:

```ts
  // Sessione di refinement (2026-10-14), o null. Additivo: un server più
  // vecchio non lo manda, e l'app lo legge come null.
  refineSession: refineSessionViewSchema.nullable().default(null),
```

`backlog-refine.ts`:

```ts
import { z } from "zod";
import { updateBacklogItemSchema } from "./backlog.js";

/**
 * Sessioni di refinement del backlog (design 2026-10-14): body delle rotte di
 * avvio e input dei tre tool con cui l'agente scrive sulla voce. I validatori
 * dei metadati sono QUELLI del `PATCH /api/backlog/:id`: mai due copie.
 */

/** Body di `POST /api/backlog/:id/refine-session`: il primo messaggio è facoltativo. */
export const startRefineSessionInputSchema = z.object({
  message: z.string().trim().min(1).max(4000).optional(),
});
export type StartRefineSessionInput = z.infer<typeof startRefineSessionInputSchema>;

export const startRefineSessionResultSchema = z.object({
  agentSessionId: z.uuid(),
  inputId: z.uuid().nullable(),
});
export type StartRefineSessionResult = z.infer<typeof startRefineSessionResultSchema>;

/** Tetto di design e piano: lo stesso di `setContentSchema`. */
export const REFINE_DOC_MAX_CHARS = 200_000;
export const refineSetDocInputSchema = z.object({
  markdown: z.string().min(1).max(REFINE_DOC_MAX_CHARS),
});

/** I metadati scrivibili dall'agente: il PATCH senza `status`, almeno un campo. */
export const refineUpdateItemInputSchema = updateBacklogItemSchema
  .omit({ status: true })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "at least one field is required",
  });
export type RefineUpdateItemInput = z.infer<typeof refineUpdateItemInputSchema>;

export const REFINE_MCP_SERVER_NAME = "stubwise_refine";
export const REFINE_TOOLS = ["set_design", "set_plan", "update_item"] as const;
export type RefineToolName = (typeof REFINE_TOOLS)[number];
/** I nomi da mettere in `allowedTools`: il CLI li chiama `mcp__<server>__<tool>`. */
export const REFINE_TOOL_NAMES: readonly string[] = REFINE_TOOLS.map(
  (tool) => `mcp__${REFINE_MCP_SERVER_NAME}__${tool}`,
);
```

In `index.ts`, dopo la riga di `backlog.js`: `export * from "./schemas/backlog-refine.js";`.

In `apps/worker/src/agent/streaming-cli.ts`:

```ts
export const SEGMENT_DELIVERABLE: Partial<Record<AgentSegmentLabel, "output" | "files" | "conversation">> = {
  // …voci esistenti invariate…
  refine: "conversation",
};
```

e nel docblock sopra la costante il terzo caso: «- `conversation`: il deliverable è la conversazione (sessione di refinement, `refine`). Gli interventi restano accettati dopo un `result` riuscito, e non si accoda il promemoria del deliverable (vedi `deliver`).».

- [ ] **Step 6: verificare che passino, isolamento compreso**

Run: `pnpm --filter @stubwise/shared build && pnpm --filter @stubwise/shared test && pnpm typecheck`
Expected: PASS, compreso `load-isolated.test.ts` (il file nuovo è enumerato da solo) e `streaming-cli` nel typecheck del worker.

- [ ] **Step 7: changeset e commit**

`.changeset/shared-backlog-refine-sessions.md`:

```md
---
"@stubwise/shared": minor
---

Sessioni di refinement del backlog: kind `backlog_refine`, segmento `refine`, stato `idle`, motivi `turn_failed`/`budget_exceeded`, `canClose` (`.default(false)`) nel dettaglio di una sessione, `refineSession` (`.nullable().default(null)`) nel dettaglio di una voce, schemi delle rotte di avvio e dei tre tool dell'agente.
```

```bash
git add packages/shared apps/worker/src/agent/streaming-cli.ts .changeset/shared-backlog-refine-sessions.md
git commit -m "feat(shared): schemi delle sessioni di refinement del backlog"
```

---

### Task 2: Migrazione 0087 e tabelle

**Files:**
- Create: `packages/db/drizzle/0087_backlog_refine_sessions.sql`
- Modify: `packages/db/drizzle/meta/_journal.json` (voce `idx` 87)
- Modify: `packages/db/src/schema.ts` (dopo `backlogCodeSessions` ~L2730; CHECK dei kind in `agentSessions` ~L4180)
- Modify: `packages/db/src/testing.ts` (`seedBacklogItem`)
- Test: `packages/db/src/migration-0087.test.ts` (nuovo, modello `migration-0085.test.ts` e `agent-sessions.test.ts`)

**Interfaces:**
- Consumes: `AgentSessionKind` con `backlog_refine` (Task 1).
- Produces: `backlogRefineSessions`, `backlogItemRevisions`, `seedBacklogItem` (contratto).

- [ ] **Step 1: test che fallisce**

```ts
// packages/db/src/migration-0087.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { seedBacklogItem, startTestDb, type TestDb } from "./testing.js";
import { agentSessions, backlogItemRevisions, backlogItems, backlogRefineSessions } from "./schema.js";

async function failureMessage(p: PromiseLike<unknown>): Promise<string> {
  try { await p; } catch (e) { return (e as { cause?: { message?: string } }).cause?.message ?? String(e); }
  return "";
}

let t: TestDb;
beforeAll(async () => { t = await startTestDb(); }, 120_000);
afterAll(async () => t.stop());

async function refineSession(itemId: string) {
  const [s] = await t.db.insert(agentSessions)
    .values({ ownerKey: `backlog_refine:${itemId}`, kind: "backlog_refine", title: "t", backlogItemId: itemId })
    .returning();
  const [r] = await t.db.insert(backlogRefineSessions)
    .values({ itemId, agentSessionId: s!.id }).returning();
  return { agentSessionId: s!.id, row: r! };
}

describe("0087 backlog_refine_sessions", () => {
  it("il kind backlog_refine passa il CHECK allargato", async () => {
    const { itemId } = await seedBacklogItem(t.db);
    const { row } = await refineSession(itemId);
    expect(row.status).toBe("active");
    expect(row.closedAt).toBeNull();
  });

  it("una sola sessione per voce", async () => {
    const { itemId } = await seedBacklogItem(t.db);
    await refineSession(itemId);
    expect(await failureMessage(refineSession(itemId))).toMatch(/unique|duplicate/i);
  });

  it("CHECK di coerenza: chiusa vuole closed_at e closed_reason, attiva nessuno dei due", async () => {
    const { itemId } = await seedBacklogItem(t.db);
    const { row } = await refineSession(itemId);
    expect(await failureMessage(
      t.db.update(backlogRefineSessions).set({ status: "closed" }).where(eq(backlogRefineSessions.id, row.id)),
    )).toMatch(/backlog_refine_sessions_closed_chk/);
    expect(await failureMessage(
      t.db.update(backlogRefineSessions).set({ closedReason: "nope" as never, status: "closed", closedAt: new Date() })
        .where(eq(backlogRefineSessions.id, row.id)),
    )).toMatch(/backlog_refine_sessions_closed_reason_chk/);
  });

  it("cancellare la voce cancella sessione di refinement e revisioni; la sessione dell'agente porta via la riga", async () => {
    const { itemId } = await seedBacklogItem(t.db);
    const { agentSessionId } = await refineSession(itemId);
    await t.db.insert(backlogItemRevisions).values({ itemId, field: "document", previous: { document: "x" }, agentSessionId });
    await t.db.delete(agentSessions).where(eq(agentSessions.id, agentSessionId));
    expect(await t.db.select().from(backlogRefineSessions).where(eq(backlogRefineSessions.itemId, itemId))).toHaveLength(0);
    const [rev] = await t.db.select().from(backlogItemRevisions).where(eq(backlogItemRevisions.itemId, itemId));
    expect(rev!.agentSessionId).toBeNull(); // SET NULL: la revisione sopravvive alla potatura della sessione
    await t.db.delete(backlogItems).where(eq(backlogItems.id, itemId));
    expect(await t.db.select().from(backlogItemRevisions).where(eq(backlogItemRevisions.itemId, itemId))).toHaveLength(0);
  });

  it("revisioni: CHECK su field", async () => {
    const { itemId } = await seedBacklogItem(t.db);
    expect(await failureMessage(
      t.db.insert(backlogItemRevisions).values({ itemId, field: "title" as never, previous: {} }),
    )).toMatch(/backlog_item_revisions_field_chk/);
  });
});
```

- [ ] **Step 2: verificare che fallisca**

Run: `pnpm --filter @stubwise/db test -- migration-0087`
Expected: FAIL (`seedBacklogItem`/tabelle inesistenti).

- [ ] **Step 3: SQL e journal**

`packages/db/drizzle/0087_backlog_refine_sessions.sql`:

```sql
-- Sessioni di refinement del backlog (design 2026-10-14). Nessun ALTER TYPE:
-- status, closed_reason e field sono text con CHECK; i motivi nuovi di
-- agent_session_inputs.reason e l'etichetta `refine` di active_segment_label
-- sono colonne text senza CHECK (bastano gli enum Zod).
CREATE TABLE "backlog_refine_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"agent_session_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"cli_session_id" text,
	"started_by_user_id" uuid,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backlog_refine_sessions_item_id_unique" UNIQUE("item_id"),
	CONSTRAINT "backlog_refine_sessions_agent_session_id_unique" UNIQUE("agent_session_id"),
	CONSTRAINT "backlog_refine_sessions_status_chk" CHECK (status in ('active','closed')),
	CONSTRAINT "backlog_refine_sessions_closed_reason_chk" CHECK (closed_reason is null or closed_reason in ('user','idle','item_closed')),
	CONSTRAINT "backlog_refine_sessions_closed_chk" CHECK ((status = 'active' and closed_at is null and closed_reason is null) or (status = 'closed' and closed_at is not null and closed_reason is not null))
);
--> statement-breakpoint
ALTER TABLE "backlog_refine_sessions" ADD CONSTRAINT "backlog_refine_sessions_item_id_backlog_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."backlog_items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "backlog_refine_sessions" ADD CONSTRAINT "backlog_refine_sessions_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "backlog_refine_sessions" ADD CONSTRAINT "backlog_refine_sessions_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "backlog_refine_sessions_active_idx" ON "backlog_refine_sessions" ("last_activity_at") WHERE status = 'active';
--> statement-breakpoint
CREATE TABLE "backlog_item_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"field" text NOT NULL,
	"previous" jsonb NOT NULL,
	"agent_session_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backlog_item_revisions_field_chk" CHECK (field in ('document','implementation_plan','metadata'))
);
--> statement-breakpoint
ALTER TABLE "backlog_item_revisions" ADD CONSTRAINT "backlog_item_revisions_item_id_backlog_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."backlog_items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "backlog_item_revisions" ADD CONSTRAINT "backlog_item_revisions_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "backlog_item_revisions_item_created_idx" ON "backlog_item_revisions" ("item_id","created_at");
--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP CONSTRAINT "agent_sessions_kind_chk";
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_kind_chk" CHECK (kind in ('ai_job','pr_review','backlog_item','backlog_job','doc_generation','email_message','project_brief','daily_report','backlog_refine'));
```

`_journal.json`, in coda all'array:

```json
    {
      "idx": 87,
      "version": "7",
      "when": 1791936000000,
      "tag": "0087_backlog_refine_sessions",
      "breakpoints": true
    }
```

- [ ] **Step 4: `schema.ts`**

Dopo `backlogCodeSessions` (importare `AgentSessionKind` non serve; servono i tipi di shared `RefineSessionStatus`, `RefineCloseReason`):

```ts
/**
 * Sessione di refinement di una voce (design 2026-10-14): al più UNA per voce,
 * continua nel tempo. `agent_session_id` è la sessione dell'agente (kind
 * `backlog_refine`) che ne tiene la trascrizione: CASCADE, quindi la potatura
 * delle sessioni (14 giorni) porta via anche questa riga, e la ripresa rinasce
 * vuota col prompt d'avvio (design e piano stanno sulla voce). `cli_session_id`
 * è l'id della conversazione del CLI per `--resume`. Coerenza di stato in un
 * CHECK: attiva ⇔ nessun `closed_*`.
 */
export const backlogRefineSessions = pgTable(
  "backlog_refine_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id").notNull().unique()
      .references(() => backlogItems.id, { onDelete: "cascade" }),
    agentSessionId: uuid("agent_session_id").notNull().unique()
      .references((): AnyPgColumn => agentSessions.id, { onDelete: "cascade" }),
    status: text("status").$type<RefineSessionStatus>().notNull().default("active"),
    cliSessionId: text("cli_session_id"),
    startedByUserId: uuid("started_by_user_id").references(() => users.id, { onDelete: "set null" }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedReason: text("closed_reason").$type<RefineCloseReason>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("backlog_refine_sessions_active_idx").on(table.lastActivityAt).where(sql`status = 'active'`),
    check("backlog_refine_sessions_status_chk", sql`status in ('active','closed')`),
    check(
      "backlog_refine_sessions_closed_reason_chk",
      sql`closed_reason is null or closed_reason in ('user','idle','item_closed')`,
    ),
    check(
      "backlog_refine_sessions_closed_chk",
      sql`(status = 'active' and closed_at is null and closed_reason is null) or (status = 'closed' and closed_at is not null and closed_reason is not null)`,
    ),
  ],
);

/**
 * Valore PRECEDENTE di un campo di una voce sovrascritto dall'agente in una
 * sessione di refinement (design 2026-10-14 §4.3): rete di sicurezza
 * recuperabile a mano. `previous`: `{ document, originContent }` per il design,
 * `{ implementationPlan }` per il piano, i soli metadati cambiati per `metadata`.
 */
export const backlogItemRevisions = pgTable(
  "backlog_item_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id").notNull().references(() => backlogItems.id, { onDelete: "cascade" }),
    field: text("field").$type<"document" | "implementation_plan" | "metadata">().notNull(),
    previous: jsonb("previous").$type<Record<string, unknown>>().notNull(),
    agentSessionId: uuid("agent_session_id")
      .references((): AnyPgColumn => agentSessions.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("backlog_item_revisions_item_created_idx").on(table.itemId, table.createdAt),
    check("backlog_item_revisions_field_chk", sql`field in ('document','implementation_plan','metadata')`),
  ],
);
```

(`agentSessions` è definita più giù nel file: per questo il `references` usa la forma con `AnyPgColumn`, già importata per `backlogItems`.) Nel CHECK `agent_sessions_kind_chk` di `agentSessions` aggiungere `,'backlog_refine'` in coda alla lista.

- [ ] **Step 5: `seedBacklogItem` in `testing.ts`**

```ts
/**
 * Una voce di backlog. Senza `projectId` crea progetto e repository
 * (`seedRepository`). `status` default `new`.
 */
export async function seedBacklogItem(
  db: Db,
  opts: { projectId?: string; title?: string; status?: BacklogItemStatus } = {},
): Promise<{ projectId: string; repositoryId: string | null; itemId: string }> {
  let projectId = opts.projectId;
  let repositoryId: string | null = null;
  if (!projectId) ({ projectId, repositoryId } = await seedRepository(db));
  const [item] = await db
    .insert(backlogItems)
    .values({ projectId, title: opts.title ?? "Voce di test", source: "manual", status: opts.status ?? "new" })
    .returning({ id: backlogItems.id });
  return { projectId, repositoryId, itemId: item!.id };
}
```

- [ ] **Step 6: verificare che passino**

Run: `pnpm --filter @stubwise/db test -- migration-0087 agent-sessions`
Expected: PASS (anche `agent-sessions.test.ts`: il kind sconosciuto è ancora rifiutato).

- [ ] **Step 7: commit**

```bash
git add packages/db
git commit -m "feat(db): 0087, sessioni di refinement e revisioni delle voci di backlog"
```

---

### Task 3: Regole di scrittura condivise

**Files:**
- Create: `packages/notifications/src/backlog-item-writes.ts`
- Modify: `packages/notifications/src/index.ts` (export)
- Modify: `apps/server/src/routes/backlog.ts:687-930` (PATCH, PUT/DELETE design, PUT/DELETE piano riscritte sul modulo)
- Test: `packages/notifications/src/backlog-item-writes.test.ts` (nuovo, Postgres vero come `pr-correction-cycle.test.ts`)

**Interfaces:**
- Consumes: `backlogItemRevisions`, `seedBacklogItem` (Task 2); `DbOrTx` (`./dispatch.js`); `UpdateBacklogItemInput`, `BacklogItemStatus`, `BacklogSuggested` da `@stubwise/shared`.
- Produces: le quattro funzioni del contratto. Il ponte (Task 6) le chiama con `revision`; le rotte senza.

Le regole sono quelle di oggi, spostate e basta:
- **design**: `origin_content` preserva il `document` precedente UNA volta sola (`originContent ?? document`); con `SELECT … FOR UPDATE`.
- **rimozione del design**: ripristina `document` da `origin_content` e lo azzera; senza `origin_content` → `no_design`.
- **piano**: sostituisce `implementation_plan`; `null` lo azzera (DELETE).
- **metadati**: aggiorna solo i campi definiti; per ogni metadato deciso (effort, risk, riskNote, urgency) toglie la voce corrispondente da `suggested`, che diventa `null` se non resta niente di azionabile (`hasActionableSuggested`, oggi nel file delle rotte: va spostata QUI ed esportata; le rotte la importano dal modulo). `status` passa da `opts.status` (solo le rotte); se è `archived`, nella stessa transazione chiama il callback `opts.onArchive?.(tx)` — le rotte ci passano `closeOpenBacklogQuestion` (e dal Task 11 anche `closeRefineSessionForItem`). Il modulo non importa niente del server.

Firma completa di `updateBacklogItemMetadata`, che allarga di poco il contratto (il callback serve all'archiviazione):

```ts
export async function updateBacklogItemMetadata(
  db: DbOrTx,
  itemId: string,
  patch: BacklogItemMetadataPatch,
  opts: {
    status?: BacklogItemStatus;
    revision?: BacklogItemRevisionSource;
    onArchive?: (tx: Tx) => Promise<void>;
  } = {},
): Promise<"ok" | "not_found">;
```

Tutte e quattro girano SEMPRE in transazione (`db.transaction`): su un `Db` è una transazione nuova, su una `Tx` — il ponte del Task 6 le chiama dentro la sua — drizzle apre un savepoint.

- [ ] **Step 1: test che falliscono**

```ts
// packages/notifications/src/backlog-item-writes.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentSessions, backlogItemRevisions, backlogItems, type Db } from "@stubwise/db";
import { seedBacklogItem, startTestDb, type TestDb } from "@stubwise/db/testing";
import {
  removeBacklogItemDesign,
  setBacklogItemDesign,
  setBacklogItemPlan,
  updateBacklogItemMetadata,
} from "./backlog-item-writes.js";

let testDb: TestDb;
let db: Db;
beforeAll(async () => { testDb = await startTestDb(); db = testDb.db; });
afterAll(async () => { await testDb.stop(); });

const itemOf = async (id: string) => (await db.select().from(backlogItems).where(eq(backlogItems.id, id)))[0]!;
const revisionsOf = (id: string) => db.select().from(backlogItemRevisions).where(eq(backlogItemRevisions.itemId, id));
async function agentSession(itemId: string) {
  const [s] = await db.insert(agentSessions)
    .values({ ownerKey: `backlog_refine:${itemId}`, kind: "backlog_refine", title: "t", backlogItemId: itemId }).returning();
  return s!.id;
}

describe("design", () => {
  it("il primo design preserva il testo originale UNA volta sola", async () => {
    const { itemId } = await seedBacklogItem(db);
    await db.update(backlogItems).set({ document: "originale" }).where(eq(backlogItems.id, itemId));
    expect(await setBacklogItemDesign(db, itemId, "design 1")).toBe("ok");
    expect(await setBacklogItemDesign(db, itemId, "design 2")).toBe("ok");
    const item = await itemOf(itemId);
    expect([item.document, item.originContent]).toEqual(["design 2", "originale"]);
  });

  it("rimozione: ripristina l'origine; senza design attivo è no_design", async () => {
    const { itemId } = await seedBacklogItem(db);
    await db.update(backlogItems).set({ document: "originale" }).where(eq(backlogItems.id, itemId));
    expect(await removeBacklogItemDesign(db, itemId)).toBe("no_design");
    await setBacklogItemDesign(db, itemId, "design");
    expect(await removeBacklogItemDesign(db, itemId)).toBe("ok");
    const item = await itemOf(itemId);
    expect([item.document, item.originContent]).toEqual(["originale", null]);
  });

  it("con revision: salva {document, originContent} PRECEDENTI nella stessa transazione", async () => {
    const { itemId } = await seedBacklogItem(db);
    await db.update(backlogItems).set({ document: "originale" }).where(eq(backlogItems.id, itemId));
    const agentSessionId = await agentSession(itemId);
    await setBacklogItemDesign(db, itemId, "design", { agentSessionId });
    const [rev] = await revisionsOf(itemId);
    expect(rev).toMatchObject({ field: "document", agentSessionId, previous: { document: "originale", originContent: null } });
  });

  it("senza revision (le rotte): nessuna riga di revisione", async () => {
    const { itemId } = await seedBacklogItem(db);
    await setBacklogItemDesign(db, itemId, "design");
    expect(await revisionsOf(itemId)).toHaveLength(0);
  });

  it("voce inesistente: not_found, niente scritto", async () => {
    expect(await setBacklogItemDesign(db, "7f1c2a1e-0000-4000-8000-0000000000ff", "x")).toBe("not_found");
  });
});

describe("piano", () => {
  it("sostituisce, null azzera, revision col piano precedente", async () => {
    const { itemId } = await seedBacklogItem(db);
    const agentSessionId = await agentSession(itemId);
    await setBacklogItemPlan(db, itemId, "piano 1");
    await setBacklogItemPlan(db, itemId, "piano 2", { agentSessionId });
    expect((await itemOf(itemId)).implementationPlan).toBe("piano 2");
    expect((await revisionsOf(itemId))[0]).toMatchObject({ field: "implementation_plan", previous: { implementationPlan: "piano 1" } });
    await setBacklogItemPlan(db, itemId, null);
    expect((await itemOf(itemId)).implementationPlan).toBeNull();
  });
});

describe("metadati", () => {
  it("aggiorna i soli campi definiti e toglie da suggested quelli decisi", async () => {
    const { itemId } = await seedBacklogItem(db);
    await db.update(backlogItems)
      .set({ suggested: { effort: 3, risk: "high", reason: "perché" } })
      .where(eq(backlogItems.id, itemId));
    await updateBacklogItemMetadata(db, itemId, { effort: 2 });
    const item = await itemOf(itemId);
    expect(item.effort).toBe(2);
    expect(item.suggested).toEqual({ risk: "high", reason: "perché" });
    await updateBacklogItemMetadata(db, itemId, { risk: "low" });
    expect((await itemOf(itemId)).suggested).toBeNull(); // il solo reason non lo tiene vivo
  });

  it("revision: i SOLI campi cambiati, coi valori precedenti", async () => {
    const { itemId } = await seedBacklogItem(db, { title: "Prima" });
    const agentSessionId = await agentSession(itemId);
    await updateBacklogItemMetadata(db, itemId, { title: "Dopo", urgency: "high" }, { revision: { agentSessionId } });
    expect((await revisionsOf(itemId))[0]).toMatchObject({ field: "metadata", previous: { title: "Prima", urgency: null } });
  });

  it("status archived chiama onArchive dentro la transazione", async () => {
    const { itemId } = await seedBacklogItem(db);
    let called = 0;
    await updateBacklogItemMetadata(db, itemId, {}, { status: "archived", onArchive: async () => { called++; } });
    expect(called).toBe(1);
    expect((await itemOf(itemId)).status).toBe("archived");
  });
});
```

Aggiungere `"@stubwise/db": "workspace:*"` con l'export `./testing` già usato da `pr-correction-cycle.test.ts`: nessuna dipendenza nuova.

- [ ] **Step 2: verificare che falliscano**

Run: `pnpm --filter @stubwise/notifications test -- backlog-item-writes`
Expected: FAIL (modulo inesistente).

- [ ] **Step 3: implementazione**

```ts
// packages/notifications/src/backlog-item-writes.ts
import { backlogItemRevisions, backlogItems, type Db } from "@stubwise/db";
import type { BacklogItemStatus, BacklogSuggested, UpdateBacklogItemInput } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { DbOrTx, Tx } from "./dispatch.js";

/**
 * Regole UNICHE di scrittura di design, piano e metadati di una voce di
 * backlog (design 2026-10-14 §4.3). Le usano le rotte del server
 * (`apps/server/src/routes/backlog.ts`) e il ponte dei tool della sessione di
 * refinement nel worker: mai due copie. Con `revision` il valore PRECEDENTE
 * finisce in `backlog_item_revisions`, nella stessa transazione.
 */

export type BacklogItemRevisionSource = { agentSessionId: string };
export type BacklogItemMetadataPatch = Omit<UpdateBacklogItemInput, "status">;
type ItemUpdate = Partial<typeof backlogItems.$inferInsert>;

/**
 * Sempre in transazione: su un `Db` è una transazione nuova, su una `Tx` (il
 * ponte del worker scrive dentro la sua) drizzle apre un SAVEPOINT. Un solo
 * percorso di codice per i due chiamanti.
 */
function inTx<T>(db: DbOrTx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (db as Db).transaction(fn);
}

/** Un `suggested` senza più metadati azionabili diventa null (un `reason` orfano non lo tiene vivo). */
export function hasActionableSuggested(s: BacklogSuggested): boolean {
  return s.effort !== undefined || s.risk !== undefined || s.riskNote !== undefined || s.urgency !== undefined;
}

async function lockItem(tx: DbOrTx, itemId: string) {
  const [item] = await tx.select().from(backlogItems).where(eq(backlogItems.id, itemId)).for("update");
  return item;
}

async function saveRevision(
  tx: DbOrTx,
  itemId: string,
  field: "document" | "implementation_plan" | "metadata",
  previous: Record<string, unknown>,
  revision: BacklogItemRevisionSource | undefined,
): Promise<void> {
  if (revision === undefined) return;
  await tx.insert(backlogItemRevisions).values({ itemId, field, previous, agentSessionId: revision.agentSessionId });
}

export async function setBacklogItemDesign(db: DbOrTx, itemId: string, markdown: string, revision?: BacklogItemRevisionSource) {
  return inTx(db, async (tx) => {
    const item = await lockItem(tx, itemId);
    if (!item) return "not_found" as const;
    await saveRevision(tx, itemId, "document", { document: item.document, originContent: item.originContent }, revision);
    // Preserva l'origine UNA SOLA VOLTA: se già impostata resta com'è.
    await tx.update(backlogItems)
      .set({ document: markdown, originContent: item.originContent ?? item.document })
      .where(eq(backlogItems.id, itemId));
    return "ok" as const;
  });
}

export async function removeBacklogItemDesign(db: DbOrTx, itemId: string) {
  return inTx(db, async (tx) => {
    const item = await lockItem(tx, itemId);
    if (!item) return "not_found" as const;
    if (item.originContent === null) return "no_design" as const;
    await tx.update(backlogItems)
      .set({ document: item.originContent, originContent: null })
      .where(eq(backlogItems.id, itemId));
    return "ok" as const;
  });
}

export async function setBacklogItemPlan(db: DbOrTx, itemId: string, markdown: string | null, revision?: BacklogItemRevisionSource) {
  return inTx(db, async (tx) => {
    const item = await lockItem(tx, itemId);
    if (!item) return "not_found" as const;
    await saveRevision(tx, itemId, "implementation_plan", { implementationPlan: item.implementationPlan }, revision);
    await tx.update(backlogItems).set({ implementationPlan: markdown }).where(eq(backlogItems.id, itemId));
    return "ok" as const;
  });
}

const METADATA_FIELDS = ["title", "effort", "risk", "riskNote", "urgency"] as const;
const SUGGESTED_FIELDS = ["effort", "risk", "riskNote", "urgency"] as const;

export async function updateBacklogItemMetadata(
  db: DbOrTx,
  itemId: string,
  patch: BacklogItemMetadataPatch,
  opts: { status?: BacklogItemStatus; revision?: BacklogItemRevisionSource; onArchive?: (tx: Tx) => Promise<void> } = {},
): Promise<"ok" | "not_found"> {
  return inTx(db, async (tx) => {
    const item = await lockItem(tx, itemId);
    if (!item) return "not_found" as const;
    const updates: ItemUpdate = {};
    const previous: Record<string, unknown> = {};
    for (const field of METADATA_FIELDS) {
      if (patch[field] === undefined) continue;
      (updates as Record<string, unknown>)[field] = patch[field];
      previous[field] = item[field];
    }
    if (opts.status !== undefined) updates.status = opts.status;
    // Azzera in `suggested` i metadati appena decisi (mappa 1:1).
    if (item.suggested && SUGGESTED_FIELDS.some((f) => patch[f] !== undefined)) {
      const next: BacklogSuggested = { ...item.suggested };
      for (const f of SUGGESTED_FIELDS) if (patch[f] !== undefined) delete next[f];
      updates.suggested = hasActionableSuggested(next) ? next : null;
    }
    if (Object.keys(previous).length > 0) await saveRevision(tx, itemId, "metadata", previous, opts.revision);
    if (Object.keys(updates).length > 0) {
      await tx.update(backlogItems).set(updates).where(eq(backlogItems.id, itemId));
    }
    if (opts.status === "archived") await opts.onArchive?.(tx);
    return "ok" as const;
  });
}
```

In `index.ts` del package: `export * from "./backlog-item-writes.js";`.

- [ ] **Step 4: riscrivere le rotte sul modulo**

In `apps/server/src/routes/backlog.ts`:
- `PATCH /:id`: resta il 404 iniziale (select di esistenza) e il 409 `convert_not_allowed` PRIMA di scrivere; poi
  `const res = await updateBacklogItemMetadata(app.db, id, { title, effort, risk, riskNote, urgency }, { ...(status !== undefined ? { status } : {}), onArchive: (tx) => closeOpenBacklogQuestion(tx, id) });` e `not_found` → 404. Togliere il blocco `suggested` locale e la funzione `hasActionableSuggested` del file (ora importata dal modulo, se usata altrove nel file — `grep -n hasActionableSuggested apps/server/src` — importarla da `@stubwise/notifications`).
- `PUT /:id/design` → `setBacklogItemDesign(app.db, id, content)`; `DELETE /:id/design` → `removeBacklogItemDesign` con le stesse mappature (`not_found` → 404 `backlog_item_not_found`, `no_design` → 404 `no_active_design`).
- `PUT /:id/plan` → `setBacklogItemPlan(app.db, id, content)`; `DELETE /:id/plan` → `setBacklogItemPlan(app.db, id, null)`.
- Le risposte restano `loadBaseItem` dopo la scrittura, invariate.

- [ ] **Step 5: verificare**

Run: `pnpm --filter @stubwise/notifications build && pnpm --filter @stubwise/notifications test -- backlog-item-writes && pnpm --filter @stubwise/server test -- routes/backlog.test`
Expected: PASS; i `describe` di `PATCH`, `PUT/DELETE design` e `PUT/DELETE plan` di `backlog.test.ts` passano SENZA modifiche ai test.

- [ ] **Step 6: commit**

```bash
git add packages/notifications apps/server/src/routes/backlog.ts
git commit -m "refactor(backlog): regole di scrittura di design, piano e metadati in un modulo condiviso"
```

---
### Task 4: Runner — `openingInput`, `signal`, deliverable `conversation`

**Files:**
- Modify: `apps/worker/src/agent/runner.ts:80-187` (due opzioni nuove, con docblock)
- Modify: `apps/worker/src/agent/streaming-cli.ts:299-302` (validazione), `:470-500` (`deliver`), `:584` (prompt iniziale), `:586-642` (abort)
- Test: `apps/worker/src/agent/streaming-cli.test.ts` (solo `describe` NUOVI in coda; nessun test esistente cambia)

**Interfaces:**
- Consumes: `SEGMENT_DELIVERABLE.refine = "conversation"` (Task 1).
- Produces: `AgentRunOptions.openingInput`, `AgentRunOptions.signal` (contratto). Il runner storico (`ClaudeCliRunner`) le ignora: il refinement gira solo con lo streaming (Task 10 lo cabla solo con `config.agentStreaming`).

- [ ] **Step 1: test che falliscono**

In coda a `streaming-cli.test.ts` (riusa `fakeClaude`, `recordingHooks`, `base`, `META`, `turnOpen` del file):

```ts
describe("StreamingClaudeRunner — sessioni di refinement", () => {
  const refine = { sessionId: "s1", label: "refine" as const };

  it("openingInput: il prompt va su stdin con uuid = inputId e l'evento input mostra SOLO il testo dell'utente", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 50 });
    await runner.run({
      ...base, cwd, session: refine,
      prompt: "CONTESTO LUNGO DELLA VOCE\n\nciao",
      openingInput: { inputId: META.inputId, text: "ciao", authorUserId: META.authorUserId },
    });
    const inputs = rec.events.filter((e) => e.type === "input");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.data).toMatchObject({ text: "ciao", inputId: META.inputId, authorUserId: META.authorUserId, interrupt: false });
    expect(JSON.stringify(rec.events)).not.toContain("CONTESTO LUNGO");
    expect(rec.notEchoed).toEqual([]);
  });

  it("openingInput senza session: AgentRunError prima dello spawn", async () => {
    const { bin, cwd } = await fakeClaude();
    const runner = new StreamingClaudeRunner({ claudePath: bin });
    await expect(
      runner.run({ ...base, cwd, prompt: "x", openingInput: { inputId: META.inputId, text: "x", authorUserId: null } }),
    ).rejects.toThrow(/openingInput/);
  });

  it("deliverable conversation: dopo il primo result l'intervento entra ancora, SENZA promemoria del deliverable", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 400 });
    const run = runner.run({ ...base, cwd, prompt: "primo", session: refine });
    for (let i = 0; i < 200 && !rec.events.some((e) => e.type === "turn_end"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(rec.handles.get("s1")!.deliver("secondo", false, META)).toBe(true);
    const result = await run;
    expect(result.output).toBe("echo: secondo");
    expect(rec.inputsClosed).toBe(1); // solo alla chiusura di stdin, mai al result
  });

  it("signal: abort a metà turno chiude il processo e il run lancia AgentRunCancelledError", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 50 });
    const controller = new AbortController();
    const run = runner.run({ ...base, timeoutMs: 30_000, cwd, prompt: "HANG", session: refine, signal: controller.signal });
    await turnOpen(rec);
    const started = Date.now();
    controller.abort();
    await expect(run).rejects.toBeInstanceOf(AgentRunCancelledError);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(rec.ended).toBe(1);
    expect(rec.handles.size).toBe(0);
  });

  it("signal già abortito: rifiuta subito, nessun processo", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks });
    const controller = new AbortController();
    controller.abort();
    await expect(
      runner.run({ ...base, cwd, prompt: "x", session: refine, signal: controller.signal }),
    ).rejects.toBeInstanceOf(AgentRunCancelledError);
    expect(rec.starts).toBe(0);
    expect(rec.ended).toBe(0);
  });
});
```

(Se `turnOpen` aspetta un evento che `HANG` non produce, sostituirlo con l'attesa di `rec.starts === 1`: il finto CLI scrive l'`init` al primo messaggio.)

- [ ] **Step 2: verificare che falliscano**

Run: `pnpm --filter @stubwise/worker test -- streaming-cli`
Expected: FAIL nei 5 test nuovi (i vecchi verdi).

- [ ] **Step 3: `runner.ts`**

Dentro `AgentRunOptions`, dopo `session`:

```ts
  /**
   * Il prompt È un messaggio di una persona (sessioni a turni, design
   * 2026-10-14 §3.2): il runner lo scrive su stdin con `uuid = inputId` e lo
   * mette in coda all'eco come un intervento, così l'evento `input` nasce
   * quando il CLI lo prende — col SOLO `text` dell'utente, mai il contesto
   * d'avvio che il prompt può contenere. Senza eco a fine segmento torna al
   * relay (`inputsNotEchoed`). Richiede `session`.
   */
  openingInput?: { inputId: string; text: string; authorUserId: string | null };
  /**
   * Annullamento dall'esterno («Chiudi sessione», voce chiusa): all'abort il
   * runner chiude stdin e termina il processo, e il run rifiuta con
   * `AgentRunCancelledError` (mai un fallimento dell'agente). Già abortito
   * all'ingresso: rifiuta senza avviare il processo.
   */
  signal?: AbortSignal;
```

- [ ] **Step 4: `streaming-cli.ts`**

In `run`, prima di `withMcpConfig`:

```ts
    if (opts.openingInput !== undefined && opts.session === undefined) {
      throw new AgentRunError("openingInput richiede session: l'eco del messaggio va registrata in una sessione");
    }
    if (opts.signal?.aborted === true) throw new AgentRunCancelledError(null, "", 0);
```

In `spawn`, accanto a `outputDeliverable`:

```ts
    /** Il deliverable è la conversazione: niente promemoria sugli interventi (vedi deliver). */
    const conversationDeliverable =
      session !== undefined && SEGMENT_DELIVERABLE[session.label] === "conversation";
```

In `deliver`, al posto della riga che scrive l'intervento:

```ts
        // Il promemoria va SOLO su stdin: evento e commento hanno il testo nudo.
        // Una conversazione non ha un output finale da proteggere: niente promemoria.
        const line = conversationDeliverable ? text : `${text}\n\n${DELIVERABLE_REMINDER}`;
        const ok = write(userMessage(line, meta.inputId));
```

Al posto di `write(userMessage(opts.prompt));`:

```ts
    const opening = opts.openingInput;
    if (opening !== undefined) {
      // In coda all'eco PRIMA della scrittura: l'eco può arrivare subito.
      awaitingEcho.set(opening.inputId, {
        text: opening.text,
        interrupt: false,
        meta: { inputId: opening.inputId, authorUserId: opening.authorUserId },
      });
    }
    write(userMessage(opts.prompt, opening?.inputId));
    armActive();
    let abortedBySignal = false;
    const onAbort = () => {
      abortedBySignal = true;
      if (pause !== null) {
        clearTimeout(pause.timer);
        pause = null;
      }
      closeStdinAfterResult();
      // SIGTERM, poi SIGKILL dopo `forceKillAfterDelay`, come il timeout.
      child.kill();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
```

Nel `try` dopo `await sink.onEnd(...)`, PRIMA del controllo `cancelledBy`:

```ts
      if (abortedBySignal) throw new AgentRunCancelledError(null, fallbackOutput(), 0);
```

Nel `finally`, come prima riga: `opts.signal?.removeEventListener("abort", onAbort);`.

(Il messaggio di `AgentRunCancelledError` parla di «Ferma»: chi lo intercetta nel refinement — Task 9 — non lo mostra a nessuno, lo traduce in esito `cancelled`.)

- [ ] **Step 5: verificare**

Run: `pnpm --filter @stubwise/worker test -- streaming-cli claude-cli`
Expected: PASS, tutti, vecchi e nuovi.

- [ ] **Step 6: commit**

```bash
git add apps/worker/src/agent
git commit -m "feat(worker): runner con messaggio d'apertura, annullamento e deliverable conversazione"
```

---

### Task 5: Relay — sessioni a turni

**Files:**
- Modify: `apps/worker/src/sessions/relay.ts`
- Test: `apps/worker/src/sessions/relay.test.ts` (un `describe` nuovo in coda; i test esistenti non cambiano)

**Interfaces:**
- Consumes: `TURN_BASED_SESSION_KINDS` (Task 1).
- Produces: `TurnStarter`, `deps.turnStarter` (contratto). Lo scheduler (Task 10) lo implementa; `index.ts` lo passa (Task 10).

Le tre regole (spec §3.2), SOLO per sessioni il cui kind è in `TURN_BASED_SESSION_KINDS` E con un `turnStarter` configurato (senza: comportamento di oggi):
1. nessun handle → l'input resta `pending` e si chiede un turno (UNA `requestTurn` per sessione e per passata). Eccezione: lo «Ferma» senza testo (`text === ""`) non ha niente da fermare e resta `undelivered`/`session_not_live` come oggi;
2. `deliver()` false → la riga reclamata torna da `delivered` a `pending` + `requestTurn` (lo «Ferma» senza testo: come oggi);
3. `inputsNotEchoed` → `pending` invece di `undelivered` + `requestTurn`.

`requestTurn` mentre il turno è ancora vivo è un no-op dello scheduler: il turno dopo parte quando lo scheduler, a fine turno, rilancia `deliverPending(sessionId)` (Task 10). Il kind di una sessione non cambia mai: si tiene in una cache in memoria (svuotata oltre 10 000 voci, per non crescere senza fine).

- [ ] **Step 1: test che falliscono**

In coda a `relay.test.ts`:

```ts
describe("SessionInputRelay — sessioni a turni (backlog_refine)", () => {
  async function refineSession() {
    return (await ensureAgentSession(t.db, {
      ownerKey: `backlog_refine:${crypto.randomUUID()}`,
      kind: "backlog_refine",
      title: "t",
    }))!;
  }
  function starter() {
    const calls: string[] = [];
    return { calls, turnStarter: { requestTurn: (id: string) => void calls.push(id) } };
  }

  it("nessun processo: gli input restano pending e si chiede UN turno per la sessione", async () => {
    const s = await refineSession();
    const a = await addInput(s, "uno");
    const b = await addInput(s, "due");
    const { calls, turnStarter } = starter();
    await new SessionInputRelay({ db: t.db, turnStarter }).deliverPending();
    expect((await rowOf(a)).status).toBe("pending");
    expect((await rowOf(b)).status).toBe("pending");
    expect(calls).toEqual([s]);
  });

  it("lo stesso per una sessione ai_job resta undelivered/session_not_live, e nessun turno", async () => {
    const s = await newSession(`ai_job:${crypto.randomUUID()}`);
    const id = await addInput(s, "x");
    const { calls, turnStarter } = starter();
    await new SessionInputRelay({ db: t.db, turnStarter }).deliverPending(s);
    expect(await rowOf(id)).toMatchObject({ status: "undelivered", reason: "session_not_live" });
    expect(calls).toEqual([]);
  });

  it("senza turnStarter configurato: comportamento di oggi anche per backlog_refine", async () => {
    const s = await refineSession();
    const id = await addInput(s, "x");
    await new SessionInputRelay({ db: t.db }).deliverPending(s);
    expect(await rowOf(id)).toMatchObject({ status: "undelivered", reason: "session_not_live" });
  });

  it("«Ferma» senza testo a processo uscito: undelivered, nessun turno", async () => {
    const s = await refineSession();
    const [row] = await t.db.insert(agentSessionInputs)
      .values({ sessionId: s, text: "", interrupt: true, authorUserId: userId }).returning();
    const { calls, turnStarter } = starter();
    await new SessionInputRelay({ db: t.db, turnStarter }).deliverPending(s);
    expect(await rowOf(row!.id)).toMatchObject({ status: "undelivered", reason: "session_not_live" });
    expect(calls).toEqual([]);
  });

  it("deliver false (il turno sta finendo): la riga torna pending e si chiede il turno dopo", async () => {
    const s = await refineSession();
    const id = await addInput(s, "tardi");
    const { calls, turnStarter } = starter();
    const relay = new SessionInputRelay({ db: t.db, turnStarter });
    const unregister = relay.register(s, { label: "refine", deliver: () => false });
    await relay.deliverPending(s);
    expect(await rowOf(id)).toMatchObject({ status: "pending", reason: null, deliveredAt: null });
    expect(calls).toContain(s);
    unregister();
  });

  it("senza eco a fine segmento: pending invece di undelivered, e un turno chiesto", async () => {
    const s = await refineSession();
    const id = await addInput(s, "mai preso");
    await t.db.update(agentSessionInputs).set({ status: "delivered", deliveredAt: new Date() })
      .where(eq(agentSessionInputs.id, id));
    const { calls, turnStarter } = starter();
    await new SessionInputRelay({ db: t.db, turnStarter }).inputsNotEchoed(s, [id]);
    expect(await rowOf(id)).toMatchObject({ status: "pending", deliveredAt: null });
    expect(calls).toEqual([s]);
  });

  it("processo vivo: consegna normale (intervento), nessun turno chiesto", async () => {
    const s = await refineSession();
    const id = await addInput(s, "dentro");
    const got: string[] = [];
    const { calls, turnStarter } = starter();
    const relay = new SessionInputRelay({ db: t.db, turnStarter });
    const unregister = relay.register(s, { label: "refine", deliver: (text) => (got.push(text), true) });
    await relay.deliverPending(s);
    expect(got).toEqual(["dentro"]);
    expect((await rowOf(id)).status).toBe("delivered");
    expect(calls).toEqual([]);
    unregister();
  });
});
```

(Gli import mancanti in testa al file: `randomUUID` da `node:crypto` al posto di `crypto.randomUUID` se il lint lo chiede. `register` chiama già `deliverPending` da sé: i test che lo usano aspettano la loro `deliverPending` esplicita, che trova le righe già reclamate e non fa nulla di doppio.)

- [ ] **Step 2: verificare che falliscano**

Run: `pnpm --filter @stubwise/worker test -- sessions/relay`
Expected: FAIL nei test nuovi.

- [ ] **Step 3: implementazione**

```ts
// in testa
import { TURN_BASED_SESSION_KINDS, type AgentSessionKind } from "@stubwise/shared";

/**
 * Avvia un turno di una sessione A TURNI (design 2026-10-14 §3.2): lo
 * implementa lo scheduler del refinement. Sincrono e idempotente: con un turno
 * già in avvio o in corso sulla sessione non fa niente.
 */
export interface TurnStarter {
  requestTurn(sessionId: string): void;
}

const KIND_CACHE_MAX = 10_000;
```

Docblock del modulo, in coda: «Sessioni A TURNI (`TURN_BASED_SESSION_KINDS`, con `turnStarter` configurato): un input senza processo, rifiutato da `deliver` o rimasto senza eco NON diventa `undelivered` — resta/torna `pending` e diventa un turno (`TurnStarter`). Un messaggio non si perde e non entra in due turni: il claim resta l'unico punto di passaggio a `delivered`.»

Nella classe:

```ts
  /** Kind per sessione: non cambia mai, si chiede al DB una volta. */
  private readonly kinds = new Map<string, AgentSessionKind>();

  /** Le sessioni (fra quelle date) con le regole a turni. Vuoto senza turnStarter. */
  private async turnBasedOf(sessionIds: Iterable<string>): Promise<Set<string>> {
    if (this.deps.turnStarter === undefined) return new Set();
    const ids = [...new Set(sessionIds)];
    const unknown = ids.filter((id) => !this.kinds.has(id));
    if (unknown.length > 0) {
      if (this.kinds.size > KIND_CACHE_MAX) this.kinds.clear();
      const rows = await this.deps.db
        .select({ id: agentSessions.id, kind: agentSessions.kind })
        .from(agentSessions)
        .where(inArray(agentSessions.id, unknown));
      for (const r of rows) this.kinds.set(r.id, r.kind);
    }
    return new Set(ids.filter((id) => {
      const kind = this.kinds.get(id);
      return kind !== undefined && TURN_BASED_SESSION_KINDS.has(kind);
    }));
  }

  /** Riporta a `pending` una riga reclamata e mai entrata. */
  private async backToPending(input: InputRow): Promise<void> {
    const updated = await this.deps.db
      .update(agentSessionInputs)
      .set({ status: "pending", deliveredAt: null })
      .where(and(eq(agentSessionInputs.id, input.id), eq(agentSessionInputs.status, "delivered")))
      .returning({ id: agentSessionInputs.id });
    if (updated.length > 0) await this.notifyChanged(input.sessionId);
  }
```

`deps` guadagna `turnStarter?: TurnStarter;`. In `deliverPending`, dopo la select:

```ts
      const turnBased = await this.turnBasedOf(pending.map((p) => p.sessionId));
      const requested = new Set<string>();
      const requestTurn = (id: string) => {
        if (requested.has(id)) return;
        requested.add(id);
        this.deps.turnStarter?.requestTurn(id);
      };
      /** Un messaggio con testo di una sessione a turni: mai `undelivered` per tempismo. */
      const becomesTurn = (input: InputRow) => turnBased.has(input.sessionId) && input.text !== "";
```

e nel ciclo:

```ts
        if (!handle) {
          if (becomesTurn(input)) {
            requestTurn(input.sessionId);
            continue;
          }
          await this.markUndelivered(input, "session_not_live", "pending");
          continue;
        }
        // …claim invariato…
        if (!ok) {
          if (becomesTurn(input)) {
            await this.backToPending(input);
            requestTurn(input.sessionId);
            continue;
          }
          // …ramo stdin_closed invariato…
        }
```

In `inputsNotEchoed`, in testa dopo il controllo della lista vuota:

```ts
    if ((await this.turnBasedOf([sessionId])).has(sessionId)) {
      const back = await this.deps.db
        .update(agentSessionInputs)
        .set({ status: "pending", deliveredAt: null })
        .where(and(
          eq(agentSessionInputs.sessionId, sessionId),
          inArray(agentSessionInputs.id, inputIds),
          eq(agentSessionInputs.status, "delivered"),
        ))
        .returning({ id: agentSessionInputs.id });
      if (back.length > 0) {
        await this.notifyChanged(sessionId);
        this.deps.turnStarter?.requestTurn(sessionId);
      }
      return;
    }
```

(Solo righe con testo arrivano qui: lo «Ferma» senza testo non è mai in attesa d'eco.)

- [ ] **Step 4: verificare**

Run: `pnpm --filter @stubwise/worker test -- sessions/relay`
Expected: PASS, vecchi e nuovi.

- [ ] **Step 5: commit**

```bash
git add apps/worker/src/sessions/relay.ts apps/worker/src/sessions/relay.test.ts
git commit -m "feat(worker): il relay passa allo scheduler i messaggi delle sessioni a turni"
```

---

### Task 6: Ponte HTTP e server MCP dei tool

**Files:**
- Create: `apps/worker/src/refine-mcp/server.ts`, `apps/worker/src/refine-mcp/index.ts`
- Create: `apps/worker/src/backlog/refine/bridge.ts`
- Test: `apps/worker/src/refine-mcp/server.test.ts`, `apps/worker/src/backlog/refine/bridge.test.ts`

**Interfaces:**
- Consumes: `refineSetDocInputSchema`, `refineUpdateItemInputSchema`, `REFINE_MCP_SERVER_NAME`, `REFINE_TOOLS`, `REFINE_TOOL_NAMES`, `AGENT_SESSION_EVENTS_CHANNEL` (Task 1); `backlogRefineSessions` (Task 2); `setBacklogItemDesign`/`setBacklogItemPlan`/`updateBacklogItemMetadata` (Task 3); `AgentMcpConfig` (`agent/runner.ts`).
- Produces: `startRefineBridge`, `RefineBridge`, `RefineTurnGrant`, `refineServerPath`, `buildRefineMcpConfig` (contratto).

Il server MCP NON valida niente di sostanza e non vede il DB: inoltra gli argomenti al ponte e restituisce all'agente la risposta del ponte (testo, con `isError` sugli errori), così l'agente si corregge nello stesso turno. Chi valida è il ponte, con gli schemi di shared. Il server MCP è autonomo come `ask-user-mcp` (solo SDK, zod, node: niente pacchetti del workspace). Nessun `readOnlyHint`: il turno non è in plan mode (spec §4.2), e lì l'annotazione non serve a renderli chiamabili; li abilita l'`allowedTools`.

Risposte del ponte (testo per l'agente, in inglese come il contratto dei run):

| Caso | HTTP | Corpo |
|---|---|---|
| ok | 200 | `{ ok: true, message: "Design saved on the backlog item." }` (o `Plan saved…`, `Item updated: title, effort.`) |
| tool sconosciuto / metodo | 404 | `{ ok: false, error: "not_found" }` |
| segreto assente, sbagliato o revocato | 401 | `{ ok: false, error: "unauthorized" }` |
| body oltre il tetto | 413 | `{ ok: false, error: "too_large" }` |
| JSON rotto o schema violato | 400 | `{ ok: false, error: "invalid_input", message: "<path>: <messaggio zod>; …" }` |
| sessione chiusa | 409 | `{ ok: false, error: "session_closed", message: "This refinement session is closed: nothing was saved." }` |
| voce convertita o archiviata | 409 | `{ ok: false, error: "item_closed", message: "The backlog item is converted or archived: nothing was saved." }` |

- [ ] **Step 1: test che falliscono — ponte**

```ts
// apps/worker/src/backlog/refine/bridge.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentSessions, backlogItemRevisions, backlogItems, backlogRefineSessions } from "@stubwise/db";
import { seedBacklogItem, startTestDb, type TestDb } from "@stubwise/db/testing";
import { AGENT_SESSION_EVENTS_CHANNEL } from "@stubwise/shared";
import { startRefineBridge, type RefineBridge } from "./bridge.js";

let t: TestDb;
let bridge: RefineBridge;
beforeAll(async () => { t = await startTestDb(); bridge = await startRefineBridge({ db: t.db }); }, 120_000);
afterAll(async () => { await bridge.close(); await t.stop(); });

async function seeded(status: "active" | "closed" = "active") {
  const { itemId } = await seedBacklogItem(t.db);
  await t.db.update(backlogItems).set({ document: "originale" }).where(eq(backlogItems.id, itemId));
  const [s] = await t.db.insert(agentSessions)
    .values({ ownerKey: `backlog_refine:${itemId}`, kind: "backlog_refine", title: "t", backlogItemId: itemId }).returning();
  await t.db.insert(backlogRefineSessions).values({
    itemId, agentSessionId: s!.id, status,
    lastActivityAt: new Date(Date.now() - 3_600_000),
    ...(status === "closed" ? { closedAt: new Date(), closedReason: "user" as const } : {}),
  });
  return { itemId, agentSessionId: s!.id };
}
const call = (tool: string, secret: string | null, body: unknown) =>
  fetch(`${bridge.url}/tools/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const itemOf = async (id: string) => (await t.db.select().from(backlogItems).where(eq(backlogItems.id, id)))[0]!;

describe("ponte dei tool di refinement", () => {
  it("ascolta solo su loopback", () => {
    expect(new URL(bridge.url).hostname).toBe("127.0.0.1");
  });

  it("set_design: scrive, preserva l'origine, salva la revisione, tocca l'attività e notifica la sessione", async () => {
    const { itemId, agentSessionId } = await seeded();
    const notified: string[] = [];
    const sub = await t.client.listen(AGENT_SESSION_EVENTS_CHANNEL, (p) => notified.push(p));
    const grant = bridge.grant({ agentSessionId, itemId });
    const res = await call("set_design", grant.secret, { markdown: "# Design" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    const item = await itemOf(itemId);
    expect([item.document, item.originContent]).toEqual(["# Design", "originale"]);
    const [rev] = await t.db.select().from(backlogItemRevisions).where(eq(backlogItemRevisions.itemId, itemId));
    expect(rev).toMatchObject({ field: "document", agentSessionId });
    const [row] = await t.db.select().from(backlogRefineSessions).where(eq(backlogRefineSessions.itemId, itemId));
    expect(Date.now() - row!.lastActivityAt.getTime()).toBeLessThan(60_000);
    await new Promise((r) => setTimeout(r, 200));
    expect(notified.map((p) => JSON.parse(p).sessionId)).toContain(agentSessionId);
    await sub.unlisten();
  });

  it("segreto assente, sbagliato, revocato o della sessione revocata: 401 e niente scritto", async () => {
    const { itemId, agentSessionId } = await seeded();
    const grant = bridge.grant({ agentSessionId, itemId });
    expect((await call("set_plan", null, { markdown: "p" })).status).toBe(401);
    expect((await call("set_plan", grant.secret + "x", { markdown: "p" })).status).toBe(401);
    grant.revoke();
    expect((await call("set_plan", grant.secret, { markdown: "p" })).status).toBe(401);
    const other = bridge.grant({ agentSessionId, itemId });
    bridge.revokeSession(agentSessionId);
    expect((await call("set_plan", other.secret, { markdown: "p" })).status).toBe(401);
    expect((await itemOf(itemId)).implementationPlan).toBeNull();
  });

  it("sessione chiusa: 409 session_closed, niente scritto", async () => {
    const { itemId, agentSessionId } = await seeded("closed");
    const grant = bridge.grant({ agentSessionId, itemId });
    const res = await call("set_plan", grant.secret, { markdown: "p" });
    expect([res.status, (await res.json()).error]).toEqual([409, "session_closed"]);
    expect((await itemOf(itemId)).implementationPlan).toBeNull();
  });

  it("voce convertita (o archiviata): 409 item_closed, niente scritto", async () => {
    const { itemId, agentSessionId } = await seeded();
    await t.db.update(backlogItems).set({ status: "converted" }).where(eq(backlogItems.id, itemId));
    const grant = bridge.grant({ agentSessionId, itemId });
    const res = await call("update_item", grant.secret, { title: "Nuovo" });
    expect([res.status, (await res.json()).error]).toEqual([409, "item_closed"]);
    expect((await itemOf(itemId)).title).toBe("Voce di test");
  });

  it("input non valido: 400 col dettaglio per l'agente; JSON rotto: 400; troppo grande: 413", async () => {
    const { itemId, agentSessionId } = await seeded();
    const grant = bridge.grant({ agentSessionId, itemId });
    const bad = await call("update_item", grant.secret, { effort: 9 });
    expect(bad.status).toBe(400);
    expect((await bad.json()).message).toMatch(/effort/);
    expect((await call("set_design", grant.secret, "{rotto")).status).toBe(400);
    expect((await call("set_design", grant.secret, { markdown: "x".repeat(1_000_000) })).status).toBe(413);
  });

  it("update_item: scrive i metadati e la revisione coi valori precedenti", async () => {
    const { itemId, agentSessionId } = await seeded();
    const grant = bridge.grant({ agentSessionId, itemId });
    const res = await call("update_item", grant.secret, { effort: 2, risk: "low", riskNote: "poco" });
    expect(res.status).toBe(200);
    const item = await itemOf(itemId);
    expect([item.effort, item.risk, item.riskNote]).toEqual([2, "low", "poco"]);
    const [rev] = await t.db.select().from(backlogItemRevisions).where(eq(backlogItemRevisions.itemId, itemId));
    expect(rev).toMatchObject({ field: "metadata", previous: { effort: null, risk: null, riskNote: null } });
  });

  it("tool sconosciuto: 404", async () => {
    const { itemId, agentSessionId } = await seeded();
    const grant = bridge.grant({ agentSessionId, itemId });
    expect((await call("delete_item", grant.secret, {})).status).toBe(404);
  });
});
```

- [ ] **Step 2: test che falliscono — server MCP e config**

```ts
// apps/worker/src/refine-mcp/server.test.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { buildRefineMcpServer, loadRefineMcpConfig } from "./server.js";

async function connect(fetchImpl: typeof fetch) {
  const server = buildRefineMcpServer({ bridgeUrl: "http://127.0.0.1:9", secret: "s3cret" }, fetchImpl);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe("server MCP stubwise_refine", () => {
  it("espone i tre tool", async () => {
    const client = await connect(vi.fn());
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["set_design", "set_plan", "update_item"]);
  });

  it("inoltra al ponte col segreto e restituisce il messaggio", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ ok: true, message: "Plan saved on the backlog item." }), { status: 200 }));
    const client = await connect(fetchImpl);
    const res = await client.callTool({ name: "set_plan", arguments: { markdown: "# P" } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:9/tools/set_plan");
    expect(new Headers(init!.headers).get("authorization")).toBe("Bearer s3cret");
    expect(JSON.parse(String(init!.body))).toEqual({ markdown: "# P" });
    expect(res.isError).toBeFalsy();
    expect(JSON.stringify(res.content)).toContain("Plan saved");
  });

  it("un errore del ponte arriva all'agente come isError col messaggio", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ ok: false, error: "item_closed", message: "The backlog item is converted" }), { status: 409 }));
    const client = await connect(fetchImpl);
    const res = await client.callTool({ name: "update_item", arguments: { title: "x" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("converted");
  });

  it("ponte irraggiungibile: isError, mai un'eccezione che chiude il server", async () => {
    const client = await connect(vi.fn<typeof fetch>(async () => { throw new Error("ECONNREFUSED"); }));
    const res = await client.callTool({ name: "set_design", arguments: { markdown: "x" } });
    expect(res.isError).toBe(true);
  });

  it("config: URL e segreto obbligatori", () => {
    expect(() => loadRefineMcpConfig({})).toThrow(/REFINE_BRIDGE_URL/);
    expect(loadRefineMcpConfig({ REFINE_BRIDGE_URL: "http://127.0.0.1:1", REFINE_BRIDGE_SECRET: "s" }))
      .toEqual({ bridgeUrl: "http://127.0.0.1:1", secret: "s" });
  });
});
```

E in `bridge.test.ts` (import in più: `mkdtemp`, `rm`, `writeFile` da `node:fs/promises`, `tmpdir` da `node:os`, `join` da `node:path`, `REFINE_TOOL_NAMES` da `@stubwise/shared`, `buildRefineMcpConfig` da `./bridge.js`):

```ts
describe("buildRefineMcpConfig", () => {
  it("null se l'entry non esiste (sviluppo con tsx): nessun server MCP fantasma", () => {
    const grant = bridge.grant({ agentSessionId: "a", itemId: "b" });
    expect(buildRefineMcpConfig(bridge, grant, "/nope/index.js")).toBeNull();
  });
  it("l'env del server MCP porta SOLO URL e segreto del ponte", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refine-mcp-"));
    const entry = join(dir, "index.js");
    await writeFile(entry, "");
    const grant = bridge.grant({ agentSessionId: "a", itemId: "b" });
    const cfg = buildRefineMcpConfig(bridge, grant, entry)!;
    const server = cfg.mcpConfig.servers["stubwise_refine"]!;
    expect(Object.keys(server.env!).sort()).toEqual(["REFINE_BRIDGE_SECRET", "REFINE_BRIDGE_URL"]);
    expect(server.env!["REFINE_BRIDGE_SECRET"]).toBe(grant.secret);
    expect(cfg.tools).toEqual(REFINE_TOOL_NAMES);
    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 3: verificare che falliscano**

Run: `pnpm --filter @stubwise/worker test -- refine-mcp backlog/refine/bridge`
Expected: FAIL (moduli inesistenti).

- [ ] **Step 4: implementazione — server MCP**

```ts
// apps/worker/src/refine-mcp/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Server MCP `stubwise_refine` (design 2026-10-14 §4.3): i tre tool con cui
 * l'agente di una sessione di refinement scrive design, piano e metadati
 * della voce. Non vede il DB né credenziali: inoltra al PONTE HTTP del worker
 * (loopback, segreto per turno) e restituisce all'agente la sua risposta. La
 * validazione vera sta nel ponte; gli schemi qui servono solo a dire al CLI
 * che forma hanno gli argomenti. Nomi tenuti allineati a mano con
 * `REFINE_MCP_SERVER_NAME`/`REFINE_TOOLS` di `@stubwise/shared` (il test di
 * `bridge.test.ts` lo verifica attraverso `buildRefineMcpConfig`): questo
 * entry resta autonomo come `ask-user-mcp`.
 */
export const REFINE_SERVER_NAME = "stubwise_refine";
const VERSION = "1.0.0";
const BRIDGE_TIMEOUT_MS = 30_000;

export interface RefineMcpConfig { bridgeUrl: string; secret: string }

export function loadRefineMcpConfig(env: NodeJS.ProcessEnv): RefineMcpConfig {
  const bridgeUrl = env["REFINE_BRIDGE_URL"];
  const secret = env["REFINE_BRIDGE_SECRET"];
  if (!bridgeUrl) throw new Error("REFINE_BRIDGE_URL mancante");
  if (!secret) throw new Error("REFINE_BRIDGE_SECRET mancante");
  return { bridgeUrl, secret };
}

const docShape = {
  markdown: z.string().min(1).describe("The full document, in Markdown. It replaces the current one."),
};
const itemShape = {
  title: z.string().optional(),
  effort: z.number().int().nullable().optional().describe("1-5, null to clear"),
  risk: z.enum(["low", "medium", "high"]).nullable().optional(),
  riskNote: z.string().nullable().optional(),
  urgency: z.enum(["low", "medium", "high", "urgent"]).nullable().optional(),
};

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

async function forward(config: RefineMcpConfig, fetchImpl: typeof fetch, tool: string, args: unknown): Promise<ToolResult> {
  try {
    const res = await fetchImpl(`${config.bridgeUrl}/tools/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.secret}` },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
    if (res.ok && body.ok === true) return { content: [{ type: "text", text: body.message ?? "Saved." }] };
    return {
      content: [{ type: "text", text: `Not saved (${body.error ?? res.status}): ${body.message ?? ""}`.trim() }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Not saved: the Stubwise bridge is unreachable (${error instanceof Error ? error.message : String(error)}).` }],
      isError: true,
    };
  }
}

export function buildRefineMcpServer(config: RefineMcpConfig, fetchImpl: typeof fetch = fetch): McpServer {
  const server = new McpServer({ name: REFINE_SERVER_NAME, version: VERSION });
  const register = (name: string, description: string, inputSchema: Record<string, z.ZodTypeAny>) =>
    server.registerTool(
      name,
      { description, inputSchema },
      ((args: Record<string, unknown>) => forward(config, fetchImpl, name, args)) as Parameters<McpServer["registerTool"]>[2],
    );
  register("set_design", "Save the design document of the backlog item (replaces the current one; the previous version is kept by Stubwise). Use it when the design is mature, and say so in the chat.", docShape);
  register("set_plan", "Save the implementation plan of the backlog item (replaces the current one; the previous version is kept by Stubwise).", docShape);
  register("update_item", "Update the item's title, effort (1-5), risk (+ riskNote) or urgency. Only the fields you pass change.", itemShape);
  return server;
}
```

`index.ts`: la copia di `apps/worker/src/ask-user-mcp/index.ts` con `loadRefineMcpConfig`/`buildRefineMcpServer` e il prefisso `refine-mcp:` nell'errore (stesso docblock sull'invariante di stdout, adattato).

(Se `effortSchema` ha un intervallo diverso da 1–5, la descrizione segue lui: `grep -n "effortSchema =" packages/shared/src/schemas/ticket.ts`.)

- [ ] **Step 5: implementazione — ponte**

```ts
// apps/worker/src/backlog/refine/bridge.ts
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { backlogItems, backlogRefineSessions, type Db } from "@stubwise/db";
import { setBacklogItemDesign, setBacklogItemPlan, updateBacklogItemMetadata } from "@stubwise/notifications";
import {
  AGENT_SESSION_EVENTS_CHANNEL,
  REFINE_DOC_MAX_CHARS,
  REFINE_MCP_SERVER_NAME,
  REFINE_TOOL_NAMES,
  refineSetDocInputSchema,
  refineUpdateItemInputSchema,
} from "@stubwise/shared";
import type { ZodError } from "zod";
import type { AgentMcpConfig } from "../../agent/runner.js";

/**
 * PONTE dei tool di refinement (design 2026-10-14 §4.3): un endpoint HTTP SOLO
 * su loopback, nel processo del worker, a cui il server MCP `stubwise_refine`
 * (figlio del CLI) inoltra le chiamate. Il server MCP non vede né il DB né
 * credenziali: riceve via env solo l'URL e un SEGRETO CASUALE PER TURNO, che
 * vale per una sola sessione e una sola voce e che il worker revoca a fine
 * turno (`grant().revoke()`) o alla chiusura (`revokeSession`). Il segreto
 * finisce nel file temporaneo della config MCP del run, come ogni env di un
 * server MCP.
 *
 * Ogni scrittura: segreto valido → sessione `active` e voce aperta (nella
 * STESSA transazione della scrittura, con la riga della sessione in lock) →
 * regole condivise con le rotte (`@stubwise/notifications`) con revisione →
 * `last_activity_at` → NOTIFY degli eventi della sessione (pagina della voce e
 * riquadro della sessione si rileggono). Risponde SUBITO all'agente, ok o
 * errore preciso, così si corregge nello stesso turno.
 */

const MAX_BODY_BYTES = REFINE_DOC_MAX_CHARS * 4 + 16_384;
const moduleDir = dirname(fileURLToPath(import.meta.url));

export interface RefineTurnGrant { secret: string; revoke(): void }
export interface RefineBridge {
  readonly url: string;
  grant(turn: { agentSessionId: string; itemId: string }): RefineTurnGrant;
  revokeSession(agentSessionId: string): void;
  close(): Promise<void>;
}

/** `dist/backlog/refine/bridge.js` → `dist/refine-mcp/index.js` (vedi `askUserServerPath`). */
export function refineServerPath(): string {
  return join(moduleDir, "..", "..", "refine-mcp", "index.js");
}

export function buildRefineMcpConfig(
  bridge: RefineBridge,
  grant: RefineTurnGrant,
  serverPath: string,
): { mcpConfig: AgentMcpConfig; tools: readonly string[] } | null {
  if (!existsSync(serverPath)) return null;
  return {
    mcpConfig: {
      servers: {
        [REFINE_MCP_SERVER_NAME]: {
          command: process.execPath,
          args: [serverPath],
          env: { REFINE_BRIDGE_URL: bridge.url, REFINE_BRIDGE_SECRET: grant.secret },
        },
      },
    },
    tools: REFINE_TOOL_NAMES,
  };
}

type Reply = { status: number; body: Record<string, unknown> };
const fail = (status: number, error: string, message?: string): Reply =>
  ({ status, body: { ok: false, error, ...(message !== undefined ? { message } : {}) } });
const zodMessage = (e: ZodError) =>
  e.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`).join("; ");

function readBody(req: IncomingMessage): Promise<string | "too_large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { resolve("too_large"); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startRefineBridge(deps: { db: Db; log?: (m: string) => void }): Promise<RefineBridge> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const grants = new Map<string, { agentSessionId: string; itemId: string }>();

  /** Confronto a tempo costante contro OGNI segreto vivo. */
  const turnOf = (header: string | undefined) => {
    const given = header?.startsWith("Bearer ") ? Buffer.from(header.slice(7)) : null;
    if (given === null) return undefined;
    let found: { agentSessionId: string; itemId: string } | undefined;
    for (const [secret, turn] of grants) {
      const expected = Buffer.from(secret);
      if (expected.length === given.length && timingSafeEqual(expected, given)) found = turn;
    }
    return found;
  };

  async function handle(req: IncomingMessage): Promise<Reply> {
    const match = /^\/tools\/(set_design|set_plan|update_item)$/.exec(req.url ?? "");
    if (req.method !== "POST" || match === null) return fail(404, "not_found");
    const turn = turnOf(req.headers.authorization);
    if (turn === undefined) return fail(401, "unauthorized");
    const raw = await readBody(req);
    if (raw === "too_large") return fail(413, "too_large", `The document exceeds ${REFINE_DOC_MAX_CHARS} characters.`);
    let json: unknown;
    try { json = JSON.parse(raw); } catch { return fail(400, "invalid_input", "The body is not valid JSON."); }
    const tool = match[1] as "set_design" | "set_plan" | "update_item";
    const parsed = tool === "update_item" ? refineUpdateItemInputSchema.safeParse(json) : refineSetDocInputSchema.safeParse(json);
    if (!parsed.success) return fail(400, "invalid_input", zodMessage(parsed.error));

    return deps.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ status: backlogRefineSessions.status, itemStatus: backlogItems.status })
        .from(backlogRefineSessions)
        .innerJoin(backlogItems, eq(backlogItems.id, backlogRefineSessions.itemId))
        .where(and(
          eq(backlogRefineSessions.agentSessionId, turn.agentSessionId),
          eq(backlogRefineSessions.itemId, turn.itemId),
        ))
        .for("update", { of: backlogRefineSessions });
      if (!row || row.status !== "active") {
        return fail(409, "session_closed", "This refinement session is closed: nothing was saved.");
      }
      if (row.itemStatus === "converted" || row.itemStatus === "archived") {
        return fail(409, "item_closed", "The backlog item is converted or archived: nothing was saved.");
      }
      const revision = { agentSessionId: turn.agentSessionId };
      let message: string;
      if (tool === "update_item") {
        const patch = parsed.data as Parameters<typeof updateBacklogItemMetadata>[2];
        await updateBacklogItemMetadata(tx, turn.itemId, patch, { revision });
        message = `Item updated: ${Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined).join(", ")}.`;
      } else {
        const { markdown } = parsed.data as { markdown: string };
        if (tool === "set_design") await setBacklogItemDesign(tx, turn.itemId, markdown, revision);
        else await setBacklogItemPlan(tx, turn.itemId, markdown, revision);
        message = tool === "set_design" ? "Design saved on the backlog item." : "Plan saved on the backlog item.";
      }
      await tx.update(backlogRefineSessions)
        .set({ lastActivityAt: sql`now()` })
        .where(eq(backlogRefineSessions.agentSessionId, turn.agentSessionId));
      // Dentro la transazione: parte al commit, mai prima che la scrittura si veda.
      await tx.execute(sql`select pg_notify(${AGENT_SESSION_EVENTS_CHANNEL}, ${JSON.stringify({ sessionId: turn.agentSessionId })})`);
      return { status: 200, body: { ok: true, message } };
    });
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(req)
      .catch((error: unknown): Reply => {
        log(`refine bridge: scrittura fallita: ${error instanceof Error ? error.message : String(error)}`);
        return fail(500, "internal", "Stubwise could not save it; try again.");
      })
      .then((reply) => {
        if (res.headersSent) return;
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.body));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("refine bridge: indirizzo non disponibile");

  return {
    url: `http://127.0.0.1:${address.port}`,
    grant(turn) {
      const secret = randomBytes(32).toString("hex");
      grants.set(secret, turn);
      return { secret, revoke: () => void grants.delete(secret) };
    },
    revokeSession(agentSessionId) {
      for (const [secret, turn] of grants) if (turn.agentSessionId === agentSessionId) grants.delete(secret);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
```

(Il 413 col client che ha già finito di mandare: `req.destroy()` può chiudere il socket prima della risposta; se il test vede un errore di rete invece del 413, sostituire `req.destroy()` con `req.resume()` — scarta il resto senza tenerlo — e lasciare la risposta. Il punto è non accumulare oltre il tetto.)

- [ ] **Step 6: verificare**

Run: `pnpm --filter @stubwise/notifications build && pnpm --filter @stubwise/worker test -- refine-mcp backlog/refine/bridge && pnpm --filter @stubwise/worker build && ls apps/worker/dist/refine-mcp/index.js`
Expected: PASS, e l'entry compilata esiste.

- [ ] **Step 7: commit**

```bash
git add apps/worker/src/refine-mcp apps/worker/src/backlog/refine/bridge.ts apps/worker/src/backlog/refine/bridge.test.ts
git commit -m "feat(worker): ponte su loopback e server MCP dei tool di refinement"
```

---
### Task 7: Worktree multi-repo lunghi

**Files:**
- Modify: `apps/worker/src/git/mirrors.ts` (metodo nuovo accanto a `withProjectWorktrees`, ~L661)
- Create: `apps/worker/src/backlog/refine/worktrees.ts`
- Test: `apps/worker/src/git/mirrors.test.ts` (un `describe` nuovo, riusa `makeRoot`/`makeUpstream`/`projectFor`/`git`), `apps/worker/src/backlog/refine/worktrees.test.ts`

**Interfaces:**
- Consumes: `MirrorManager.openWorktree(project, branch, { dir })`, `prepareFixedParentDir`, `mirrorSlug` (stesso file).
- Produces: `ProjectWorktreeRepo`, `MirrorManager.openProjectWorktrees`, `RefineWorktreeEntry`, `RefineWorktreeRegistry`, `createRefineWorktreeRegistry`, `refineParentDir` (contratto).

`withProjectWorktrees` è a callback (smonta tutto all'uscita) e non va bene per un handle che vive quanto una sessione. `openProjectWorktrees` è lo stesso primitivo senza callback: parent dir DETERMINISTICA (ripulita e ricreata, `prepareFixedParentDir`), un `openWorktree` per repo in `join(parentDir, mirrorSlug(repoUrl))`, e su errore a metà smonta ciò che ha aperto e la parent dir prima di rilanciare. `remove()` è idempotente.

- [ ] **Step 1: test che falliscono**

```ts
// in mirrors.test.ts
describe("MirrorManager.openProjectWorktrees", () => {
  it("apre un worktree per repo sotto la parent DATA, e remove() smonta tutto (idempotente)", async () => {
    const root = await makeRoot();
    const upA = await makeUpstream(root, "repo-a");
    const upB = await makeUpstream(root, "repo-b");
    const manager = new MirrorManager({ mirrorsDir: join(root, "mirrors") });
    const parentDir = join(root, "refine", "sess-1");
    const handle = await manager.openProjectWorktrees(
      [
        { repositoryId: "a", name: "Repo A", project: projectFor(upA) },
        { repositoryId: "b", name: "Repo B", project: projectFor(upB) },
      ],
      "stubwise/backlog-refine-sess-1",
      parentDir,
    );
    expect(handle.dirs.map((d) => [d.repositoryId, d.name, d.dir])).toEqual([
      ["a", "Repo A", join(parentDir, mirrorSlug(upA.url))],
      ["b", "Repo B", join(parentDir, mirrorSlug(upB.url))],
    ]);
    for (const d of handle.dirs) {
      expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], d.dir)).toBe("stubwise/backlog-refine-sess-1");
      expect(existsSync(join(d.dir, "README.md"))).toBe(true);
    }
    await handle.remove();
    await handle.remove();
    expect(existsSync(parentDir)).toBe(false);
  });

  it("riaprire lo STESSO percorso dopo un riavvio (dir rimasta sporca) funziona", async () => {
    const root = await makeRoot();
    const up = await makeUpstream(root, "repo-a");
    const manager = new MirrorManager({ mirrorsDir: join(root, "mirrors") });
    const parentDir = join(root, "refine", "sess-2");
    const repos = [{ repositoryId: "a", name: "A", project: projectFor(up) }];
    await manager.openProjectWorktrees(repos, "stubwise/backlog-refine-sess-2", parentDir); // mai rimosso: «crash»
    const again = await manager.openProjectWorktrees(repos, "stubwise/backlog-refine-sess-2", parentDir);
    expect(again.dirs[0]!.dir.startsWith(parentDir + "/")).toBe(true);
    await again.remove();
  });

  it("un repo che non si apre: smonta quelli già aperti e la parent, poi rilancia", async () => {
    const root = await makeRoot();
    const up = await makeUpstream(root, "repo-a");
    const manager = new MirrorManager({ mirrorsDir: join(root, "mirrors") });
    const parentDir = join(root, "refine", "sess-3");
    const broken = { ...projectFor(up), repoUrl: join(root, "non-esiste") };
    await expect(
      manager.openProjectWorktrees(
        [{ repositoryId: "a", name: "A", project: projectFor(up) }, { repositoryId: "x", name: "X", project: broken }],
        "stubwise/backlog-refine-sess-3",
        parentDir,
      ),
    ).rejects.toThrow();
    expect(existsSync(parentDir)).toBe(false);
  });
});
```

```ts
// apps/worker/src/backlog/refine/worktrees.test.ts
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRefineWorktreeRegistry, refineParentDir } from "./worktrees.js";

describe("registro dei worktree di refinement", () => {
  it("la parent dir è deterministica per sessione (il CLI indicizza --resume per cwd)", () => {
    expect(refineParentDir("abc")).toBe(join(tmpdir(), "stubwise-refine", "abc"));
    expect(refineParentDir("abc")).toBe(refineParentDir("abc"));
  });

  it("remove toglie dalla mappa PRIMA di smontare: due remove concorrenti smontano una volta", async () => {
    const reg = createRefineWorktreeRegistry();
    const remove = vi.fn(async () => undefined);
    reg.set({ agentSessionId: "s", parentDir: "/p", repos: [], remove });
    await Promise.all([reg.remove("s"), reg.remove("s")]);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(reg.get("s")).toBeUndefined();
  });

  it("closeAll smonta tutto e non si ferma su un errore", async () => {
    const reg = createRefineWorktreeRegistry();
    const ok = vi.fn(async () => undefined);
    reg.set({ agentSessionId: "a", parentDir: "/a", repos: [], remove: async () => { throw new Error("x"); } });
    reg.set({ agentSessionId: "b", parentDir: "/b", repos: [], remove: ok });
    await reg.closeAll();
    expect(ok).toHaveBeenCalledTimes(1);
    expect(reg.ids()).toEqual([]);
  });
});
```

- [ ] **Step 2: verificare che falliscano**

Run: `pnpm --filter @stubwise/worker test -- git/mirrors backlog/refine/worktrees`
Expected: FAIL.

- [ ] **Step 3: implementazione**

In `mirrors.ts`:

```ts
/** Un repository del progetto da aprire in una sessione lunga (refinement). */
export interface ProjectWorktreeRepo {
  repositoryId: string;
  name: string;
  project: MirrorProject;
}

  /**
   * N worktree — uno per repo — sotto una parent dir DETERMINISTICA, SENZA
   * callback: la vita è in mano al chiamante (sessione di refinement del
   * backlog, design 2026-10-14 §3.4, che li tiene aperti finché la sessione è
   * attiva). Stesse invarianti di withProjectWorktrees (stesso primitivo,
   * `openWorktree` con la dir imposta); la parent viene ripulita e ricreata,
   * così una dir rimasta da un riavvio non blocca la riapertura. Setup fallito
   * a metà: smonta i già aperti e la parent, poi rilancia. `remove()`
   * idempotente.
   *
   * INVARIANTE mirror: un `fetch --prune` di un altro job dello stesso
   * progetto può potare il ref `stubwise/backlog-refine-*` di un worktree vivo.
   * Senza commit è innocuo (il worktree resta leggibile): per questo il
   * chiamante serializza solo l'APERTURA, non la vita del worktree.
   */
  async openProjectWorktrees(
    repos: ProjectWorktreeRepo[],
    branchName: string,
    parentDir: string,
  ): Promise<{ dirs: { repositoryId: string; name: string; dir: string }[]; remove: () => Promise<void> }> {
    assertBranchName(branchName, { adopted: false });
    await prepareFixedParentDir(parentDir);
    const opened: { repositoryId: string; name: string; dir: string; remove: () => Promise<void> }[] = [];
    const removeAll = async () => {
      for (const handle of opened.splice(0)) await handle.remove().catch(() => undefined);
      await rm(parentDir, { recursive: true, force: true });
    };
    try {
      for (const repo of repos) {
        const handle = await this.openWorktree(repo.project, branchName, {
          dir: join(parentDir, mirrorSlug(repo.project.repoUrl)),
        });
        opened.push({ repositoryId: repo.repositoryId, name: repo.name, dir: handle.dir, remove: handle.remove });
      }
    } catch (error) {
      await removeAll();
      throw error;
    }
    let removed = false;
    return {
      dirs: opened.map(({ repositoryId, name, dir }) => ({ repositoryId, name, dir })),
      remove: async () => {
        if (removed) return;
        removed = true;
        await removeAll();
      },
    };
  }
```

`backlog/refine/worktrees.ts`:

```ts
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Worktree aperti delle sessioni di refinement (design 2026-10-14 §3.4), per
 * id della sessione dell'agente. In memoria: il worker è UN processo (come il
 * registro della chat CODE, `code-session.ts`). Al riavvio è vuoto e il turno
 * successivo riapre i worktree nello STESSO percorso (`refineParentDir`).
 */
export interface RefineWorktreeEntry {
  agentSessionId: string;
  parentDir: string;
  repos: { repositoryId: string; name: string; dir: string }[];
  remove(): Promise<void>;
}

export interface RefineWorktreeRegistry {
  get(agentSessionId: string): RefineWorktreeEntry | undefined;
  set(entry: RefineWorktreeEntry): void;
  remove(agentSessionId: string): Promise<void>;
  ids(): string[];
  closeAll(): Promise<void>;
}

/** Cwd del CLI della sessione: DETERMINISTICA, il CLI indicizza `--resume` per cwd. */
export function refineParentDir(agentSessionId: string): string {
  return join(tmpdir(), "stubwise-refine", agentSessionId);
}

export function createRefineWorktreeRegistry(): RefineWorktreeRegistry {
  const entries = new Map<string, RefineWorktreeEntry>();
  return {
    get: (id) => entries.get(id),
    set: (entry) => void entries.set(entry.agentSessionId, entry),
    ids: () => [...entries.keys()],
    async remove(id) {
      const entry = entries.get(id);
      if (!entry) return;
      entries.delete(id); // prima della chiusura: una seconda remove non la ritrova
      await entry.remove();
    },
    async closeAll() {
      const all = [...entries.values()];
      entries.clear();
      for (const entry of all) await entry.remove().catch(() => undefined);
    },
  };
}
```

- [ ] **Step 4: verificare**

Run: `pnpm --filter @stubwise/worker test -- git/mirrors backlog/refine/worktrees`
Expected: PASS (anche i test esistenti di `withProjectWorktrees`).

- [ ] **Step 5: commit**

```bash
git add apps/worker/src/git/mirrors.ts apps/worker/src/git/mirrors.test.ts apps/worker/src/backlog/refine/worktrees.ts apps/worker/src/backlog/refine/worktrees.test.ts
git commit -m "feat(worker): worktree multi-repo lunghi per le sessioni di refinement"
```

---

### Task 8: Prompt d'avvio e contratto del plugin base

**Files:**
- Create: `apps/worker/src/backlog/refine/prompts.ts`
- Modify: `apps/worker/plugins/stubwise-base/hooks/session-start.sh` (una riga del contratto)
- Test: `apps/worker/src/backlog/refine/prompts.test.ts`, `apps/worker/src/plugins/base.test.ts` (un'asserzione in più)

**Interfaces:**
- Consumes: `Language` (shared), `renderGraphHint` (`graph/agent-hint.ts`, il chiamante passa la stringa già pronta).
- Produces: `RefinePromptContext`, `buildRefinePrimingPrompt`, `buildRefineResumePrompt` (contratto).

Il prompt d'avvio (spec §4.1) è in italiano come gli altri prompt del backlog (`backlog/prompts.ts`), con la lingua delle risposte presa da `language`. Contiene, nell'ordine: ruolo e mandato, le repository aperte con i percorsi, il grafo (se c'è), la voce (titolo, metadati, testo originale se diverso dal documento, design/documento, piano), le ultime decisioni del registro, gli ultimi messaggi (solo quando si riparte senza `--resume`), il messaggio della persona. Tutto il contenuto della voce è input NON fidato: va fra delimitatori come in `buildCodeChatPrimingPrompt`.

Il mandato, testo esatto:

```
COME LAVORI IN QUESTA SESSIONE
- È una conversazione con le persone del team: rispondi a chi ti scrive. Leggi il codice (Read/Grep/Glob) per fondare le risposte sui fatti; non modificare file e non eseguire comandi.
- Se ti serve una scelta o un'informazione, CHIEDILA SCRIVENDO NELLA RISPOSTA: qui la chat è il canale verso le persone, non esiste ask_user.
- Design e piano NON sono file del repository: quando sono maturi salvali con i tool `set_design` e `set_plan` (sostituiscono il testo attuale; Stubwise conserva la versione precedente), e titolo, effort (1–5), rischio con la sua nota e urgenza con `update_item`. Dopo ogni salvataggio dillo in chat. Se un tool risponde con un errore, correggi e riprova.
- Non chiudere il lavoro da solo: ogni turno finisce con una risposta a chi ha scritto, e la persona decide quando un documento è pronto.
```

- [ ] **Step 1: test che falliscono**

```ts
// apps/worker/src/backlog/refine/prompts.test.ts
import { describe, expect, it } from "vitest";
import { buildRefinePrimingPrompt, buildRefineResumePrompt, type RefinePromptContext } from "./prompts.js";

const ctx = (over: Partial<RefinePromptContext> = {}): RefinePromptContext => ({
  language: "it",
  item: {
    title: "Esportare in CSV", document: "Serve l'export", implementationPlan: null, originContent: null,
    effort: null, risk: null, riskNote: null, urgency: "high",
  },
  repos: [{ name: "api", dir: "/tmp/stubwise-refine/s/api-1" }, { name: "web", dir: "/tmp/stubwise-refine/s/web-2" }],
  graphHint: "",
  decisions: [],
  recentTranscript: [],
  ...over,
});

describe("prompt della sessione di refinement", () => {
  it("contiene voce, repository coi percorsi, mandato e il messaggio in fondo", () => {
    const p = buildRefinePrimingPrompt(ctx(), "partiamo dal formato");
    for (const needle of ["Esportare in CSV", "Serve l'export", "/tmp/stubwise-refine/s/api-1", "web", "set_design", "set_plan", "update_item", "non esiste ask_user"]) {
      expect(p).toContain(needle);
    }
    expect(p.trimEnd().endsWith("partiamo dal formato")).toBe(true);
    expect(p).toContain("Italian");
  });

  it("design e piano attuali e testo originale preservato compaiono quando ci sono", () => {
    const p = buildRefinePrimingPrompt(
      ctx({ item: { ...ctx().item, document: "# Design v1", originContent: "richiesta originale", implementationPlan: "# Piano v1" } }),
      "x",
    );
    expect(p).toContain("# Design v1");
    expect(p).toContain("richiesta originale");
    expect(p).toContain("# Piano v1");
  });

  it("decisioni e ultimi messaggi (ripartenza senza --resume) quando ci sono, assenti altrimenti", () => {
    const empty = buildRefinePrimingPrompt(ctx(), "x");
    expect(empty).not.toContain("DECISIONI");
    expect(empty).not.toContain("CONVERSAZIONE FINORA");
    const full = buildRefinePrimingPrompt(
      ctx({
        decisions: [{ title: "Niente XLSX", decision: "Solo CSV", decidedAt: new Date("2026-10-01T00:00:00Z") }],
        recentTranscript: [{ role: "user", text: "e il separatore?" }, { role: "agent", text: "punto e virgola" }],
      }),
      "x",
    );
    expect(full).toContain("Niente XLSX");
    expect(full).toContain("e il separatore?");
    expect(full).toContain("punto e virgola");
  });

  it("il turno ripreso con --resume riceve SOLO il messaggio", () => {
    expect(buildRefineResumePrompt("e adesso il piano")).toBe("e adesso il piano");
  });
});
```

In `base.test.ts`, nel test «stampa un JSON valido col contratto della run», aggiungere alla lista dei `needle`: `"set_design"`. Il test del tetto dei 400 token resta com'è e deve restare verde.

- [ ] **Step 2: verificare che falliscano**

Run: `pnpm --filter @stubwise/worker test -- backlog/refine/prompts plugins/base`
Expected: FAIL.

- [ ] **Step 3: implementazione — prompt**

```ts
// apps/worker/src/backlog/refine/prompts.ts
import type { Language } from "@stubwise/shared";

/**
 * Prompt della sessione di refinement (design 2026-10-14 §4.1). Il PRIMO
 * turno (o una ripartenza senza `--resume`) riceve il contesto completo; i
 * turni ripresi con `--resume` solo il messaggio della persona, perché la
 * conversazione CLI ha già tutto il resto.
 *
 * INJECTION: titolo, documento, piano, decisioni e messaggi sono input non
 * fidato. Il caso peggiore è che l'agente legga il codice (che legge già) o
 * scriva sulla voce con i tool (che passano dal ponte, con revisione).
 */
export interface RefinePromptContext {
  language: Language;
  item: {
    title: string;
    document: string;
    implementationPlan: string | null;
    originContent: string | null;
    effort: number | null;
    risk: string | null;
    riskNote: string | null;
    urgency: string | null;
  };
  repos: { name: string; dir: string }[];
  /** Blocco del grafo già pronto (`renderGraphHint(..., "it")`), "" senza grafi. */
  graphHint: string;
  decisions: { title: string; decision: string; decidedAt: Date }[];
  recentTranscript: { role: "user" | "agent"; text: string }[];
}

const LANGUAGE_NAME: Record<Language, string> = { en: "English", it: "Italian" };

const MANDATE = [
  "COME LAVORI IN QUESTA SESSIONE",
  "- È una conversazione con le persone del team: rispondi a chi ti scrive. Leggi il codice (Read/Grep/Glob) per fondare le risposte sui fatti; non modificare file e non eseguire comandi.",
  "- Se ti serve una scelta o un'informazione, CHIEDILA SCRIVENDO NELLA RISPOSTA: qui la chat è il canale verso le persone, non esiste ask_user.",
  "- Design e piano NON sono file del repository: quando sono maturi salvali con i tool `set_design` e `set_plan` (sostituiscono il testo attuale; Stubwise conserva la versione precedente), e titolo, effort (1–5), rischio con la sua nota e urgenza con `update_item`. Dopo ogni salvataggio dillo in chat. Se un tool risponde con un errore, correggi e riprova.",
  "- Non chiudere il lavoro da solo: ogni turno finisce con una risposta a chi ha scritto, e la persona decide quando un documento è pronto.",
].join("\n");

const block = (label: string, body: string) => `--- ${label} ---\n${body}`;

export function buildRefinePrimingPrompt(ctx: RefinePromptContext, openingText: string): string {
  const { item } = ctx;
  const meta = [
    `- effort: ${item.effort ?? "non stimato"} (scala 1–5)`,
    `- rischio: ${item.risk ?? "non stimato"}${item.riskNote ? ` — ${item.riskNote}` : ""}`,
    `- urgenza: ${item.urgency ?? "non stimata"}`,
  ].join("\n");
  const repos = ctx.repos.map((r) => `- ${r.name}: ${r.dir}`).join("\n");
  const parts = [
    "Sei un ingegnere senior che affianca il team nel raffinamento di una voce del backlog di prodotto, in una sessione di Claude Code. La tua working directory contiene, in SOLA LETTURA, tutte le repository del progetto." +
      (ctx.graphHint ? `\n\n${ctx.graphHint}` : ""),
    "",
    `Rispondi SEMPRE in ${LANGUAGE_NAME[ctx.language]}, in prosa Markdown. Cita percorsi e simboli reali che hai visto. Se una risposta non è nel codice, dillo invece di inventare.`,
    "",
    MANDATE,
    "",
    block("REPOSITORY APERTE", repos || "(nessuna)"),
    "",
    block("VOCE: TITOLO", item.title),
    "",
    block("VOCE: METADATI", meta),
    "",
  ];
  if (item.originContent !== null) parts.push(block("VOCE: RICHIESTA ORIGINALE", item.originContent), "");
  parts.push(block(item.originContent !== null ? "VOCE: DESIGN ATTUALE" : "VOCE: DOCUMENTO", item.document || "(vuoto)"), "");
  parts.push(block("VOCE: PIANO ATTUALE", item.implementationPlan ?? "(nessun piano)"), "");
  if (ctx.decisions.length > 0) {
    parts.push(
      block(
        "DECISIONI RECENTI DEL PROGETTO (fatti: non riproporre alternative già scartate)",
        ctx.decisions.map((d) => `- ${d.decidedAt.toISOString().slice(0, 10)} · ${d.title}: ${d.decision}`).join("\n"),
      ),
      "",
    );
  }
  if (ctx.recentTranscript.length > 0) {
    parts.push(
      block(
        "CONVERSAZIONE FINORA (ultimi messaggi)",
        ctx.recentTranscript.map((m) => `[${m.role === "user" ? "persona" : "tu"}] ${m.text}`).join("\n\n"),
      ),
      "",
    );
  }
  parts.push(block("MESSAGGIO", openingText));
  return parts.join("\n");
}

/** Turno ripreso con `--resume`: il contesto è già nella conversazione CLI. */
export function buildRefineResumePrompt(openingText: string): string {
  return openingText;
}
```

- [ ] **Step 4: implementazione — contratto**

In `session-start.sh`, nel blocco `Asking a human:`, come ultima riga:

```
- Refinement sessions: the chat is the channel (no ask_user); save design and plan with set_design/set_plan, never as files.
```

(≈115 caratteri: il contratto passa da ~1480 a ~1595, sotto i 1600 del test. Se il test del tetto fallisce, accorciare QUESTA riga, non le altre.)

- [ ] **Step 5: verificare**

Run: `pnpm --filter @stubwise/worker test -- backlog/refine/prompts plugins/base`
Expected: PASS.

- [ ] **Step 6: commit**

```bash
git add apps/worker/src/backlog/refine/prompts.ts apps/worker/src/backlog/refine/prompts.test.ts apps/worker/plugins/stubwise-base apps/worker/src/plugins/base.test.ts
git commit -m "feat(worker): prompt d'avvio del refinement e riga nel contratto dei run"
```

---

### Task 9: `runRefineTurn` e `backlogRefineSession`

**Files:**
- Create: `apps/worker/src/backlog/refine/turn.ts`
- Modify: `apps/worker/src/sessions/owners.ts` (`backlogRefineSession`)
- Test: `apps/worker/src/backlog/refine/turn.test.ts`

**Interfaces:**
- Consumes: Task 1 (`REFINE_TOOL_NAMES`), Task 2 (tabelle), Task 4 (`openingInput`, `signal`, `AgentRunCancelledError`), Task 6 (`RefineBridge`, `buildRefineMcpConfig`, `refineServerPath`), Task 7 (registro, `openProjectWorktrees`, `refineParentDir`), Task 8 (prompt). Esistenti: `resolveBacklogProvider`/`loadProjectAiProviderId` (`backlog/provider.ts`), `openRunPlugins` (`plugins/materialize-run.ts`), `GRAPHIFY_AGENT_ALLOWED_TOOLS`/`resolveRepoGraphJson`/`renderGraphHint` (`graph/agent-hint.ts`), `monthlyCostUsd`/`instanceSettings`/`decrypt` (`@stubwise/db`), `getContentLanguage` (`settings.ts`).
- Produces: `RefineTurnDeps`, `RefineTurnOutcome`, `runRefineTurn`, `backlogRefineSession` (contratto).

Il turno, in ordine (spec §3.2, §3.4, §4, §5.5):
1. **claim** dell'input d'apertura (`pending → delivered`, lo stesso UPDATE guardato del relay). Perso → `skipped` (lo ha preso qualcun altro, o non è più `pending`).
2. sessione `active` e voce né `converted` né `archived`, altrimenti input `undelivered`/`session_not_live` e `skipped`.
3. **budget mensile** (`instance_settings.monthly_budget_usd` contro `monthlyCostUsd`): sforato e autore NON admin → input `undelivered`/`budget_exceeded`, `skipped`. Admin passa (stessa regola delle correzioni).
4. provider come la chat CODE.
5. worktree: dal registro, o aperti dentro `serializer.run(projectId, …)` (solo l'apertura), in `refineParentDir(agentSessionId)`, branch `stubwise/backlog-refine-<agentSessionId>`. Progetto senza repository → `turn_failed`.
6. plugin per OGNI turno (`openRunPlugins`, il flag non persiste nella sessione CLI), grafo per repo, ponte (`grant`) + config MCP. Entry MCP assente → turno senza tool e una riga nel log (fail-open come `ask_user`).
7. run: `cwd = parentDir`, `permissionMode: "default"`, `allowedTools` chiuso, `--resume` col `cli_session_id` salvato se c'è, `openingInput`, `signal`, `timeoutMs = turnTimeoutMs`, `pauseKey = backlog_refine:<sessionId>:<turnId>`.
8. **`--resume` rifiutato** (exit ≠ 0, nessun `sessionId` nel risultato, e il messaggio d'apertura mai preso — nessun evento `input` col suo id): UN nuovo tentativo senza `--resume` col prompt d'avvio, più gli ultimi messaggi della trascrizione; l'input si reclama di nuovo (il relay può averlo riportato a `pending`).
9. riuscito → `cli_session_id` (quello nuovo, o il vecchio se il CLI non ne riporta) e `last_activity_at`. `AgentRunCancelledError` → `cancelled`, input lasciato com'è. Ogni altro errore, o exit ≠ 0 dopo i tentativi → se il messaggio d'apertura NON è mai stato preso, `undelivered`/`turn_failed`; → `failed`.
10. `finally`: `grant.revoke()` e pulizia dei plugin. I worktree restano (li smonta lo scheduler alla chiusura).

- [ ] **Step 1: `backlogRefineSession` in `owners.ts`**

```ts
/**
 * Sessione di refinement (design 2026-10-14): la riga di `agent_sessions` la
 * crea il SERVER all'avvio; qui solo l'opzione del run. Il tetto della pausa
 * è del TURNO (la sessione dura giorni). Nessun segreto: i worktree non hanno
 * `.env` materializzati.
 */
export function backlogRefineSession(agentSessionId: string, turnId: string): AgentRunSession {
  return { sessionId: agentSessionId, label: "refine", pauseKey: `backlog_refine:${agentSessionId}:${turnId}` };
}
```

- [ ] **Step 2: test che falliscono**

```ts
// apps/worker/src/backlog/refine/turn.test.ts
import { mkdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentSessionEvents, agentSessionInputs, agentSessions, backlogItems, backlogRefineSessions,
  instanceSettings, users, type Db,
} from "@stubwise/db";
import { seedBacklogItem, startTestDb, type TestDb } from "@stubwise/db/testing";
import { AgentRunCancelledError, type AgentRunOptions, type AgentRunResult, type AgentRunner } from "../../agent/runner.js";
import { startRefineBridge, type RefineBridge } from "./bridge.js";
import { runRefineTurn, type RefineTurnDeps } from "./turn.js";
import { createRefineWorktreeRegistry, refineParentDir } from "./worktrees.js";

let t: TestDb;
let bridge: RefineBridge;
let adminId: string;
let memberId: string;
beforeAll(async () => {
  t = await startTestDb();
  bridge = await startRefineBridge({ db: t.db });
  const [a] = await t.db.insert(users).values({ email: "a@x.test", passwordHash: "x", role: "admin" }).returning();
  const [m] = await t.db.insert(users).values({ email: "m@x.test", passwordHash: "x", role: "member" }).returning();
  adminId = a!.id; memberId = m!.id;
}, 120_000);
afterAll(async () => { await bridge.close(); await t.stop(); });

const OK: AgentRunResult = { exitCode: 0, output: "fatto", sessionId: "cli-1" } as AgentRunResult;

/** Runner finto: registra le opzioni; `script` decide l'esito di ogni chiamata. */
function fakeRunner(script: Array<(o: AgentRunOptions) => Promise<AgentRunResult>>) {
  const calls: AgentRunOptions[] = [];
  const runner: AgentRunner = {
    recordsSessions: true,
    run: vi.fn(async (o: AgentRunOptions) => { calls.push(o); return (script[calls.length - 1] ?? script.at(-1)!)(o); }),
  } as unknown as AgentRunner;
  return { runner, calls };
}

/** Il CLI ha PRESO il messaggio: l'evento input che il runner vero scriverebbe all'eco. */
async function echo(o: AgentRunOptions) {
  await t.db.insert(agentSessionEvents).values({
    sessionId: o.session!.sessionId, segmentId: "seg", type: "input",
    data: { inputId: o.openingInput!.inputId, text: o.openingInput!.text },
  });
}

async function seeded(opts: { cliSessionId?: string; status?: "active" | "closed"; author?: string } = {}) {
  const { itemId } = await seedBacklogItem(t.db, { title: "Export CSV" });
  const [s] = await t.db.insert(agentSessions)
    .values({ ownerKey: `backlog_refine:${itemId}`, kind: "backlog_refine", title: "t", backlogItemId: itemId }).returning();
  await t.db.insert(backlogRefineSessions).values({
    itemId, agentSessionId: s!.id, status: opts.status ?? "active", cliSessionId: opts.cliSessionId ?? null,
    ...(opts.status === "closed" ? { closedAt: new Date(), closedReason: "user" as const } : {}),
  });
  const [input] = await t.db.insert(agentSessionInputs)
    .values({ sessionId: s!.id, text: "ciao", authorUserId: opts.author ?? adminId }).returning();
  return { itemId, agentSessionId: s!.id, inputId: input!.id };
}

function deps(runner: AgentRunner, over: Partial<RefineTurnDeps> = {}) {
  const openProjectWorktrees = vi.fn(async (repos: { repositoryId: string; name: string }[], _b: string, parentDir: string) => {
    await mkdir(parentDir, { recursive: true });
    return { dirs: repos.map((r) => ({ repositoryId: r.repositoryId, name: r.name, dir: `${parentDir}/${r.name}` })), remove: vi.fn(async () => undefined) };
  });
  const d: RefineTurnDeps = {
    db: t.db, runner, bridge,
    mirrors: { openProjectWorktrees } as unknown as RefineTurnDeps["mirrors"],
    serializer: { run: (_id: string, fn: () => Promise<unknown>) => fn() } as unknown as RefineTurnDeps["serializer"],
    worktrees: createRefineWorktreeRegistry(),
    encryptionKey: Buffer.alloc(32, 1),
    maxTurns: 30, turnTimeoutMs: 60_000,
    refineServerPath: "/nope/index.js",
    loadProviderChainFn: async () => [],
    loadMirrorProjectsFn: async (_db: Db, projectId: string) => [{ repositoryId: projectId, name: "api", project: {} as never }],
    log: () => undefined,
    ...over,
  };
  return { d, openProjectWorktrees };
}
const inputOf = async (id: string) => (await t.db.select().from(agentSessionInputs).where(eq(agentSessionInputs.id, id)))[0]!;
const refineOf = async (sid: string) => (await t.db.select().from(backlogRefineSessions).where(eq(backlogRefineSessions.agentSessionId, sid)))[0]!;
const run = (d: RefineTurnDeps, s: { agentSessionId: string; inputId: string }) =>
  runRefineTurn(d, { ...s, signal: new AbortController().signal });

describe("runRefineTurn", () => {
  it("primo turno: prompt d'avvio, nessun --resume, sola lettura per costruzione, cli_session_id salvato", async () => {
    const s = await seeded();
    const { runner, calls } = fakeRunner([async (o) => { await echo(o); return OK; }]);
    expect(await run(deps(runner).d, s)).toBe("completed");
    const o = calls[0]!;
    expect(o.prompt).toContain("Export CSV");
    expect(o.resumeSessionId).toBeUndefined();
    expect(o.permissionMode).toBe("default");
    expect(o.cwd).toBe(refineParentDir(s.agentSessionId));
    expect(o.openingInput).toEqual({ inputId: s.inputId, text: "ciao", authorUserId: adminId });
    expect(o.session).toMatchObject({ sessionId: s.agentSessionId, label: "refine" });
    for (const forbidden of ["Edit", "Write", "Bash", "WebFetch", "NotebookEdit", "MultiEdit"]) {
      expect(o.allowedTools).not.toContain(forbidden);
    }
    expect(o.allowedTools!.slice(0, 3)).toEqual(["Read", "Grep", "Glob"]);
    expect((await refineOf(s.agentSessionId)).cliSessionId).toBe("cli-1");
    expect((await inputOf(s.inputId)).status).toBe("delivered");
  });

  it("turno successivo: --resume col cli_session_id, prompt = solo il messaggio, worktree NON riaperti", async () => {
    const s = await seeded({ cliSessionId: "cli-0" });
    const { runner, calls } = fakeRunner([async (o) => { await echo(o); return OK; }]);
    const { d, openProjectWorktrees } = deps(runner);
    await run(d, s);
    const [second] = await t.db.insert(agentSessionInputs).values({ sessionId: s.agentSessionId, text: "e il piano?", authorUserId: adminId }).returning();
    await run(d, { agentSessionId: s.agentSessionId, inputId: second!.id });
    expect(calls[1]!.resumeSessionId).toBe("cli-1");
    expect(calls[1]!.prompt).toBe("e il piano?");
    expect(openProjectWorktrees).toHaveBeenCalledTimes(1);
  });

  it("riavvio + --resume rifiutato: stesso percorso, un tentativo col prompt d'avvio e cli_session_id riscritto", async () => {
    const s = await seeded({ cliSessionId: "cli-perso" });
    const { runner, calls } = fakeRunner([
      async () => ({ exitCode: 1, output: "No conversation found" }) as AgentRunResult,
      async (o) => { await echo(o); return { ...OK, sessionId: "cli-nuovo" }; },
    ]);
    const { d, openProjectWorktrees } = deps(runner); // registro VUOTO: come dopo un riavvio
    expect(await run(d, s)).toBe("completed");
    expect(openProjectWorktrees.mock.calls[0]![2]).toBe(refineParentDir(s.agentSessionId));
    expect(calls[0]!.resumeSessionId).toBe("cli-perso");
    expect(calls[1]!.resumeSessionId).toBeUndefined();
    expect(calls[1]!.prompt).toContain("Export CSV");
    expect(calls[1]!.openingInput!.inputId).toBe(s.inputId);
    expect((await refineOf(s.agentSessionId)).cliSessionId).toBe("cli-nuovo");
  });

  it("input già reclamato da altri: skipped, nessun run", async () => {
    const s = await seeded();
    await t.db.update(agentSessionInputs).set({ status: "delivered" }).where(eq(agentSessionInputs.id, s.inputId));
    const { runner, calls } = fakeRunner([async () => OK]);
    expect(await run(deps(runner).d, s)).toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  it("sessione chiusa o voce convertita: input undelivered/session_not_live, nessun run", async () => {
    const closed = await seeded({ status: "closed" });
    const converted = await seeded();
    await t.db.update(backlogItems).set({ status: "converted" }).where(eq(backlogItems.id, converted.itemId));
    const { runner, calls } = fakeRunner([async () => OK]);
    for (const s of [closed, converted]) {
      expect(await run(deps(runner).d, s)).toBe("skipped");
      expect(await inputOf(s.inputId)).toMatchObject({ status: "undelivered", reason: "session_not_live" });
    }
    expect(calls).toHaveLength(0);
  });

  it("budget sforato, due ruoli: il member riceve budget_exceeded e niente run, l'admin passa", async () => {
    await t.db.insert(instanceSettings).values({ id: 1, monthlyBudgetUsd: "1" })
      .onConflictDoUpdate({ target: instanceSettings.id, set: { monthlyBudgetUsd: "1" } });
    try {
      const byMember = await seeded({ author: memberId });
      const byAdmin = await seeded({ author: adminId });
      const { runner, calls } = fakeRunner([async (o) => { await echo(o); return OK; }]);
      const { d } = deps(runner, { monthlyCostUsdFn: async () => 5 });
      expect(await run(d, byMember)).toBe("skipped");
      expect(await inputOf(byMember.inputId)).toMatchObject({ status: "undelivered", reason: "budget_exceeded" });
      expect(await run(d, byAdmin)).toBe("completed");
      expect(calls).toHaveLength(1);
    } finally {
      await t.db.update(instanceSettings).set({ monthlyBudgetUsd: null }).where(eq(instanceSettings.id, 1));
    }
  });

  it("annullato («Chiudi»): cancelled, l'input non diventa turn_failed", async () => {
    const s = await seeded();
    const { runner } = fakeRunner([async () => { throw new AgentRunCancelledError(null, "", 0); }]);
    expect(await run(deps(runner).d, s)).toBe("cancelled");
    expect((await inputOf(s.inputId)).reason).toBeNull();
  });

  it("errore prima che il CLI prenda il messaggio: undelivered/turn_failed, e il segreto del turno è revocato", async () => {
    const s = await seeded();
    let secret = "";
    const { runner } = fakeRunner([async (o) => {
      secret = o.mcpConfig?.servers["stubwise_refine"]?.env?.["REFINE_BRIDGE_SECRET"] ?? "";
      throw new Error("provider giù");
    }]);
    const { d } = deps(runner, { refineServerPath: process.execPath }); // un file che esiste: la config MCP c'è
    expect(await run(d, s)).toBe("failed");
    expect(await inputOf(s.inputId)).toMatchObject({ status: "undelivered", reason: "turn_failed" });
    const res = await fetch(`${bridge.url}/tools/set_plan`, {
      method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ markdown: "x" }),
    });
    expect(res.status).toBe(401);
  });
});
```

Note: `loadMirrorProjectsFn` è un'iniezione in più rispetto al contratto (default: la query qui sotto), per non dover cifrare credenziali git vere nei test. `mcpConfig` è il nome del campo di `AgentRunOptions` che `withMcpConfig` legge (verificarlo con `grep -n "mcpConfig" apps/worker/src/agent/runner.ts` e adattare il test se il campo si chiama diversamente).

- [ ] **Step 3: verificare che falliscano**

Run: `pnpm --filter @stubwise/worker test -- backlog/refine/turn`
Expected: FAIL (modulo inesistente).

- [ ] **Step 4: implementazione**

```ts
// apps/worker/src/backlog/refine/turn.ts
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  agentSessionEvents, agentSessionInputs, backlogItems, backlogRefineSessions, decrypt, gitAccounts,
  instanceSettings, monthlyCostUsd, projectDecisions, repositories, users, type Db,
} from "@stubwise/db";
import { AGENT_SESSION_EVENTS_CHANNEL, type AgentInputReason } from "@stubwise/shared";
import { AgentRunCancelledError, type AgentRunOptions, type AgentRunResult, type AgentRunner } from "../../agent/runner.js";
import type { MirrorManager, ProjectWorktreeRepo } from "../../git/mirrors.js";
import { GRAPHIFY_AGENT_ALLOWED_TOOLS, renderGraphHint, resolveRepoGraphJson } from "../../graph/agent-hint.js";
import type { ProjectSerializer } from "../../handler.js";
import { openRunPlugins } from "../../plugins/materialize-run.js";
import type { loadProviderById, loadProviderChain } from "../../providers/chain.js";
import { backlogRefineSession } from "../../sessions/owners.js";
import { getContentLanguage } from "../../settings.js";
import { loadProjectAiProviderId, resolveBacklogProvider } from "../provider.js";
import { buildRefineMcpConfig, refineServerPath, type RefineBridge } from "./bridge.js";
import { buildRefinePrimingPrompt, buildRefineResumePrompt } from "./prompts.js";
import { refineParentDir, type RefineWorktreeRegistry } from "./worktrees.js";

/**
 * UN turno di una sessione di refinement (design 2026-10-14 §3.2, §4): nasce
 * da un messaggio (l'input d'apertura), gira FUORI dal serializer del
 * progetto (che si usa solo per aprire i worktree) e riprende la conversazione
 * CLI con `--resume`. Mai due turni sulla stessa sessione: lo garantisce lo
 * scheduler. Vedi il docblock del piano per l'ordine dei passi.
 */

const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"] as const;
const DECISIONS_IN_PROMPT = 10;
const TRANSCRIPT_IN_PROMPT = 20;

export interface RefineTurnDeps {
  db: Db;
  runner: AgentRunner;
  mirrors: Pick<MirrorManager, "openProjectWorktrees">;
  serializer: ProjectSerializer;
  worktrees: RefineWorktreeRegistry;
  bridge: RefineBridge;
  encryptionKey: Buffer;
  graphsDir?: string;
  pluginsDir?: string;
  model?: string;
  maxTurns: number;
  turnTimeoutMs: number;
  refineServerPath?: string;
  monthlyCostUsdFn?: (db: Db) => Promise<number>;
  loadProviderByIdFn?: typeof loadProviderById;
  loadProviderChainFn?: typeof loadProviderChain;
  /** Iniettabile nei test: i repository del progetto con le credenziali decifrate. */
  loadMirrorProjectsFn?: (db: Db, projectId: string) => Promise<ProjectWorktreeRepo[]>;
  log: (m: string) => void;
}

export type RefineTurnOutcome = "completed" | "cancelled" | "failed" | "skipped";

const credentialsSchema = z.object({
  username: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  token: z.string().min(1),
});

/** Tutti i repository del progetto, in ordine di slug (come il fix). */
async function loadMirrorProjects(deps: Pick<RefineTurnDeps, "db" | "encryptionKey">, projectId: string): Promise<ProjectWorktreeRepo[]> {
  const rows = await deps.db
    .select({ repository: repositories, account: gitAccounts })
    .from(repositories)
    .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
    .where(eq(repositories.projectId, projectId))
    .orderBy(repositories.slug);
  return rows.map(({ repository, account }) => ({
    repositoryId: repository.id,
    name: repository.name,
    project: {
      provider: repository.provider,
      repoUrl: repository.repoUrl,
      defaultBranch: repository.defaultBranch,
      credentials: credentialsSchema.parse(JSON.parse(decrypt(account.encryptedCredentials, deps.encryptionKey))),
    },
  }));
}

/** `pending → delivered`, lo stesso claim del relay. Ammette `delivered` solo per il nuovo tentativo dopo un --resume rifiutato. */
async function claimOpening(db: Db, inputId: string, retry = false) {
  const [row] = await db
    .update(agentSessionInputs)
    .set({ status: "delivered", deliveredAt: sql`now()` })
    .where(and(
      eq(agentSessionInputs.id, inputId),
      retry ? inArray(agentSessionInputs.status, ["pending", "delivered"]) : eq(agentSessionInputs.status, "pending"),
    ))
    .returning();
  return row;
}

async function markUndelivered(db: Db, sessionId: string, inputId: string, reason: AgentInputReason): Promise<void> {
  const updated = await db
    .update(agentSessionInputs)
    .set({ status: "undelivered", reason, deliveredAt: null })
    .where(and(eq(agentSessionInputs.id, inputId), inArray(agentSessionInputs.status, ["pending", "delivered"])))
    .returning({ id: agentSessionInputs.id });
  if (updated.length > 0) {
    await db.execute(sql`select pg_notify(${AGENT_SESSION_EVENTS_CHANNEL}, ${JSON.stringify({ sessionId })})`).catch(() => undefined);
  }
}

/** Il CLI ha PRESO il messaggio: il runner scrive l'evento `input` all'eco. */
async function echoed(db: Db, sessionId: string, inputId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: agentSessionEvents.id })
    .from(agentSessionEvents)
    .where(and(
      eq(agentSessionEvents.sessionId, sessionId),
      eq(agentSessionEvents.type, "input"),
      sql`${agentSessionEvents.data}->>'inputId' = ${inputId}`,
    ))
    .limit(1);
  return row !== undefined;
}

async function overBudget(deps: RefineTurnDeps): Promise<boolean> {
  const [settings] = await deps.db
    .select({ monthlyBudgetUsd: instanceSettings.monthlyBudgetUsd })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1));
  const limit = settings?.monthlyBudgetUsd != null && settings.monthlyBudgetUsd !== "" ? Number(settings.monthlyBudgetUsd) : null;
  if (limit === null) return false;
  return (await (deps.monthlyCostUsdFn ?? monthlyCostUsd)(deps.db)) >= limit;
}

/** Ultimi messaggi della trascrizione (persona e agente), per ripartire senza --resume. */
async function recentTranscript(db: Db, sessionId: string, excludeInputId: string) {
  const rows = await db
    .select({ type: agentSessionEvents.type, data: agentSessionEvents.data })
    .from(agentSessionEvents)
    .where(and(eq(agentSessionEvents.sessionId, sessionId), inArray(agentSessionEvents.type, ["input", "assistant_text"])))
    .orderBy(desc(agentSessionEvents.id))
    .limit(TRANSCRIPT_IN_PROMPT + 1);
  return rows
    .filter((r) => !(r.type === "input" && r.data["inputId"] === excludeInputId))
    .slice(0, TRANSCRIPT_IN_PROMPT)
    .reverse()
    .flatMap((r) => (typeof r.data["text"] === "string" && r.data["text"] !== ""
      ? [{ role: r.type === "input" ? ("user" as const) : ("agent" as const), text: r.data["text"] as string }]
      : []));
}

export async function runRefineTurn(
  deps: RefineTurnDeps,
  input: { agentSessionId: string; inputId: string; signal: AbortSignal },
): Promise<RefineTurnOutcome> {
  const { db, log } = deps;
  const sid = input.agentSessionId;

  // 1. Claim del messaggio d'apertura.
  const opening = await claimOpening(db, input.inputId);
  if (!opening) return "skipped";

  // 2. Sessione attiva e voce aperta.
  const [ctx] = await db
    .select({ refine: backlogRefineSessions, item: backlogItems })
    .from(backlogRefineSessions)
    .innerJoin(backlogItems, eq(backlogItems.id, backlogRefineSessions.itemId))
    .where(eq(backlogRefineSessions.agentSessionId, sid));
  if (!ctx || ctx.refine.status !== "active" || ctx.item.status === "converted" || ctx.item.status === "archived") {
    await markUndelivered(db, sid, input.inputId, "session_not_live");
    return "skipped";
  }
  const { item } = ctx;

  // 3. Budget mensile: il messaggio di un maintainer passa, quello di un member no.
  if (await overBudget(deps)) {
    const [author] = opening.authorUserId
      ? await db.select({ role: users.role }).from(users).where(eq(users.id, opening.authorUserId))
      : [];
    if (author?.role !== "admin") {
      await markUndelivered(db, sid, input.inputId, "budget_exceeded");
      return "skipped";
    }
  }

  let grant: ReturnType<RefineBridge["grant"]> | undefined;
  let cleanupPlugins: () => Promise<void> = async () => undefined;
  try {
    // 4. Provider (pinned del progetto o primo della catena).
    const provider = await resolveBacklogProvider(deps, await loadProjectAiProviderId(db, item.projectId));

    // 5. Worktree: dal registro, o aperti nel serializer (solo l'apertura).
    let entry = deps.worktrees.get(sid);
    if (!entry) {
      const repos = await (deps.loadMirrorProjectsFn ?? ((d, p) => loadMirrorProjects(deps, p)))(db, item.projectId);
      if (repos.length === 0) throw new Error(`il progetto ${item.projectId} non ha repository`);
      const parentDir = refineParentDir(sid);
      const opened = await deps.serializer.run(item.projectId, () =>
        deps.mirrors.openProjectWorktrees(repos, `stubwise/backlog-refine-${sid}`, parentDir),
      );
      entry = { agentSessionId: sid, parentDir, repos: opened.dirs, remove: opened.remove };
      deps.worktrees.set(entry);
    }

    // 6. Plugin (a ogni turno), grafo, ponte.
    const plugins = await openRunPlugins(db, {
      projectId: item.projectId,
      ...(deps.pluginsDir !== undefined ? { pluginsDir: deps.pluginsDir } : {}),
      log,
    });
    cleanupPlugins = plugins.cleanup;
    const graphs = deps.graphsDir === undefined ? [] : entry.repos.flatMap((r) => {
      const path = resolveRepoGraphJson(deps.graphsDir!, r.repositoryId);
      return path === null ? [] : [{ label: r.name, graphJsonPath: path }];
    });
    grant = deps.bridge.grant({ agentSessionId: sid, itemId: item.id });
    const mcp = buildRefineMcpConfig(deps.bridge, grant, deps.refineServerPath ?? refineServerPath());
    if (mcp === null) log(`[refine] tool di scrittura non disponibili (entry MCP assente): la sessione ${sid} non potrà salvare design e piano`);
    const allowedTools = [
      ...READ_ONLY_TOOLS,
      ...(graphs.length > 0 ? GRAPHIFY_AGENT_ALLOWED_TOOLS : []),
      ...(mcp?.tools ?? []),
    ];

    const priming = async (withTranscript: boolean) =>
      buildRefinePrimingPrompt(
        {
          language: await getContentLanguage(db),
          item: {
            title: item.title, document: item.document, implementationPlan: item.implementationPlan,
            originContent: item.originContent, effort: item.effort, risk: item.risk,
            riskNote: item.riskNote, urgency: item.urgency,
          },
          repos: entry!.repos.map((r) => ({ name: r.name, dir: r.dir })),
          graphHint: renderGraphHint(graphs, "it"),
          decisions: await db
            .select({ title: projectDecisions.title, decision: projectDecisions.decision, decidedAt: projectDecisions.decidedAt })
            .from(projectDecisions)
            .where(and(eq(projectDecisions.projectId, item.projectId), isNull(projectDecisions.supersededById)))
            .orderBy(desc(projectDecisions.decidedAt))
            .limit(DECISIONS_IN_PROMPT),
          recentTranscript: withTranscript ? await recentTranscript(db, sid, input.inputId) : [],
        },
        opening.text,
      );
    const attempt = (resumeSessionId: string | null, prompt: string): Promise<AgentRunResult> =>
      deps.runner.run({
        cwd: entry!.parentDir,
        prompt,
        permissionMode: "default",
        allowedTools,
        maxTurns: deps.maxTurns,
        timeoutMs: deps.turnTimeoutMs,
        ...(deps.model !== undefined ? { model: deps.model } : {}),
        ...(provider !== undefined ? { provider } : {}),
        ...(resumeSessionId !== null ? { resumeSessionId } : {}),
        ...(mcp !== null ? { mcpConfig: mcp.mcpConfig } : {}),
        ...plugins.options,
        session: backlogRefineSession(sid, randomUUID()),
        openingInput: { inputId: opening.id, text: opening.text, authorUserId: opening.authorUserId },
        signal: input.signal,
      } satisfies AgentRunOptions);

    // 7–8. Run, con UN nuovo tentativo se il --resume è rifiutato.
    const stored = ctx.refine.cliSessionId;
    let result = await attempt(stored, stored !== null ? buildRefineResumePrompt(opening.text) : await priming(false));
    if (stored !== null && result.exitCode !== 0 && result.sessionId === undefined && !(await echoed(db, sid, opening.id))) {
      log(`[refine] --resume ${stored} rifiutato per la sessione ${sid}: riparto col prompt d'avvio`);
      await claimOpening(db, opening.id, true);
      result = await attempt(null, await priming(true));
    }
    if (result.exitCode !== 0) throw new Error(`agente uscito con exit ${result.exitCode}`);

    // 9. Riuscito.
    await db
      .update(backlogRefineSessions)
      .set({ cliSessionId: result.sessionId ?? stored, lastActivityAt: sql`now()` })
      .where(eq(backlogRefineSessions.agentSessionId, sid));
    return "completed";
  } catch (error) {
    if (error instanceof AgentRunCancelledError) return "cancelled";
    log(`[refine] turno della sessione ${sid} fallito: ${error instanceof Error ? error.message : String(error)}`);
    if (!(await echoed(db, sid, opening.id).catch(() => true))) {
      await markUndelivered(db, sid, opening.id, "turn_failed").catch(() => undefined);
    }
    return "failed";
  } finally {
    grant?.revoke();
    await cleanupPlugins().catch(() => undefined);
  }
}
```

(Il campo con cui un run riceve la config MCP è quello che `buildAskUserRunConfig` mette in `mcpOpt`: `mcpConfig`. Se la catena dei provider risolve `undefined`, il run usa l'auth del container, come la chat CODE.)

- [ ] **Step 5: verificare**

Run: `pnpm --filter @stubwise/worker test -- backlog/refine/turn sessions/owners`
Expected: PASS.

- [ ] **Step 6: commit**

```bash
git add apps/worker/src/backlog/refine/turn.ts apps/worker/src/backlog/refine/turn.test.ts apps/worker/src/sessions/owners.ts
git commit -m "feat(worker): il turno della sessione di refinement"
```

---
### Task 10: `RefineScheduler`, sweep, chiusura, cablaggio, env

**Files:**
- Create: `apps/worker/src/backlog/refine/scheduler.ts`
- Modify: `apps/worker/src/config.ts` (tre env, accanto a `BACKLOG_CHAT_*` ~L600-650, e nel tipo/ritorno ~L1052/1210)
- Modify: `apps/worker/src/index.ts:188-200` (relay con `turnStarter`), dopo lo sweep della chat CODE (~L563) il blocco del refinement, e in coda (~L769) lo shutdown
- Modify: `docker-compose.yml` (blocco `worker`, accanto a `BACKLOG_CHAT_SESSION_TTL_MINUTES`), `.env.example` (accanto alla stessa)
- Test: `apps/worker/src/backlog/refine/scheduler.test.ts`, `apps/worker/src/config.test.ts`

**Interfaces:**
- Consumes: `TurnStarter`, `SessionInputRelay.deliverPending` (Task 5); `RefineBridge` (Task 6); `RefineWorktreeRegistry` (Task 7); `runRefineTurn` (Task 9); `BACKLOG_REFINE_CLOSED_CHANNEL` (Task 1).
- Produces: `RefineScheduler` (contratto). La chiusura di una sessione la SCRIVE il server (Task 11: `DELETE` e voce chiusa) o lo sweep d'inattività; lo scheduler pulisce (turno, segreti, input, worktree).

Regole (spec §3.2, §3.3, §5.5):
- **Mai due turni sulla stessa sessione**: lo stato in memoria `turns: Map<sessionId, { controller, done }>` si scrive in modo SINCRONO in `requestTurn`, prima di qualunque `await`.
- `requestTurn(id)`: in chiusura del worker, turno già attivo sulla sessione, o tetto (`maxConcurrent`) pieno → niente (i messaggi restano `pending`; il poll di 3 s del relay ripete la richiesta). Altrimenti prende l'input `pending` con testo PIÙ VECCHIO e chiama `runTurn`. A fine turno (qualunque esito) libera lo slot e chiama `relay.deliverPending()` (TUTTE le sessioni: il posto liberato può servire a un'altra in coda; il messaggio arrivato nella grazia diventa qui il turno successivo).
- `closeSession(id)`: PRIMA `bridge.revokeSession(id)` (nessuna scrittura dopo la richiesta di chiusura), poi `abort` del turno e attesa della sua fine, poi input `pending` della sessione → `undelivered`/`session_not_live` (+ NOTIFY degli eventi), poi `worktrees.remove(id)`. Idempotente.
- `start()`: `LISTEN BACKLOG_REFINE_CLOSED_CHANNEL` → `closeSession(agentSessionId)` (fail-open: senza LISTEN resta lo sweep).
- `sweepIdle(now)`: (a) chiude con `idle` le sessioni `active` con `last_activity_at < now − idleMinutes`, senza input `pending` e senza turno in corso nello scheduler — UPDATE guardato sugli stessi predicati, poi NOTIFY degli eventi e `closeSession`; (b) riconcilia: ogni sessione nel registro dei worktree la cui riga non è più `active` (chiusa dal server mentre la NOTIFY si è persa) → `closeSession`.
- `shutdown()`: niente turni nuovi, abort di quelli in corso, attesa, `worktrees.closeAll()`.

- [ ] **Step 1: test che falliscono**

```ts
// apps/worker/src/backlog/refine/scheduler.test.ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agentSessionInputs, agentSessions, backlogRefineSessions, users } from "@stubwise/db";
import { seedBacklogItem, startTestDb, type TestDb } from "@stubwise/db/testing";
import { BACKLOG_REFINE_CLOSED_CHANNEL } from "@stubwise/shared";
import { SessionInputRelay } from "../../sessions/relay.js";
import { RefineScheduler, type RefineSchedulerDeps } from "./scheduler.js";
import { createRefineWorktreeRegistry } from "./worktrees.js";
import type { RefineTurnOutcome } from "./turn.js";

let t: TestDb;
let userId: string;
beforeAll(async () => {
  t = await startTestDb();
  const [u] = await t.db.insert(users).values({ email: "a@x.test", passwordHash: "x", role: "admin" }).returning();
  userId = u!.id;
}, 120_000);
afterAll(async () => t.stop());

async function session(lastActivityAt = new Date()) {
  const { itemId } = await seedBacklogItem(t.db);
  const [s] = await t.db.insert(agentSessions)
    .values({ ownerKey: `backlog_refine:${itemId}`, kind: "backlog_refine", title: "t", backlogItemId: itemId }).returning();
  await t.db.insert(backlogRefineSessions).values({ itemId, agentSessionId: s!.id, lastActivityAt });
  return s!.id;
}
async function input(sessionId: string, text: string) {
  const [r] = await t.db.insert(agentSessionInputs).values({ sessionId, text, authorUserId: userId }).returning();
  return r!.id;
}
const inputOf = async (id: string) => (await t.db.select().from(agentSessionInputs).where(eq(agentSessionInputs.id, id)))[0]!;
const refineOf = async (sid: string) => (await t.db.select().from(backlogRefineSessions).where(eq(backlogRefineSessions.agentSessionId, sid)))[0]!;

/** Un runTurn finto, controllato dal test: ogni chiamata resta aperta finché non la si chiude. */
function controlledTurns() {
  const calls: { agentSessionId: string; inputId: string; signal: AbortSignal; finish: (o: RefineTurnOutcome) => void }[] = [];
  const runTurn = vi.fn((i: { agentSessionId: string; inputId: string; signal: AbortSignal }) =>
    new Promise<RefineTurnOutcome>((resolve) => {
      i.signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
      calls.push({ ...i, finish: resolve });
    }));
  return { calls, runTurn };
}
const tick = () => new Promise((r) => setTimeout(r, 50));

function scheduler(over: Partial<RefineSchedulerDeps> = {}) {
  const bridge = { revokeSession: vi.fn(), grant: vi.fn(), url: "", close: vi.fn() };
  const worktrees = createRefineWorktreeRegistry();
  const relay = { deliverPending: vi.fn(async () => undefined) };
  const s = new RefineScheduler({
    db: t.db, maxConcurrent: 2, idleMinutes: 30, bridge: bridge as never, worktrees,
    runTurn: controlledTurns().runTurn, log: () => undefined, ...over,
  });
  s.attachRelay(relay);
  return { s, bridge, worktrees, relay };
}

describe("RefineScheduler", () => {
  it("due richieste insieme: UN turno, col messaggio più vecchio (Review Focus #2)", async () => {
    const sid = await session();
    const first = await input(sid, "primo");
    await input(sid, "secondo");
    const turns = controlledTurns();
    const { s } = scheduler({ runTurn: turns.runTurn });
    s.requestTurn(sid);
    s.requestTurn(sid);
    await tick();
    expect(turns.calls.map((c) => c.inputId)).toEqual([first]);
    turns.calls[0]!.finish("completed");
  });

  it("a fine turno sveglia il relay: il messaggio arrivato nella grazia diventa il turno dopo (Review Focus #1)", async () => {
    const sid = await session();
    const first = await input(sid, "primo");
    const turns = controlledTurns();
    const { s } = scheduler({ runTurn: turns.runTurn });
    const relay = new SessionInputRelay({ db: t.db, turnStarter: s });
    s.attachRelay(relay);
    s.requestTurn(sid);
    await tick();
    const late = await input(sid, "arrivato tardi");
    await relay.deliverPending(sid); // turno ancora in corso: requestTurn è un no-op
    expect(turns.calls).toHaveLength(1);
    expect((await inputOf(late)).status).toBe("pending");
    turns.calls[0]!.finish("completed");
    await tick(); await tick();
    expect(turns.calls.map((c) => c.inputId)).toEqual([first, late]);
    turns.calls[1]!.finish("completed");
  });

  it("tetto d'istanza: la seconda sessione aspetta e parte quando il posto si libera", async () => {
    const a = await session();
    const b = await session();
    await input(a, "a");
    await input(b, "b");
    const turns = controlledTurns();
    const { s, relay } = scheduler({ runTurn: turns.runTurn, maxConcurrent: 1 });
    s.requestTurn(a);
    s.requestTurn(b);
    await tick();
    expect(turns.calls.map((c) => c.agentSessionId)).toEqual([a]);
    turns.calls[0]!.finish("completed");
    await tick();
    expect(relay.deliverPending).toHaveBeenCalled();
    s.requestTurn(b); // ciò che farebbe il relay
    await tick();
    expect(turns.calls.map((c) => c.agentSessionId)).toEqual([a, b]);
    turns.calls[1]!.finish("completed");
  });

  it("closeSession a metà turno: segreti revocati PRIMA, turno annullato, pending → undelivered, worktree smontati (Review Focus #3)", async () => {
    const sid = await session();
    await input(sid, "in corso");
    const turns = controlledTurns();
    const { s, bridge, worktrees } = scheduler({ runTurn: turns.runTurn });
    const remove = vi.fn(async () => undefined);
    worktrees.set({ agentSessionId: sid, parentDir: "/p", repos: [], remove });
    s.requestTurn(sid);
    await tick();
    const waiting = await input(sid, "in coda");
    let abortedAtRevoke: boolean | null = null;
    bridge.revokeSession.mockImplementation(() => { abortedAtRevoke = turns.calls[0]!.signal.aborted; });
    await s.closeSession(sid);
    expect(bridge.revokeSession).toHaveBeenCalledWith(sid);
    expect(abortedAtRevoke).toBe(false); // revoca PRIMA dell'abort
    expect(turns.calls[0]!.signal.aborted).toBe(true);
    expect(await inputOf(waiting)).toMatchObject({ status: "undelivered", reason: "session_not_live" });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("NOTIFY di chiusura dal server: closeSession", async () => {
    const sid = await session();
    const { s, bridge } = scheduler({ listen: (ch, cb) => t.client.listen(ch, cb) });
    await s.start();
    await t.db.execute(sql`select pg_notify(${BACKLOG_REFINE_CLOSED_CHANNEL}, ${JSON.stringify({ agentSessionId: sid })})`);
    await tick(); await tick();
    expect(bridge.revokeSession).toHaveBeenCalledWith(sid);
    await s.shutdown();
  });

  it("sweep: chiude per inattività solo senza messaggi in coda e senza turno in corso", async () => {
    const old = new Date(Date.now() - 3_600_000);
    const idle = await session(old);
    const queued = await session(old);
    await input(queued, "in coda");
    const busy = await session(old);
    await input(busy, "al lavoro");
    const fresh = await session();
    const turns = controlledTurns();
    const { s } = scheduler({ runTurn: turns.runTurn });
    s.requestTurn(busy);
    await tick();
    await s.sweepIdle();
    expect(await refineOf(idle)).toMatchObject({ status: "closed", closedReason: "idle" });
    for (const sid of [queued, busy, fresh]) expect((await refineOf(sid)).status).toBe("active");
    turns.calls[0]!.finish("completed");
  });

  it("sweep: riconcilia i worktree di una sessione chiusa dal server (NOTIFY persa)", async () => {
    const sid = await session();
    await t.db.update(backlogRefineSessions)
      .set({ status: "closed", closedReason: "user", closedAt: new Date() })
      .where(eq(backlogRefineSessions.agentSessionId, sid));
    const { s, worktrees } = scheduler();
    const remove = vi.fn(async () => undefined);
    worktrees.set({ agentSessionId: sid, parentDir: "/p", repos: [], remove });
    await s.sweepIdle();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
```

Import mancante: `sql` da `drizzle-orm`.

In `config.test.ts`:

```ts
it("sessioni di refinement: default e limiti", () => {
  const d = loadWorkerConfig({ ...VALID });
  expect([d.backlogRefineMaxConcurrent, d.backlogRefineIdleMinutes, d.backlogRefineTurnTimeoutMs]).toEqual([2, 30, 900_000]);
  const empty = loadWorkerConfig({ ...VALID, BACKLOG_REFINE_MAX_CONCURRENT: "", BACKLOG_REFINE_IDLE_MINUTES: "", BACKLOG_REFINE_TURN_TIMEOUT_MS: "" });
  expect(empty.backlogRefineMaxConcurrent).toBe(2);
  const o = loadWorkerConfig({ ...VALID, BACKLOG_REFINE_MAX_CONCURRENT: "4", BACKLOG_REFINE_IDLE_MINUTES: "10", BACKLOG_REFINE_TURN_TIMEOUT_MS: "120000" });
  expect([o.backlogRefineMaxConcurrent, o.backlogRefineIdleMinutes, o.backlogRefineTurnTimeoutMs]).toEqual([4, 10, 120_000]);
  expect(() => loadWorkerConfig({ ...VALID, BACKLOG_REFINE_MAX_CONCURRENT: "0" })).toThrow(/BACKLOG_REFINE_MAX_CONCURRENT/);
  expect(() => loadWorkerConfig({ ...VALID, BACKLOG_REFINE_IDLE_MINUTES: "0" })).toThrow(/BACKLOG_REFINE_IDLE_MINUTES/);
  expect(() => loadWorkerConfig({ ...VALID, BACKLOG_REFINE_TURN_TIMEOUT_MS: "1000" })).toThrow(/BACKLOG_REFINE_TURN_TIMEOUT_MS/);
});
```

- [ ] **Step 2: verificare che falliscano**

Run: `pnpm --filter @stubwise/worker test -- backlog/refine/scheduler config`
Expected: FAIL.

- [ ] **Step 3: implementazione — scheduler**

```ts
// apps/worker/src/backlog/refine/scheduler.ts
import { and, asc, eq, inArray, lt, ne, notExists, sql } from "drizzle-orm";
import { agentSessionInputs, backlogRefineSessions, type Db } from "@stubwise/db";
import { AGENT_SESSION_EVENTS_CHANNEL, BACKLOG_REFINE_CLOSED_CHANNEL } from "@stubwise/shared";
import type { TurnStarter } from "../../sessions/relay.js";
import type { RefineBridge } from "./bridge.js";
import type { RefineTurnOutcome } from "./turn.js";
import type { RefineWorktreeRegistry } from "./worktrees.js";

/**
 * Scheduler dei turni di refinement (design 2026-10-14 §3.2, §3.3, §5.5).
 * In memoria: il worker è UN processo (come relay e serializer). Garantisce
 * che su una sessione giri al più UN turno, tiene il tetto d'istanza e pulisce
 * alla chiusura. Non scrive mai la chiusura voluta da una persona (la scrive
 * il server); scrive solo quella per inattività.
 */
export interface RefineSchedulerDeps {
  db: Db;
  maxConcurrent: number;
  idleMinutes: number;
  bridge: Pick<RefineBridge, "revokeSession">;
  worktrees: RefineWorktreeRegistry;
  runTurn: (input: { agentSessionId: string; inputId: string; signal: AbortSignal }) => Promise<RefineTurnOutcome>;
  listen?: (channel: string, cb: (payload: string) => void) => Promise<unknown>;
  log: (m: string) => void;
}

export class RefineScheduler implements TurnStarter {
  private readonly turns = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private relay: { deliverPending(sessionId?: string): Promise<void> } | undefined;
  private stopping = false;

  constructor(private readonly deps: RefineSchedulerDeps) {}

  /** Il relay nasce prima (è lui a chiamare `requestTurn`): si aggancia dopo. */
  attachRelay(relay: { deliverPending(sessionId?: string): Promise<void> }): void {
    this.relay = relay;
  }

  async start(): Promise<void> {
    if (!this.deps.listen) return;
    try {
      await this.deps.listen(BACKLOG_REFINE_CLOSED_CHANNEL, (payload) => {
        try {
          const { agentSessionId } = JSON.parse(payload) as { agentSessionId?: string };
          if (agentSessionId) void this.closeSession(agentSessionId);
        } catch {
          // payload illeggibile: resta lo sweep
        }
      });
    } catch (error) {
      this.deps.log(`[refine] LISTEN ${BACKLOG_REFINE_CLOSED_CHANNEL} fallito, resta lo sweep: ${String(error)}`);
    }
  }

  requestTurn(sessionId: string): void {
    if (this.stopping || this.turns.has(sessionId) || this.turns.size >= this.deps.maxConcurrent) return;
    const controller = new AbortController();
    // Registrato SINCRONO, prima di ogni await: una seconda requestTurn lo vede.
    const done = this.runOne(sessionId, controller.signal).finally(() => {
      this.turns.delete(sessionId);
      // Il messaggio arrivato nella grazia, o un'altra sessione in coda.
      void this.relay?.deliverPending();
    });
    this.turns.set(sessionId, { controller, done });
  }

  private async runOne(sessionId: string, signal: AbortSignal): Promise<void> {
    try {
      const [oldest] = await this.deps.db
        .select({ id: agentSessionInputs.id })
        .from(agentSessionInputs)
        .where(and(
          eq(agentSessionInputs.sessionId, sessionId),
          eq(agentSessionInputs.status, "pending"),
          ne(agentSessionInputs.text, ""),
        ))
        .orderBy(asc(agentSessionInputs.createdAt))
        .limit(1);
      if (!oldest || signal.aborted) return;
      await this.deps.runTurn({ agentSessionId: sessionId, inputId: oldest.id, signal });
    } catch (error) {
      this.deps.log(`[refine] turno della sessione ${sessionId}: ${String(error)}`);
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    // Prima i segreti: nessuna scrittura del ponte dopo la richiesta di chiusura.
    this.deps.bridge.revokeSession(sessionId);
    const turn = this.turns.get(sessionId);
    if (turn) {
      turn.controller.abort();
      await turn.done;
    }
    try {
      const updated = await this.deps.db
        .update(agentSessionInputs)
        .set({ status: "undelivered", reason: "session_not_live", deliveredAt: null })
        .where(and(eq(agentSessionInputs.sessionId, sessionId), eq(agentSessionInputs.status, "pending")))
        .returning({ id: agentSessionInputs.id });
      if (updated.length > 0) await this.notifyEvents(sessionId);
    } catch (error) {
      this.deps.log(`[refine] chiusura ${sessionId}: input non marcati: ${String(error)}`);
    }
    await this.deps.worktrees.remove(sessionId).catch((error: unknown) => {
      this.deps.log(`[refine] chiusura ${sessionId}: worktree non smontati: ${String(error)}`);
    });
  }

  async sweepIdle(now: Date = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - this.deps.idleMinutes * 60_000);
    const busy = [...this.turns.keys()];
    try {
      const closed = await this.deps.db
        .update(backlogRefineSessions)
        .set({ status: "closed", closedReason: "idle", closedAt: now })
        .where(and(
          eq(backlogRefineSessions.status, "active"),
          lt(backlogRefineSessions.lastActivityAt, cutoff),
          notExists(this.deps.db.select({ one: sql`1` }).from(agentSessionInputs).where(and(
            eq(agentSessionInputs.sessionId, backlogRefineSessions.agentSessionId),
            eq(agentSessionInputs.status, "pending"),
          ))),
          ...(busy.length > 0 ? [sql`${backlogRefineSessions.agentSessionId} not in ${busy}`] : []),
        ))
        .returning({ agentSessionId: backlogRefineSessions.agentSessionId });
      for (const { agentSessionId } of closed) {
        await this.notifyEvents(agentSessionId);
        await this.closeSession(agentSessionId);
      }
      // Riconciliazione: worktree di sessioni chiuse dal server con la NOTIFY persa.
      const open = this.deps.worktrees.ids();
      if (open.length > 0) {
        const active = new Set((await this.deps.db
          .select({ id: backlogRefineSessions.agentSessionId })
          .from(backlogRefineSessions)
          .where(and(inArray(backlogRefineSessions.agentSessionId, open), eq(backlogRefineSessions.status, "active"))))
          .map((r) => r.id));
        for (const id of open) if (!active.has(id)) await this.closeSession(id);
      }
    } catch (error) {
      this.deps.log(`[refine] sweep fallito: ${String(error)}`);
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const turn of this.turns.values()) turn.controller.abort();
    await Promise.allSettled([...this.turns.values()].map((t) => t.done));
    await this.deps.worktrees.closeAll();
  }

  private async notifyEvents(sessionId: string): Promise<void> {
    await this.deps.db
      .execute(sql`select pg_notify(${AGENT_SESSION_EVENTS_CHANNEL}, ${JSON.stringify({ sessionId })})`)
      .catch(() => undefined);
  }
}
```

(Se `sql\`… not in ${busy}\`` non espande l'array come lista, usare `notInArray(backlogRefineSessions.agentSessionId, busy)` di drizzle: è la forma da preferire, il frammento è solo per non dipendere dalla versione.)

- [ ] **Step 4: implementazione — config ed env**

In `config.ts`, accanto alle `BACKLOG_CHAT_*`, con lo stesso stile (`z.preprocess(emptyAsUndefined, z.coerce.number({ error }).int(…).min(…).default(…))`):

```ts
  // Sessioni di refinement del backlog (design 2026-10-14 §5.5): turni
  // CONTEMPORANEI d'istanza. Un turno in più resta in coda (input pending,
  // sessione «queued»). Default 2.
  BACKLOG_REFINE_MAX_CONCURRENT: … .min(1, "deve essere un intero ≥ 1 (es. 2)").default(2),
  // Minuti di inattività dopo cui una sessione di refinement si chiude (si
  // riprende scrivendo). Default 30.
  BACKLOG_REFINE_IDLE_MINUTES: … .min(1, "deve essere un intero ≥ 1 in minuti (es. 30)").default(30),
  // Timeout di UN turno di refinement. Default 900000 = 15'.
  BACKLOG_REFINE_TURN_TIMEOUT_MS: … .min(60_000, "deve essere un intero ≥ 60000 in millisecondi (es. 900000)").default(900_000),
```

e nel tipo/ritorno `backlogRefineMaxConcurrent`, `backlogRefineIdleMinutes`, `backlogRefineTurnTimeoutMs`. Nessun legame con `WORKER_STALE_MINUTES`: i turni non sono job e non hanno righe da recuperare (spec §5.5).

`docker-compose.yml`, blocco `worker`:

```yaml
      - BACKLOG_REFINE_MAX_CONCURRENT=${BACKLOG_REFINE_MAX_CONCURRENT:-2}
      - BACKLOG_REFINE_IDLE_MINUTES=${BACKLOG_REFINE_IDLE_MINUTES:-30}
      - BACKLOG_REFINE_TURN_TIMEOUT_MS=${BACKLOG_REFINE_TURN_TIMEOUT_MS:-900000}
```

`.env.example`, con un commento di una riga come le vicine: `BACKLOG_REFINE_MAX_CONCURRENT=`, `BACKLOG_REFINE_IDLE_MINUTES=`, `BACKLOG_REFINE_TURN_TIMEOUT_MS=`.

- [ ] **Step 5: implementazione — cablaggio in `index.ts`**

Il relay nasce prima di mirror e serializer: si collega allo scheduler con una chiusura (late binding). Al posto della costruzione del relay:

```ts
// Sessioni di refinement (design 2026-10-14): lo scheduler nasce più giù (gli
// servono mirror e serializer); il relay gli parla attraverso questa chiusura.
let refineScheduler: RefineScheduler | null = null;
const relay = config.agentStreaming
  ? new SessionInputRelay({
      db,
      listen: (channel, cb) => client.listen(channel, cb),
      turnStarter: { requestTurn: (id) => refineScheduler?.requestTurn(id) },
    })
  : null;
```

Dopo lo sweep della chat CODE:

```ts
// SESSIONI DI REFINEMENT DEL BACKLOG (design 2026-10-14): solo col runner in
// streaming (il relay esiste solo lì). Ponte dei tool su loopback, registro
// dei worktree, scheduler dei turni (FUORI dal serializer: il serializer si
// usa solo per aprire i worktree) e sweep d'inattività ogni 60 s.
const refineWorktrees = createRefineWorktreeRegistry();
const refineBridge = relay ? await startRefineBridge({ db }) : null;
if (relay && refineBridge) {
  const scheduler = new RefineScheduler({
    db,
    maxConcurrent: config.backlogRefineMaxConcurrent,
    idleMinutes: config.backlogRefineIdleMinutes,
    bridge: refineBridge,
    worktrees: refineWorktrees,
    listen: (channel, cb) => client.listen(channel, cb),
    log: (m) => console.warn(m),
    runTurn: (input) =>
      runRefineTurn(
        {
          db, runner, mirrors, serializer, worktrees: refineWorktrees, bridge: refineBridge,
          encryptionKey: config.encryptionKey, graphsDir: config.graphsDir, pluginsDir: config.pluginsDir,
          model: config.backlogModel, maxTurns: config.backlogChatTurnMaxTurns,
          turnTimeoutMs: config.backlogRefineTurnTimeoutMs, log: (m) => console.warn(m),
        },
        input,
      ),
  });
  scheduler.attachRelay(relay);
  await scheduler.start();
  refineScheduler = scheduler;
  const sweep = setInterval(() => void scheduler.sweepIdle(), 60_000);
  sweep.unref();
  controller.signal.addEventListener("abort", () => clearInterval(sweep), { once: true });
}
```

In coda, dopo `await runWorker(...)` e prima di `relay?.stop()`:

```ts
await refineScheduler?.shutdown();
await refineBridge?.close();
```

(Al riavvio non serve un recupero: `resetLiveSegmentsAtStartup` azzera i segmenti, gli input rimasti `pending` diventano turni alla prima sveglia del relay, e un input d'apertura rimasto `delivered` senza eco resta nella trascrizione com'è — spec §5.5.)

- [ ] **Step 6: verificare**

Run: `pnpm --filter @stubwise/worker test -- backlog/refine config && pnpm --filter @stubwise/worker typecheck`
Expected: PASS.

- [ ] **Step 7: commit**

```bash
git add apps/worker/src/backlog/refine/scheduler.ts apps/worker/src/backlog/refine/scheduler.test.ts apps/worker/src/config.ts apps/worker/src/config.test.ts apps/worker/src/index.ts docker-compose.yml .env.example
git commit -m "feat(worker): scheduler dei turni di refinement, sweep d'inattività e cablaggio"
```

---
### Task 11: Server — avvio e chiusura

**Files:**
- Create: `apps/server/src/services/backlog-refine.ts`
- Modify: `apps/server/src/routes/backlog.ts` (rotte nuove accanto a `/:id/code-session` ~L1240; `refineSession` nel `GET /:id` ~L640; `onArchive` del PATCH; ramo merge ~L1607)
- Modify: `apps/server/src/services/backlog.ts:120-138` (conversione)
- Test: `apps/server/src/services/backlog-refine.test.ts` (nuovo), `apps/server/src/routes/backlog.test.ts` (`describe` nuovi in coda)

**Interfaces:**
- Consumes: Task 1 (schemi, canali), Task 2 (tabelle), Task 3 (`updateBacklogItemMetadata` con `onArchive`).
- Produces: `startRefineSession`, `closeRefineSession`, `closeRefineSessionForItem`, `reopenRefineSessionIfClosed`, `loadRefineSessionView` (contratto); `POST`/`DELETE /api/backlog/:id/refine-session`; `refineSession` nel dettaglio.

Regole:
- **Avvio** (`POST`, `requireAuth`, member ammessi come la chat): in UNA transazione, con la voce in lock: voce assente → 404; `converted`/`archived` → 409 `item_closed`, nessuna riga; upsert della sessione dell'agente (`owner_key = backlog_refine:<itemId>`, kind `backlog_refine`, `project_id`, `backlog_item_id`, titolo = titolo della voce) e della riga `backlog_refine_sessions` (nuova `active` con `started_by_user_id`, oppure riaperta: `active`, `closed_*` azzerati, `last_activity_at = now()`); con `message`, l'input (autore = chi chiama) + `pg_notify(AGENT_SESSION_INPUT_CHANNEL)`; sempre `pg_notify(AGENT_SESSION_EVENTS_CHANNEL)`. Risposta 200 `{ agentSessionId, inputId }`. Non parte niente da sola: il turno nasce dal messaggio (relay → scheduler).
- **Chiusura** (`DELETE`, `requireAuth`): voce assente → 404; altrimenti 204 SEMPRE (idempotente, anche senza sessione o già chiusa). Se c'era una sessione `active`: `closed`/`user`, input `pending` → `undelivered`/`session_not_live`, `pg_notify(BACKLOG_REFINE_CLOSED_CHANNEL, { agentSessionId })` (il worker annulla il turno, revoca i segreti, smonta i worktree) e `pg_notify` degli eventi.
- **Voce chiusa**: `closeRefineSessionForItem(tx, itemId)` fa lo stesso con `item_closed`, nella transazione di chi chiude la voce: conversione (`services/backlog.ts`), PATCH verso `archived` (`onArchive`), fusione (la voce assorbita, nel ramo che oggi chiama `closeOpenBacklogQuestion`).
- **Riapertura** (`reopenRefineSessionIfClosed`, la usa il Task 12 nella transazione dell'input): `not_refine` se la sessione non è di refinement; `item_closed` se la voce è convertita o archiviata; altrimenti `active` (riapre se serve) e SEMPRE `last_activity_at = now()`, così lo sweep non chiude una sessione a cui si è appena scritto.

- [ ] **Step 1: test che falliscono — servizio**

```ts
// apps/server/src/services/backlog-refine.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentSessionInputs, agentSessions, backlogItems, backlogRefineSessions, users, type Db } from "@stubwise/db";
import { seedBacklogItem, startTestDb, type TestDb } from "@stubwise/db/testing";
import { AGENT_SESSION_INPUT_CHANNEL, BACKLOG_REFINE_CLOSED_CHANNEL } from "@stubwise/shared";
import {
  closeRefineSession, closeRefineSessionForItem, loadRefineSessionView,
  reopenRefineSessionIfClosed, startRefineSession,
} from "./backlog-refine.js";

let t: TestDb;
let db: Db;
let member: { id: string; role: "member" };
beforeAll(async () => {
  t = await startTestDb(); db = t.db;
  const [u] = await db.insert(users).values({ email: "m@x.test", passwordHash: "x", role: "member" }).returning();
  member = { id: u!.id, role: "member" };
}, 120_000);
afterAll(async () => t.stop());

const refineOf = async (itemId: string) => (await db.select().from(backlogRefineSessions).where(eq(backlogRefineSessions.itemId, itemId)))[0];

describe("startRefineSession", () => {
  it("un member crea la sessione: agent_sessions backlog_refine legata alla voce, riga attiva, nessun input senza messaggio", async () => {
    const { itemId, projectId } = await seedBacklogItem(db, { title: "Export" });
    const res = await startRefineSession(db, member, itemId);
    expect(res).toMatchObject({ ok: true, inputId: null });
    if (!res.ok) throw new Error();
    const [s] = await db.select().from(agentSessions).where(eq(agentSessions.id, res.agentSessionId));
    expect(s).toMatchObject({ kind: "backlog_refine", ownerKey: `backlog_refine:${itemId}`, backlogItemId: itemId, projectId, title: "Export" });
    expect(await refineOf(itemId)).toMatchObject({ status: "active", startedByUserId: member.id, agentSessionId: res.agentSessionId });
    expect(await db.select().from(agentSessionInputs).where(eq(agentSessionInputs.sessionId, res.agentSessionId))).toHaveLength(0);
  });

  it("col messaggio: input pending dell'autore e NOTIFY sul canale degli input", async () => {
    const { itemId } = await seedBacklogItem(db);
    const notified: string[] = [];
    const sub = await t.client.listen(AGENT_SESSION_INPUT_CHANNEL, (p) => notified.push(p));
    const res = await startRefineSession(db, member, itemId, "partiamo");
    if (!res.ok) throw new Error();
    const [input] = await db.select().from(agentSessionInputs).where(eq(agentSessionInputs.id, res.inputId!));
    expect(input).toMatchObject({ text: "partiamo", status: "pending", authorUserId: member.id });
    await new Promise((r) => setTimeout(r, 200));
    expect(notified.map((p) => JSON.parse(p).sessionId)).toContain(res.agentSessionId);
    await sub.unlisten();
  });

  it("una sola sessione per voce: il secondo avvio riapre la STESSA, chiusa compresa", async () => {
    const { itemId } = await seedBacklogItem(db);
    const a = await startRefineSession(db, member, itemId);
    await closeRefineSession(db, member, itemId);
    const b = await startRefineSession(db, member, itemId);
    expect(b.ok && a.ok && b.agentSessionId === a.agentSessionId).toBe(true);
    expect(await refineOf(itemId)).toMatchObject({ status: "active", closedAt: null, closedReason: null });
  });

  it("voce convertita o archiviata: item_closed e nessuna riga; voce inesistente: not_found", async () => {
    for (const status of ["converted", "archived"] as const) {
      const { itemId } = await seedBacklogItem(db, { status });
      expect(await startRefineSession(db, member, itemId, "x")).toEqual({ ok: false, error: "item_closed" });
      expect(await refineOf(itemId)).toBeUndefined();
    }
    expect(await startRefineSession(db, member, "7f1c2a1e-0000-4000-8000-0000000000ff")).toEqual({ ok: false, error: "not_found" });
  });
});

describe("chiusura", () => {
  it("«Chiudi»: closed/user, pending → undelivered, NOTIFY di chiusura; idempotente", async () => {
    const { itemId } = await seedBacklogItem(db);
    const res = await startRefineSession(db, member, itemId, "in coda");
    if (!res.ok) throw new Error();
    const closed: string[] = [];
    const sub = await t.client.listen(BACKLOG_REFINE_CLOSED_CHANNEL, (p) => closed.push(p));
    expect(await closeRefineSession(db, member, itemId)).toEqual({ ok: true });
    expect(await closeRefineSession(db, member, itemId)).toEqual({ ok: true });
    expect(await refineOf(itemId)).toMatchObject({ status: "closed", closedReason: "user" });
    const [input] = await db.select().from(agentSessionInputs).where(eq(agentSessionInputs.id, res.inputId!));
    expect(input).toMatchObject({ status: "undelivered", reason: "session_not_live" });
    await new Promise((r) => setTimeout(r, 200));
    expect(closed.map((p) => JSON.parse(p).agentSessionId)).toEqual([res.agentSessionId]); // una sola: la seconda non chiude niente
    await sub.unlisten();
  });

  it("voce senza sessione: ok; voce inesistente: not_found", async () => {
    const { itemId } = await seedBacklogItem(db);
    expect(await closeRefineSession(db, member, itemId)).toEqual({ ok: true });
    expect(await closeRefineSession(db, member, "7f1c2a1e-0000-4000-8000-0000000000ff")).toEqual({ ok: false, error: "not_found" });
  });

  it("closeRefineSessionForItem: item_closed, e da lì reopen risponde item_closed", async () => {
    const { itemId } = await seedBacklogItem(db);
    const res = await startRefineSession(db, member, itemId);
    if (!res.ok) throw new Error();
    await db.transaction(async (tx) => {
      await tx.update(backlogItems).set({ status: "archived" }).where(eq(backlogItems.id, itemId));
      await closeRefineSessionForItem(tx, itemId);
    });
    expect(await refineOf(itemId)).toMatchObject({ status: "closed", closedReason: "item_closed" });
    expect(await db.transaction((tx) => reopenRefineSessionIfClosed(tx, res.agentSessionId))).toBe("item_closed");
  });

  it("reopen: riapre una sessione chiusa su voce aperta e tocca l'attività; not_refine per gli altri kind", async () => {
    const { itemId } = await seedBacklogItem(db);
    const res = await startRefineSession(db, member, itemId);
    if (!res.ok) throw new Error();
    await closeRefineSession(db, member, itemId);
    expect(await db.transaction((tx) => reopenRefineSessionIfClosed(tx, res.agentSessionId))).toBe("active");
    expect((await refineOf(itemId))!.status).toBe("active");
    const [other] = await db.insert(agentSessions).values({ ownerKey: `ai_job:${itemId}`, kind: "ai_job", title: "t" }).returning();
    expect(await db.transaction((tx) => reopenRefineSessionIfClosed(tx, other!.id))).toBe("not_refine");
  });

  it("loadRefineSessionView: null senza sessione, la vista con closedReason", async () => {
    const { itemId } = await seedBacklogItem(db);
    expect(await loadRefineSessionView(db, itemId)).toBeNull();
    const res = await startRefineSession(db, member, itemId);
    await closeRefineSession(db, member, itemId);
    expect(await loadRefineSessionView(db, itemId)).toMatchObject({
      agentSessionId: res.ok ? res.agentSessionId : "", status: "closed", closedReason: "user",
    });
  });
});
```

- [ ] **Step 2: test che falliscono — rotte**

In `routes/backlog.test.ts`, con gli helper del file (`insertItem`, cookie di admin e member di `seedUsers`):

```ts
describe("POST/DELETE /api/backlog/:id/refine-session", () => {
  it("un member avvia (200, agentSessionId) e col messaggio riceve inputId", async () => {
    const item = await insertItem();
    const res = await app.inject({ method: "POST", url: `/api/backlog/${item.id}/refine-session`, headers: { cookie: memberCookie }, payload: { message: "ciao" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ agentSessionId: expect.any(String), inputId: expect.any(String) });
  });
  it("voce convertita: 409 item_closed", async () => {
    const item = await insertItem({ status: "converted" });
    const res = await app.inject({ method: "POST", url: `/api/backlog/${item.id}/refine-session`, headers: { cookie: memberCookie }, payload: {} });
    expect([res.statusCode, res.json().code]).toEqual([409, "item_closed"]);
  });
  it("messaggio vuoto: 400; voce inesistente: 404", async () => {
    const item = await insertItem();
    expect((await app.inject({ method: "POST", url: `/api/backlog/${item.id}/refine-session`, headers: { cookie: memberCookie }, payload: { message: "  " } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/backlog/7f1c2a1e-0000-4000-8000-0000000000ff/refine-session`, headers: { cookie: memberCookie }, payload: {} })).statusCode).toBe(404);
  });
  it("DELETE: 204 due volte di fila; voce inesistente 404", async () => {
    const item = await insertItem();
    await app.inject({ method: "POST", url: `/api/backlog/${item.id}/refine-session`, headers: { cookie: memberCookie }, payload: {} });
    for (let i = 0; i < 2; i++) {
      expect((await app.inject({ method: "DELETE", url: `/api/backlog/${item.id}/refine-session`, headers: { cookie: memberCookie } })).statusCode).toBe(204);
    }
    expect((await app.inject({ method: "DELETE", url: `/api/backlog/7f1c2a1e-0000-4000-8000-0000000000ff/refine-session`, headers: { cookie: memberCookie } })).statusCode).toBe(404);
  });
  it("senza login: 401", async () => {
    const item = await insertItem();
    expect((await app.inject({ method: "POST", url: `/api/backlog/${item.id}/refine-session`, payload: {} })).statusCode).toBe(401);
  });
});

describe("la voce chiusa chiude la sessione di refinement (Review Focus #6)", () => {
  async function started() {
    const item = await insertItem();
    const res = await app.inject({ method: "POST", url: `/api/backlog/${item.id}/refine-session`, headers: { cookie: memberCookie }, payload: {} });
    return { itemId: item.id, agentSessionId: res.json().agentSessionId as string };
  }
  const refineOf = async (itemId: string) =>
    (await testDb.db.select().from(backlogRefineSessions).where(eq(backlogRefineSessions.itemId, itemId)))[0]!;

  it("conversione in ticket", async () => {
    const { itemId } = await started();
    expect((await app.inject({ method: "POST", url: `/api/backlog/${itemId}/convert`, headers: { cookie: adminCookie }, payload: {} })).statusCode).toBeLessThan(300);
    expect(await refineOf(itemId)).toMatchObject({ status: "closed", closedReason: "item_closed" });
  });
  it("archiviazione via PATCH", async () => {
    const { itemId } = await started();
    await app.inject({ method: "PATCH", url: `/api/backlog/${itemId}`, headers: { cookie: adminCookie }, payload: { status: "archived" } });
    expect(await refineOf(itemId)).toMatchObject({ status: "closed", closedReason: "item_closed" });
  });
  it("fusione: si chiude quella della voce ASSORBITA", async () => {
    const { itemId } = await started();
    const target = await insertItem();
    await app.inject({ method: "POST", url: `/api/backlog/${itemId}/merge`, headers: { cookie: adminCookie }, payload: { targetId: target.id } });
    expect(await refineOf(itemId)).toMatchObject({ status: "closed", closedReason: "item_closed" });
  });
});

describe("GET /api/backlog/:id refineSession", () => {
  it("null senza sessione, la vista con una sessione", async () => {
    const item = await insertItem();
    const before = await app.inject({ method: "GET", url: `/api/backlog/${item.id}`, headers: { cookie: memberCookie } });
    expect(before.json().refineSession).toBeNull();
    await app.inject({ method: "POST", url: `/api/backlog/${item.id}/refine-session`, headers: { cookie: memberCookie }, payload: {} });
    const after = await app.inject({ method: "GET", url: `/api/backlog/${item.id}`, headers: { cookie: memberCookie } });
    expect(after.json().refineSession).toMatchObject({ status: "active", closedReason: null });
  });
});
```

(Body di `convert` e `merge`: copiarli dai `describe` esistenti di quelle rotte nello stesso file; i nomi dei cookie da `seedUsers` come li usa il file.)

- [ ] **Step 3: verificare che falliscano**

Run: `pnpm --filter @stubwise/server test -- services/backlog-refine routes/backlog.test`
Expected: FAIL nei test nuovi.

- [ ] **Step 4: implementazione — servizio**

```ts
// apps/server/src/services/backlog-refine.ts
import { and, eq, sql } from "drizzle-orm";
import { agentSessionInputs, agentSessions, backlogItems, backlogRefineSessions, type Db } from "@stubwise/db";
import {
  AGENT_SESSION_EVENTS_CHANNEL,
  AGENT_SESSION_INPUT_CHANNEL,
  BACKLOG_REFINE_CLOSED_CHANNEL,
  type RefineCloseReason,
  type RefineSessionView,
} from "@stubwise/shared";
import type { Actor } from "./jobs.js";

/**
 * Sessioni di refinement del backlog, lato server (design 2026-10-14 §3, §5).
 * Il server apre, chiude e riapre la sessione e scrive gli input; il turno lo
 * decide e lo esegue il worker. Chi può: chiunque possa lavorare sul backlog
 * (`requireAuth`, come la chat), quindi `actor` serve solo come autore.
 */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTx = Db | Tx;

const isClosedItem = (status: string) => status === "converted" || status === "archived";

async function notify(tx: DbOrTx, channel: string, payload: Record<string, string>): Promise<void> {
  await tx.execute(sql`select pg_notify(${channel}, ${JSON.stringify(payload)})`);
}

export async function startRefineSession(
  db: Db,
  actor: Actor,
  itemId: string,
  message?: string,
): Promise<{ ok: true; agentSessionId: string; inputId: string | null } | { ok: false; error: "not_found" | "item_closed" }> {
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select({ id: backlogItems.id, projectId: backlogItems.projectId, title: backlogItems.title, status: backlogItems.status })
      .from(backlogItems)
      .where(eq(backlogItems.id, itemId))
      .for("update");
    if (!item) return { ok: false as const, error: "not_found" as const };
    if (isClosedItem(item.status)) return { ok: false as const, error: "item_closed" as const };
    const [session] = await tx
      .insert(agentSessions)
      .values({
        ownerKey: `backlog_refine:${itemId}`,
        kind: "backlog_refine",
        title: item.title,
        projectId: item.projectId,
        backlogItemId: itemId,
      })
      .onConflictDoUpdate({ target: agentSessions.ownerKey, set: { title: item.title } })
      .returning({ id: agentSessions.id });
    const agentSessionId = session!.id;
    await tx
      .insert(backlogRefineSessions)
      .values({ itemId, agentSessionId, startedByUserId: actor.id })
      .onConflictDoUpdate({
        target: backlogRefineSessions.itemId,
        set: { agentSessionId, status: "active", closedAt: null, closedReason: null, lastActivityAt: sql`now()` },
      });
    let inputId: string | null = null;
    if (message !== undefined) {
      const [input] = await tx
        .insert(agentSessionInputs)
        .values({ sessionId: agentSessionId, authorUserId: actor.id, text: message })
        .returning({ id: agentSessionInputs.id });
      inputId = input!.id;
      await notify(tx, AGENT_SESSION_INPUT_CHANNEL, { sessionId: agentSessionId });
    }
    await notify(tx, AGENT_SESSION_EVENTS_CHANNEL, { sessionId: agentSessionId });
    return { ok: true as const, agentSessionId, inputId };
  });
}

/** Chiude la sessione ATTIVA della voce (se c'è) e avvisa il worker. Nella transazione del chiamante. */
async function closeActive(tx: DbOrTx, itemId: string, reason: RefineCloseReason): Promise<void> {
  const [closed] = await tx
    .update(backlogRefineSessions)
    .set({ status: "closed", closedReason: reason, closedAt: sql`now()` })
    .where(and(eq(backlogRefineSessions.itemId, itemId), eq(backlogRefineSessions.status, "active")))
    .returning({ agentSessionId: backlogRefineSessions.agentSessionId });
  if (!closed) return;
  await tx
    .update(agentSessionInputs)
    .set({ status: "undelivered", reason: "session_not_live", deliveredAt: null })
    .where(and(eq(agentSessionInputs.sessionId, closed.agentSessionId), eq(agentSessionInputs.status, "pending")));
  // Al commit: il worker annulla il turno, revoca i segreti, smonta i worktree.
  await notify(tx, BACKLOG_REFINE_CLOSED_CHANNEL, { agentSessionId: closed.agentSessionId });
  await notify(tx, AGENT_SESSION_EVENTS_CHANNEL, { sessionId: closed.agentSessionId });
}

export async function closeRefineSession(
  db: Db,
  _actor: Actor,
  itemId: string,
): Promise<{ ok: true } | { ok: false; error: "not_found" }> {
  return db.transaction(async (tx) => {
    const [item] = await tx.select({ id: backlogItems.id }).from(backlogItems).where(eq(backlogItems.id, itemId));
    if (!item) return { ok: false as const, error: "not_found" as const };
    await closeActive(tx, itemId, "user");
    return { ok: true as const };
  });
}

/** Voce convertita, archiviata o assorbita: nella transazione di chi la chiude. */
export async function closeRefineSessionForItem(tx: DbOrTx, itemId: string): Promise<void> {
  await closeActive(tx, itemId, "item_closed");
}

/**
 * Nella transazione dell'input (Task 12): riapre la sessione se era chiusa e
 * tocca SEMPRE `last_activity_at` (lo sweep non chiude una sessione a cui si è
 * appena scritto). Mai su una voce chiusa.
 */
export async function reopenRefineSessionIfClosed(
  tx: DbOrTx,
  agentSessionId: string,
): Promise<"active" | "item_closed" | "not_refine"> {
  const [row] = await tx
    .select({ itemStatus: backlogItems.status })
    .from(backlogRefineSessions)
    .innerJoin(backlogItems, eq(backlogItems.id, backlogRefineSessions.itemId))
    .where(eq(backlogRefineSessions.agentSessionId, agentSessionId))
    .for("update", { of: backlogRefineSessions });
  if (!row) return "not_refine";
  if (isClosedItem(row.itemStatus)) return "item_closed";
  await tx
    .update(backlogRefineSessions)
    .set({ status: "active", closedAt: null, closedReason: null, lastActivityAt: sql`now()` })
    .where(eq(backlogRefineSessions.agentSessionId, agentSessionId));
  return "active";
}

export async function loadRefineSessionView(db: DbOrTx, itemId: string): Promise<RefineSessionView | null> {
  const [row] = await db.select().from(backlogRefineSessions).where(eq(backlogRefineSessions.itemId, itemId));
  if (!row) return null;
  return {
    agentSessionId: row.agentSessionId,
    status: row.status,
    closedReason: row.closedReason ?? null,
    lastActivityAt: row.lastActivityAt.toISOString(),
  };
}
```

- [ ] **Step 5: implementazione — rotte e punti di chiusura**

In `routes/backlog.ts`, accanto alle rotte `/:id/code-session` (i path hanno un suffisso letterale dopo `:id`, e `GET /:id` non condivide il metodo: nessuna trappola d'ordine, ma vanno comunque PRIMA di qualunque rotta parametrica più generica, come le vicine):

```ts
  // --- Sessione di refinement (design 2026-10-14) ---------------------------
  // Chiunque possa lavorare sul backlog (requireAuth, come la chat). L'avvio
  // NON fa partire niente: il turno nasce dal messaggio (relay → scheduler nel
  // worker). La chiusura è idempotente.
  app.post(
    "/:id/refine-session",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        body: startRefineSessionInputSchema,
        response: { 200: startRefineSessionResultSchema, 400: errorSchema, 404: errorSchema, 409: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const res = await startRefineSession(app.db, request.user!, request.params.id, request.body.message);
      if (res.ok) return { agentSessionId: res.agentSessionId, inputId: res.inputId };
      return res.error === "not_found"
        ? apiError(reply, 404, "backlog_item_not_found", "Backlog item not found")
        : apiError(reply, 409, "item_closed", "The backlog item is converted or archived");
    },
  );

  app.delete(
    "/:id/refine-session",
    {
      preHandler: requireAuth,
      schema: { params: idParamsSchema, response: { 204: z.null(), 404: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      const res = await closeRefineSession(app.db, request.user!, request.params.id);
      if (!res.ok) return apiError(reply, 404, "backlog_item_not_found", "Backlog item not found");
      return reply.code(204).send();
    },
  );
```

(Se il file non usa `z.null()` per i 204, copiare la forma della `DELETE` più vicina che risponde 204: `grep -n "204" apps/server/src/routes/*.ts | head`.)

- `GET /:id`: aggiungere `loadRefineSessionView(app.db, id)` al `Promise.all` e `refineSession` alla risposta.
- PATCH: `onArchive: async (tx) => { await closeOpenBacklogQuestion(tx, id); await closeRefineSessionForItem(tx, id); }`.
- Fusione: dopo `await closeOpenBacklogQuestion(tx, id);` del ramo della voce assorbita, `await closeRefineSessionForItem(tx, id);`.
- `services/backlog.ts`, conversione: dopo `await closeOpenBacklogQuestion(tx, id);`, `await closeRefineSessionForItem(tx, id);` con una riga di commento («La conversione chiude anche la sessione di refinement: la voce è ormai un ticket.»).

- [ ] **Step 6: verificare**

Run: `pnpm --filter @stubwise/server test -- services/backlog-refine routes/backlog.test services/backlog`
Expected: PASS, compresi i test esistenti di conversione, PATCH e fusione.

- [ ] **Step 7: commit**

```bash
git add apps/server/src/services/backlog-refine.ts apps/server/src/services/backlog-refine.test.ts apps/server/src/services/backlog.ts apps/server/src/routes/backlog.ts apps/server/src/routes/backlog.test.ts
git commit -m "feat(server): avvio e chiusura delle sessioni di refinement del backlog"
```

---

### Task 12: Server — permessi per kind e stato

**Files:**
- Modify: `apps/server/src/services/agent-sessions.ts` (`SessionDerivationInput`/`deriveAgentSessionState` ~L68-104, `openBacklogQuestionSql` ~L320, `possiblyActiveSql` ~L352, `baseSelect` ~L368, `displayTitle` ~L429, `toSummary` ~L489, `loadAgentSession` ~L619, `sendAgentMessage` ~L777-839)
- Modify: `apps/server/src/routes/agent-sessions.ts:79-120` (preHandler, errore `item_closed`)
- Modify: `packages/i18n/src/catalog.ts` (`agentSession.title.backlogRefine`, EN ~L631 e IT ~L1076)
- Test: `apps/server/src/routes/agent-sessions.messages.test.ts`, `apps/server/src/services/agent-sessions.test.ts` (o il file dove stanno i test di `deriveAgentSessionState`: `grep -rln deriveAgentSessionState apps/server/src`)

**Interfaces:**
- Consumes: `MEMBER_WRITABLE_SESSION_KINDS`, `TURN_BASED_SESSION_KINDS`, `canClose`, stato `idle` (Task 1); `backlogRefineSessions` (Task 2); `reopenRefineSessionIfClosed` (Task 11).
- Produces: `SessionDerivationInput.refineStatus?`/`pendingInput?` (OPZIONALI: i test esistenti che costruiscono l'input a mano restano invariati), errore `item_closed` di `sendAgentMessage`.

Regole:
- **Stato** (dopo `live → working`, prima di tutto il resto): `refineStatus === "closed"` → `ended`; `refineStatus === "active"` → `queued` con un input `pending`, altrimenti `idle`.
- `possiblyActiveSql` guadagna `or ${backlogRefineSessions.status} = 'active'` (una sessione `idle` è aperta: sta fra le attive).
- `openBacklogQuestionSql` e le domande di backlog nel dettaglio: solo `kind = 'backlog_item'` (vedi «Cose trovate nel codice»).
- **Permessi** (`loadAgentSession`): `intervenable = INTERVENABLE_SESSION_KINDS.has(kind) && (viewer.role === "admin" || MEMBER_WRITABLE_SESSION_KINDS.has(kind))`; `liveWritable` = la regola di oggi (`intervenable && live && segmento aperto && interattivo`); per i kind a turni `canWrite = intervenable && voce né convertita né archiviata` (attiva o chiusa: scrivere la riprende), per gli altri `canWrite = liveWritable`; `canInterrupt` resta su `liveWritable` (solo con un turno vivo); `canClose = kind a turni && sessione active && intervenable`.
- **Scrittura** (`sendAgentMessage`): via il controllo di ruolo in testa; dopo il `loadAgentSession`: kind fuori da `MEMBER_WRITABLE_SESSION_KINDS` e attore non admin → `forbidden` (nessuna riga). Per i kind a turni: niente controllo `!live`; interruzione senza `canInterrupt` → `interrupt_unsupported`; `!canWrite` → `item_closed`; nella transazione dell'insert, PRIMA dell'insert, `reopenRefineSessionIfClosed` → `item_closed` ferma tutto senza riga. Gli altri kind: percorso di oggi, invariato.
- La rotta passa da `requireAdmin` a `requireAuth`; 409 `item_closed` («The backlog item is converted or archived»). Il 403 `forbidden` resta («Administrators only» va bene: è vero per quei kind).

- [ ] **Step 1: test che falliscono — scrittura a due ruoli e permessi**

In `agent-sessions.messages.test.ts`, un `describe` nuovo (usa `post`, `inputsOf`, `u`, `jobSession` del file):

```ts
describe("sessioni di refinement: scrive anche un member, e solo lì", () => {
  async function refineSession(opts: { status?: "active" | "closed"; itemStatus?: "new" | "converted" } = {}) {
    const { itemId, projectId } = await seedBacklogItem(t.db, { status: opts.itemStatus ?? "new" });
    const [s] = await t.db.insert(agentSessions).values({
      ownerKey: `backlog_refine:${itemId}`, kind: "backlog_refine", title: "t", backlogItemId: itemId, projectId,
    }).returning();
    await t.db.insert(backlogRefineSessions).values({
      itemId, agentSessionId: s!.id, status: opts.status ?? "active",
      ...(opts.status === "closed" ? { closedAt: new Date(), closedReason: "idle" as const } : {}),
    });
    return { id: s!.id, itemId };
  }
  const refineOf = async (itemId: string) =>
    (await t.db.select().from(backlogRefineSessions).where(eq(backlogRefineSessions.itemId, itemId)))[0]!;

  it("stesso member, due kind (Review Focus #4): backlog_refine 202 con la sua riga; ai_job 403 e NESSUNA riga", async () => {
    const r = await refineSession();
    const ok = await post(r.id, u.memberCookie, { text: "proposta" });
    expect(ok.statusCode).toBe(202);
    expect((await inputsOf(r.id)).map((i) => [i.text, i.authorUserId, i.status])).toEqual([["proposta", u.memberId, "pending"]]);
    const before = (await inputsOf(jobSession)).length;
    const no = await post(jobSession, u.memberCookie, { text: "proposta" });
    expect(no.statusCode).toBe(403);
    expect(await inputsOf(jobSession)).toHaveLength(before);
  });

  it("servizio: il member su ai_job è forbidden e nessuna riga, anche sotto la rotta", async () => {
    const before = (await inputsOf(jobSession)).length;
    expect(await sendAgentMessage(t.db, { sessionId: jobSession, actor: { id: u.memberId, role: "member" }, text: "x", interrupt: false }))
      .toEqual({ ok: false, error: "forbidden" });
    expect(await inputsOf(jobSession)).toHaveLength(before);
  });

  it("senza processo vivo NON è session_ended: il messaggio diventa un turno (riga pending)", async () => {
    const r = await refineSession();
    expect((await post(r.id, u.adminCookie, { text: "via" })).statusCode).toBe(202);
  });

  it("su una sessione chiusa (voce aperta) la riapre e tocca l'attività", async () => {
    const r = await refineSession({ status: "closed" });
    expect((await post(r.id, u.memberCookie, { text: "riprendiamo" })).statusCode).toBe(202);
    expect(await refineOf(r.itemId)).toMatchObject({ status: "active", closedAt: null, closedReason: null });
  });

  it("voce convertita (Review Focus #6): 409 item_closed e nessuna riga", async () => {
    const r = await refineSession({ status: "closed", itemStatus: "converted" });
    const res = await post(r.id, u.memberCookie, { text: "x" });
    expect([res.statusCode, res.json().code]).toEqual([409, "item_closed"]);
    expect(await inputsOf(r.id)).toHaveLength(0);
  });

  it("«Ferma» senza un turno vivo: 409 interrupt_unsupported, nessuna riga", async () => {
    const r = await refineSession();
    const res = await post(r.id, u.memberCookie, { text: "", interrupt: true });
    expect([res.statusCode, res.json().code]).toEqual([409, "interrupt_unsupported"]);
    expect(await inputsOf(r.id)).toHaveLength(0);
  });

  it("dettaglio per un member: canWrite e canIntervene anche fermi, canClose solo attiva, canInterrupt mai senza turno", async () => {
    const active = await refineSession();
    const closed = await refineSession({ status: "closed" });
    const converted = await refineSession({ itemStatus: "converted" });
    const get = async (id: string) =>
      (await app.inject({ method: "GET", url: `/api/agent-sessions/${id}`, headers: { cookie: u.memberCookie } })).json();
    expect(await get(active.id)).toMatchObject({ canWrite: true, canIntervene: true, canClose: true, canInterrupt: false, state: "idle" });
    expect(await get(closed.id)).toMatchObject({ canWrite: true, canClose: false, state: "ended" });
    expect(await get(converted.id)).toMatchObject({ canWrite: false });
  });
});
```

Import da aggiungere: `seedBacklogItem` (`@stubwise/db/testing`), `backlogRefineSessions` (`@stubwise/db`). I test esistenti del file NON cambiano: «member: 403 E nessuna riga scritta» resta verde perché `jobSession` è `ai_job`.

- [ ] **Step 2: test che falliscono — stato ed elenco**

Accanto ai test esistenti di `deriveAgentSessionState`:

```ts
describe("stato di una sessione di refinement", () => {
  const base = { live: false, aiJobStatus: null, prReviewStatus: null, docGenerationStatus: null, backlogJobStatus: null, openBacklogQuestion: false, lastSegmentEnd: null };
  it("viva → working; attiva con messaggio in coda → queued; attiva ferma → idle; chiusa → ended", () => {
    expect(deriveAgentSessionState({ ...base, live: true, refineStatus: "active", pendingInput: true })).toBe("working");
    expect(deriveAgentSessionState({ ...base, refineStatus: "active", pendingInput: true })).toBe("queued");
    expect(deriveAgentSessionState({ ...base, refineStatus: "active", pendingInput: false })).toBe("idle");
    expect(deriveAgentSessionState({ ...base, refineStatus: "closed", pendingInput: true })).toBe("ended");
  });
  it("senza i campi nuovi (gli altri kind): come prima", () => {
    expect(deriveAgentSessionState(base)).toBe("ended");
  });
});
```

E in `agent-sessions.test.ts` delle rotte (Postgres), un test d'elenco:

```ts
it("una sessione di refinement idle sta fra le attive; una domanda aperta della chat CODE sulla stessa voce non la mette in waiting_input", async () => {
  // semina voce + agent_sessions backlog_refine + riga active (come sopra) e una backlog_questions aperta sulla voce
  // GET /api/agent-sessions → la sessione c'è, con state "idle"
  // GET /api/agent-sessions/:id → questions: []
});
```

(Scriverlo con gli helper di semina di quel file; `backlog_questions` si semina come in `apps/server/src/services/backlog-questions.test.ts`.)

- [ ] **Step 3: verificare che falliscano**

Run: `pnpm --filter @stubwise/server test -- agent-sessions`
Expected: FAIL nei test nuovi; i vecchi verdi.

- [ ] **Step 4: implementazione**

```ts
export interface SessionDerivationInput {
  // …campi esistenti…
  /** Solo sessioni di refinement (2026-10-14): stato della riga, null/assente altrimenti. */
  refineStatus?: "active" | "closed" | null;
  /** Un input `pending` sulla sessione (refinement: un turno in coda). */
  pendingInput?: boolean;
}

export function deriveAgentSessionState(i: SessionDerivationInput): AgentSessionState {
  if (i.live) return "working";
  // Refinement: aperta ma ferma è `idle` (scrivere la fa ripartire), con un
  // messaggio in attesa di un turno è `queued`. Nessun'altra fonte vale qui.
  if (i.refineStatus === "closed") return "ended";
  if (i.refineStatus === "active") return i.pendingInput === true ? "queued" : "idle";
  // …resto invariato…
}
```

```ts
const openBacklogQuestionSql = sql<boolean>`(${agentSessions.kind} = 'backlog_item' and ${agentSessions.backlogItemId} is not null and exists (…invariato…))`;

const pendingInputSql = sql<boolean>`exists (
  select 1 from ${agentSessionInputs}
  where ${agentSessionInputs.sessionId} = ${agentSessions.id} and ${agentSessionInputs.status} = 'pending')`;

// possiblyActiveSql: in coda alla disgiunzione
  or ${backlogRefineSessions.status} = 'active'
```

In `baseSelect`: colonne `refineStatus: backlogRefineSessions.status`, `backlogItemStatus: backlogItems.status`, `pendingInput: pendingInputSql`, e `.leftJoin(backlogRefineSessions, eq(backlogRefineSessions.agentSessionId, agentSessions.id))`. In `toSummary`: `refineStatus: row.refineStatus ?? null, pendingInput: row.pendingInput === true`. `pendingInputSql` gira per riga: l'indice parziale `agent_session_inputs_pending_idx` (0086) lo copre.

`displayTitle`:

```ts
    case "backlog_refine":
      if (row.backlogItemTitle !== null) {
        return t(lang, "agentSession.title.backlogRefine", { title: row.backlogItemTitle });
      }
      break;
```

catalog i18n: EN `"agentSession.title.backlogRefine": "Refinement · {title}"`, IT `"agentSession.title.backlogRefine": "Refinement · {title}"`.

`loadAgentSession`:

```ts
  const turnBased = TURN_BASED_SESSION_KINDS.has(row.kind);
  // La parte dell'ATTORE: un maintainer su un tipo in cui si interviene, o
  // chiunque su un tipo aperto ai member (refinement, design 2026-10-14 §5.2).
  const intervenable =
    INTERVENABLE_SESSION_KINDS.has(row.kind) &&
    (viewer.role === "admin" || MEMBER_WRITABLE_SESSION_KINDS.has(row.kind));
  // Si interviene in un processo solo a un segmento aperto e interattivo.
  const liveWritable = intervenable && live && row.activeSegmentOpen === true && row.interactive;
  const itemOpen = row.backlogItemStatus !== "converted" && row.backlogItemStatus !== "archived";
  // A turni: scrivere avvia (o riprende) la sessione, viva o no, finché la voce è aperta.
  const writable = turnBased ? intervenable && row.refineStatus !== null && itemOpen : liveWritable;
```

`questions`: il ramo di `backlogQuestions` solo se `row.kind === "backlog_item"`. Nel `detail`: `canWrite: writable`, `canInterrupt` calcolato da `liveWritable` (non da `writable`), `canClose: turnBased && row.refineStatus === "active" && intervenable`. Anche la `pauseCandidate` resta su `live && …` com'è.

`sendAgentMessage`:

```ts
  const loaded = await loadAgentSession(db, input.actor, input.sessionId);
  if (!loaded) return { ok: false, error: "not_found" };
  const kind = loaded.detail.kind;
  // Il ruolo, per kind (design 2026-10-14 §5.2): fuori dai kind aperti ai
  // member scrivere resta da maintainer. UN posto, prima di qualunque riga.
  if (!MEMBER_WRITABLE_SESSION_KINDS.has(kind) && input.actor.role !== "admin") {
    return { ok: false, error: "forbidden" };
  }
  if (TURN_BASED_SESSION_KINDS.has(kind)) {
    if (input.interrupt && !loaded.detail.canInterrupt) return { ok: false, error: "interrupt_unsupported" };
    if (!loaded.detail.canWrite) return { ok: false, error: "item_closed" };
    return db.transaction(async (tx) => {
      // Riapre la sessione chiusa (e tocca l'attività) nella STESSA transazione
      // dell'input: il worker vede insieme sessione attiva e messaggio.
      if ((await reopenRefineSessionIfClosed(tx, input.sessionId)) === "item_closed") {
        return { ok: false as const, error: "item_closed" as const };
      }
      const [row] = await tx.insert(agentSessionInputs).values({ … come oggi … }).returning({ id: agentSessionInputs.id });
      await tx.execute(sql`select pg_notify(${AGENT_SESSION_INPUT_CHANNEL}, ${JSON.stringify({ sessionId: input.sessionId })})`);
      return { ok: true as const, inputId: row!.id };
    });
  }
  // …percorso di oggi (live, canWrite, canInterrupt, insert) invariato…
```

`SendAgentMessageResult.error` guadagna `"item_closed"`; aggiornare il docblock della funzione (non più «solo maintainer»: «per kind»). Nella rotta: `preHandler: requireAuth` (import), e nel `switch`:

```ts
        case "item_closed":
          return apiError(reply, 409, "item_closed", "The backlog item is converted or archived");
```

- [ ] **Step 5: verificare**

Run: `pnpm --filter @stubwise/i18n build && pnpm --filter @stubwise/server test -- agent-sessions && pnpm typecheck`
Expected: PASS, test esistenti compresi.

- [ ] **Step 6: commit**

```bash
git add apps/server/src/services/agent-sessions.ts apps/server/src/routes/agent-sessions.ts apps/server/src/routes/agent-sessions*.test.ts apps/server/src/services/*.test.ts packages/i18n/src/catalog.ts
git commit -m "feat(server): nelle sessioni di refinement scrive anche un member; stati idle e queued"
```

---

### Task 13: Client, golden, documentazione

**Files:**
- Create: `packages/api-client/src/endpoints/backlog-refine.ts`, `packages/api-client/src/endpoints/backlog-refine.test.ts`
- Modify: `packages/api-client/src/client.ts:110-130` (gruppo `backlogRefine`), `packages/api-client/src/index.ts` (export se gli altri gruppi lo fanno)
- Modify: `apps/worker/scripts/golden/checks.ts` (`SCENARIO_NAMES` + `refineChecks`), `apps/worker/scripts/golden/run.ts` (`runRefine` in `SCENARIOS`), `apps/worker/scripts/golden/README.md`, `apps/worker/scripts/golden/checks.test.ts`
- Modify: `docs/operations/deploy-log.md` (voce nuova in coda), `CLAUDE.md` (indice del deploy-log, indice delle invarianti, golden, perimetro plugin)
- Create: `docs/invariants/backlog-refine.md`
- Create: `.changeset/api-client-backlog-refine.md` SOLO se `@stubwise/api-client` è versionato da Changesets (è `private`: verificare in `.changeset/config.json` e nei changeset passati; se non lo è, niente changeset)

**Interfaces:**
- Consumes: `startRefineSessionInputSchema`/`startRefineSessionResultSchema` (Task 1), rotte del Task 11.
- Produces: `client.backlogRefine.start(itemId, body)`, `client.backlogRefine.close(itemId)` per il Piano B. Il «server senza la funzione» si riconosce con `isAgentSessionsUnavailable` (404 senza `code`), già esportata.

- [ ] **Step 1: client — test che falliscono**

```ts
// packages/api-client/src/endpoints/backlog-refine.test.ts
import { describe, expect, it, vi } from "vitest";
import { ApiError, createStubwiseClient, isAgentSessionsUnavailable } from "../index.js";

const ITEM = "7f1c2a1e-0000-4000-8000-000000000001";
const SESSION = "7f1c2a1e-0000-4000-8000-000000000002";
function client(body: unknown, status = 200) {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(async () =>
    status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  return { c: createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl }), fetchImpl };
}

describe("endpoints backlogRefine", () => {
  it("start: POST col messaggio, risposta parsata", async () => {
    const { c, fetchImpl } = client({ agentSessionId: SESSION, inputId: null });
    expect(await c.backlogRefine.start(ITEM, { message: "ciao" })).toEqual({ agentSessionId: SESSION, inputId: null });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect([String(url), init!.method, JSON.parse(String(init!.body))]).toEqual([`/api/backlog/${ITEM}/refine-session`, "POST", { message: "ciao" }]);
  });
  it("close: DELETE, 204", async () => {
    const { c, fetchImpl } = client(null, 204);
    await c.backlogRefine.close(ITEM);
    expect(fetchImpl.mock.calls[0]![1]!.method).toBe("DELETE");
  });
  it("server senza la funzione: 404 senza code → isAgentSessionsUnavailable", async () => {
    const { c } = client({ message: "Route POST:/api/backlog/x/refine-session not found", statusCode: 404 }, 404);
    const error = await c.backlogRefine.start(ITEM, {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(isAgentSessionsUnavailable(error)).toBe(true);
  });
  it("409 item_closed: ApiError col code, NON «funzione assente»", async () => {
    const { c } = client({ code: "item_closed", message: "closed" }, 409);
    const error = await c.backlogRefine.start(ITEM, {}).catch((e: unknown) => e);
    expect((error as ApiError).code).toBe("item_closed");
    expect(isAgentSessionsUnavailable(error)).toBe(false);
  });
});
```

(La forma del corpo d'errore che produce `code` va copiata da un test esistente di `ApiError`: `grep -n "code:" packages/api-client/src/endpoints/agent-sessions.test.ts`.)

- [ ] **Step 2: client — implementazione**

```ts
// packages/api-client/src/endpoints/backlog-refine.ts
import { startRefineSessionResultSchema, type StartRefineSessionInput } from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { seg } from "../query.js";

/**
 * Sessioni di refinement del backlog (design 2026-10-14). Chiunque possa
 * lavorare sul backlog. Contro un server che non ha la funzione la rotta è un
 * 404 SENZA `code`: `isAgentSessionsUnavailable` lo riconosce, e il bottone
 * non si mostra.
 */
export function createBacklogRefineEndpoints(request: ApiRequest) {
  return {
    start(itemId: string, body: StartRefineSessionInput = {}) {
      return request("POST", `/api/backlog/${seg(itemId)}/refine-session`, body, startRefineSessionResultSchema);
    },
    close(itemId: string): Promise<void> {
      return request("DELETE", `/api/backlog/${seg(itemId)}/refine-session`);
    },
  };
}
```

In `client.ts`, in `createEndpoints`: `backlogRefine: createBacklogRefineEndpoints(request),`.

Run: `pnpm --filter @stubwise/api-client test -- backlog-refine` → PASS. Commit:

```bash
git add packages/api-client
git commit -m "feat(api-client): gruppo backlogRefine"
```

- [ ] **Step 3: scenario golden `refine` — check puri, test che falliscono**

In `checks.ts`:

```ts
// SCENARIO_NAMES: in coda
  "refine",

/** Ciò che lo scenario `refine` osserva (run vero col CLI pinnato). */
export interface RefineObservation {
  timedOut: boolean;
  exitCode: number | null;
  /** Chiamate ricevute dal ponte finto, in ordine: nome del tool. */
  bridgeCalls: string[];
  /** Nomi dei tool usati dall'agente (eventi tool_use). */
  toolNames: string[];
  /** `git status --porcelain` del repo fixture dopo il run (vuoto = nessun file toccato). */
  gitStatus: string;
  /** Messaggio finale dell'ultimo turno. */
  finalMessage: string;
  /** Id dell'intervento a metà turno e se ha avuto l'evento input (eco). */
  inputId: string;
  inputEchoed: boolean;
}

export function refineChecks(obs: RefineObservation): Check[] {
  const writers = obs.toolNames.filter((n) => ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"].includes(n));
  return [
    { name: "il run finisce entro il timeout", passed: !obs.timedOut, detail: obs.timedOut ? "AgentTimeoutError" : "nessun timeout" },
    { name: "exit 0", passed: obs.exitCode === 0, detail: `exit code: ${obs.exitCode}` },
    { name: "design salvato col tool", passed: obs.bridgeCalls.includes("set_design"), detail: `chiamate al ponte: ${obs.bridgeCalls.join(", ") || "nessuna"}` },
    { name: "piano salvato col tool", passed: obs.bridgeCalls.includes("set_plan"), detail: `chiamate al ponte: ${obs.bridgeCalls.join(", ") || "nessuna"}` },
    { name: "nessun tool che scrive file o esegue comandi", passed: writers.length === 0, detail: writers.length === 0 ? "nessuno" : writers.join(", ") },
    { name: "nessun file toccato nel repo", passed: obs.gitStatus.trim() === "", detail: obs.gitStatus.trim() || "working tree pulito" },
    { name: "la risposta è rivolta alla persona (non vuota)", passed: obs.finalMessage.trim().length > 0, detail: obs.finalMessage.slice(0, 120) },
    { name: "l'intervento a metà turno è assorbito (eco)", passed: obs.inputEchoed, detail: obs.inputEchoed ? `input ${obs.inputId} preso` : "mai preso dal CLI" },
  ];
}
```

In `checks.test.ts`: un caso tutto verde e uno per ciascun check rosso (stessa forma dei test di `intervene`), più `expect(isScenarioName("refine")).toBe(true)`.

- [ ] **Step 4: scenario golden `refine` — run**

In `run.ts`, `runRefine(ctx)`, sul modello di `runIntervene` (runner costruito dallo scenario con `ctx.claudePath` e degli hook che registrano eventi e handle):
1. Prepara la working dir col repo fixture come gli altri scenari; la cwd dell'agente è la parent dir (come nel worker).
2. Avvia un ponte FINTO con `node:http` su `127.0.0.1:0`: registra il nome del tool dal path `/tools/<nome>`, risponde `200 { ok: true, message: "Saved." }`.
3. Config MCP: `servers.stubwise_refine = { command: process.execPath, args: [<dist/refine-mcp/index.js del worker, risolto come resolveAskUserServerPath>], env: { REFINE_BRIDGE_URL, REFINE_BRIDGE_SECRET: "golden" } }`.
4. Run: label `refine`, `permissionMode: "default"`, `allowedTools: ["Read", "Grep", "Glob", ...REFINE_TOOL_NAMES]`, `pluginDirs` di `ctx`, prompt = `buildRefinePrimingPrompt(...)` con una voce fissa («Aggiungere un endpoint di health check al servizio della fixture») e il messaggio «Scrivi il design e il piano e salvali, poi dimmi cosa hai deciso.», `openingInput` con un id casuale.
5. Appena c'è il primo `tool_use`, consegna sull'handle l'intervento «Nel piano aggiungi anche un test.» (id casuale): è il check dell'eco.
6. Raccoglie `RefineObservation` (`git status --porcelain` nel repo fixture) e restituisce `refineChecks`.

Registrare `refine: runRefine` in `SCENARIOS`. README: scenario `refine`, cosa verifica, **3 lanci**; e una riga in più nel paragrafo su cosa lanciare quando si tocca il turno del refinement (`apps/worker/src/backlog/refine/`). Lo scenario verifica anche la premessa «DA VERIFICARE» della spec §4.2: con la versione pinnata, un tool fuori elenco in `permissionMode: "default"` e `-p` è negato e non chiesto (se l'agente provasse `Write`, il check «nessun file toccato» lo direbbe).

Run (non in CI): `pnpm --filter @stubwise/worker build && pnpm --filter @stubwise/worker golden -- --scenario refine --plugin <dir superpowers> --claude <claude 2.1.287>` tre volte. Expected: 3/3 verdi. Commit:

```bash
git add apps/worker/scripts/golden
git commit -m "test(golden): scenario refine delle sessioni di refinement"
```

- [ ] **Step 5: documentazione**

`docs/invariants/backlog-refine.md` (nuovo), titolo «Sessioni di refinement del backlog (14 ott 2026)», con le voci:
- Le regole a turni del relay valgono SOLO per `TURN_BASED_SESSION_KINDS`, e la scrittura dei member SOLO per `MEMBER_WRITABLE_SESSION_KINDS`: elenchi espliciti in `@stubwise/shared`, un kind nuovo non li eredita; il ruolo si controlla in UN posto (`sendAgentMessage`), con test negativi a due ruoli sulle righe.
- Un messaggio di una sessione a turni non diventa mai `undelivered` per tempismo: solo `turn_failed`, `budget_exceeded`, o `session_not_live` a sessione chiusa.
- Sola lettura per COSTRUZIONE: `permissionMode: "default"` e `allowedTools` chiuso (`Read`, `Grep`, `Glob`, grafo, tre tool). Chi aggiunge un tool all'elenco lo dichiara qui. Mai la plan mode (bloccherebbe i tool MCP di scrittura).
- Il server MCP dei tool non vede DB né credenziali: ponte su loopback con un segreto per turno, revocato a fine turno e PRIMA dell'abort alla chiusura.
- Le regole di scrittura di design, piano e metadati stanno in `packages/notifications/src/backlog-item-writes.ts`, condivise fra rotte e ponte: mai una seconda copia. Ogni sovrascrittura dell'agente salva il valore precedente in `backlog_item_revisions`.
- Un piano scritto in una sessione di refinement NON è approvato: conversione e run passano dal gate di sempre.
- `agent_sessions.backlog_item_id` non vuol dire più «chat della voce»: chi lo legge per quel significato filtri `kind = 'backlog_item'`.
- Limite noto: il costo dei turni non entra in `monthlyCostUsd` (i run di backlog non scrivono `agent_runs`).

`docs/operations/deploy-log.md`, voce in coda, nello stile delle vicine: **«Sessioni di refinement del backlog» (14 ott 2026)**:
- ORDINE: server (applica la 0087; verificare `select count(*) from backlog_refine_sessions;` e il CHECK `agent_sessions_kind_chk` con `backlog_refine`), poi worker e caddy, col worker SENZA lavoro dell'agente in corso (controllo d'inattività in più campioni, sessioni vive comprese).
- Env nuove del worker (tutte con default): `BACKLOG_REFINE_MAX_CONCURRENT`, `BACKLOG_REFINE_IDLE_MINUTES`, `BACKLOG_REFINE_TURN_TIMEOUT_MS`.
- Rollback del server: NON innocuo — un server vecchio risponde 500 sull'INTERO `GET /api/agent-sessions` appena incontra una riga `backlog_refine` (enum chiuso dei kind). Prima di scendere: `delete from agent_sessions where kind = 'backlog_refine';` (eventi, input e righe `backlog_refine_sessions` in cascata; design e piano restano sulla voce). Il caddy scende insieme al server; nell'app il bottone sparisce da solo (404 senza `code`).
- Rollback del worker: il relay vecchio marca `undelivered` (`session_not_live`) gli input delle sessioni di refinement. Prima di scendere: `update backlog_refine_sessions set status='closed', closed_reason='user', closed_at=now() where status='active';`.
- Limite noto: il costo dei turni non è contato nel budget mensile (lo è il blocco a budget sforato).

`CLAUDE.md` (resta sotto il limite: solo righe d'indice):
- nell'indice del deploy-log: `- «Sessioni di refinement del backlog» (14 ott 2026)`;
- nell'elenco delle invarianti per area: `- **Sessioni di refinement del backlog → \`docs/invariants/backlog-refine.md\`**:` con i titoli delle voci;
- nella sezione dei plugin, «Run col perimetro plugin»: aggiungere «turno di refinement del backlog»;
- negli scenari golden: aggiungere `refine` (3 lanci) all'elenco e «o il turno di refinement (`apps/worker/src/backlog/refine/`)» a «Lanciali quando aggiorni…».

```bash
git add docs/invariants/backlog-refine.md docs/operations/deploy-log.md CLAUDE.md
git commit -m "docs: sessioni di refinement del backlog — invarianti e voce di deploy"
```

- [ ] **Step 6: verifica finale del piano A**

Run: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
Expected: tutto verde (la CI fallisce sul lint anche con test verdi). Poi `graphify update .` e commit di `graphify-out/` se cambiato.
