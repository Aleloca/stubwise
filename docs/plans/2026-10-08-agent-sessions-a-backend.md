# Sessioni degli agenti — Piano A: worker, DB, server

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ogni run dell'agente scrive i suoi eventi in una sessione legata al lavoro che la contiene (job, review, voce di backlog…); il server li espone in lettura e dal vivo (SSE) e accetta gli interventi di un maintainer, che il worker consegna sullo stdin del processo `claude` vivo.

**Architecture:** un secondo runner, `StreamingClaudeRunner`, lancia il CLI con `--input-format stream-json --output-format stream-json --verbose --include-partial-messages`, tiene stdin aperto, normalizza gli eventi e li passa a un `SessionRecorder` (Postgres + `pg_notify`, fail-open). Il runner storico resta intatto ed è il rollback (`AGENT_STREAMING=false`). Il server ascolta con `LISTEN`, serve le rotte `/api/agent-sessions*` e scrive gli interventi in `agent_session_inputs`; un `SessionInputRelay` nel worker li consegna al processo giusto.

**Tech Stack:** Node 22, TypeScript, execa, postgres.js (`client.listen`), drizzle, Fastify + Zod, Vitest + testcontainers.

**Spec:** `docs/plans/2026-10-08-agent-sessions-design.md`. Piani successivi: **B** (web) e **C** (app), che consumano le rotte e gli schemi di questo.

## Global Constraints

- CLI fissato a `2.1.287` (`ARG CLAUDE_CODE_VERSION`, `apps/worker/Dockerfile`): non si tocca.
- L'argv del runner storico (`ClaudeCliRunner`) **non cambia**: i suoi 40+ test restano verdi senza modifiche.
- Scrivere eventi è **fail-open**: nessun errore del recorder sale mai al run.
- Retention: **14 giorni** (`AGENT_SESSION_RETENTION_DAYS = 14`, costante, non env).
- Solo `admin` interviene: `requireAdmin` sulla rotta **e** `actor.role !== "admin"` nel servizio.
- Sessioni `email_message`: visibili **solo** a `mailbox_owner_user_id`, nessun ramo per ruolo.
- Migrazione **0086**, a mano (SQL + voce `_journal.json`, `when` = `1791417600000`), nessun `ALTER TYPE`, CHECK al posto dei pgEnum.
- Ogni campo di risposta nuovo letto dall'app nasce `.default()`/`.nullable()`.
- Rotte letterali registrate PRIMA di `/:id`.
- Testi automatici (commento sul ticket) da **template i18n**, mai AI.

## Comportamenti del CLI 2.1.287 già verificati (8 ott 2026, in scratchpad)

1. Un processo con `--input-format stream-json` regge più turni; ogni turno finisce con un evento `result`.
2. **`total_cost_usd` e `modelUsage` del `result` sono CUMULATIVI** sul processo (turno 1: 10/109 token, $0.0169; turno 2: 20/472, $0.0226). L'usage del run = quello dell'**ultimo** `result`.
3. **Un messaggio scritto a metà turno (priorità di default) viene ASSORBITO nello stesso turno**: un solo `result` finale, che tiene conto del messaggio. Quindi NON si possono contare i turni per decidere quando chiudere stdin: si chiude dopo `RESULT_GRACE_MS` (2000 ms) di silenzio dopo un `result`.
4. `control_request` `{"subtype":"interrupt"}` chiude il turno con un `result` `error_during_execution`; il processo resta vivo e accetta un messaggio successivo.
5. I messaggi iniettati NON vengono rieccheggiati sullo stdout: l'evento `input` lo scrive il worker.

## Review Focus

1. **Run che non finisce più**: stdin lasciato aperto dopo l'ultimo `result` (es. un intervento consegnato un attimo prima della chiusura). Atteso: il processo esce entro `RESULT_GRACE_MS` dall'ultimo `result` senza input nuovi; un intervento che arriva dopo la chiusura diventa `undelivered`. Test in Task 5.
2. **Interruzione scambiata per fallimento**: `result` `error_during_execution` seguito da un messaggio. Atteso: l'esito del run è l'ULTIMO `result`, exit 0. Test in Task 5.
3. **Segreto nello stream**: valore di un `.env` dentro un `tool_result` o un parziale. Atteso: `•••` in tabella e nel `pg_notify`. Test in Task 4 e Task 6.
4. **DB giù durante un fix**: il recorder fallisce ogni insert. Atteso: il run finisce identico, una riga di log, nessuna eccezione. Test in Task 6.
5. **Posta di un collega**: un admin che chiede elenco o dettaglio di una sessione `email_message` altrui. Atteso: assente dall'elenco, 404 sul dettaglio, e il proprietario la vede. Test in Task 10.

---

## File structure

| File | Responsabilità |
|---|---|
| `packages/shared/src/schemas/agent-session.ts` | enum (kind, tipo evento, segmento, stato input), schemi di risposta/richiesta, `INTERACTIVE_SEGMENTS` |
| `packages/shared/src/agent-activity.ts` | `describeAgentActivity`: evento → `{ kind, target }` per la riga «ultima azione» |
| `packages/db/drizzle/0086_agent_sessions.sql` + `schema.ts` | tre tabelle nuove |
| `apps/worker/src/agent/cli-args.ts` | argv e config MCP condivisi dai due runner (estratto da `claude-cli.ts`) |
| `apps/worker/src/sessions/stream-parser.ts` | puro: riga stdout → evento CLI → eventi di sessione; tracker del risultato |
| `apps/worker/src/sessions/redact.ts` | puro: oscuramento dei valori segreti |
| `apps/worker/src/sessions/store.ts` | `ensureAgentSession`, `SessionRecorder` (batch, notify, heartbeat, fail-open), prune |
| `apps/worker/src/sessions/relay.ts` | `SessionInputRelay`: registro dei processi vivi, `LISTEN`, consegna, commento sul ticket |
| `apps/worker/src/agent/streaming-cli.ts` | `StreamingClaudeRunner` |
| `apps/server/src/services/agent-sessions.ts` | query di elenco/dettaglio/eventi, visibilità, `canWrite`, invio intervento |
| `apps/server/src/agent-session-bus.ts` | `LISTEN` → fan-out ai sottoscrittori SSE |
| `apps/server/src/routes/agent-sessions.ts` | rotte HTTP + SSE |
| `packages/api-client/src/endpoints/agent-sessions.ts` | gruppo `agentSessions` del client |

---

### Task 1: Schemi condivisi e `describeAgentActivity`

**Files:**
- Create: `packages/shared/src/schemas/agent-session.ts`
- Create: `packages/shared/src/agent-activity.ts`
- Modify: `packages/shared/src/index.ts` (due `export * from`)
- Test: `packages/shared/src/schemas/agent-session.test.ts`, `packages/shared/src/agent-activity.test.ts`

**Interfaces:**
- Produces: `agentSessionKindSchema`, `AgentSessionKind`; `agentSegmentLabelSchema`, `AgentSegmentLabel`; `INTERACTIVE_SEGMENTS: ReadonlySet<AgentSegmentLabel>`; `agentSessionEventTypeSchema`, `AgentSessionEventType`; `agentSessionEventSchema`, `AgentSessionEvent`; `agentSessionStateSchema`; `agentSessionSummarySchema`; `agentSessionListSchema`; `agentSessionDetailSchema`; `agentSessionEventPageSchema`; `sendAgentMessageInputSchema`; `sendAgentMessageResultSchema`; `describeAgentActivity(event: { type: string; data: Record<string, unknown> }): AgentActivity`.

- [ ] **Step 1: test degli schemi**

```ts
// packages/shared/src/schemas/agent-session.test.ts
import { describe, expect, it } from "vitest";
import {
  INTERACTIVE_SEGMENTS,
  agentSessionDetailSchema,
  agentSessionSummarySchema,
  sendAgentMessageInputSchema,
} from "./agent-session.js";

const summary = {
  id: "7f1c2a1e-0000-4000-8000-000000000001",
  kind: "ai_job",
  title: "#42 Fix del login",
  projectId: null,
  projectName: null,
  ticketId: null,
  ticketNumber: null,
  startedAt: "2026-10-08T10:00:00.000Z",
  lastEventAt: "2026-10-08T10:05:00.000Z",
  state: "working",
};

describe("agent-session schemas", () => {
  it("una risposta di un server senza i campi additivi si parsa coi default", () => {
    const parsed = agentSessionSummarySchema.parse(summary);
    expect(parsed.lastActivity).toBeNull();
    expect(parsed.activeSegment).toBeNull();
  });

  it("il dettaglio senza canWrite/canInterrupt/questions li legge falsi/vuoti", () => {
    const parsed = agentSessionDetailSchema.parse({ ...summary });
    expect(parsed.canWrite).toBe(false);
    expect(parsed.canInterrupt).toBe(false);
    expect(parsed.questions).toEqual([]);
  });

  it("un messaggio vuoto o oltre 4000 caratteri è rifiutato", () => {
    expect(sendAgentMessageInputSchema.safeParse({ text: "  " }).success).toBe(false);
    expect(sendAgentMessageInputSchema.safeParse({ text: "x".repeat(4001) }).success).toBe(false);
    expect(sendAgentMessageInputSchema.parse({ text: "ok" }).interrupt).toBe(false);
  });

  it("i run brevi non sono interattivi, i run lunghi sì", () => {
    expect(INTERACTIVE_SEGMENTS.has("execute")).toBe(true);
    expect(INTERACTIVE_SEGMENTS.has("review")).toBe(true);
    expect(INTERACTIVE_SEGMENTS.has("email_classify")).toBe(false);
    expect(INTERACTIVE_SEGMENTS.has("triage")).toBe(false);
  });
});
```

- [ ] **Step 2: eseguilo e verifica che fallisca**

Run: `pnpm --filter @stubwise/shared test -- agent-session`
Expected: FAIL, `Cannot find module './agent-session.js'`.

- [ ] **Step 3: implementa gli schemi**

```ts
// packages/shared/src/schemas/agent-session.ts
import { z } from "zod";

/**
 * Sessioni degli agenti (design 2026-10-08-agent-sessions-design.md).
 *
 * Una SESSIONE è l'unità di lavoro che l'utente riconosce (un job, una review,
 * una voce di backlog…), fatta di uno o più SEGMENTI: ogni segmento è un
 * processo `claude`. Gli eventi sono la trascrizione normalizzata dal worker.
 *
 * Forward-compat verso l'app (che parsa con `readerSchema`): ogni campo che
 * può mancare in un server più vecchio nasce `.default()`/`.nullable()`, e
 * `data` di un evento è un record aperto — un tipo di evento nuovo arriva come
 * `UNKNOWN` e il client semplicemente non lo disegna.
 */

export const agentSessionKindSchema = z.enum([
  "ai_job",
  "pr_review",
  "backlog_item",
  "backlog_job",
  "doc_generation",
  "email_message",
  "project_brief",
  "daily_report",
]);
export type AgentSessionKind = z.infer<typeof agentSessionKindSchema>;

export const agentSegmentLabelSchema = z.enum([
  "triage",
  "plan",
  "plan_resume",
  "execute",
  "self_repair",
  "correction",
  "correction_self_repair",
  "review",
  "plan_summary",
  "failure_summary",
  "pr_summary",
  "deep_dive",
  "chat_turn",
  "intake",
  "estimate",
  "email_classify",
  "docs",
  "brief",
  "daily_report",
]);
export type AgentSegmentLabel = z.infer<typeof agentSegmentLabelSchema>;

/**
 * Segmenti su cui un maintainer può scrivere. Elenco ESPLICITO: un segmento
 * nuovo non diventa interattivo da solo (spec §6.4).
 */
export const INTERACTIVE_SEGMENTS: ReadonlySet<AgentSegmentLabel> = new Set<AgentSegmentLabel>([
  "plan",
  "plan_resume",
  "execute",
  "self_repair",
  "correction",
  "correction_self_repair",
  "review",
  "deep_dive",
  "chat_turn",
  "docs",
]);

export const agentSessionEventTypeSchema = z.enum([
  "segment_start",
  "assistant_text",
  "tool_use",
  "tool_result",
  "input",
  "turn_end",
  "segment_end",
]);
export type AgentSessionEventType = z.infer<typeof agentSessionEventTypeSchema>;

export const agentSessionEventSchema = z.object({
  /** bigserial come stringa: è anche il cursore di paginazione. */
  id: z.string(),
  type: agentSessionEventTypeSchema,
  segmentId: z.string(),
  at: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export type AgentSessionEvent = z.infer<typeof agentSessionEventSchema>;

/**
 * Stato DERIVATO a lettura dal server:
 * - working: un segmento vivo con heartbeat fresco;
 * - waiting_input: il job è fermo su una domanda (o la voce ha una domanda aperta);
 * - held: il job è parcheggiato (limite, budget, gate);
 * - ended: nient'altro.
 */
export const agentSessionStateSchema = z.enum(["working", "waiting_input", "held", "ended"]);
export type AgentSessionState = z.infer<typeof agentSessionStateSchema>;

export const agentActivitySchema = z.object({
  kind: z.enum(["edit", "read", "run", "search", "web", "ask", "subagent", "write", "other"]),
  target: z.string().nullable(),
});

export const agentSessionSummarySchema = z.object({
  id: z.string().uuid(),
  kind: agentSessionKindSchema,
  title: z.string(),
  projectId: z.string().uuid().nullable(),
  projectName: z.string().nullable(),
  ticketId: z.string().uuid().nullable(),
  ticketNumber: z.number().int().nullable(),
  startedAt: z.string(),
  lastEventAt: z.string().nullable(),
  state: agentSessionStateSchema,
  activeSegment: agentSegmentLabelSchema.nullable().default(null),
  lastActivity: agentActivitySchema.nullable().default(null),
});
export type AgentSessionSummary = z.infer<typeof agentSessionSummarySchema>;

export const agentSessionListSchema = z.object({
  live: z.array(agentSessionSummarySchema),
  recent: z.array(agentSessionSummarySchema),
});

export const agentSessionQuestionSchema = z.object({
  id: z.string().uuid(),
  source: z.enum(["agent", "backlog"]),
  question: z.string(),
  askedAt: z.string(),
  answered: z.boolean(),
});

export const agentSessionDetailSchema = agentSessionSummarySchema.extend({
  /** Calcolato dal server col ruolo di chi guarda: mai dedotto dal client. */
  canWrite: z.boolean().default(false),
  /** Il CLI del segmento vivo dichiara l'interruzione fra le capabilities. */
  canInterrupt: z.boolean().default(false),
  questions: z.array(agentSessionQuestionSchema).default([]),
});
export type AgentSessionDetail = z.infer<typeof agentSessionDetailSchema>;

export const agentSessionEventPageSchema = z.object({
  events: z.array(agentSessionEventSchema),
  /** Cursore per la pagina PRECEDENTE (eventi più vecchi), null se finita. */
  before: z.string().nullable(),
});

export const sendAgentMessageInputSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  interrupt: z.boolean().default(false),
});
export type SendAgentMessageInput = z.infer<typeof sendAgentMessageInputSchema>;

export const agentInputStatusSchema = z.enum(["pending", "delivered", "undelivered"]);

export const sendAgentMessageResultSchema = z.object({
  inputId: z.string().uuid(),
  status: agentInputStatusSchema,
});
```

Aggiungi in `packages/shared/src/index.ts`:

```ts
export * from "./schemas/agent-session.js";
export * from "./agent-activity.js";
```

- [ ] **Step 4: test di `describeAgentActivity`**

```ts
// packages/shared/src/agent-activity.test.ts
import { describe, expect, it } from "vitest";
import { describeAgentActivity } from "./agent-activity.js";

const tool = (name: string, input: Record<string, unknown>) => ({
  type: "tool_use",
  data: { name, input },
});

describe("describeAgentActivity", () => {
  it("modifiche ai file → edit col path", () => {
    expect(describeAgentActivity(tool("Edit", { file_path: "apps/x/routes/tickets.ts" }))).toEqual({
      kind: "edit",
      target: "apps/x/routes/tickets.ts",
    });
    expect(describeAgentActivity(tool("Write", { file_path: "a.ts" })).kind).toBe("edit");
  });

  it("Bash → run con la prima riga del comando, troncata a 80", () => {
    const long = `pnpm test ${"x".repeat(200)}\nsecond line`;
    const out = describeAgentActivity(tool("Bash", { command: long }));
    expect(out.kind).toBe("run");
    expect(out.target!.length).toBeLessThanOrEqual(80);
    expect(out.target).not.toContain("second line");
  });

  it("ricerca, lettura, web, domanda, subagent", () => {
    expect(describeAgentActivity(tool("Grep", { pattern: "foo" }))).toEqual({ kind: "search", target: "foo" });
    expect(describeAgentActivity(tool("Read", { file_path: "b.ts" }))).toEqual({ kind: "read", target: "b.ts" });
    expect(describeAgentActivity(tool("WebFetch", { url: "https://x.y" })).kind).toBe("web");
    expect(describeAgentActivity(tool("mcp__stubwise_ask__ask_user", {})).kind).toBe("ask");
    expect(describeAgentActivity(tool("Task", { description: "esplora" }))).toEqual({
      kind: "subagent",
      target: "esplora",
    });
  });

  it("testo dell'agente → write; tool sconosciuto → other col nome", () => {
    expect(describeAgentActivity({ type: "assistant_text", data: { text: "ciao" } })).toEqual({
      kind: "write",
      target: null,
    });
    expect(describeAgentActivity(tool("mcp__x__y", {}))).toEqual({ kind: "other", target: "mcp__x__y" });
  });

  it("input malformato non lancia", () => {
    expect(describeAgentActivity({ type: "tool_use", data: {} })).toEqual({ kind: "other", target: null });
  });
});
```

- [ ] **Step 5: implementa**

