import { describe, expect, it } from "vitest";
import {
  INTERACTIVE_SEGMENTS,
  agentSessionDetailSchema,
  agentSessionInputSchema,
  agentSessionListQuerySchema,
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
    // `summary` qui sopra NON ha activeSegment, lastActivity, aiJobId, outcome:
    // è apposta, è la prova che i default ci sono.
    const parsed = agentSessionSummarySchema.parse(summary);
    expect(parsed.lastActivity).toBeNull();
    expect(parsed.activeSegment).toBeNull();
    expect(parsed.aiJobId).toBeNull();
    expect(parsed.outcome).toBeNull();
  });

  it("il dettaglio senza canWrite/canInterrupt/questions/inputs li legge falsi/vuoti", () => {
    const parsed = agentSessionDetailSchema.parse({ ...summary });
    expect(parsed.canWrite).toBe(false);
    expect(parsed.canInterrupt).toBe(false);
    expect(parsed.questions).toEqual([]);
    expect(parsed.inputs).toEqual([]);
  });

  it("un intervento senza authorName (server più vecchio) lo legge null", () => {
    const parsed = agentSessionInputSchema.parse({
      id: "7f1c2a1e-0000-4000-8000-000000000002",
      text: "guarda anche X",
      status: "undelivered",
      reason: "session_not_live",
      authorUserId: null,
      createdAt: "2026-10-08T10:06:00.000Z",
    });
    expect(parsed.authorName).toBeNull();
  });

  it("i filtri dell'elenco sono tutti facoltativi e vogliono uuid", () => {
    expect(agentSessionListQuerySchema.parse({})).toEqual({});
    expect(agentSessionListQuerySchema.safeParse({ ticketId: "nope" }).success).toBe(false);
  });

  it("un messaggio vuoto o oltre 4000 caratteri è rifiutato", () => {
    expect(sendAgentMessageInputSchema.safeParse({ text: "  " }).success).toBe(false);
    expect(sendAgentMessageInputSchema.safeParse({ text: "x".repeat(4001) }).success).toBe(false);
    expect(sendAgentMessageInputSchema.parse({ text: "ok" }).interrupt).toBe(false);
  });

  it("i run brevi non sono interattivi, i run lunghi sì; Docs e review in sola lettura (v1)", () => {
    expect(INTERACTIVE_SEGMENTS.has("execute")).toBe(true);
    // La review gira SENZA plugin base e il suo output è il verdetto JSON: un
    // intervento lo sostituirebbe con una risposta al maintainer (design §12).
    expect(INTERACTIVE_SEGMENTS.has("review")).toBe(false);
    expect(INTERACTIVE_SEGMENTS.has("email_classify")).toBe(false);
    expect(INTERACTIVE_SEGMENTS.has("triage")).toBe(false);
    expect(INTERACTIVE_SEGMENTS.has("docs")).toBe(false);
  });
});
