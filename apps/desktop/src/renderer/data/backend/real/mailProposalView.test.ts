import { mailProposalSchema } from "@stubwise/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { session } from "./client";
import { ME_ID, PROJECT_ID } from "./fakeServer";
import { proposalViewOf } from "./mailProposalView";

// Una proposta della F2 (`MailProposal` di `@stubwise/shared`, la rotta
// `/api/me/mail/proposals`) come la legge la Posta del prototipo: le azioni coi
// nomi e gli argomenti del prototipo, i permessi e la condivisione detti dal
// server, l'origine per «Da decidere».

const ACC = "aaaaaaaa-1111-4111-8111-111111111111";
const M1 = "dddddddd-1111-4111-8111-111111111111";
const P1 = "cccccccc-1111-4111-8111-111111111111";
const T1 = "77777777-1111-4111-8111-111111111111";
const BOB = "88888888-1111-4111-8111-111111111111";
const CARLA = "88888888-2222-4222-8222-222222222222";

const proposal = (over: Record<string, unknown> = {}) =>
  mailProposalSchema.parse({
    id: P1,
    messageId: M1,
    projectId: PROJECT_ID,
    status: "open",
    createdAt: "2026-11-12T08:05:00.000Z",
    excerpt: "Ecco il preventivo.",
    actions: [
      { type: "create_task", args: { title: "Export CSV", description: "Per Rossi", assigneeId: BOB, dueDate: "2026-11-20" }, label: "Crea la task «Export CSV»" },
      { type: "create_backlog_item", args: { title: "Preventivo", description: "" }, label: "Crea la richiesta «Preventivo»" },
      { type: "update_ticket", args: { ticketId: T1, patch: { dueDate: "2026-11-21" } }, label: "Sposta la scadenza" },
      { type: "comment_ticket", args: { ticketId: T1, body: "Il cliente conferma" }, label: "Commenta" },
      { type: "create_milestone", args: { name: "Consegna", dueDate: "2026-11-30" }, label: "Traguardo" },
      { type: "record_decision", args: { ticketId: T1 }, label: "Registra la decisione" },
    ],
    canConfirm: true,
    canHand: false,
    canReassign: true,
    outsiders: [{ userId: BOB, name: "Bob" }],
    sharedWith: [{ userId: CARLA, name: "Carla" }],
    origin: { threadId: "t-1", accountId: ACC, from: "Bob Rossi <bob@client.test>", subject: "Preventivo" },
    ...over,
  });

beforeEach(() => {
  session.personId = ME_ID;
});
afterEach(() => {
  session.personId = null;
});