```ts
// packages/shared/src/agent-activity.ts
import type { z } from "zod";
import type { agentActivitySchema } from "./schemas/agent-session.js";

export type AgentActivity = z.infer<typeof agentActivitySchema>;

const MAX_TARGET = 80;

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function clip(value: string | null): string | null {
  if (value === null) return null;
  const first = value.split("\n")[0]!.trim();
  return first.length > MAX_TARGET ? `${first.slice(0, MAX_TARGET - 1)}…` : first;
}

/**
 * Traduce un evento di sessione nella riga «ultima azione» (spec §8.2). È
 * l'UNICA regola: web e app la chiamano, e localizzano solo `kind`. Pura, non
 * lancia mai: un input malformato diventa `other`.
 */
export function describeAgentActivity(event: {
  type: string;
  data: Record<string, unknown>;
}): AgentActivity {
  if (event.type === "assistant_text") return { kind: "write", target: null };
  if (event.type !== "tool_use") return { kind: "other", target: null };
  const name = str(event.data["name"]);
  const input =
    typeof event.data["input"] === "object" && event.data["input"] !== null
      ? (event.data["input"] as Record<string, unknown>)
      : {};
  switch (name) {
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return { kind: "edit", target: clip(str(input["file_path"]) ?? str(input["notebook_path"])) };
    case "Read":
      return { kind: "read", target: clip(str(input["file_path"])) };
    case "Bash":
      return { kind: "run", target: clip(str(input["command"])) };
    case "Grep":
    case "Glob":
      return { kind: "search", target: clip(str(input["pattern"])) };
    case "WebFetch":
    case "WebSearch":
      return { kind: "web", target: clip(str(input["url"]) ?? str(input["query"])) };
    case "Task":
    case "Agent":
      return { kind: "subagent", target: clip(str(input["description"])) };
    case null:
      return { kind: "other", target: null };
    default:
      if (name.endsWith("__ask_user")) return { kind: "ask", target: null };
      return { kind: "other", target: clip(name) };
  }
}
```

- [ ] **Step 6: test, build, commit**

Run: `pnpm --filter @stubwise/shared test && pnpm --filter @stubwise/shared build`
Expected: PASS (compreso `load-isolated.test.ts`, che carica il file nuovo da solo).

```bash
git add packages/shared/src
git commit -m "feat(shared): schemi delle sessioni degli agenti e riga dell'ultima azione"
```

---

### Task 2: Migrazione 0086 e tabelle

**Files:**
- Create: `packages/db/drizzle/0086_agent_sessions.sql`
- Modify: `packages/db/drizzle/meta/_journal.json` (voce idx 86)
- Modify: `packages/db/src/schema.ts` (tre tabelle in fondo)
- Test: `packages/db/src/agent-sessions.test.ts`

**Interfaces:**
- Produces: `agentSessions`, `agentSessionEvents`, `agentSessionInputs` (drizzle).

- [ ] **Step 1: test di schema contro Postgres vero**

```ts
// packages/db/src/agent-sessions.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { startTestDb, type TestDb } from "./testing.js";
import { agentSessionEvents, agentSessionInputs, agentSessions } from "./schema.js";

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => t.stop());

describe("0086 agent_sessions", () => {
  it("owner_key è unico e gli eventi cadono in cascata con la sessione", async () => {
    const [s] = await t.db
      .insert(agentSessions)
      .values({ ownerKey: "ai_job:x", kind: "ai_job", title: "t" })
      .returning();
    await expect(
      t.db.insert(agentSessions).values({ ownerKey: "ai_job:x", kind: "ai_job", title: "t" }),
    ).rejects.toThrow();
    await t.db.insert(agentSessionEvents).values({
      sessionId: s!.id,
      segmentId: "seg",
      type: "assistant_text",
      data: { text: "ciao" },
    });
    await t.db.delete(agentSessions).where(sql`id = ${s!.id}`);
    const rows = await t.db.select().from(agentSessionEvents);
    expect(rows).toHaveLength(0);
  });

  it("i CHECK rifiutano kind, tipo di evento e stato di input sconosciuti", async () => {
    await expect(
      t.db.insert(agentSessions).values({ ownerKey: "k1", kind: "nope" as never, title: "t" }),
    ).rejects.toThrow();
    const [s] = await t.db
      .insert(agentSessions)
      .values({ ownerKey: "k2", kind: "pr_review", title: "t" })
      .returning();
    await expect(
      t.db
        .insert(agentSessionEvents)
        .values({ sessionId: s!.id, segmentId: "s", type: "nope" as never, data: {} }),
    ).rejects.toThrow();
    await expect(
      t.db
        .insert(agentSessionInputs)
        .values({ sessionId: s!.id, text: "x", status: "nope" as never }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: verifica che fallisca**

Run: `pnpm --filter @stubwise/db test -- agent-sessions`
Expected: FAIL (export `agentSessions` assente).

- [ ] **Step 3: SQL della migrazione**

```sql
-- packages/db/drizzle/0086_agent_sessions.sql
CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_key" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"project_id" uuid,
	"ticket_id" uuid,
	"ai_job_id" uuid,
	"backlog_item_id" uuid,
	"mailbox_owner_user_id" uuid,
	"active_segment_id" text,
	"active_segment_label" text,
	"active_segment_interactive" boolean DEFAULT false NOT NULL,
	"capabilities" text[] DEFAULT '{}' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	CONSTRAINT "agent_sessions_owner_key_unique" UNIQUE("owner_key"),
	CONSTRAINT "agent_sessions_kind_chk" CHECK (kind in ('ai_job','pr_review','backlog_item','backlog_job','doc_generation','email_message','project_brief','daily_report'))
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_ai_job_id_ai_jobs_id_fk" FOREIGN KEY ("ai_job_id") REFERENCES "public"."ai_jobs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_backlog_item_id_backlog_items_id_fk" FOREIGN KEY ("backlog_item_id") REFERENCES "public"."backlog_items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_mailbox_owner_user_id_users_id_fk" FOREIGN KEY ("mailbox_owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "agent_sessions_started_at_idx" ON "agent_sessions" ("started_at");
--> statement-breakpoint
CREATE INDEX "agent_sessions_active_idx" ON "agent_sessions" ("heartbeat_at") WHERE "active_segment_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "agent_session_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"segment_id" text NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_session_events_type_chk" CHECK (type in ('segment_start','assistant_text','tool_use','tool_result','input','turn_end','segment_end'))
);
--> statement-breakpoint
ALTER TABLE "agent_session_events" ADD CONSTRAINT "agent_session_events_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "agent_session_events_session_id_idx" ON "agent_session_events" ("session_id","id");
--> statement-breakpoint
CREATE TABLE "agent_session_inputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"author_user_id" uuid,
	"text" text NOT NULL,
	"interrupt" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "agent_session_inputs_status_chk" CHECK (status in ('pending','delivered','undelivered'))
);
--> statement-breakpoint
ALTER TABLE "agent_session_inputs" ADD CONSTRAINT "agent_session_inputs_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_session_inputs" ADD CONSTRAINT "agent_session_inputs_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "agent_session_inputs_pending_idx" ON "agent_session_inputs" ("session_id") WHERE "status" = 'pending';
```

Voce in `_journal.json` (dopo idx 85, stesso formato delle precedenti):

```json
{ "idx": 86, "version": "7", "when": 1791417600000, "tag": "0086_agent_sessions", "breakpoints": true }
```

- [ ] **Step 4: tabelle drizzle in fondo a `schema.ts`**

```ts
/**
 * Sessioni degli agenti (0086, design 2026-10-08-agent-sessions-design.md).
 * Una riga per UNITÀ DI LAVORO (`owner_key`, es. `ai_job:<id>`), non per
 * processo: i segmenti (processi `claude`) si susseguono dentro. Lo stato
 * mostrato si DERIVA a lettura (heartbeat, stato del job, domande aperte).
 * `mailbox_owner_user_id`: solo per `email_message`, ed è l'unico che la vede.
 */
export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerKey: text("owner_key").notNull().unique(),
    kind: text("kind").$type<AgentSessionKind>().notNull(),
    title: text("title").notNull(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "cascade" }),
    aiJobId: uuid("ai_job_id").references(() => aiJobs.id, { onDelete: "cascade" }),
    backlogItemId: uuid("backlog_item_id").references(() => backlogItems.id, { onDelete: "cascade" }),
    mailboxOwnerUserId: uuid("mailbox_owner_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    activeSegmentId: text("active_segment_id"),
    activeSegmentLabel: text("active_segment_label").$type<AgentSegmentLabel>(),
    activeSegmentInteractive: boolean("active_segment_interactive").notNull().default(false),
    capabilities: text("capabilities").array().notNull().default(sql`'{}'`),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
  },
  (table) => [
    index("agent_sessions_started_at_idx").on(table.startedAt),
    index("agent_sessions_active_idx").on(table.heartbeatAt).where(sql`active_segment_id IS NOT NULL`),
    check(
      "agent_sessions_kind_chk",
      sql`kind in ('ai_job','pr_review','backlog_item','backlog_job','doc_generation','email_message','project_brief','daily_report')`,
    ),
  ],
);

export const agentSessionEvents = pgTable(
  "agent_session_events",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    segmentId: text("segment_id").notNull(),
    type: text("type").$type<AgentSessionEventType>().notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_session_events_session_id_idx").on(table.sessionId, table.id),
    check(
      "agent_session_events_type_chk",
      sql`type in ('segment_start','assistant_text','tool_use','tool_result','input','turn_end','segment_end')`,
    ),
  ],
);

export const agentSessionInputs = pgTable(
  "agent_session_inputs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    text: text("text").notNull(),
    interrupt: boolean("interrupt").notNull().default(false),
    status: text("status").$type<"pending" | "delivered" | "undelivered">().notNull().default("pending"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => [
    index("agent_session_inputs_pending_idx").on(table.sessionId).where(sql`status = 'pending'`),
    check("agent_session_inputs_status_chk", sql`status in ('pending','delivered','undelivered')`),
  ],
);
```

Importa `bigserial` da `drizzle-orm/pg-core` se non c'è già, e `AgentSessionKind`, `AgentSegmentLabel`, `AgentSessionEventType` da `@stubwise/shared` (stesso stile degli altri `$type` del file).

- [ ] **Step 5: test, build, commit**

Run: `pnpm --filter @stubwise/db test -- agent-sessions && pnpm --filter @stubwise/db build`
Expected: PASS.

```bash
git add packages/db
git commit -m "feat(db): tabelle delle sessioni degli agenti (0086)"
```

---

### Task 3: Tracce vere e parser dello stream

**Files:**
- Create: `apps/worker/src/sessions/fixtures/record-traces.mjs` (script manuale, non in CI)
- Create: `apps/worker/src/sessions/fixtures/*.jsonl` (tracce registrate)
- Create: `apps/worker/src/sessions/stream-parser.ts`
- Test: `apps/worker/src/sessions/stream-parser.test.ts`

**Interfaces:**
- Consumes: `extractUsage` da `apps/worker/src/agent/claude-cli.ts`; `AgentSessionEventType` da `@stubwise/shared`.
- Produces:
  - `type CliStreamEvent = Record<string, unknown> & { type: string }`
  - `parseStreamLine(line: string): CliStreamEvent | null`
  - `interface SessionEventDraft { type: AgentSessionEventType; data: Record<string, unknown> }`
  - `toSessionEvents(ev: CliStreamEvent): SessionEventDraft[]`
  - `partialTextOf(ev: CliStreamEvent): string | null`
  - `capabilitiesOf(ev: CliStreamEvent): string[] | null`
  - `class ResultTracker { observe(ev): void; get hasResult(): boolean; toRunResult(exitCode: number, fallback: string): AgentRunResult }`

- [ ] **Step 1: registra le tracce (a mano, con il CLI fissato)**

```js
// apps/worker/src/sessions/fixtures/record-traces.mjs
// Uso (NON in CI, serve un login claude):
//   npx -y @anthropic-ai/claude-code@2.1.287 --version   # verifica il pin
//   node apps/worker/src/sessions/fixtures/record-traces.mjs <claude-bin>
// Scrive una .jsonl per scenario accanto a questo file. Ricontrolla a mano
// che non contengano dati personali prima del commit.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bin = process.argv[2] ?? "claude";
const user = (content) => ({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });

const scenarios = {
  "two-turns": [[0, user("Say ONE.")], ["afterResult", user("Say TWO.")]],
  "mid-turn-message": [[0, user("Run `sleep 6; echo done` and report.")], [3000, user("End with BANANA.")]],
  "interrupt-then-message": [
    [0, user("Run `sleep 20; echo done` and report.")],
    [5000, { type: "control_request", request_id: "int-1", request: { subtype: "interrupt" } }],
    [5200, user("Forget it. Reply only OK.")],
  ],
};

for (const [name, steps] of Object.entries(scenarios)) {
  const cwd = mkdtempSync(join(tmpdir(), "trace-"));
  const p = spawn(bin, [
    "-p", "--model", "haiku", "--input-format", "stream-json", "--output-format", "stream-json",
    "--verbose", "--include-partial-messages", "--permission-mode", "default",
    "--allowedTools", "Bash", "--setting-sources", "",
  ], { cwd });
  const lines = [];
  let buf = "";
  let grace = null;
  let sentAfterResult = false;
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      lines.push(line);
      if (grace) clearTimeout(grace);
      if (line.includes('"type":"result"')) {
        const next = steps.find(([at]) => at === "afterResult");
        if (next && !sentAfterResult) {
          sentAfterResult = true;
          p.stdin.write(JSON.stringify(next[1]) + "\n");
        } else grace = setTimeout(() => p.stdin.end(), 2000);
      }
    }
  });
  for (const [at, msg] of steps) {
    if (typeof at === "number") setTimeout(() => p.stdin.write(JSON.stringify(msg) + "\n"), at);
  }
  await new Promise((r) => p.on("exit", r));
  writeFileSync(join(here, `${name}.jsonl`), lines.join("\n") + "\n");
  console.log(name, lines.length, "righe");
}
```

Run: `node apps/worker/src/sessions/fixtures/record-traces.mjs <path del claude 2.1.287>`
Expected: tre file `.jsonl`; in `two-turns.jsonl` due righe `"type":"result"`, la seconda con `total_cost_usd` maggiore della prima. In `mid-turn-message.jsonl` UN solo `result`, il cui testo contiene `BANANA`.

- [ ] **Step 2: test del parser sulle tracce**

```ts
// apps/worker/src/sessions/stream-parser.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ResultTracker,
  capabilitiesOf,
  parseStreamLine,
  partialTextOf,
  toSessionEvents,
} from "./stream-parser.js";

const trace = (name: string) =>
  readFileSync(join(__dirname, "fixtures", `${name}.jsonl`), "utf8")
    .split("\n")
    .map(parseStreamLine)
    .filter((e): e is NonNullable<typeof e> => e !== null);

describe("parseStreamLine", () => {
  it("riga vuota o non JSON → null, mai un'eccezione", () => {
    expect(parseStreamLine("")).toBeNull();
    expect(parseStreamLine("not json")).toBeNull();
    expect(parseStreamLine("[1,2]")).toBeNull();
  });
});

describe("toSessionEvents", () => {
  it("su due turni produce testo e due turn_end, e niente dagli stream_event", () => {
    const events = trace("two-turns").flatMap(toSessionEvents);
    expect(events.filter((e) => e.type === "turn_end")).toHaveLength(2);
    expect(events.some((e) => e.type === "assistant_text")).toBe(true);
    expect(events.every((e) => e.type !== ("stream_event" as never))).toBe(true);
  });

  it("un tool produce tool_use e tool_result legati dallo stesso toolUseId", () => {
    const events = trace("mid-turn-message").flatMap(toSessionEvents);
    const use = events.find((e) => e.type === "tool_use")!;
    const res = events.find((e) => e.type === "tool_result")!;
    expect(use.data["name"]).toBe("Bash");
    expect(res.data["toolUseId"]).toBe(use.data["toolUseId"]);
  });

  it("un tool_result enorme è troncato a 16 KB con la marca", () => {
    const big = {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t", content: "x".repeat(40_000) }] },
    };
    const [ev] = toSessionEvents(big);
    expect(String(ev!.data["content"]).length).toBeLessThanOrEqual(16_400);
    expect(ev!.data["truncated"]).toBe(true);
  });
});

describe("partialTextOf / capabilitiesOf", () => {
  it("estrae i delta di testo e le capabilities dell'init", () => {
    const evs = trace("two-turns");
    expect(evs.map(partialTextOf).filter(Boolean).join("")).toContain("ONE");
    const caps = evs.map(capabilitiesOf).find((c) => c !== null)!;
    expect(caps).toContain("interrupt_receipt_v1");
  });
});

describe("ResultTracker", () => {
  it("usa l'ULTIMO result: output, session id e usage cumulativo", () => {
    const t = new ResultTracker();
    const evs = trace("two-turns");
    evs.forEach((e) => t.observe(e));
    const results = evs.filter((e) => e.type === "result");
    const last = results[results.length - 1]!;
    const out = t.toRunResult(0, "");
    expect(out.output).toBe(last["result"]);
    expect(out.sessionId).toBe(last["session_id"]);
    expect(out.usage?.totalCostUsd).toBe(last["total_cost_usd"]);
  });

  it("interruzione seguita da messaggio: l'esito è il result finale, non l'errore", () => {
    const t = new ResultTracker();
    trace("interrupt-then-message").forEach((e) => t.observe(e));
    const out = t.toRunResult(0, "");
    expect(out.exitCode).toBe(0);
    expect(out.output).toMatch(/OK/);
  });

  it("senza result usa il fallback grezzo", () => {
    const t = new ResultTracker();
    expect(t.hasResult).toBe(false);
    expect(t.toRunResult(1, "raw").output).toBe("raw");
  });
});
```

- [ ] **Step 3: verifica che fallisca**

Run: `pnpm --filter @stubwise/worker test -- stream-parser`
Expected: FAIL, modulo assente.

- [ ] **Step 4: implementa**

```ts
// apps/worker/src/sessions/stream-parser.ts
import type { AgentSessionEventType } from "@stubwise/shared";
import { extractUsage } from "../agent/claude-cli.js";
import type { AgentRunResult } from "../agent/runner.js";

/**
 * Lettura dello stdout di `claude -p --output-format stream-json` (CLI
 * 2.1.287, tracce in fixtures/). Tutto PURO e difensivo: una riga che non si
 * capisce si scarta, non lancia. Comportamenti verificati e su cui questo
 * modulo si appoggia: vedi l'intestazione del piano A
 * (`docs/plans/2026-10-08-agent-sessions-a-backend.md`).
 */

export type CliStreamEvent = Record<string, unknown> & { type: string };

export interface SessionEventDraft {
  type: AgentSessionEventType;
  data: Record<string, unknown>;
}

const MAX_TOOL_RESULT = 16_384;
const MAX_TOOL_INPUT_STRING = 8_192;

export function parseStreamLine(line: string): CliStreamEvent | null {
  if (line.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const type = (parsed as Record<string, unknown>)["type"];
    return typeof type === "string" ? (parsed as CliStreamEvent) : null;
  } catch {
    return null;
  }
}

function contentBlocks(ev: CliStreamEvent): Record<string, unknown>[] {
  const message = ev["message"];
  if (typeof message !== "object" || message === null) return [];
  const content = (message as Record<string, unknown>)["content"];
  return Array.isArray(content)
    ? content.filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null)
    : [];
}

