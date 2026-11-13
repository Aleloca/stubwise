import { describe, expect, it } from "vitest";
import { inboxItemSchema, notificationKindSchema } from "./notification.js";
import { searchResultsSchema } from "./search.js";

// Area 7, fetta 1: i quattro kind delle Automations, e il campo `automation`
// di una card, derivato a lettura: additivo (una card di un server di prima,
// SENZA il campo, si legge con `automation: null`).
const ID = "6f1c2a52-1d7b-4c3e-9a51-0b6a7f2e1a07";
const base = {
  id: ID,
  status: "open",
  text: "x",
  actions: [],
  projectId: null,
  ticketId: null,
  jobId: null,
  createdAt: "2026-11-13T10:00:00.000Z",
  readAt: null,
  snoozedUntil: null,
  handledAt: null,
  handledBy: null,
};

describe("le card delle Automations", () => {
  it("i quattro kind esistono", () => {
    for (const k of ["automation.approval", "automation.failed", "automation.notify", "automation.paused"]) expect(notificationKindSchema.options).toContain(k);
  });
  it("una card senza `automation` (server di prima) si legge con automation null", () => {
    expect(inboxItemSchema.parse({ ...base, kind: "task.assigned" }).automation).toBeNull();
  });
  it("una card con lo stato dell'esecuzione", () => {
    const card = inboxItemSchema.parse({
      ...base,
      kind: "automation.approval",
      automation: { automationCode: "AUD-A1", automationName: "Onboarding", runCode: "AUD-A1 #2", runStatus: "waiting_approval", waitingOnYou: true, decided: false },
    });
    expect(card.automation).toMatchObject({ waitingOnYou: true, decided: false });
  });
});


describe("la ricerca: il gruppo delle Automations", () => {
  it("una risposta di un server di prima, SENZA `automations`, si legge con il gruppo vuoto", () => {
    const empty = { items: [], hasMore: false };
    expect(searchResultsSchema.parse({ tickets: empty, projects: empty, repositories: empty, docs: empty }).automations).toEqual(empty);
  });
});

describe("i traguardi: automationCreated", () => {
  it("un traguardo di un server di prima, SENZA il campo, si legge (e non dice di chiedere l'origine)", async () => {
    const { milestoneSchema } = await import("./milestone.js");
    const m = milestoneSchema.parse({ id: ID, projectId: ID, name: "v1", description: null, dueDate: null, status: "open", closedAt: null, createdAt: "2026-11-13T10:00:00.000Z" });
    expect(m.automationCreated === true).toBe(false);
  });
});
