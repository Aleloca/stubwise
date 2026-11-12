import { describe, expect, it } from "vitest";
import { readerSchema, UNKNOWN } from "../reader.js";
import { mailThreadItemSchema, mailThreadMessageSchema } from "./google.js";
import { mailProposalListSchema, mailProposalSchema } from "./mail-proposals.js";

/**
 * Area 6, F2: i campi nuovi della Posta (importanza, scadenza, progetti per
 * id, stato della classificazione) e la proposta condivisa. Additivi: una
 * risposta di un server di prima, SENZA i campi, si legge coi default.
 */

const OLD_THREAD = {
  threadId: "t1",
  accountId: "11111111-1111-4111-8111-111111111111",
  accountEmail: "a@acme.com",
  lastFrom: "c@x.it",
  lastReceivedAt: "2026-11-12T10:00:00.000Z",
};

describe("righe e messaggi della Posta (F2)", () => {
  it("una riga di un server di prima si legge coi default nuovi", () => {
    expect(readerSchema(mailThreadItemSchema).parse(OLD_THREAD)).toMatchObject({
      importance: null,
      dueDate: null,
      analysing: false,
      failed: false,
      projectIds: [],
      snippet: "",
    });
  });

  it("un'importanza che il client non conosce diventa UNKNOWN, non un errore", () => {
    const row = readerSchema(mailThreadItemSchema).parse({ ...OLD_THREAD, importance: "critical" });
    expect(row.importance).toBe(UNKNOWN);
  });

  it("un messaggio senza `classification` si legge come `off`", () => {
    const message = readerSchema(mailThreadMessageSchema).parse({
      id: "22222222-2222-4222-8222-222222222222",
      from: "c@x.it",
      receivedAt: "2026-11-12T10:00:00.000Z",
    });
    expect(message.classification).toEqual({ state: "off", projectIds: [], importance: null, dueDate: null, uncertainProjectIds: [] });
  });
});

const PROPOSAL = {
  id: "33333333-3333-4333-8333-333333333333",
  messageId: "22222222-2222-4222-8222-222222222222",
  projectId: "44444444-4444-4444-8444-444444444444",
  status: "open",
  createdAt: "2026-11-12T10:00:00.000Z",
  actions: [{ type: "create_task", args: { title: "Export", description: "", assigneeId: null, dueDate: null }, label: "Crea la task" }],
};

describe("la proposta condivisa (F2)", () => {
  it("una proposta coi soli campi necessari si legge coi default", () => {
    const p = readerSchema(mailProposalSchema).parse(PROPOSAL);
    expect(p).toMatchObject({
      excerpt: "",
      canConfirm: false,
      canHand: false,
      canReassign: false,
      editable: false,
      blockedIndices: [],
      outsiders: [],
      decidedBy: null,
      decidedAt: null,
      confirmedIndices: [],
      results: [],
      error: null,
      handedAt: null,
      handedBy: null,
      sharedWith: [],
      origin: null,
    });
  });

  it("uno stato o un tipo d'azione nuovi diventano UNKNOWN", () => {
    const p = readerSchema(mailProposalSchema).parse({ ...PROPOSAL, status: "archived", actions: [{ type: "send_email", args: {}, label: "x" }] });
    expect(p.status).toBe(UNKNOWN);
    expect(p.actions[0]!.type).toBe(UNKNOWN);
  });

  it("l'elenco", () => {
    expect(readerSchema(mailProposalListSchema).parse({ items: [PROPOSAL] }).items).toHaveLength(1);
  });
});