function clipInput(input: unknown): unknown {
  if (typeof input === "string") {
    return input.length > MAX_TOOL_INPUT_STRING ? `${input.slice(0, MAX_TOOL_INPUT_STRING)}…` : input;
  }
  if (Array.isArray(input)) return input.map(clipInput);
  if (typeof input === "object" && input !== null) {
    return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, clipInput(v)]));
  }
  return input;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof c === "object" && c !== null && (c as Record<string, unknown>)["type"] === "text"
          ? String((c as Record<string, unknown>)["text"] ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

/** Eventi COMPLETI da salvare. I parziali (`stream_event`) non producono nulla qui. */
export function toSessionEvents(ev: CliStreamEvent): SessionEventDraft[] {
  if (ev.type === "assistant") {
    const out: SessionEventDraft[] = [];
    for (const block of contentBlocks(ev)) {
      if (block["type"] === "text" && typeof block["text"] === "string" && block["text"] !== "") {
        out.push({ type: "assistant_text", data: { text: block["text"] } });
      } else if (block["type"] === "tool_use") {
        out.push({
          type: "tool_use",
          data: { toolUseId: block["id"], name: block["name"], input: clipInput(block["input"]) },
        });
      }
    }
    return out;
  }
  if (ev.type === "user") {
    const out: SessionEventDraft[] = [];
    for (const block of contentBlocks(ev)) {
      if (block["type"] !== "tool_result") continue;
      const text = resultText(block["content"]);
      const truncated = text.length > MAX_TOOL_RESULT;
      out.push({
        type: "tool_result",
        data: {
          toolUseId: block["tool_use_id"],
          isError: block["is_error"] === true,
          content: truncated ? `${text.slice(0, MAX_TOOL_RESULT)}…` : text,
          ...(truncated ? { truncated: true } : {}),
        },
      });
    }
    return out;
  }
  if (ev.type === "result") {
    return [
      {
        type: "turn_end",
        data: {
          subtype: ev["subtype"] ?? null,
          isError: ev["is_error"] === true,
          costUsd: typeof ev["total_cost_usd"] === "number" ? ev["total_cost_usd"] : null,
        },
      },
    ];
  }
  return [];
}

/** Il delta di testo di un evento parziale, o null. */
export function partialTextOf(ev: CliStreamEvent): string | null {
  if (ev.type !== "stream_event") return null;
  const inner = ev["event"] as Record<string, unknown> | undefined;
  if (inner?.["type"] !== "content_block_delta") return null;
  const delta = inner["delta"] as Record<string, unknown> | undefined;
  return delta?.["type"] === "text_delta" && typeof delta["text"] === "string" ? delta["text"] : null;
}

export function capabilitiesOf(ev: CliStreamEvent): string[] | null {
  if (ev.type !== "system" || ev["subtype"] !== "init") return null;
  const caps = ev["capabilities"];
  return Array.isArray(caps) ? caps.filter((c): c is string => typeof c === "string") : [];
}

/**
 * Tiene l'ULTIMO `result`: costo e token sono cumulativi sul processo, e un
 * `result` di interruzione seguito da un messaggio non è l'esito del run.
 */
export class ResultTracker {
  private last: CliStreamEvent | null = null;

  observe(ev: CliStreamEvent): void {
    if (ev.type === "result") this.last = ev;
  }

  get hasResult(): boolean {
    return this.last !== null;
  }

  toRunResult(exitCode: number, fallback: string): AgentRunResult {
    if (this.last === null) return { output: fallback, exitCode };
    const result = this.last["result"];
    const usage = extractUsage(this.last);
    const sessionId = this.last["session_id"];
    return {
      output: typeof result === "string" ? result : fallback,
      exitCode,
      ...(usage !== undefined ? { usage } : {}),
      ...(typeof sessionId === "string" && sessionId !== "" ? { sessionId } : {}),
    };
  }
}
```

- [ ] **Step 5: test e commit**

Run: `pnpm --filter @stubwise/worker test -- stream-parser`
Expected: PASS.

```bash
git add apps/worker/src/sessions
git commit -m "feat(worker): parser dello stream-json del CLI con tracce vere della 2.1.287"
```

---

### Task 4: Oscuramento dei segreti

**Files:**
- Create: `apps/worker/src/sessions/redact.ts`
- Test: `apps/worker/src/sessions/redact.test.ts`

**Interfaces:**
- Produces: `type Redactor = <T>(value: T) => T`; `createRedactor(secrets: Iterable<string>): Redactor`; `REDACTED = "•••"`; `MIN_SECRET_LENGTH = 6`.

- [ ] **Step 1: test**

```ts
// apps/worker/src/sessions/redact.test.ts
import { describe, expect, it } from "vitest";
import { REDACTED, createRedactor } from "./redact.js";

describe("createRedactor", () => {
  it("oscura un valore ovunque compaia, anche annidato in oggetti e array", () => {
    const r = createRedactor(["s3cr3t-token"]);
    expect(
      r({ content: "TOKEN=s3cr3t-token\nother", list: ["a s3cr3t-token b"], n: 3, ok: true }),
    ).toEqual({ content: `TOKEN=${REDACTED}\nother`, list: [`a ${REDACTED} b`], n: 3, ok: true });
  });

  it("ignora i valori corti (sotto MIN_SECRET_LENGTH) per non oscurare 'true' o '1'", () => {
    const r = createRedactor(["true", "1", "abc"]);
    expect(r("true 1 abc")).toBe("true 1 abc");
  });

  it("oscura prima il valore più lungo quando uno contiene l'altro", () => {
    const r = createRedactor(["abcdefgh", "abcdefgh-ijkl"]);
    expect(r("x abcdefgh-ijkl y")).toBe(`x ${REDACTED} y`);
  });

  it("senza segreti è l'identità", () => {
    const value = { a: "b" };
    expect(createRedactor([])(value)).toBe(value);
  });

  it("i caratteri speciali di regex nel valore non rompono niente", () => {
    const r = createRedactor(["p@ss(w0rd)+$"]);
    expect(r("x p@ss(w0rd)+$ y")).toBe(`x ${REDACTED} y`);
  });
});
```

- [ ] **Step 2: verifica che fallisca**

Run: `pnpm --filter @stubwise/worker test -- redact`
Expected: FAIL.

- [ ] **Step 3: implementa**

```ts
// apps/worker/src/sessions/redact.ts
/**
 * Oscura i valori dei `.env` materializzati nel worktree prima che un evento
 * di sessione venga salvato o inoltrato (spec §5.5). Difesa PARZIALE per
 * costruzione: un valore derivato, codificato o spezzato fra due parziali
 * passa. Sotto MIN_SECRET_LENGTH non si oscura: trasformerebbe ogni `true` o
 * `1` del transcript in `•••`.
 */
export const REDACTED = "•••";
export const MIN_SECRET_LENGTH = 6;

export type Redactor = <T>(value: T) => T;

export function createRedactor(secrets: Iterable<string>): Redactor {
  const values = [...new Set(secrets)]
    .filter((s) => s.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  if (values.length === 0) return <T>(value: T) => value;
  const replace = (text: string): string =>
    values.reduce((acc, secret) => acc.split(secret).join(REDACTED), text);
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return replace(value);
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return <T>(value: T) => walk(value) as T;
}
```

- [ ] **Step 4: test e commit**

Run: `pnpm --filter @stubwise/worker test -- redact`
Expected: PASS.

```bash
git add apps/worker/src/sessions/redact*
git commit -m "feat(worker): oscuramento dei valori d'ambiente negli eventi di sessione"
```

---

### Task 5: `StreamingClaudeRunner`

**Files:**
- Create: `apps/worker/src/agent/cli-args.ts` (estratto da `claude-cli.ts`, nessun cambio di comportamento)
- Modify: `apps/worker/src/agent/claude-cli.ts` (usa `cli-args.ts`)
- Modify: `apps/worker/src/agent/runner.ts` (`AgentRunOptions.session?`)
- Create: `apps/worker/src/agent/streaming-cli.ts`
- Test: `apps/worker/src/agent/streaming-cli.test.ts`

**Interfaces:**
- Consumes: Task 3 (`parseStreamLine`, `toSessionEvents`, `partialTextOf`, `capabilitiesOf`, `ResultTracker`), Task 4 (`createRedactor`).
- Produces:
  - in `runner.ts`:
    ```ts
    export interface AgentRunSession {
      /** id della riga agent_sessions (da ensureAgentSession). */
      sessionId: string;
      label: AgentSegmentLabel;
      /** Valori da oscurare (env materializzati). */
      secrets?: string[];
    }
    // in AgentRunOptions:
    session?: AgentRunSession;
    ```
  - in `cli-args.ts`: `buildCliArgs(opts: AgentRunOptions, format: "json" | "stream"): string[]`, `withMcpConfig<T>(opts, args, fn: (args: string[]) => Promise<T>): Promise<T>`.
  - in `streaming-cli.ts`:
    ```ts
    export interface SegmentSink {
      onStart(caps: string[]): void;
      onEvents(events: SessionEventDraft[]): void;
      onPartial(text: string): void;
      onEnd(info: { exitCode: number | null; timedOut: boolean }): Promise<void>;
    }
    export interface LiveProcessHandle {
      /** false se stdin è già chiuso: l'intervento è undelivered. */
      deliver(text: string, interrupt: boolean): boolean;
    }
    export interface SessionHooks {
      openSegment(session: AgentRunSession, segmentId: string, interactive: boolean): SegmentSink;
      register(sessionId: string, handle: LiveProcessHandle): () => void;
    }
    export class StreamingClaudeRunner implements AgentRunner {
      constructor(options?: ClaudeCliRunnerOptions & { hooks?: SessionHooks; resultGraceMs?: number });
    }
    ```

- [ ] **Step 1: estrai `cli-args.ts` senza cambiare comportamento**

Sposta in `apps/worker/src/agent/cli-args.ts` la costruzione di `args` di `ClaudeCliRunner.run` (dalla validazione di `maxTurns`/`timeoutMs` fino alla gestione di `mcpConfigDir`) e `writeMcpConfigFile`, con questa forma:

```ts
// apps/worker/src/agent/cli-args.ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunError, type AgentMcpConfig, type AgentRunOptions } from "./runner.js";

/** Formato dell'output del CLI: json (storico) o stream (sessioni dal vivo). */
export type CliFormat = "json" | "stream";

export function validateRunOptions(opts: AgentRunOptions): void {
  if (!Number.isInteger(opts.maxTurns) || opts.maxTurns <= 0) {
    throw new AgentRunError(`maxTurns non valido: ${opts.maxTurns} (atteso intero > 0)`);
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new AgentRunError(`timeoutMs non valido: ${opts.timeoutMs} (atteso > 0)`);
  }
}

/**
 * argv del CLI. Con `format: "json"` è IDENTICO a quello storico (i test di
 * claude-cli.test.ts lo verificano); con `"stream"` cambia solo la coppia di
 * formato, il resto (permessi, MCP, plugin, resume) resta uguale.
 */
export function buildCliArgs(opts: AgentRunOptions, format: CliFormat): string[] {
  const permissionMode = opts.permissionMode ?? "acceptEdits";
  const args =
    format === "json"
      ? ["-p", "--output-format", "json"]
      : [
          "-p",
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
        ];
  args.push("--permission-mode", permissionMode, "--max-turns", String(opts.maxTurns));
  if (opts.resumeSessionId !== undefined) args.push("--resume", opts.resumeSessionId);
  if (opts.model !== undefined) args.push("--model", opts.model);
  if (opts.allowedTools !== undefined && opts.allowedTools.length > 0) {
    args.push("--allowedTools", ...opts.allowedTools);
  }
  if (opts.disallowedTools !== undefined && opts.disallowedTools.length > 0) {
    args.push("--disallowedTools", ...opts.disallowedTools);
  }
  if (opts.pluginDirs !== undefined && opts.pluginDirs.length > 0) {
    for (const dir of opts.pluginDirs) args.push("--plugin-dir", dir);
  }
  if (opts.settingSources !== undefined) args.push("--setting-sources", opts.settingSources);
  return args;
}

async function writeMcpConfigFile(dir: string, config: AgentMcpConfig): Promise<string> {
  const path = join(dir, "mcp-config.json");
  await writeFile(path, JSON.stringify({ mcpServers: config.servers }), "utf8");
  return path;
}

/**
 * Aggiunge `--mcp-config <file effimero> --strict-mcp-config` se il run ha
 * server MCP, esegue `fn` e rimuove il file in ogni caso.
 */
export async function withMcpConfig<T>(
  opts: AgentRunOptions,
  args: string[],
  fn: (args: string[]) => Promise<T>,
): Promise<T> {
  let mcpConfigDir: string | undefined;
  if (opts.mcpConfig !== undefined && Object.keys(opts.mcpConfig.servers).length > 0) {
    try {
      mcpConfigDir = await mkdtemp(join(tmpdir(), "stubwise-mcp-"));
      const configPath = await writeMcpConfigFile(mcpConfigDir, opts.mcpConfig);
      args = [...args, "--mcp-config", configPath, "--strict-mcp-config"];
    } catch (error) {
      if (mcpConfigDir !== undefined) {
        await rm(mcpConfigDir, { recursive: true, force: true }).catch(() => undefined);
      }
      throw new AgentRunError(
        `Impossibile scrivere la configurazione MCP del run: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  try {
    return await fn(args);
  } finally {
    if (mcpConfigDir !== undefined) {
      await rm(mcpConfigDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
```

Porta con te i commenti esistenti di `claude-cli.ts` sui singoli flag (non riscriverli). `ClaudeCliRunner.run` diventa:

```ts
async run(opts: AgentRunOptions): Promise<AgentRunResult> {
  validateRunOptions(opts);
  return withMcpConfig(opts, buildCliArgs(opts, "json"), (args) => this.spawn(opts, args));
}
```

Run: `pnpm --filter @stubwise/worker test -- claude-cli`
Expected: PASS, **senza toccare** `claude-cli.test.ts`.

- [ ] **Step 2: aggiungi `session` a `AgentRunOptions`**

In `apps/worker/src/agent/runner.ts`, prima di `AgentRunOptions`:

```ts
import type { AgentSegmentLabel } from "@stubwise/shared";

/**
 * Sessione a cui appartiene il run (design 2026-10-08-agent-sessions). Il
 * runner storico la ignora; lo streaming la usa per registrare gli eventi e
 * ricevere gli interventi. Assente = run non registrato (credential test,
 * smoke dei plugin, usage poller).
 */
export interface AgentRunSession {
  sessionId: string;
  label: AgentSegmentLabel;
  /** Valori da oscurare negli eventi (i .env materializzati nel worktree). */
  secrets?: string[];
}
```

e dentro `AgentRunOptions`:

```ts
  /** Vedi AgentRunSession. */
  session?: AgentRunSession;
```

Aggiungi in `apps/worker/src/agent/fake.ts` il campo nelle opzioni registrate, se `FakeAgentRunner` copia le opzioni selettivamente (controlla; se salva `opts` intero non serve nulla).

- [ ] **Step 3: test del runner in streaming con un CLI finto in Node**

```ts
// apps/worker/src/agent/streaming-cli.test.ts
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StreamingClaudeRunner, type LiveProcessHandle, type SessionHooks } from "./streaming-cli.js";
import type { SessionEventDraft } from "../sessions/stream-parser.js";

// Finto CLI stream-json: legge stdin riga per riga. Un messaggio utente
// produce init (solo la prima volta) + assistant + result. Un messaggio che
// contiene SLOW risponde dopo 300 ms (per iniettare a metà turno); un
// control_request interrupt chiude il turno in corso con un result di errore.
// Ogni result porta un costo CUMULATIVO, come il CLI vero.
const FAKE = `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
let cost = 0, inited = false, pending = null, absorbed = [];
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
function finish(text) {
  cost += 0.01;
  out({ type: "assistant", message: { content: [{ type: "text", text }] } });
  out({ type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: cost, session_id: "sess-1", modelUsage: { m: { inputTokens: 1, outputTokens: 1, costUSD: cost } } });
}
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "control_request") {
    if (pending) { clearTimeout(pending.t); pending = null;
      cost += 0.01;
      out({ type: "control_response", response: { request_id: msg.request_id, subtype: "success" } });
      out({ type: "result", subtype: "error_during_execution", is_error: true, result: "", total_cost_usd: cost, session_id: "sess-1" }); }
    return;
  }
  const text = msg.message.content;
  if (!inited) { inited = true; out({ type: "system", subtype: "init", capabilities: ["interrupt_receipt_v1"] }); }
  if (pending) { absorbed.push(text); return; }
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "…" } } });
  if (text.includes("SLOW")) {
    pending = { t: setTimeout(() => { const extra = absorbed.join("+"); absorbed = []; pending = null; finish("slow done" + (extra ? " with " + extra : "")); }, 300) };
  } else finish("echo: " + text + (text.includes("SECRET") ? " value=hunter2-secret" : ""));
});
rl.on("close", () => process.exit(0));
`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function fakeClaude(): Promise<{ bin: string; cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), "stw-stream-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "claude");
  await writeFile(bin, FAKE, "utf8");
  await chmod(bin, 0o755);
  return { bin, cwd: root };
}

function recordingHooks() {
  const events: SessionEventDraft[] = [];
  const partials: string[] = [];
  const handles = new Map<string, LiveProcessHandle>();
  let ended = 0;
  let caps: string[] = [];
  const hooks: SessionHooks = {
    openSegment: () => ({
      onStart: (c) => { caps = c; },
      onEvents: (e) => { events.push(...e); },
      onPartial: (p) => { partials.push(p); },
      onEnd: async () => { ended++; },
    }),
    register: (id, h) => {
      handles.set(id, h);
      return () => handles.delete(id);
    },
  };
  return { hooks, events, partials, handles, get ended() { return ended; }, get caps() { return caps; } };
}

const base = { maxTurns: 5, timeoutMs: 10_000 };
const session = { sessionId: "s1", label: "execute" as const };

describe("StreamingClaudeRunner", () => {
  it("un run semplice esce da solo dopo il grace e restituisce output, usage, session id", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 50 });
    const result = await runner.run({ ...base, cwd, prompt: "hello", session });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("echo: hello");
    expect(result.sessionId).toBe("sess-1");
    expect(result.usage?.totalCostUsd).toBeCloseTo(0.01);
    expect(rec.events.map((e) => e.type)).toEqual(["assistant_text", "turn_end"]);
    expect(rec.partials.length).toBeGreaterThan(0);
    expect(rec.caps).toContain("interrupt_receipt_v1");
    expect(rec.ended).toBe(1);
    expect(rec.handles.size).toBe(0); // deregistrato a fine run
  });

  it("un messaggio consegnato a metà turno viene assorbito e il run finisce (nessun hang)", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 50 });
    const run = runner.run({ ...base, cwd, prompt: "SLOW", session });
    await new Promise((r) => setTimeout(r, 100));
    expect(rec.handles.get("s1")!.deliver("BANANA", false)).toBe(true);
    const result = await run;
    expect(result.output).toBe("slow done with BANANA");
    expect(rec.events.some((e) => e.type === "input" && e.data["text"] === "BANANA")).toBe(true);
  });

  it("interruzione + messaggio: l'esito è l'ULTIMO result, exit 0, costo cumulativo", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 50 });
    const run = runner.run({ ...base, cwd, prompt: "SLOW", session });
    await new Promise((r) => setTimeout(r, 100));
    expect(rec.handles.get("s1")!.deliver("cambia strada", true)).toBe(true);
    const result = await run;
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("echo: cambia strada");
    expect(result.usage?.totalCostUsd).toBeCloseTo(0.02);
  });

  it("dopo la chiusura di stdin deliver restituisce false (→ undelivered)", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    let handle: LiveProcessHandle | undefined;
    const hooks: SessionHooks = {
      ...rec.hooks,
      register: (id, h) => {
        handle = h;
        return () => undefined;
      },
    };
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks, resultGraceMs: 20 });
    await runner.run({ ...base, cwd, prompt: "hi", session });
    expect(handle!.deliver("troppo tardi", false)).toBe(false);
  });

  it("oscura i segreti negli eventi e nei parziali", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 20 });
    await runner.run({ ...base, cwd, prompt: "SECRET", session: { ...session, secrets: ["hunter2-secret"] } });
    expect(JSON.stringify(rec.events)).not.toContain("hunter2-secret");
    expect(JSON.stringify(rec.events)).toContain("•••");
  });

  it("un sink che lancia non fa fallire il run (fail-open)", async () => {
    const { bin, cwd } = await fakeClaude();
    const hooks: SessionHooks = {
      openSegment: () => ({
        onStart: () => { throw new Error("db down"); },
        onEvents: () => { throw new Error("db down"); },
        onPartial: () => { throw new Error("db down"); },
        onEnd: async () => { throw new Error("db down"); },
      }),
      register: () => () => undefined,
    };
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks, resultGraceMs: 20 });
    const result = await runner.run({ ...base, cwd, prompt: "hello", session });
    expect(result.output).toBe("echo: hello");
  });

  it("senza session funziona uguale e non registra niente", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 20 });
    const result = await runner.run({ ...base, cwd, prompt: "hello" });
    expect(result.output).toBe("echo: hello");
    expect(rec.events).toHaveLength(0);
  });

  it("argv in streaming: i flag di formato e nessun prompt in argv", async () => {
    const root = await mkdtemp(join(tmpdir(), "stw-argv-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = join(root, "claude");
    // Stampa argv come result e chiude.
    await writeFile(
      bin,
      `#!/usr/bin/env node