describe("una proposta della F2 nella Posta", () => {
  it("le azioni coi nomi e gli argomenti del prototipo, e la frase del server", () => {
    const v = proposalViewOf(proposal());
    expect(v.proposal.actions).toEqual([
      { fn: "createTask", args: { title: "Export CSV", description: "Per Rossi", assigneeId: BOB, dueDate: "2026-11-20" }, summary: "Crea la task «Export CSV»" },
      { fn: "createRequest", args: { title: "Preventivo", description: "" }, summary: "Crea la richiesta «Preventivo»" },
      { fn: "updateTask", args: { id: T1, patch: { dueDate: "2026-11-21" } }, summary: "Sposta la scadenza" },
      { fn: "addComment", args: { taskId: T1, body: "Il cliente conferma" }, summary: "Commenta" },
      { fn: "createMilestone", args: { name: "Consegna", dueDate: "2026-11-30" }, summary: "Traguardo" },
      { fn: "recordDecision", args: { taskId: T1 }, summary: "Registra la decisione" },
    ]);
  });

  it("la proposta: il messaggio d'origine, l'estratto, lo stato", () => {
    expect(proposalViewOf(proposal()).proposal).toMatchObject({
      id: P1,
      source: "email",
      sourceId: M1,
      projectId: PROJECT_ID,
      excerpt: "Ecco il preventivo.",
      createdAt: "2026-11-12T08:05:00.000Z",
      status: "open",
      decidedById: null,
      decidedAt: null,
      resultCodes: [],
      error: null,
      handedAt: null,
      handedById: null,
    });
  });

  it("i permessi, gli incaricati fuori dal progetto e chi la condivide li dice il server", () => {
    expect(proposalViewOf(proposal())).toMatchObject({
      canConfirm: true,
      canHand: false,
      canReassign: true,
      outsiders: [{ personId: BOB, name: "Bob" }],
      sharedWith: [{ personId: CARLA, name: "Carla" }],
      decidedBy: null,
    });
  });

  it("l'origine per «Da decidere»: la conversazione della mia casella; senza messaggio nella mia casella, nessuna", () => {
    expect(proposalViewOf(proposal()).origin).toEqual({ kind: "email", threadId: `${ACC}_t-1`, from: "Bob Rossi <bob@client.test>", subject: "Preventivo" });
    expect(proposalViewOf(proposal({ origin: null })).origin).toBeNull();
  });

  it("decisa: chi e quando, le azioni confermate in parte, i codici nati; passata: da chi", () => {
    const v = proposalViewOf(
      proposal({
        status: "confirmed",
        decidedBy: { userId: CARLA, name: "Carla" },
        decidedAt: "2026-11-12T09:00:00.000Z",
        confirmedIndices: [0, 4],
        results: [
          { kind: "task", id: "x", code: "AUD-12" },
          { kind: "milestone", id: "y", code: null },
        ],
        handedAt: "2026-11-12T08:30:00.000Z",
        handedBy: { userId: BOB, name: "Bob" },
      }),
    );
    expect(v.proposal).toMatchObject({
      status: "confirmed",
      decidedById: CARLA,
      decidedAt: "2026-11-12T09:00:00.000Z",
      confirmedActions: [0, 4],
      resultCodes: ["AUD-12"],
      handedAt: "2026-11-12T08:30:00.000Z",
      handedById: BOB,
    });
    expect(v.decidedBy).toEqual({ personId: CARLA, name: "Carla" });
  });

  it("confermata per intero: nessuna conferma parziale", () => {
    const v = proposalViewOf(proposal({ status: "confirmed", confirmedIndices: [] }));
    expect(v.proposal.confirmedActions).toBeUndefined();
  });

  it("«Quale progetto?»: i progetti fra cui scegliere", () => {
    const other = "22222222-9999-4999-8999-999999999999";
    const v = proposalViewOf(
      proposal({ actions: [{ type: "choose_project", args: { projectIds: [PROJECT_ID, other] }, label: "Quale progetto?" }], canConfirm: false, canReassign: false }),
    );
    expect(v.proposal.actions).toEqual([{ fn: "chooseProject", args: { projectIds: [PROJECT_ID, other] }, summary: "Quale progetto?" }]);
  });

  it("se i campi si possono modificare lo dice il server (`editable`); di default no", () => {
    expect(proposalViewOf(proposal({ editable: true })).editable).toBe(true);
    expect(proposalViewOf(proposal()).editable).toBe(false);
  });
});

describe("F3b: le proposte del calendario nella stessa lista (`kind: \"calendar\"`)", () => {
  const EVENT = "eeeeeeee-1111-4111-8111-111111111111";
  // La forma del task 7 di 72: `messageId` null, l'origine in `calendarOrigin`
  // (`origin` resta quella dell'email, qui null); hand e reassign non ci sono.
  const calendarProposal = (over: Record<string, unknown> = {}) =>
    proposal({
      kind: "calendar",
      messageId: null,
      origin: null,
      canHand: false,
      canReassign: false,
      calendarOrigin: { eventId: EVENT, title: "Board trimestrale", startsAt: "2026-11-20T09:00:00.000Z", allDay: false },
      actions: [
        { type: "create_milestone", args: { projectId: PROJECT_ID, name: "Board trimestrale", dueDate: "2026-11-20" }, label: "Traguardo «Board trimestrale»" },
        { type: "acknowledge_reminder", args: {}, label: "Visto" },
      ],
      ...over,
    });

  it("viene dall'evento, non da un messaggio: la sorgente e l'origine del calendario", () => {
    const v = proposalViewOf(calendarProposal());
    expect(v.proposal).toMatchObject({ source: "calendar", sourceId: EVENT });
    expect(v.origin).toEqual({ kind: "calendar", eventId: EVENT, title: "Board trimestrale", startsAt: "2026-11-20T09:00:00.000Z", allDay: false });
    expect([v.canHand, v.canReassign]).toEqual([false, false]);
  });

  it("le azioni del calendario coi nomi del prototipo: il traguardo e il promemoria «Visto»", () => {
    expect(proposalViewOf(calendarProposal()).proposal.actions.map((a) => a.fn)).toEqual(["createMilestone", "acknowledgeReminder"]);
  });

  it("senza l'origine (un evento che non vedo più): sorgente calendario, nessuna riga d'origine", () => {
    const v = proposalViewOf(calendarProposal({ calendarOrigin: null }));
    expect(v.proposal.source).toBe("calendar");
    expect(v.origin).toBeNull();
  });

  it("un server di prima (senza `kind`): è della posta, come sempre", () => {
    const v = proposalViewOf(proposal());
    expect(v.proposal).toMatchObject({ source: "email", sourceId: M1 });
    expect(v.origin).toMatchObject({ kind: "email" });
  });
});