require("node:readline").createInterface({ input: process.stdin }).once("line", () => {
  process.stdout.write(JSON.stringify({ type: "result", result: process.argv.slice(2).join(" ") }) + "\\n");
});`,
    );
    await chmod(bin, 0o755);
    const runner = new StreamingClaudeRunner({ claudePath: bin, resultGraceMs: 20 });
    const { output } = await runner.run({ ...base, cwd: root, prompt: "PROMPT-SEGRETO" });
    expect(output).toContain("--input-format stream-json --output-format stream-json --verbose --include-partial-messages");
    expect(output).not.toContain("PROMPT-SEGRETO");
  });
});
```

- [ ] **Step 4: verifica che fallisca**

Run: `pnpm --filter @stubwise/worker test -- streaming-cli`
Expected: FAIL, modulo assente.

- [ ] **Step 5: implementa il runner**

```ts
// apps/worker/src/agent/streaming-cli.ts
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { execa } from "execa";
import { INTERACTIVE_SEGMENTS } from "@stubwise/shared";
import { buildAgentEnv, type ClaudeCliRunnerOptions } from "./claude-cli.js";
import { buildCliArgs, validateRunOptions, withMcpConfig } from "./cli-args.js";
import {
  AgentRunError,
  AgentTimeoutError,
  type AgentRunner,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentRunSession,
} from "./runner.js";
import { createRedactor } from "../sessions/redact.js";
import {
  ResultTracker,
  capabilitiesOf,
  parseStreamLine,
  partialTextOf,
  toSessionEvents,
  type SessionEventDraft,
} from "../sessions/stream-parser.js";

/**
 * Runner in streaming bidirezionale (design 2026-10-08-agent-sessions §5).
 * Stesso contratto di ClaudeCliRunner (exit non-zero = risultato, timeout =
 * AgentTimeoutError, spawn fallito = AgentRunError), più:
 * - gli eventi del run vanno a un SegmentSink (fail-open: un sink che lancia
 *   non tocca il run);
 * - stdin resta aperto: un LiveProcessHandle registrato per la sessione
 *   consegna gli interventi;
 * - CHIUSURA: dopo un `result`, se per RESULT_GRACE_MS non arriva né output
 *   né un intervento, si chiude stdin e il CLI esce. Non si contano i turni:
 *   un messaggio a metà turno viene ASSORBITO nello stesso turno (verificato
 *   sulla 2.1.287), quindi i `result` non sono uno per messaggio.
 */

export const RESULT_GRACE_MS = 2000;

export interface SegmentSink {
  onStart(capabilities: string[]): void;
  onEvents(events: SessionEventDraft[]): void;
  onPartial(text: string): void;
  onEnd(info: { exitCode: number | null; timedOut: boolean }): Promise<void>;
}

export interface LiveProcessHandle {
  deliver(text: string, interrupt: boolean): boolean;
}

export interface SessionHooks {
  openSegment(session: AgentRunSession, segmentId: string, interactive: boolean): SegmentSink;
  register(sessionId: string, handle: LiveProcessHandle): () => void;
}

const NOOP_SINK: SegmentSink = {
  onStart: () => undefined,
  onEvents: () => undefined,
  onPartial: () => undefined,
  onEnd: async () => undefined,
};

/** Avvolge un sink in modo che nessuna sua eccezione esca (fail-open). */
function safeSink(sink: SegmentSink, log: (msg: string) => void): SegmentSink {
  const guard =
    <A extends unknown[]>(name: string, fn: (...a: A) => void) =>
    (...a: A) => {
      try {
        fn(...a);
      } catch (error) {
        log(`sessione: ${name} fallito: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
  return {
    onStart: guard("onStart", (c: string[]) => sink.onStart(c)),
    onEvents: guard("onEvents", (e: SessionEventDraft[]) => sink.onEvents(e)),
    onPartial: guard("onPartial", (p: string) => sink.onPartial(p)),
    onEnd: async (info) => {
      try {
        await sink.onEnd(info);
      } catch (error) {
        log(`sessione: onEnd fallito: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

const userMessage = (content: string) =>
  `${JSON.stringify({ type: "user", message: { role: "user", content }, parent_tool_use_id: null })}\n`;

export class StreamingClaudeRunner implements AgentRunner {
  private readonly claudePath: string;
  private readonly extraEnv: Record<string, string> | undefined;
  private readonly hooks: SessionHooks | undefined;
  private readonly graceMs: number;
  private readonly log: (msg: string) => void;

  constructor(
    options: ClaudeCliRunnerOptions & {
      hooks?: SessionHooks;
      resultGraceMs?: number;
      log?: (msg: string) => void;
    } = {},
  ) {
    this.claudePath = options.claudePath ?? "claude";
    this.extraEnv = options.extraEnv;
    this.hooks = options.hooks;
    this.graceMs = options.resultGraceMs ?? RESULT_GRACE_MS;
    this.log = options.log ?? ((msg) => console.warn(msg));
  }

  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    validateRunOptions(opts);
    return withMcpConfig(opts, buildCliArgs(opts, "stream"), (args) => this.spawn(opts, args));
  }

  private async spawn(opts: AgentRunOptions, args: string[]): Promise<AgentRunResult> {
    const session = opts.session;
    const segmentId = randomUUID();
    const interactive = session !== undefined && INTERACTIVE_SEGMENTS.has(session.label);
    const redact = createRedactor(session?.secrets ?? []);
    const sink =
      session !== undefined && this.hooks !== undefined
        ? safeSink(this.hooks.openSegment(session, segmentId, interactive), this.log)
        : NOOP_SINK;

    let child;
    try {
      child = execa(this.claudePath, args, {
        cwd: opts.cwd,
        stdin: "pipe",
        timeout: opts.timeoutMs,
        forceKillAfterDelay: 5000,
        extendEnv: false,
        env: buildAgentEnv(process.env, this.extraEnv, opts.provider),
        all: true,
      });
    } catch (error) {
      throw new AgentRunError(`Impossibile eseguire ${this.claudePath}: ${String(error)}`);
    }

    const tracker = new ResultTracker();
    let stdinOpen = true;
    let grace: NodeJS.Timeout | null = null;
    const clearGrace = () => {
      if (grace !== null) clearTimeout(grace);
      grace = null;
    };
    const closeStdin = () => {
      clearGrace();
      if (!stdinOpen) return;
      stdinOpen = false;
      child.stdin?.end();
    };
    const write = (line: string): boolean => {
      if (!stdinOpen || child.stdin === null || child.stdin.destroyed) return false;
      child.stdin.write(line);
      return true;
    };

    const handle: LiveProcessHandle = {
      deliver: (text, interrupt) => {
        if (!stdinOpen) return false;
        clearGrace();
        if (interrupt) {
          write(
            `${JSON.stringify({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } })}\n`,
          );
        }
        const ok = write(userMessage(text));
        if (ok) sink.onEvents([{ type: "input", data: redact({ text, interrupt }) }]);
        return ok;
      },
    };
    const unregister =
      session !== undefined && interactive && this.hooks !== undefined
        ? this.hooks.register(session.sessionId, handle)
        : () => undefined;

    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      const ev = parseStreamLine(line);
      if (ev === null) return;
      clearGrace();
      tracker.observe(ev);
      const caps = capabilitiesOf(ev);
      if (caps !== null) sink.onStart(caps);
      const partial = partialTextOf(ev);
      if (partial !== null) sink.onPartial(redact(partial));
      const drafts = toSessionEvents(ev);
      if (drafts.length > 0) sink.onEvents(drafts.map((d) => ({ type: d.type, data: redact(d.data) })));
      if (ev.type === "result") grace = setTimeout(closeStdin, this.graceMs);
    });

    write(userMessage(opts.prompt));

    try {
      const { all, exitCode } = await child;
      await sink.onEnd({ exitCode: exitCode ?? 0, timedOut: false });
      return tracker.toRunResult(exitCode ?? 0, all ?? "");
    } catch (error) {
      const e = error as { timedOut?: boolean; all?: string; exitCode?: number; shortMessage?: string };
      await sink.onEnd({ exitCode: e.exitCode ?? null, timedOut: e.timedOut === true });
      if (e.timedOut === true) throw new AgentTimeoutError(opts.timeoutMs, e.all ?? "");
      if (typeof e.exitCode === "number") {
        const result = tracker.toRunResult(e.exitCode, e.all ?? "");
        return { ...result, output: e.all ?? result.output };
      }
      throw new AgentRunError(`Impossibile eseguire ${this.claudePath}: ${e.shortMessage ?? String(error)}`);
    } finally {
      closeStdin();
      unregister();
      lines.close();
    }
  }
}
```

Nota: un exit non-zero restituisce `output = all` (stdout+stderr) come il runner storico, ma con usage e session id dall'ultimo `result`.

- [ ] **Step 6: test e commit**

Run: `pnpm --filter @stubwise/worker test -- streaming-cli claude-cli`
Expected: PASS entrambi.

```bash
git add apps/worker/src/agent
git commit -m "feat(worker): runner in streaming bidirezionale del CLI claude"
```

---

### Task 6: `SessionRecorder` e `ensureAgentSession`

**Files:**
- Create: `apps/worker/src/sessions/store.ts`
- Test: `apps/worker/src/sessions/store.test.ts`

**Interfaces:**
- Consumes: Task 2 (tabelle), Task 5 (`SegmentSink`, `AgentRunSession`).
- Produces:
  ```ts
  export interface EnsureSessionInput {
    ownerKey: string;               // es. `ai_job:${jobId}`
    kind: AgentSessionKind;
    title: string;
    projectId?: string | null;
    ticketId?: string | null;
    aiJobId?: string | null;
    backlogItemId?: string | null;
    mailboxOwnerUserId?: string | null;
  }
  export async function ensureAgentSession(db: Db, input: EnsureSessionInput, log?: (m: string) => void): Promise<string | null>;
  export const AGENT_EVENTS_CHANNEL = "agent_session_events";
  export const AGENT_PARTIAL_CHANNEL = "agent_session_partial";
  export function createSegmentSink(db: Db, session: AgentRunSession, segmentId: string, interactive: boolean, opts?: { flushMs?: number; heartbeatMs?: number; log?: (m: string) => void }): SegmentSink;
  export async function pruneAgentSessions(db: Db, now?: Date): Promise<number>;
  export const AGENT_SESSION_RETENTION_DAYS = 14;
  ```

- [ ] **Step 1: test contro Postgres vero**

```ts
// apps/worker/src/sessions/store.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { agentSessionEvents, agentSessions } from "@stubwise/db";
import { AGENT_EVENTS_CHANNEL, createSegmentSink, ensureAgentSession, pruneAgentSessions } from "./store.js";

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => t.stop());

describe("ensureAgentSession", () => {
  it("è idempotente sull'owner_key e restituisce sempre lo stesso id", async () => {
    const a = await ensureAgentSession(t.db, { ownerKey: "pr_review:1", kind: "pr_review", title: "PR #1" });
    const b = await ensureAgentSession(t.db, { ownerKey: "pr_review:1", kind: "pr_review", title: "PR #1 bis" });
    expect(a).not.toBeNull();
    expect(b).toBe(a);
  });

  it("su errore DB restituisce null e non lancia", async () => {
    const broken = { insert: () => { throw new Error("db down"); } } as never;
    expect(await ensureAgentSession(broken, { ownerKey: "x", kind: "ai_job", title: "x" }, () => undefined)).toBeNull();
  });
});

describe("createSegmentSink", () => {
  it("scrive segment_start, eventi e segment_end, aggiorna il segmento attivo e notifica", async () => {
    const id = (await ensureAgentSession(t.db, { ownerKey: "ai_job:sink", kind: "ai_job", title: "t" }))!;
    const notified: string[] = [];
    await t.client.listen(AGENT_EVENTS_CHANNEL, (payload) => notified.push(payload));
    const sink = createSegmentSink(t.db, { sessionId: id, label: "execute" }, "seg-1", true, { flushMs: 10 });
    sink.onStart(["interrupt_receipt_v1"]);
    let [row] = await t.db.select().from(agentSessions).where(eq(agentSessions.id, id));
    expect(row!.activeSegmentId).toBe("seg-1");
    expect(row!.activeSegmentInteractive).toBe(true);
    sink.onEvents([{ type: "assistant_text", data: { text: "ciao" } }]);
    await sink.onEnd({ exitCode: 0, timedOut: false });
    const events = await t.db
      .select()
      .from(agentSessionEvents)
      .where(eq(agentSessionEvents.sessionId, id))
      .orderBy(agentSessionEvents.id);
    expect(events.map((e) => e.type)).toEqual(["segment_start", "assistant_text", "segment_end"]);
    [row] = await t.db.select().from(agentSessions).where(eq(agentSessions.id, id));
    expect(row!.activeSegmentId).toBeNull();
    expect(row!.capabilities).toEqual(["interrupt_receipt_v1"]);
    await new Promise((r) => setTimeout(r, 100));
    expect(notified.some((p) => JSON.parse(p).sessionId === id)).toBe(true);
  });

  it("un DB che fallisce non lancia da nessun metodo", async () => {
    const broken = {
      insert: () => { throw new Error("db down"); },
      update: () => { throw new Error("db down"); },
      execute: () => { throw new Error("db down"); },
    } as never;
    const sink = createSegmentSink(broken, { sessionId: "s", label: "execute" }, "g", true, { flushMs: 5, log: () => undefined });
    expect(() => sink.onStart([])).not.toThrow();
    expect(() => sink.onEvents([{ type: "assistant_text", data: {} }])).not.toThrow();
    expect(() => sink.onPartial("x")).not.toThrow();
    await expect(sink.onEnd({ exitCode: 0, timedOut: false })).resolves.toBeUndefined();
  });
});

describe("pruneAgentSessions", () => {
  it("cancella le sessioni ferme da più di 14 giorni e i loro eventi, tiene le recenti", async () => {
    const oldId = (await ensureAgentSession(t.db, { ownerKey: "old", kind: "ai_job", title: "t" }))!;
    const newId = (await ensureAgentSession(t.db, { ownerKey: "new", kind: "ai_job", title: "t" }))!;
    await t.db
      .update(agentSessions)
      .set({ startedAt: sql`now() - interval '20 days'`, lastEventAt: sql`now() - interval '15 days'` })
      .where(eq(agentSessions.id, oldId));
    const deleted = await pruneAgentSessions(t.db);
    expect(deleted).toBeGreaterThanOrEqual(1);
    const ids = (await t.db.select({ id: agentSessions.id }).from(agentSessions)).map((r) => r.id);
    expect(ids).toContain(newId);
    expect(ids).not.toContain(oldId);
  });
});
```

- [ ] **Step 2: verifica che fallisca**

Run: `pnpm --filter @stubwise/worker test -- sessions/store`
Expected: FAIL.

- [ ] **Step 3: implementa**

```ts
// apps/worker/src/sessions/store.ts
import { and, eq, lt, sql } from "drizzle-orm";
import { agentSessionEvents, agentSessions, type Db } from "@stubwise/db";
import type { AgentSessionKind } from "@stubwise/shared";
import type { AgentRunSession } from "../agent/runner.js";
import type { SegmentSink } from "../agent/streaming-cli.js";
import type { SessionEventDraft } from "./stream-parser.js";

/**
 * Persistenza delle sessioni (design §5.3–5.4). TUTTO fail-open: ogni errore
 * si logga e si ingoia, perché guardare è un di più e non deve mai far
 * fallire un fix.
 */

export const AGENT_EVENTS_CHANNEL = "agent_session_events";
export const AGENT_PARTIAL_CHANNEL = "agent_session_partial";
export const AGENT_SESSION_RETENTION_DAYS = 14;
/** Il payload di NOTIFY è limitato a 8000 byte: il testo parziale sta sotto. */
const MAX_PARTIAL_NOTIFY_CHARS = 3000;

export interface EnsureSessionInput {
  ownerKey: string;
  kind: AgentSessionKind;
  title: string;
  projectId?: string | null;
  ticketId?: string | null;
  aiJobId?: string | null;
  backlogItemId?: string | null;
  mailboxOwnerUserId?: string | null;
}

const warn = (msg: string) => console.warn(msg);
const describeError = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function ensureAgentSession(
  db: Db,
  input: EnsureSessionInput,
  log: (m: string) => void = warn,
): Promise<string | null> {
  try {
    const [row] = await db
      .insert(agentSessions)
      .values({
        ownerKey: input.ownerKey,
        kind: input.kind,
        title: input.title,
        projectId: input.projectId ?? null,
        ticketId: input.ticketId ?? null,
        aiJobId: input.aiJobId ?? null,
        backlogItemId: input.backlogItemId ?? null,
        mailboxOwnerUserId: input.mailboxOwnerUserId ?? null,
      })
      .onConflictDoUpdate({ target: agentSessions.ownerKey, set: { title: input.title } })
      .returning({ id: agentSessions.id });
    return row?.id ?? null;
  } catch (error) {
    log(`sessione ${input.ownerKey}: creazione fallita: ${describeError(error)}`);
    return null;
  }
}

export function createSegmentSink(
  db: Db,
  session: AgentRunSession,
  segmentId: string,
  interactive: boolean,
  opts: { flushMs?: number; heartbeatMs?: number; log?: (m: string) => void } = {},
): SegmentSink {
  const log = opts.log ?? warn;
  const flushMs = opts.flushMs ?? 200;
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  let queue: SessionEventDraft[] = [{ type: "segment_start", data: { label: session.label, interactive } }];
  let partial = "";
  let flushTimer: NodeJS.Timeout | null = null;
  let chain: Promise<void> = Promise.resolve();

  const run = (what: string, fn: () => Promise<unknown>) => {
    chain = chain.then(async () => {
      try {
        await fn();
      } catch (error) {
        log(`sessione ${session.sessionId}: ${what} fallito: ${describeError(error)}`);
      }
    });
  };

  const flush = () => {
    flushTimer = null;
    const batch = queue;
    queue = [];
    const text = partial;
    partial = "";
    if (batch.length > 0) {
      run("scrittura eventi", async () => {
        await db.insert(agentSessionEvents).values(
          batch.map((e) => ({ sessionId: session.sessionId, segmentId, type: e.type, data: e.data })),
        );
        await db
          .update(agentSessions)
          .set({ lastEventAt: sql`now()`, heartbeatAt: sql`now()` })
          .where(eq(agentSessions.id, session.sessionId));
        await db.execute(
          sql`select pg_notify(${AGENT_EVENTS_CHANNEL}, ${JSON.stringify({ sessionId: session.sessionId })})`,
        );
      });
    }
    if (text !== "") {
      run("notifica parziale", () =>
        db.execute(
          sql`select pg_notify(${AGENT_PARTIAL_CHANNEL}, ${JSON.stringify({
            sessionId: session.sessionId,
            segmentId,
            text: text.slice(-MAX_PARTIAL_NOTIFY_CHARS),
          })})`,
        ),
      );
    }
  };
  const schedule = () => {
    if (flushTimer === null) flushTimer = setTimeout(flush, flushMs);
  };

  const heartbeat = setInterval(() => {
    run("heartbeat", () =>
      db.update(agentSessions).set({ heartbeatAt: sql`now()` }).where(eq(agentSessions.id, session.sessionId)),
    );
  }, heartbeatMs);
  heartbeat.unref();

  return {
    onStart(capabilities) {
      run("apertura segmento", () =>
        db
          .update(agentSessions)
          .set({
            activeSegmentId: segmentId,
            activeSegmentLabel: session.label,
            activeSegmentInteractive: interactive,
            capabilities,
            heartbeatAt: sql`now()`,
          })
          .where(eq(agentSessions.id, session.sessionId)),
      );
      schedule();
    },
    onEvents(events) {
      queue.push(...events);
      schedule();
    },
    onPartial(text) {
      partial += text;
      schedule();
    },
    async onEnd(info) {
      clearInterval(heartbeat);
      if (flushTimer !== null) clearTimeout(flushTimer);
      queue.push({ type: "segment_end", data: { exitCode: info.exitCode, timedOut: info.timedOut } });
      flush();
      run("chiusura segmento", () =>
        db
          .update(agentSessions)
          .set({ activeSegmentId: null, activeSegmentLabel: null, activeSegmentInteractive: false })
          .where(
            and(eq(agentSessions.id, session.sessionId), eq(agentSessions.activeSegmentId, segmentId)),
          ),
      );
      await chain;
    },
  };
}

/** Pota sessioni (ed eventi/input in cascata) senza attività da 14 giorni. */
export async function pruneAgentSessions(db: Db, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - AGENT_SESSION_RETENTION_DAYS * 86_400_000);
  const deleted = await db
    .delete(agentSessions)
    .where(lt(sql`coalesce(${agentSessions.lastEventAt}, ${agentSessions.startedAt})`, cutoff))
    .returning({ id: agentSessions.id });
  return deleted.length;
}
```

Attenzione: il test «un DB che fallisce» passa un oggetto senza `delete`; `onEnd` non lo chiama. Se `chain` resta in sospeso nel test, controlla che ogni `run` catturi anche gli errori sincroni (`fn()` dentro il `try`: già così).

- [ ] **Step 4: test e commit**

Run: `pnpm --filter @stubwise/worker test -- sessions/store`
Expected: PASS.

```bash
git add apps/worker/src/sessions/store*
git commit -m "feat(worker): registrazione fail-open degli eventi di sessione"
```

---

### Task 7: `SessionInputRelay`, prune nel tick, cablaggio in `index.ts`, `AGENT_STREAMING`

**Files:**
- Create: `apps/worker/src/sessions/relay.ts`
- Modify: `apps/worker/src/config.ts` (env `AGENT_STREAMING`)
- Modify: `apps/worker/src/index.ts:143-149` (scelta del runner, relay)
- Modify: `apps/worker/src/queue.ts` (prune nel blocco `nextRequeueAt`, override in `_internals`)
- Modify: `packages/i18n/src/catalog.ts` (`comment.agentIntervention` en/it)
- Test: `apps/worker/src/sessions/relay.test.ts`

**Interfaces:**
- Consumes: Task 5 (`SessionHooks`, `LiveProcessHandle`), Task 6 (`createSegmentSink`, `pruneAgentSessions`).
- Produces:
  ```ts
  export const AGENT_INPUT_CHANNEL = "agent_session_input";
  export class SessionInputRelay implements SessionHooks {
    constructor(deps: { db: Db; listen?: (channel: string, cb: (payload: string) => void) => Promise<unknown>; pollMs?: number; log?: (m: string) => void });
    start(): Promise<void>;
    stop(): void;
    openSegment(...): SegmentSink;      // delega a createSegmentSink
    register(sessionId, handle): () => void;
    deliverPending(sessionId?: string): Promise<void>;  // esposto per i test
  }
  ```

- [ ] **Step 1: catalogo i18n**

In `packages/i18n/src/catalog.ts`, vicino alle altre chiavi `comment.*`:

```ts
// en
"comment.agentIntervention": "Written to the agent while it was working ({segment}):\n\n{text}",
"agentSegment.plan": "planning",
"agentSegment.plan_resume": "planning",
"agentSegment.execute": "fix execution",
"agentSegment.self_repair": "self-repair",
"agentSegment.correction": "correction",
"agentSegment.correction_self_repair": "correction",
"agentSegment.review": "PR review",
"agentSegment.deep_dive": "deep dive",
"agentSegment.chat_turn": "backlog chat",
"agentSegment.docs": "documentation",
// it
"comment.agentIntervention": "Scritto all'agente mentre lavorava ({segment}):\n\n{text}",
"agentSegment.plan": "pianificazione",
"agentSegment.plan_resume": "pianificazione",
"agentSegment.execute": "esecuzione del fix",
"agentSegment.self_repair": "auto-riparazione",
"agentSegment.correction": "correzione",
"agentSegment.correction_self_repair": "correzione",
"agentSegment.review": "review della PR",
"agentSegment.deep_dive": "deep dive",
"agentSegment.chat_turn": "chat del backlog",
"agentSegment.docs": "documentazione",
```

Run: `pnpm --filter @stubwise/i18n test && pnpm --filter @stubwise/i18n build` (il test di parità en/it deve restare verde).

- [ ] **Step 2: test del relay**

```ts
// apps/worker/src/sessions/relay.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startTestDb, type TestDb, seedTicket } from "@stubwise/db/testing";
import { agentSessionInputs, comments, users } from "@stubwise/db";
import { SessionInputRelay } from "./relay.js";
import { ensureAgentSession } from "./store.js";

let t: TestDb;
let userId: string;
let ticketId: string;
beforeAll(async () => {
  t = await startTestDb();
  const [u] = await t.db
    .insert(users)
    .values({ email: "m@x.test", name: "Mara", passwordHash: "x", role: "admin" })
    .returning();
  userId = u!.id;
  ticketId = (await seedTicket(t.db)).id;
}, 120_000);
afterAll(async () => t.stop());

async function newSession(owner: string) {
  return (await ensureAgentSession(t.db, { ownerKey: owner, kind: "ai_job", title: "t", ticketId }))!;
}
async function addInput(sessionId: string, text: string) {
  const [row] = await t.db.insert(agentSessionInputs).values({ sessionId, text, authorUserId: userId }).returning();
  return row!.id;
}
const statusOf = async (id: string) =>
  (await t.db.select().from(agentSessionInputs).where(eq(agentSessionInputs.id, id)))[0]!;

describe("SessionInputRelay", () => {
  let relay: SessionInputRelay;
  beforeEach(() => {
    relay = new SessionInputRelay({ db: t.db, pollMs: 60_000, log: () => undefined });
  });

  it("consegna un input pending al processo registrato, lo marca delivered e scrive il commento sul ticket", async () => {
    const sessionId = await newSession("ai_job:relay-1");
    const got: Array<[string, boolean]> = [];
    relay.register(sessionId, { deliver: (text, i) => (got.push([text, i]), true) });
    const id = await addInput(sessionId, "guarda anche X");
    await relay.deliverPending(sessionId);
    expect(got).toEqual([["guarda anche X", false]]);
    const row = await statusOf(id);
    expect(row.status).toBe("delivered");
    const c = await t.db.select().from(comments).where(eq(comments.ticketId, ticketId));
    expect(c.some((x) => x.body.includes("guarda anche X") && x.authorId === userId && x.authorType === "user")).toBe(true);
  });

  it("nessun processo registrato → undelivered con reason, niente commento", async () => {
    const sessionId = await newSession("ai_job:relay-2");
    const before = (await t.db.select().from(comments)).length;
    const id = await addInput(sessionId, "orfano");
    await relay.deliverPending(sessionId);
    const row = await statusOf(id);
    expect(row.status).toBe("undelivered");
    expect(row.reason).toBe("session_not_live");
    expect((await t.db.select().from(comments)).length).toBe(before);
  });

  it("deliver che restituisce false (stdin chiuso) → undelivered", async () => {
    const sessionId = await newSession("ai_job:relay-3");
    relay.register(sessionId, { deliver: () => false });
    const id = await addInput(sessionId, "tardi");
    await relay.deliverPending(sessionId);
    expect((await statusOf(id)).reason).toBe("stdin_closed");
  });

  it("dopo la deregistrazione il processo non riceve più niente", async () => {
    const sessionId = await newSession("ai_job:relay-4");
    const got: string[] = [];
    const off = relay.register(sessionId, { deliver: (text) => (got.push(text), true) });
    off();
    await addInput(sessionId, "dopo");
    await relay.deliverPending(sessionId);
    expect(got).toEqual([]);
  });
});
```

Se `users` richiede altre colonne NOT NULL, usa l'helper di seed degli utenti del worker (cerca `insert(users)` in `apps/worker/src/**/*.test.ts` e copia i valori).

- [ ] **Step 3: verifica che fallisca**

Run: `pnpm --filter @stubwise/worker test -- sessions/relay`
Expected: FAIL.

- [ ] **Step 4: implementa il relay**

```ts
// apps/worker/src/sessions/relay.ts
import { and, eq, sql } from "drizzle-orm";
import { agentSessionInputs, agentSessions, comments, type Db } from "@stubwise/db";
import { t } from "@stubwise/i18n";
import type { AgentRunSession } from "../agent/runner.js";
import type { LiveProcessHandle, SegmentSink, SessionHooks } from "../agent/streaming-cli.js";
import { getContentLanguage } from "../settings.js";
import { createSegmentSink } from "./store.js";

/**
 * Consegna degli interventi (design §6.2). Il worker è UN processo: questo
 * registro in memoria è l'unico che tiene gli stdin vivi — stessa assunzione
 * del serializer di progetto e di requeueWaitingReviews; va rivista con loro
 * il giorno in cui il worker diventasse multi-processo.
 *
 * Due vie di sveglia: LISTEN sul canale (subito) e un poll di rete
 * (`pollMs`), perché una connessione LISTEN caduta perde le notifiche.
 */

export const AGENT_INPUT_CHANNEL = "agent_session_input";

type Reason = "session_not_live" | "stdin_closed";

export class SessionInputRelay implements SessionHooks {
  private readonly live = new Map<string, LiveProcessHandle>();
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly log: (m: string) => void;

  constructor(
    private readonly deps: {
      db: Db;
      listen?: (channel: string, cb: (payload: string) => void) => Promise<unknown>;
      pollMs?: number;
      log?: (m: string) => void;
    },
  ) {
    this.log = deps.log ?? ((m) => console.warn(m));
  }

  async start(): Promise<void> {
    if (this.deps.listen) {
      try {
        await this.deps.listen(AGENT_INPUT_CHANNEL, (payload) => {
          try {
            const { sessionId } = JSON.parse(payload) as { sessionId?: string };
            void this.deliverPending(sessionId);
          } catch {
            void this.deliverPending();
          }
        });
      } catch (error) {
        this.log(`relay: LISTEN fallito, resta il poll: ${String(error)}`);
      }
    }
    this.pollTimer = setInterval(() => void this.deliverPending(), this.deps.pollMs ?? 3000);
    this.pollTimer.unref();
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  openSegment(session: AgentRunSession, segmentId: string, interactive: boolean): SegmentSink {
    return createSegmentSink(this.deps.db, session, segmentId, interactive, { log: this.log });
  }

  register(sessionId: string, handle: LiveProcessHandle): () => void {
    this.live.set(sessionId, handle);
    void this.deliverPending(sessionId);
    return () => {
      if (this.live.get(sessionId) === handle) this.live.delete(sessionId);
      // Ciò che resta in coda per questa sessione non avrà più un processo.
      void this.deliverPending(sessionId);
    };
  }

  /** Consegna (o marca undelivered) gli input pending. Fail-open. */
  async deliverPending(sessionId?: string): Promise<void> {
    try {
      const pending = await this.deps.db
        .select()
        .from(agentSessionInputs)
        .where(
          sessionId
            ? and(eq(agentSessionInputs.status, "pending"), eq(agentSessionInputs.sessionId, sessionId))
            : eq(agentSessionInputs.status, "pending"),
        )
        .orderBy(agentSessionInputs.createdAt);
      for (const input of pending) {
        const handle = this.live.get(input.sessionId);
        if (!handle) {
          await this.markUndelivered(input.id, "session_not_live");
          continue;
        }
        if (!handle.deliver(input.text, input.interrupt)) {
          await this.markUndelivered(input.id, "stdin_closed");
          continue;
        }
        await this.markDelivered(input);
      }
    } catch (error) {
      this.log(`relay: consegna fallita: ${String(error)}`);
    }
  }

  private async markUndelivered(id: string, reason: Reason): Promise<void> {
    await this.deps.db
      .update(agentSessionInputs)
      .set({ status: "undelivered", reason })
      .where(and(eq(agentSessionInputs.id, id), eq(agentSessionInputs.status, "pending")));
  }

  private async markDelivered(input: typeof agentSessionInputs.$inferSelect): Promise<void> {
    const db = this.deps.db;
    const lang = await getContentLanguage(db);
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(agentSessionInputs)
        .set({ status: "delivered", deliveredAt: sql`now()` })
        .where(and(eq(agentSessionInputs.id, input.id), eq(agentSessionInputs.status, "pending")))
        .returning({ id: agentSessionInputs.id });
      if (updated.length === 0) return;
      const [session] = await tx
        .select({ ticketId: agentSessions.ticketId, label: agentSessions.activeSegmentLabel })
        .from(agentSessions)
        .where(eq(agentSessions.id, input.sessionId));
      if (!session?.ticketId) return;
      await tx.insert(comments).values({
        ticketId: session.ticketId,
        authorType: "user",
        authorId: input.authorUserId,
        body: t(lang, "comment.agentIntervention", {
          segment: t(lang, `agentSegment.${session.label ?? "execute"}`),
          text: input.text,
        }),
      });
    });
  }
}
```

- [ ] **Step 5: config e cablaggio**

In `apps/worker/src/config.ts`, accanto a `FIX_TWO_PHASE` (stesso pattern):

```ts
  AGENT_STREAMING: z.preprocess(
    (value) => (value === "" ? undefined : value === "true" ? true : value === "false" ? false : value),
    z.boolean({ error: "deve essere true o false" }).default(true),
  ),
```

campo `agentStreaming: boolean;` in `WorkerConfig` e `agentStreaming: parsed.AGENT_STREAMING,` in `loadWorkerConfig`.

In `apps/worker/src/index.ts`, al posto di `const runner = new ClaudeCliRunner();`:

```ts
  // Sessioni degli agenti (design 2026-10-08): in streaming il runner registra
  // gli eventi e accetta gli interventi. AGENT_STREAMING=false è il rollback:
  // argv e parsing storici, nessuna sessione.
  const relay = config.agentStreaming
    ? new SessionInputRelay({ db, listen: (channel, cb) => client.listen(channel, cb) })
    : null;
  if (relay) await relay.start();
  const runner: AgentRunner = relay
    ? new StreamingClaudeRunner({ hooks: relay })
    : new ClaudeCliRunner();
```

e `relay?.stop()` nello shutdown, accanto agli altri `stop`.

In `apps/worker/src/queue.ts`, nel blocco `if (Date.now() >= nextRequeueAt)` dopo `promoteStalePendings`, con la stessa forma di try/catch e un override in `_internals`:

```ts
      try {
        const pruned = await internals.pruneAgentSessions(db);
        if (pruned > 0) log(`sessioni degli agenti potate: ${pruned}`);
      } catch (error) {
        log(`potatura delle sessioni fallita: ${String(error)}`);
      }
```

- [ ] **Step 6: test e commit**

Run: `pnpm --filter @stubwise/worker test -- sessions config queue && pnpm --filter @stubwise/worker typecheck`
Expected: PASS.

```bash
git add apps/worker packages/i18n
git commit -m "feat(worker): consegna degli interventi e AGENT_STREAMING"
```

---

### Task 8: Cablaggio delle sessioni nei run del fix, della correzione e della review

**Files:**
- Create: `apps/worker/src/sessions/owners.ts`
- Modify: `apps/worker/src/pipeline/fix.ts` (call site :1137, :1198, :1336, :1384; riassunto :1598)
- Modify: `apps/worker/src/pipeline/triage.ts` (:244; riassunto fallimento :182)
- Modify: `apps/worker/src/pipeline/job-outcomes.ts` (:72)
- Modify: `apps/worker/src/pipeline/correction.ts` (:1044, :1073)
- Modify: `apps/worker/src/review/run-review.ts` (:771, riassunto :846)
- Modify: `apps/worker/src/agent/text.ts` (`RunAgentTextOptions.session?`)
- Test: `apps/worker/src/sessions/owners.test.ts`, più un caso in `apps/worker/src/pipeline/fix.test.ts`

**Interfaces:**
- Consumes: Task 6 `ensureAgentSession`.
- Produces:
  ```ts
  export async function aiJobSession(db: Db, job: { id: string; ticketId: string }, label: AgentSegmentLabel, secrets?: string[]): Promise<AgentRunSession | undefined>;
  export async function prReviewSession(db: Db, review: { id: string; projectId: string | null; prNumber: number; repositoryName: string }, label: AgentSegmentLabel): Promise<AgentRunSession | undefined>;
  ```
  Restituiscono `undefined` se la sessione non si crea (fail-open: il run parte senza sessione).

- [ ] **Step 1: test di `owners.ts`**

```ts
// apps/worker/src/sessions/owners.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startTestDb, type TestDb, seedTicket } from "@stubwise/db/testing";
import { agentSessions, aiJobs } from "@stubwise/db";
import { aiJobSession } from "./owners.js";

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => t.stop());

describe("aiJobSession", () => {
  it("una sola sessione per job, col ticket e il progetto, titolo «#N titolo»", async () => {
    const ticket = await seedTicket(t.db);
    const [job] = await t.db.insert(aiJobs).values({ ticketId: ticket.id }).returning();
    const a = await aiJobSession(t.db, { id: job!.id, ticketId: ticket.id }, "plan");
    const b = await aiJobSession(t.db, { id: job!.id, ticketId: ticket.id }, "execute", ["s3cr3t-value"]);
    expect(a!.sessionId).toBe(b!.sessionId);
    expect(b!.label).toBe("execute");
    expect(b!.secrets).toEqual(["s3cr3t-value"]);
    const [row] = await t.db.select().from(agentSessions).where(eq(agentSessions.id, a!.sessionId));
    expect(row!.ticketId).toBe(ticket.id);
    expect(row!.aiJobId).toBe(job!.id);
    expect(row!.title).toBe(`#${ticket.number} ${ticket.title}`);
  });
});
```

(Usa i campi che `seedTicket` restituisce davvero: controlla la sua firma in `packages/db/src/testing.ts`.)

- [ ] **Step 2: implementa `owners.ts`**

```ts
// apps/worker/src/sessions/owners.ts
import { eq } from "drizzle-orm";
import { tickets, type Db } from "@stubwise/db";
import type { AgentSegmentLabel } from "@stubwise/shared";
import type { AgentRunSession } from "../agent/runner.js";
import { ensureAgentSession } from "./store.js";

/**
 * Una funzione per proprietario: costruiscono l'owner_key e il titolo in UN
 * posto, così due call site dello stesso job non creano due sessioni.
 */

export async function aiJobSession(
  db: Db,
  job: { id: string; ticketId: string },
  label: AgentSegmentLabel,
  secrets?: string[],
): Promise<AgentRunSession | undefined> {
  try {
    const [ticket] = await db
      .select({ number: tickets.number, title: tickets.title, projectId: tickets.projectId })
      .from(tickets)
      .where(eq(tickets.id, job.ticketId));
    const sessionId = await ensureAgentSession(db, {
      ownerKey: `ai_job:${job.id}`,
      kind: "ai_job",
      title: ticket ? `#${ticket.number} ${ticket.title}` : "Job",
      projectId: ticket?.projectId ?? null,
      ticketId: job.ticketId,
      aiJobId: job.id,
    });
    return sessionId ? { sessionId, label, ...(secrets ? { secrets } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

export async function prReviewSession(
  db: Db,
  review: { id: string; projectId: string | null; prNumber: number; repositoryName: string },
  label: AgentSegmentLabel,
): Promise<AgentRunSession | undefined> {
  const sessionId = await ensureAgentSession(db, {
    ownerKey: `pr_review:${review.id}`,
    kind: "pr_review",
    title: `${review.repositoryName} #${review.prNumber}`,
    projectId: review.projectId,
  });
  return sessionId ? { sessionId, label } : undefined;
}
```

(Verifica i nomi delle colonne di `tickets`: `number`, `title`, `projectId`.)

- [ ] **Step 3: `runAgentText` accetta la sessione**

In `apps/worker/src/agent/text.ts`, aggiungi a `RunAgentTextOptions`:

```ts
  /** Sessione a cui appartiene il run (vedi AgentRunSession). */
  session?: AgentRunSession;
```

e nella chiamata a `runner.run`: `...(opts.session !== undefined ? { session: opts.session } : {}),`.

- [ ] **Step 4: passa la sessione ai call site**

Per ogni call site, subito prima di `runner.run(...)`/`runAgentText(...)`, calcola la sessione e aggiungi `session` alle opzioni. La forma è sempre questa:

```ts
const session = await aiJobSession(deps.db, { id: job.id, ticketId: job.ticketId }, "execute", secrets);
const result = await deps.runner.run({
  // …opzioni esistenti invariate…
  ...(session ? { session } : {}),
});
```

| File:riga | label | secrets |
|---|---|---|
| `pipeline/triage.ts:244` | `triage` | — |
| `pipeline/fix.ts:1137` (`runPlanResume`) | `plan_resume` | — |
| `pipeline/fix.ts:1198` (`runPlanPhase`) | `plan` | — |
| `pipeline/fix.ts:1336` (esecuzione) | `execute` | `Object.values(state.envProcessEnv ?? {})` |
| `pipeline/fix.ts:1384` (self-repair) | `self_repair` | idem |
| `pipeline/fix.ts:1598` (riassunto del piano, `runAgentText`) | `plan_summary` | — |
| `pipeline/triage.ts:182` e `pipeline/job-outcomes.ts:72` (riassunto fallimento) | `failure_summary` | — |
| `pipeline/correction.ts:1044` | `correction` | env della correzione (`envProcessEnv` dello stato di `materializeEnvAndInstall`) |
| `pipeline/correction.ts:1073` | `correction_self_repair` | idem |
| `review/run-review.ts:771` | `review` (via `prReviewSession`) | — |
| `review/run-review.ts:846` (riassunto PR) | `pr_summary` (via `prReviewSession`) | — |

`state.envProcessEnv` è scritto da `materializeEnvAndInstall` (`pipeline/repo-steps.ts:228`): controlla il nome del campo di stato in quel file e usa lo stesso.

- [ ] **Step 5: test d'integrazione sul fix**

In `apps/worker/src/pipeline/fix.test.ts` aggiungi un caso che usa il `FakeAgentRunner` esistente e verifica che ogni chiamata registrata del fix abbia `session.sessionId` uguale e le label `plan` poi `execute` (adatta al setup già presente nel file, cercando un test che esegue il flusso a due fasi):

```ts
it("tutti i run di un job condividono una sessione, con la label della fase", async () => {
  // …setup come il test del flusso a due fasi già presente…
  const sessions = fake.calls.map((c) => c.session).filter(Boolean);
  expect(new Set(sessions.map((s) => s!.sessionId)).size).toBe(1);
  expect(sessions.map((s) => s!.label)).toEqual(expect.arrayContaining(["plan", "execute"]));
});
```

- [ ] **Step 6: test, typecheck, commit**

Run: `pnpm --filter @stubwise/worker test -- owners fix correction run-review triage && pnpm --filter @stubwise/worker typecheck`
Expected: PASS.

```bash
git add apps/worker/src
git commit -m "feat(worker): i run di fix, correzione e review scrivono nella loro sessione"
```

---

### Task 9: Cablaggio nei run di backlog, posta, Docs, brief e report

**Files:**
- Modify: `apps/worker/src/sessions/owners.ts` (quattro funzioni nuove)
- Modify: `apps/worker/src/backlog/deep-dive.ts:312`, `backlog/chat-turn.ts:487`, `backlog/estimate.ts:80`, `backlog/intake.ts:144,201`
- Modify: `apps/worker/src/google/classify.ts:1589,1749`
- Modify: `apps/worker/src/docs/recursive/orient-handler.ts:354,415`, `explore-handler.ts:160`, `synthesize-handler.ts:119`, `product-handler.ts:288,328`, `docs/auto-update.ts:405,602,719,770,1124`
- Modify: `apps/worker/src/briefs/poller.ts:386`, `reports/daily-report-poller.ts:528,569`
- Test: `apps/worker/src/sessions/owners.test.ts` (estendi)

**Interfaces:**
- Produces:
  ```ts
  export async function backlogItemSession(db: Db, item: { id: string; projectId: string; title: string }, label: AgentSegmentLabel): Promise<AgentRunSession | undefined>;
  export async function backlogJobSession(db: Db, job: { id: string; projectId: string }, label: AgentSegmentLabel): Promise<AgentRunSession | undefined>;
  export async function emailMessageSession(db: Db, message: { id: string; accountId: string; subject: string | null }): Promise<AgentRunSession | undefined>;
  export async function docGenerationSession(db: Db, generation: { id: string; projectId: string | null; title: string }): Promise<AgentRunSession | undefined>;
  export async function projectBriefSession(db: Db, brief: { id: string; projectId: string }): Promise<AgentRunSession | undefined>;
  export async function dailyReportSession(db: Db, project: { id: string; name: string }, day: string): Promise<AgentRunSession | undefined>;
  ```

- [ ] **Step 1: test della posta (la proprietà che conta)**

```ts
it("la sessione di un messaggio ha come unico lettore il proprietario della casella", async () => {
  // seed: utente + google_account (user_id = utente) + email_message su quell'account;
  // copia il setup da apps/worker/src/google/classify.test.ts.
  const s = await emailMessageSession(t.db, { id: messageId, accountId, subject: "Fattura" });
  const [row] = await t.db.select().from(agentSessions).where(eq(agentSessions.id, s!.sessionId));
  expect(row!.kind).toBe("email_message");
  expect(row!.mailboxOwnerUserId).toBe(ownerUserId);
  expect(s!.label).toBe("email_classify");
});
```

- [ ] **Step 2: implementa le funzioni**

```ts
export async function backlogItemSession(
  db: Db,
  item: { id: string; projectId: string; title: string },
  label: AgentSegmentLabel,
): Promise<AgentRunSession | undefined> {
  const sessionId = await ensureAgentSession(db, {
    ownerKey: `backlog_item:${item.id}`,
    kind: "backlog_item",
    title: item.title,
    projectId: item.projectId,
    backlogItemId: item.id,
  });
  return sessionId ? { sessionId, label } : undefined;
}

export async function backlogJobSession(
  db: Db,
  job: { id: string; projectId: string },
  label: AgentSegmentLabel,
): Promise<AgentRunSession | undefined> {
  const sessionId = await ensureAgentSession(db, {
    ownerKey: `backlog_job:${job.id}`,
    kind: "backlog_job",
    title: label === "intake" ? "Intake" : "Backlog",
    projectId: job.projectId,
  });
  return sessionId ? { sessionId, label } : undefined;
}

export async function emailMessageSession(
  db: Db,
  message: { id: string; accountId: string; subject: string | null },
): Promise<AgentRunSession | undefined> {
  try {
    const [account] = await db
      .select({ userId: googleAccounts.userId })
      .from(googleAccounts)
      .where(eq(googleAccounts.id, message.accountId));
    // Senza proprietario risolto NON si crea la sessione: una sessione di
    // posta senza mailbox_owner sarebbe visibile a tutti (spec §5.6).
    if (!account) return undefined;
    const sessionId = await ensureAgentSession(db, {
      ownerKey: `email_message:${message.id}`,
      kind: "email_message",
      title: message.subject ?? "(senza oggetto)",
      mailboxOwnerUserId: account.userId,
    });
    return sessionId ? { sessionId, label: "email_classify" } : undefined;
  } catch {
    return undefined;
  }
}

export async function docGenerationSession(
  db: Db,
  generation: { id: string; projectId: string | null; title: string },
): Promise<AgentRunSession | undefined> {
  const sessionId = await ensureAgentSession(db, {
    ownerKey: `doc_generation:${generation.id}`,
    kind: "doc_generation",
    title: generation.title,
    projectId: generation.projectId,
  });
  return sessionId ? { sessionId, label: "docs" } : undefined;
}

export async function projectBriefSession(
  db: Db,
  brief: { id: string; projectId: string },
): Promise<AgentRunSession | undefined> {
  const sessionId = await ensureAgentSession(db, {
    ownerKey: `project_brief:${brief.id}`,
    kind: "project_brief",
    title: "Brief settimanale",
    projectId: brief.projectId,
  });
  return sessionId ? { sessionId, label: "brief" } : undefined;
}

export async function dailyReportSession(
  db: Db,
  project: { id: string; name: string },
  day: string,
): Promise<AgentRunSession | undefined> {
  const sessionId = await ensureAgentSession(db, {
    ownerKey: `daily_report:${project.id}:${day}`,
    kind: "daily_report",
    title: `Report ${day} · ${project.name}`,
    projectId: project.id,
  });
  return sessionId ? { sessionId, label: "daily_report" } : undefined;
}
```

- [ ] **Step 3: call site**

Stessa forma del Task 8 (`...(session ? { session } : {})` nelle opzioni):

| File:riga | funzione | label |
|---|---|---|
| `backlog/deep-dive.ts:312` | `backlogItemSession(item)` | `deep_dive` |
| `backlog/chat-turn.ts:487` | `backlogItemSession(item)` | `chat_turn` |
| `backlog/estimate.ts:80` | `backlogItemSession(item)` | `estimate` |
| `backlog/intake.ts:144` (merge) | `backlogItemSession(item di destinazione)` | `intake` |
| `backlog/intake.ts:201` (voce nuova) | `backlogJobSession(job)` | `intake` |
| `google/classify.ts:1589`, `:1749` | `emailMessageSession(message)` | `email_classify` |
| tutti i run Docs elencati sopra | `docGenerationSession(generation)` | `docs` |
| `briefs/poller.ts:386` | `projectBriefSession(brief)` | `brief` |
| `reports/daily-report-poller.ts:528,569` | `dailyReportSession(project, day)` | `daily_report` |

`rollupDevSummaries` (`reports/daily-report-poller.ts:761`), il credential test, lo smoke dei plugin e l'usage poller restano **senza** sessione: non sono lavoro di un progetto. La generazione Docs: tutti i nodi di una generazione vanno nella stessa sessione (anche quando girano in parallelo; l'ordine degli eventi è per `id`, e ogni nodo ha il suo `segmentId`).

- [ ] **Step 4: test, typecheck, commit**

Run: `pnpm --filter @stubwise/worker test && pnpm --filter @stubwise/worker typecheck`
Expected: PASS (l'intera suite: i doppi `FakeAgentRunner` ignorano `session`).

```bash
git add apps/worker/src
git commit -m "feat(worker): sessioni per backlog, posta, Docs, brief e report"
```

---

### Task 10: Servizio e rotte di lettura sul server

**Files:**
- Create: `apps/server/src/services/agent-sessions.ts`
- Create: `apps/server/src/routes/agent-sessions.ts`
- Modify: `apps/server/src/app.ts` (registrazione con prefisso `/api/agent-sessions`)
- Test: `apps/server/src/routes/agent-sessions.test.ts`

**Interfaces:**
- Consumes: Task 1 schemi, Task 2 tabelle, `Actor` da `services/jobs.ts`, `describeAgentActivity`.
- Produces:
  ```ts
  export const LIVE_HEARTBEAT_SECONDS = 90;
  export async function listAgentSessions(db: Db, viewer: Actor): Promise<{ live: AgentSessionSummary[]; recent: AgentSessionSummary[] }>;
  export async function getAgentSession(db: Db, viewer: Actor, id: string): Promise<AgentSessionDetail | null>;
  export async function listAgentSessionEvents(db: Db, viewer: Actor, id: string, page: { after?: string; before?: string; limit: number }): Promise<{ events: AgentSessionEvent[]; before: string | null } | null>;
  export function visibleTo(viewer: Actor): SQL;   // la regola mailbox_owner
  ```
  Rotte: `GET /api/agent-sessions`, `GET /api/agent-sessions/:id`, `GET /api/agent-sessions/:id/events?after=&before=&limit=`.

- [ ] **Step 1: test delle rotte (visibilità prima di tutto)**

```ts
// apps/server/src/routes/agent-sessions.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, seedTicket } from "@stubwise/db/testing";
import { agentSessionEvents, agentSessions, aiJobs, users } from "@stubwise/db";
import { eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { seedUsers } from "../test/fixtures.js";

let t: TestDb;
let app: ReturnType<typeof buildApp>;
let u: Awaited<ReturnType<typeof seedUsers>>;
let mailSessionOfMember: string;
let jobSession: string;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(32) });
  u = await seedUsers(app);
  const ticket = await seedTicket(t.db);
  const [job] = await t.db.insert(aiJobs).values({ ticketId: ticket.id, status: "fixing" }).returning();
  const [s1] = await t.db
    .insert(agentSessions)
    .values({
      ownerKey: `ai_job:${job!.id}`, kind: "ai_job", title: "#1 fix", ticketId: ticket.id, aiJobId: job!.id,
      activeSegmentId: "seg", activeSegmentLabel: "execute", activeSegmentInteractive: true,
      capabilities: ["interrupt_receipt_v1"], heartbeatAt: new Date(),
    })
    .returning();
  jobSession = s1!.id;
  await t.db.insert(agentSessionEvents).values([
    { sessionId: jobSession, segmentId: "seg", type: "assistant_text", data: { text: "parola-unica-del-fix" } },
    { sessionId: jobSession, segmentId: "seg", type: "tool_use", data: { name: "Edit", input: { file_path: "a.ts" } } },
  ]);
  const [s2] = await t.db
    .insert(agentSessions)
    .values({ ownerKey: "email_message:m1", kind: "email_message", title: "Oggetto privato", mailboxOwnerUserId: u.memberId })
    .returning();
  mailSessionOfMember = s2!.id;
  await t.db.insert(agentSessionEvents).values({
    sessionId: mailSessionOfMember, segmentId: "s", type: "assistant_text", data: { text: "parola-solo-nella-posta" },
  });
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

const get = (url: string, cookie: string) => app.inject({ method: "GET", url, headers: { cookie } });

describe("GET /api/agent-sessions", () => {
  it("la sessione di un job vivo è fra le live, con stato working e ultima azione derivata", async () => {
    const res = await get("/api/agent-sessions", u.memberCookie);
    expect(res.statusCode).toBe(200);
    const live = res.json().live;
    const row = live.find((s: { id: string }) => s.id === jobSession);
    expect(row.state).toBe("working");
    expect(row.lastActivity).toEqual({ kind: "edit", target: "a.ts" });
  });

  it("la posta di un member NON compare a un admin, e compare al member", async () => {
    const asAdmin = (await get("/api/agent-sessions", u.adminCookie)).json();
    const ids = [...asAdmin.live, ...asAdmin.recent].map((s: { id: string }) => s.id);
    expect(ids).not.toContain(mailSessionOfMember);
    const asOwner = (await get("/api/agent-sessions", u.memberCookie)).json();
    expect([...asOwner.live, ...asOwner.recent].map((s: { id: string }) => s.id)).toContain(mailSessionOfMember);
  });
});

describe("GET /api/agent-sessions/:id e /events", () => {
  it("admin: 404 sul dettaglio e sugli eventi della posta altrui; il proprietario legge il testo", async () => {
    expect((await get(`/api/agent-sessions/${mailSessionOfMember}`, u.adminCookie)).statusCode).toBe(404);
    const evAdmin = await get(`/api/agent-sessions/${mailSessionOfMember}/events`, u.adminCookie);
    expect(evAdmin.statusCode).toBe(404);
    expect(evAdmin.body).not.toContain("parola-solo-nella-posta");
    const evOwner = await get(`/api/agent-sessions/${mailSessionOfMember}/events`, u.memberCookie);
    expect(evOwner.body).toContain("parola-solo-nella-posta");
  });

  it("stessi dati, due ruoli: canWrite vero per l'admin e falso per il member", async () => {
    const admin = (await get(`/api/agent-sessions/${jobSession}`, u.adminCookie)).json();
    const member = (await get(`/api/agent-sessions/${jobSession}`, u.memberCookie)).json();
    expect(admin.canWrite).toBe(true);
    expect(member.canWrite).toBe(false);
    expect(admin.canInterrupt).toBe(true);
  });

  it("heartbeat vecchio: la sessione è ended e nessuno può scrivere", async () => {
    await t.db
      .update(agentSessions)
      .set({ heartbeatAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(agentSessions.id, jobSession));
    const admin = (await get(`/api/agent-sessions/${jobSession}`, u.adminCookie)).json();
    expect(admin.state).not.toBe("working");
    expect(admin.canWrite).toBe(false);
    await t.db.update(agentSessions).set({ heartbeatAt: new Date() }).where(eq(agentSessions.id, jobSession));
  });

  it("eventi paginati in ordine, con cursore", async () => {
    const page = (await get(`/api/agent-sessions/${jobSession}/events?limit=1`, u.memberCookie)).json();
    expect(page.events).toHaveLength(1);
    expect(page.events[0].type).toBe("tool_use");
    expect(page.before).not.toBeNull();
    const older = (
      await get(`/api/agent-sessions/${jobSession}/events?limit=1&before=${page.before}`, u.memberCookie)
    ).json();
    expect(older.events[0].type).toBe("assistant_text");
  });

  it("id non uuid → 400, senza login → 401", async () => {
    expect((await get("/api/agent-sessions/nope", u.adminCookie)).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/agent-sessions" })).statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: verifica che fallisca**

Run: `pnpm --filter @stubwise/server test -- agent-sessions`
Expected: FAIL (404 sulle rotte).

- [ ] **Step 3: implementa il servizio**

```ts
// apps/server/src/services/agent-sessions.ts
import { and, desc, eq, gt, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import {
  agentQuestions,
  agentSessionEvents,
  agentSessions,
  aiJobs,
  backlogQuestions,
  projects,
  tickets,
  type Db,
} from "@stubwise/db";
import {
  describeAgentActivity,
  type AgentSessionDetail,
  type AgentSessionEvent,
  type AgentSessionState,
  type AgentSessionSummary,
} from "@stubwise/shared";
import type { Actor } from "./jobs.js";

/**
 * Lettura delle sessioni degli agenti (design 2026-10-08 §8). Stato, ultima
 * azione, canWrite e domande si DERIVANO a lettura: niente di tutto ciò è
 * scritto dal worker in una forma che invecchi.
 */

export const LIVE_HEARTBEAT_SECONDS = 90;
const RECENT_LIMIT = 50;

/**
 * Visibilità: una sessione di posta la vede SOLO il proprietario della
 * casella, nessun ramo per ruolo (invariante mailbox_owner).
 */
export function visibleTo(viewer: Actor): SQL {
  return or(
    isNull(agentSessions.mailboxOwnerUserId),
    eq(agentSessions.mailboxOwnerUserId, viewer.id),
  )!;
}

const liveSql = sql<boolean>`(${agentSessions.activeSegmentId} is not null and ${agentSessions.heartbeatAt} > now() - make_interval(secs => ${LIVE_HEARTBEAT_SECONDS}))`;

const stateSql = sql<AgentSessionState>`case
  when ${liveSql} then 'working'
  when ${aiJobs.status} = 'awaiting_input' then 'waiting_input'
  when ${agentSessions.backlogItemId} is not null and exists (
    select 1 from ${backlogQuestions}
    where ${backlogQuestions.backlogItemId} = ${agentSessions.backlogItemId}
      and ${backlogQuestions.answeredAt} is null and ${backlogQuestions.dismissedAt} is null
  ) then 'waiting_input'
  when ${aiJobs.status} = 'held' then 'held'
  else 'ended' end`;

const lastToolEvent = sql<{ type: string; data: Record<string, unknown> } | null>`(
  select json_build_object('type', e.type, 'data', e.data)
  from ${agentSessionEvents} e
  where e.session_id = ${agentSessions.id} and e.type in ('tool_use', 'assistant_text')
  order by e.id desc limit 1)`;

function baseSelect(db: Db) {
  return db
    .select({
      id: agentSessions.id,
      kind: agentSessions.kind,
      title: agentSessions.title,
      projectId: agentSessions.projectId,
      projectName: projects.name,
      ticketId: agentSessions.ticketId,
      ticketNumber: tickets.number,
      startedAt: agentSessions.startedAt,
      lastEventAt: agentSessions.lastEventAt,
      state: stateSql,
      activeSegment: agentSessions.activeSegmentLabel,
      interactive: agentSessions.activeSegmentInteractive,
      capabilities: agentSessions.capabilities,
      lastTool: lastToolEvent,
      aiJobId: agentSessions.aiJobId,
      backlogItemId: agentSessions.backlogItemId,
    })
    .from(agentSessions)
    .leftJoin(projects, eq(projects.id, agentSessions.projectId))
    .leftJoin(tickets, eq(tickets.id, agentSessions.ticketId))
    .leftJoin(aiJobs, eq(aiJobs.id, agentSessions.aiJobId));
}

type Row = Awaited<ReturnType<ReturnType<typeof baseSelect>["execute"]>>[number];

function toSummary(row: Row): AgentSessionSummary {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    projectId: row.projectId,
    projectName: row.projectName ?? null,
    ticketId: row.ticketId,
    ticketNumber: row.ticketNumber ?? null,
    startedAt: row.startedAt.toISOString(),
    lastEventAt: row.lastEventAt?.toISOString() ?? null,
    state: row.state,
    activeSegment: row.state === "working" ? (row.activeSegment ?? null) : null,
    lastActivity: row.state === "working" && row.lastTool ? describeAgentActivity(row.lastTool) : null,
  };
}

export async function listAgentSessions(
  db: Db,
  viewer: Actor,
): Promise<{ live: AgentSessionSummary[]; recent: AgentSessionSummary[] }> {
  const rows = await baseSelect(db)
    .where(and(visibleTo(viewer), sql`${agentSessions.startedAt} > now() - interval '14 days'`))
    .orderBy(desc(sql`coalesce(${agentSessions.lastEventAt}, ${agentSessions.startedAt})`))
    .limit(RECENT_LIMIT + 200);
  const all = rows.map(toSummary);
  return {
    live: all.filter((s) => s.state !== "ended"),
    recent: all.filter((s) => s.state === "ended").slice(0, RECENT_LIMIT),
  };
}

export async function getAgentSession(
  db: Db,
  viewer: Actor,
  id: string,
): Promise<AgentSessionDetail | null> {
  const [row] = await baseSelect(db).where(and(eq(agentSessions.id, id), visibleTo(viewer)));
  if (!row) return null;
  const summary = toSummary(row);
  const live = summary.state === "working";
  const questions = [
    ...(row.aiJobId
      ? (
          await db
            .select()
            .from(agentQuestions)
            .where(eq(agentQuestions.jobId, row.aiJobId))
        ).map((q) => ({
          id: q.id,
          source: "agent" as const,
          question: q.question,
          askedAt: q.askedAt.toISOString(),
          answered: q.answeredAt !== null,
        }))
      : []),
    ...(row.backlogItemId
      ? (
          await db
            .select()
            .from(backlogQuestions)
            .where(eq(backlogQuestions.backlogItemId, row.backlogItemId))
        ).map((q) => ({
          id: q.id,
          source: "backlog" as const,
          question: q.question,
          askedAt: q.createdAt.toISOString(),
          answered: q.answeredAt !== null || q.dismissedAt !== null,
        }))
      : []),
  ];
  return {
    ...summary,
    canWrite: viewer.role === "admin" && live && row.interactive,
    canInterrupt:
      viewer.role === "admin" && live && row.interactive && row.capabilities.some((c) => c.startsWith("interrupt_")),
    questions,
  };
}

export async function listAgentSessionEvents(
  db: Db,
  viewer: Actor,
  id: string,
  page: { after?: string; before?: string; limit: number },
): Promise<{ events: AgentSessionEvent[]; before: string | null } | null> {
  const [visible] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(and(eq(agentSessions.id, id), visibleTo(viewer)));
  if (!visible) return null;
  const conditions = [eq(agentSessionEvents.sessionId, id)];
  if (page.after) conditions.push(gt(agentSessionEvents.id, BigInt(page.after)));
  if (page.before) conditions.push(lt(agentSessionEvents.id, BigInt(page.before)));
  // Con `after` si legge in avanti (riconnessione SSE); altrimenti le ultime N.
  const rows = await db
    .select()
    .from(agentSessionEvents)
    .where(and(...conditions))
    .orderBy(page.after ? agentSessionEvents.id : desc(agentSessionEvents.id))
    .limit(page.limit);
  const ordered = page.after ? rows : rows.reverse();
  const events = ordered.map((e) => ({
    id: e.id.toString(),
    type: e.type,
    segmentId: e.segmentId,
    at: e.createdAt.toISOString(),
    data: e.data,
  }));
  const before = !page.after && rows.length === page.limit ? (events[0]?.id ?? null) : null;
  return { events, before };
}
```

Controlla i nomi reali delle colonne `backlogQuestions.createdAt`/`answeredAt`/`dismissedAt` e `agentQuestions.askedAt` in `schema.ts` e adatta.

- [ ] **Step 4: rotte**

```ts
// apps/server/src/routes/agent-sessions.ts
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  agentSessionDetailSchema,
  agentSessionEventPageSchema,
  agentSessionListSchema,
} from "@stubwise/shared";
import { requireAuth } from "../auth/session.js";
import { apiError, authErrorResponses, errorSchema } from "../errors.js";
import {
  getAgentSession,
  listAgentSessionEvents,
  listAgentSessions,
} from "../services/agent-sessions.js";

const idParams = z.object({ id: z.string().uuid() });
const cursor = z.string().regex(/^\d+$/);

export async function agentSessionRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/",
    { preHandler: requireAuth, schema: { response: { 200: agentSessionListSchema, ...authErrorResponses } } },
    async (request) => listAgentSessions(app.db, request.user!),
  );

  // Rotte con una parte letterale PRIMA di `GET /:id` (trappola di routing).
  app.get(
    "/:id/events",
    {
      preHandler: requireAuth,
      schema: {
        params: idParams,
        querystring: z.object({
          after: cursor.optional(),
          before: cursor.optional(),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        }),
        response: { 200: agentSessionEventPageSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const page = await listAgentSessionEvents(app.db, request.user!, request.params.id, request.query);
      if (!page) return apiError(reply, 404, "not_found", "Session not found");
      return page;
    },
  );

  app.get(
    "/:id",
    {
      preHandler: requireAuth,
      schema: { params: idParams, response: { 200: agentSessionDetailSchema, 404: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      const detail = await getAgentSession(app.db, request.user!, request.params.id);
      if (!detail) return apiError(reply, 404, "not_found", "Session not found");
      return detail;
    },
  );
}
```

(Allinea gli import di `apiError`, `errorSchema`, `authErrorResponses` a dove li prende `routes/release.ts`.)

In `apps/server/src/app.ts`, vicino a `releaseRoutes`:

```ts
  void app.register(agentSessionRoutes, { prefix: "/api/agent-sessions" });
```

- [ ] **Step 5: test e commit**

Run: `pnpm --filter @stubwise/server test -- agent-sessions`
Expected: PASS.

```bash
git add apps/server/src
git commit -m "feat(server): elenco, dettaglio ed eventi delle sessioni degli agenti"
```

---

### Task 11: Interventi (POST) e stream SSE

**Files:**
- Create: `apps/server/src/agent-session-bus.ts`
- Modify: `apps/server/src/services/agent-sessions.ts` (`sendAgentMessage`)
- Modify: `apps/server/src/routes/agent-sessions.ts` (`POST /:id/messages`, `GET /:id/stream`)
- Modify: `apps/server/src/app.ts` (`BuildAppOptions.sessionBus?`), `apps/server/src/index.ts` (crea il bus col `client`)
- Test: `apps/server/src/routes/agent-sessions.messages.test.ts`, `apps/server/src/agent-session-bus.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // agent-session-bus.ts
  export type BusMessage = { kind: "events"; sessionId: string } | { kind: "partial"; sessionId: string; segmentId: string; text: string };
  export interface AgentSessionBus { subscribe(sessionId: string, cb: (m: BusMessage) => void): () => void; }
  export function createAgentSessionBus(listen: (channel: string, cb: (payload: string) => void) => Promise<unknown>): Promise<AgentSessionBus>;
  export const NOOP_BUS: AgentSessionBus;
  // services
  export type SendAgentMessageResult =
    | { ok: true; inputId: string }
    | { ok: false; error: "forbidden" | "not_found" | "session_ended" | "not_interactive" | "interrupt_unsupported" };
  export async function sendAgentMessage(db: Db, input: { sessionId: string; actor: Actor; text: string; interrupt: boolean }): Promise<SendAgentMessageResult>;
  ```
  Rotte: `POST /api/agent-sessions/:id/messages` (body `sendAgentMessageInputSchema`, 202 `sendAgentMessageResultSchema`; 403/404/409), `GET /api/agent-sessions/:id/stream?after=` (SSE: `{type:"events",events:[…]}`, `{type:"partial",segmentId,text}`, `{type:"session",detail}`; commento `: ping` ogni 25 s).

- [ ] **Step 1: test degli interventi (negativi sulle righe)**

```ts
// apps/server/src/routes/agent-sessions.messages.test.ts
// Setup come in agent-sessions.test.ts: una sessione `ai_job` viva e interattiva
// (jobSession), una viva ma NON interattiva (triageSession, activeSegmentLabel
// "triage", activeSegmentInteractive false) e una finita (endedSession,
// activeSegmentId null).
import { agentSessionInputs } from "@stubwise/db";

const post = (id: string, cookie: string, body: object) =>
  app.inject({ method: "POST", url: `/api/agent-sessions/${id}/messages`, headers: { cookie }, payload: body });
const inputsOf = async (id: string) =>
  t.db.select().from(agentSessionInputs).where(eq(agentSessionInputs.sessionId, id));

describe("POST /api/agent-sessions/:id/messages", () => {
  it("member: 403 E nessuna riga scritta", async () => {
    const res = await post(jobSession, u.memberCookie, { text: "salta il piano" });
    expect(res.statusCode).toBe(403);
    expect(await inputsOf(jobSession)).toHaveLength(0);
  });

  it("admin su sessione viva e interattiva: 202, riga pending e pg_notify sul canale degli input", async () => {
    const notified: string[] = [];
    await t.client.listen("agent_session_input", (p) => notified.push(p));
    const res = await post(jobSession, u.adminCookie, { text: "guarda anche X", interrupt: true });
    expect(res.statusCode).toBe(202);
    const [row] = await inputsOf(jobSession);
    expect(row!.status).toBe("pending");
    expect(row!.interrupt).toBe(true);
    expect(row!.authorUserId).toBe(u.adminId);
    await new Promise((r) => setTimeout(r, 100));
    expect(notified.map((p) => JSON.parse(p).sessionId)).toContain(jobSession);
  });

  it("sessione finita: 409 session_ended e nessuna riga", async () => {
    const res = await post(endedSession, u.adminCookie, { text: "ciao" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("session_ended");
    expect(await inputsOf(endedSession)).toHaveLength(0);
  });

  it("segmento non interattivo: 409 not_interactive", async () => {
    const res = await post(triageSession, u.adminCookie, { text: "ciao" });
    expect(res.json().error).toBe("not_interactive");
  });

  it("posta altrui: 404 anche per un admin, nessuna riga", async () => {
    const res = await post(mailSessionOfMember, u.adminCookie, { text: "x" });
    expect(res.statusCode).toBe(404);
    expect(await inputsOf(mailSessionOfMember)).toHaveLength(0);
  });

  it("testo vuoto: 400", async () => {
    expect((await post(jobSession, u.adminCookie, { text: "   " })).statusCode).toBe(400);
  });
});
```

Più un test di servizio diretto: `sendAgentMessage(db, { actor: { id, role: "member" }, … })` → `{ ok: false, error: "forbidden" }` senza righe (difesa in profondità sotto la rotta).

- [ ] **Step 2: test del bus**

```ts
// apps/server/src/agent-session-bus.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { createAgentSessionBus, type BusMessage } from "./agent-session-bus.js";

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => t.stop());

describe("createAgentSessionBus", () => {
  it("smista eventi e parziali solo ai sottoscrittori di quella sessione", async () => {
    const bus = await createAgentSessionBus((c, cb) => t.client.listen(c, cb));
    const a: BusMessage[] = [];
    const b: BusMessage[] = [];
    const offA = bus.subscribe("A", (m) => a.push(m));
    bus.subscribe("B", (m) => b.push(m));
    await t.db.execute(sql`select pg_notify('agent_session_events', ${JSON.stringify({ sessionId: "A" })})`);
    await t.db.execute(
      sql`select pg_notify('agent_session_partial', ${JSON.stringify({ sessionId: "A", segmentId: "s", text: "ci" })})`,
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(a).toEqual([
      { kind: "events", sessionId: "A" },
      { kind: "partial", sessionId: "A", segmentId: "s", text: "ci" },
    ]);
    expect(b).toEqual([]);
    offA();
  });

  it("un payload malformato non lancia", async () => {
    const bus = await createAgentSessionBus((c, cb) => t.client.listen(c, cb));
    bus.subscribe("A", () => undefined);
    await t.db.execute(sql`select pg_notify('agent_session_events', 'not json')`);
    await new Promise((r) => setTimeout(r, 100));
  });
});
```

- [ ] **Step 3: verifica che falliscano**

Run: `pnpm --filter @stubwise/server test -- agent-session`
Expected: FAIL.

- [ ] **Step 4: bus**

```ts
// apps/server/src/agent-session-bus.ts
/**
 * Fan-out delle notifiche Postgres del worker ai flussi SSE aperti (design
 * §5.3). Una sola LISTEN per canale per processo server; le notifiche portano
 * solo l'id della sessione (gli eventi si rileggono dalla tabella), tranne i
 * parziali, che non si salvano.
 */
export type BusMessage =
  | { kind: "events"; sessionId: string }
  | { kind: "partial"; sessionId: string; segmentId: string; text: string };

export interface AgentSessionBus {
  subscribe(sessionId: string, cb: (m: BusMessage) => void): () => void;
}

export const NOOP_BUS: AgentSessionBus = { subscribe: () => () => undefined };

export async function createAgentSessionBus(
  listen: (channel: string, cb: (payload: string) => void) => Promise<unknown>,
): Promise<AgentSessionBus> {
  const subs = new Map<string, Set<(m: BusMessage) => void>>();
  const emit = (m: BusMessage) => subs.get(m.sessionId)?.forEach((cb) => cb(m));
  const parse = (payload: string): Record<string, unknown> | null => {
    try {
      const v: unknown = JSON.parse(payload);
      return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  await listen("agent_session_events", (payload) => {
    const p = parse(payload);
    if (typeof p?.["sessionId"] === "string") emit({ kind: "events", sessionId: p["sessionId"] });
  });
  await listen("agent_session_partial", (payload) => {
    const p = parse(payload);
    if (typeof p?.["sessionId"] === "string" && typeof p["text"] === "string") {
      emit({
        kind: "partial",
        sessionId: p["sessionId"],
        segmentId: String(p["segmentId"] ?? ""),
        text: p["text"],
      });
    }
  });
  return {
    subscribe(sessionId, cb) {
      const set = subs.get(sessionId) ?? new Set();
      set.add(cb);
      subs.set(sessionId, set);
      return () => {
        set.delete(cb);
        if (set.size === 0) subs.delete(sessionId);
      };
    },
  };
}
```

- [ ] **Step 5: servizio `sendAgentMessage`**

```ts
export type SendAgentMessageResult =
  | { ok: true; inputId: string }
  | {
      ok: false;
      error: "forbidden" | "not_found" | "session_ended" | "not_interactive" | "interrupt_unsupported";
    };

/** Spec §6.2–6.3. Difesa in profondità: il ruolo si ricontrolla qui. */
export async function sendAgentMessage(
  db: Db,
  input: { sessionId: string; actor: Actor; text: string; interrupt: boolean },
): Promise<SendAgentMessageResult> {
  if (input.actor.role !== "admin") return { ok: false, error: "forbidden" };
  const detail = await getAgentSession(db, input.actor, input.sessionId);
  if (!detail) return { ok: false, error: "not_found" };
  if (detail.state !== "working") return { ok: false, error: "session_ended" };
  if (!detail.canWrite) return { ok: false, error: "not_interactive" };
  if (input.interrupt && !detail.canInterrupt) return { ok: false, error: "interrupt_unsupported" };
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(agentSessionInputs)
      .values({
        sessionId: input.sessionId,
        authorUserId: input.actor.id,
        text: input.text,
        interrupt: input.interrupt,
      })
      .returning({ id: agentSessionInputs.id });
    await tx.execute(
      sql`select pg_notify('agent_session_input', ${JSON.stringify({ sessionId: input.sessionId })})`,
    );
    return { ok: true as const, inputId: row!.id };
  });
}
```

(`pg_notify` dentro la transazione parte al commit: il worker non legge mai un input che non esiste ancora.)

- [ ] **Step 6: rotte POST e SSE**

In `routes/agent-sessions.ts`, PRIMA di `GET /:id`:

```ts
  app.post(
    "/:id/messages",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParams,
        body: sendAgentMessageInputSchema,
        response: {
          202: sendAgentMessageResultSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await sendAgentMessage(app.db, {
        sessionId: request.params.id,
        actor: request.user!,
        text: request.body.text,
        interrupt: request.body.interrupt,
      });
      if (result.ok) return reply.code(202).send({ inputId: result.inputId, status: "pending" });
      switch (result.error) {
        case "forbidden":
          return apiError(reply, 403, "forbidden", "Administrators only");
        case "not_found":
          return apiError(reply, 404, "not_found", "Session not found");
        default:
          return apiError(reply, 409, result.error, "The session cannot receive messages now");
      }
    },
  );

  app.get(
    "/:id/stream",
    {
      preHandler: requireAuth,
      schema: { params: idParams, querystring: z.object({ after: cursor.optional() }) },
    },
    async (request, reply) => {
      const viewer = request.user!;
      const id = request.params.id;
      // Errori PRIMA del hijack, in JSON (stessa regola di backlog.ts).
      const initial = await getAgentSession(app.db, viewer, id);
      if (!initial) return apiError(reply, 404, "not_found", "Session not found");

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const send = (event: unknown) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      let cursorId = request.query.after;
      let closed = false;
      let reading = false;

      const pump = async () => {
        if (closed || reading) return;
        reading = true;
        try {
          for (;;) {
            const page = await listAgentSessionEvents(app.db, viewer, id, {
              ...(cursorId ? { after: cursorId } : {}),
              limit: 200,
            });
            if (!page || page.events.length === 0) break;
            cursorId = page.events[page.events.length - 1]!.id;
            send({ type: "events", events: page.events });
            if (page.events.length < 200) break;
          }
          const detail = await getAgentSession(app.db, viewer, id);
          if (detail) send({ type: "session", detail });
        } catch (error) {
          request.log.warn({ err: error }, "agent session stream: lettura fallita");
        } finally {
          reading = false;
        }
      };

      send({ type: "session", detail: initial });
      await pump();
      const unsubscribe = app.agentSessionBus.subscribe(id, (m) => {
        if (m.kind === "partial") send({ type: "partial", segmentId: m.segmentId, text: m.text });
        else void pump();
      });
      // Rete: una NOTIFY persa (connessione LISTEN caduta) non deve fermare lo stream.
      const poll = setInterval(() => void pump(), 5000);
      const ping = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);
      request.raw.on("close", () => {
        closed = true;
        clearInterval(poll);
        clearInterval(ping);
        unsubscribe();
      });
    },
  );
```

Nota: senza `after`, `listAgentSessionEvents` restituisce le ULTIME 200 in ordine; da lì il cursore va in avanti. Il client che vuole lo storico più vecchio usa `GET /:id/events?before=`.

In `app.ts`: aggiungi `sessionBus?: AgentSessionBus` a `BuildAppOptions`, `app.decorate("agentSessionBus", opts.sessionBus ?? NOOP_BUS)` e la dichiarazione di tipo di `FastifyInstance.agentSessionBus` accanto a quella di `db`. In `index.ts`:

```ts
const { db, client } = createDb(config.databaseUrl);
const sessionBus = await createAgentSessionBus((channel, cb) => client.listen(channel, cb));
const app = buildApp({ /* …esistenti… */, sessionBus });
```

- [ ] **Step 7: un test SSE minimo**

In `agent-sessions.messages.test.ts` costruisci l'app col bus vero e mettila in ascolto (la guardia di rete dei test ammette il loopback):

```ts
import { createAgentSessionBus } from "../agent-session-bus.js";

describe("GET /api/agent-sessions/:id/stream", () => {
  let base: string;
  let sseApp: ReturnType<typeof buildApp>;
  beforeAll(async () => {
    sseApp = buildApp({
      db: t.db,
      sessionSecret: "x".repeat(32),
      sessionBus: await createAgentSessionBus((c, cb) => t.client.listen(c, cb)),
    });
    base = await sseApp.listen({ port: 0, host: "127.0.0.1" });
  });
  afterAll(async () => sseApp.close());

  async function readUntil(res: Response, needle: string, ms = 3000): Promise<string> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let acc = "";
    const deadline = Date.now() + ms;
    while (!acc.includes(needle) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      acc += decoder.decode(value);
    }
    return acc;
  }

  it("un member riceve il dettaglio e poi gli eventi nuovi notificati dal worker", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/agent-sessions/${jobSession}/stream`, {
      headers: { cookie: u.memberCookie },
      signal: ctrl.signal,
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await readUntil(res, '"type":"session"')).toContain('"type":"session"');
    await t.db.insert(agentSessionEvents).values({
      sessionId: jobSession, segmentId: "seg", type: "assistant_text", data: { text: "evento-nuovo-dal-vivo" },
    });
    await t.db.execute(sql`select pg_notify('agent_session_events', ${JSON.stringify({ sessionId: jobSession })})`);
    expect(await readUntil(res, "evento-nuovo-dal-vivo")).toContain("evento-nuovo-dal-vivo");
    ctrl.abort();
  });

  it("posta altrui: 404 in JSON anche per un admin, senza aprire lo stream", async () => {
    const res = await fetch(`${base}/api/agent-sessions/${mailSessionOfMember}/stream`, {
      headers: { cookie: u.adminCookie },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
```

(I cookie di `seedUsers` sono legati al `sessionSecret`: usa lo stesso valore di `app`, così valgono per entrambe le istanze.)

- [ ] **Step 8: test e commit**

Run: `pnpm --filter @stubwise/server test -- agent-session && pnpm --filter @stubwise/server typecheck`
Expected: PASS.

```bash
git add apps/server/src
git commit -m "feat(server): interventi e stream dal vivo delle sessioni degli agenti"
```

---

### Task 12: Client API, scenario golden, documentazione, changeset

**Files:**
- Create: `packages/api-client/src/endpoints/agent-sessions.ts`
- Modify: `packages/api-client/src/client.ts` (`agentSessions: createAgentSessionsEndpoints(request)`)
- Test: `packages/api-client/src/endpoints/agent-sessions.test.ts`
- Modify: `apps/worker/scripts/golden/` (scenario `intervene`, README)
- Modify: `CLAUDE.md` (voce di deploy + invarianti)
- Create: `.changeset/shared-agent-sessions.md`

**Interfaces:**
- Produces: `client.agentSessions.list()`, `.get(id)`, `.events(id, { before?, after?, limit? })`, `.send(id, { text, interrupt })`, `.streamUrl(id, after?)`.

- [ ] **Step 1: test del client (vecchio server)**

```ts
// packages/api-client/src/endpoints/agent-sessions.test.ts
import { describe, expect, it } from "vitest";
import { createClient } from "../client.js";

describe("agentSessions", () => {
  it("parsa un dettaglio di un server più vecchio senza i campi additivi", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          id: "7f1c2a1e-0000-4000-8000-000000000001",
          kind: "ai_job",
          title: "t",
          projectId: null,
          projectName: null,
          ticketId: null,
          ticketNumber: null,
          startedAt: "2026-10-08T10:00:00.000Z",
          lastEventAt: null,
          state: "working",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const client = createClient({ baseUrl: "http://x", fetch: fetchImpl as typeof fetch });
    const detail = await client.agentSessions.get("7f1c2a1e-0000-4000-8000-000000000001");
    expect(detail.canWrite).toBe(false);
    expect(detail.questions).toEqual([]);
  });

  it("un kind sconosciuto non rompe il parse (readerSchema)", async () => {
    // stessa risposta con kind: "future_kind" → detail.kind === "__unknown__"
  });
});
```

Adatta `createClient`/opzioni al nome reale esportato da `packages/api-client/src/client.ts` (cerca come lo crea un test esistente, es. quello di `tickets.release`). Completa il secondo caso con la stessa risposta e `kind: "future_kind"`.

- [ ] **Step 2: endpoint**

```ts
// packages/api-client/src/endpoints/agent-sessions.ts
import {
  agentSessionDetailSchema,
  agentSessionEventPageSchema,
  agentSessionListSchema,
  sendAgentMessageResultSchema,
  type SendAgentMessageInput,
} from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { seg } from "./util.js";

export function createAgentSessionsEndpoints(request: ApiRequest) {
  return {
    list() {
      return request("GET", "/api/agent-sessions", undefined, agentSessionListSchema);
    },
    get(id: string) {
      return request("GET", `/api/agent-sessions/${seg(id)}`, undefined, agentSessionDetailSchema);
    },
    events(id: string, page: { before?: string; after?: string; limit?: number } = {}) {
      const q = new URLSearchParams();
      if (page.before) q.set("before", page.before);
      if (page.after) q.set("after", page.after);
      if (page.limit) q.set("limit", String(page.limit));
      const qs = q.toString();
      return request(
        "GET",
        `/api/agent-sessions/${seg(id)}/events${qs ? `?${qs}` : ""}`,
        undefined,
        agentSessionEventPageSchema,
      );
    },
    send(id: string, body: SendAgentMessageInput) {
      return request("POST", `/api/agent-sessions/${seg(id)}/messages`, body, sendAgentMessageResultSchema);
    },
    /** Path dello stream SSE: il trasporto lo sceglie il client (EventSource sul web, polyfill sull'app). */
    streamPath(id: string, after?: string) {
      return `/api/agent-sessions/${seg(id)}/stream${after ? `?after=${encodeURIComponent(after)}` : ""}`;
    },
  };
}
```

(`seg` e `ApiRequest`: importali da dove li prende `endpoints/tickets.ts`.)

Run: `pnpm --filter @stubwise/api-client test && pnpm --filter @stubwise/api-client build`

- [ ] **Step 3: scenario golden `intervene`**

Leggi `apps/worker/scripts/golden/README.md` e uno scenario esistente (`execute`). Aggiungi `intervene` con lo `StreamingClaudeRunner` vero e un `SessionHooks` in memoria: prompt «aggiungi una funzione `sum` in `math.ts`», e dopo il primo `tool_use` consegna «chiamala `add`, non `sum`» con `interrupt: true`. Verifica: il run finisce entro il timeout, nel worktree c'è `add` e non `sum`, e c'è un evento `input`. Lo scenario è **probabilistico**: lancialo 3 volte come `ask-user`. Aggiorna il README (elenco scenari e «quando lanciarli»: ora anche quando cambia `streaming-cli.ts`).

Run: `pnpm --filter @stubwise/worker golden -- --plugin <dir> --only intervene` (a mano, non in CI).

- [ ] **Step 4: CLAUDE.md**

Aggiungi in «Deploy (prod)» una voce **«Sessioni degli agenti dal vivo (8 ott 2026)»** sullo stile delle ultime:
- ORDINE: server (healthy + 0086: `\d agent_sessions`, oppure `max(created_at)` di `drizzle.__drizzle_migrations` = `1791417600000`), poi `worker caddy`;
- **senza job né generazioni Docs in corso** (cambia il runner);
- env nuova `AGENT_STREAMING` (default `true`, `false` = rollback innocuo);
- nessun kind, nessun enum toccato;
- **rollback**: server vecchio → rotte 404; worker vecchio o `AGENT_STREAMING=false` → nessuna sessione nuova; le tabelle sopravvivono;
- golden obbligatori (argv cambiato), più `intervene`.

E in «Invarianti e trappole»:
- **Lo stdin di un run si chiude dopo `RESULT_GRACE_MS` di silenzio, non contando i turni**: un messaggio a metà turno viene assorbito nello stesso turno (CLI 2.1.287). Chi «semplifica» contando i `result` fa restare appesi i run fino al timeout.
- **Le sessioni di posta sono del solo proprietario**: `visibleTo` (`services/agent-sessions.ts`) senza ramo per ruolo, ed `emailMessageSession` non crea la sessione se il proprietario non si risolve.
- **Il recorder è fail-open**: `safeSink` nel runner e i `run(...)` del recorder ingoiano ogni errore.

- [ ] **Step 5: changeset e verifiche finali**

```md
<!-- .changeset/shared-agent-sessions.md -->
---
"@stubwise/shared": minor
---

Schemi delle sessioni degli agenti (elenco, dettaglio, eventi, interventi) e `describeAgentActivity`.
```

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: tutto verde (la CI fallisce sul lint anche con test verdi).

```bash
git add packages/api-client apps/worker/scripts CLAUDE.md .changeset
git commit -m "feat: client delle sessioni, scenario golden intervene e documentazione"
```
