import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inboxItemSchema } from "@stubwise/shared";
import { setAppClientForTests } from "./client";
import { installFakeServer, me, ME_ID, PROJECT_ID } from "./fakeServer";
import { presentInboxItem } from "./notifications";
import { listPeople } from "./people";
import { getSessionPerson, getViewer, auth } from "./session";

beforeEach(() => setAppClientForTests(null));
afterEach(() => {
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("sessione e permessi dal server", () => {
  it("i permessi del viewer vengono dal server, non dedotti", async () => {
    const { seen } = installFakeServer({ "GET /api/auth/me": { body: me() } });
    const viewer = await getViewer();
    expect(viewer).toEqual({
      personId: ME_ID,
      instancePermissions: ["users.view_all"],
      projectPermissions: { [PROJECT_ID]: ["tickets.create", "tickets.edit"] },
      departmentPermissions: {},
    });
    // Nel browser: il cookie del web, nessun bearer dal renderer.
    expect(seen[0]).toMatchObject({ credentials: "include", authorization: null });
  });

  it("fuori (401 su /me) la sessione è «nessuno» e il cancello dice login", async () => {
    installFakeServer({ "GET /api/auth/me": { status: 401, body: { code: "unauthenticated" } } });
    expect(await getSessionPerson()).toBeNull();
    expect(auth.readEntry()).toEqual({ stage: "out", empty: false });
  });

  it("dentro, il cancello dice «in»", async () => {
    installFakeServer({ "GET /api/auth/me": { body: me() } });
    expect(await getSessionPerson()).toBe(ME_ID);
    expect(auth.readEntry().stage).toBe("in");
  });

  it("una funzione d'ingresso non integrata rifiuta, non è undefined", async () => {
    await expect(auth.prototypeAccounts([])).rejects.toThrow(/auth\.prototypeAccounts/);
  });
});

describe("persone", () => {
  it("listPeople usa display_name o la parte locale dell'email", async () => {
    // Il nome lo risolve il server (`display_name ?? parte locale`): il client lo usa così com'è.
    installFakeServer({
      "GET /api/people": {
        body: [
          { id: ME_ID, name: "Ada Lovelace", initials: "AL", departmentIds: [], email: "ada@example.com" },
          { id: PROJECT_ID, name: "bob", initials: "BO", departmentIds: [], email: "bob@example.com", deactivated: true },
        ],
      },
    });
    const people = await listPeople();
    expect(people.map((p) => [p.name, p.initials, p.isClaude, p.deactivated])).toEqual([
      ["Ada Lovelace", "AL", false, false],
      ["bob", "BO", false, true],
    ]);
  });
});

describe("le card dell'inbox", () => {
  const base = {
    id: "33333333-3333-4333-8333-333333333333",
    status: "open",
    text: "Ada asks you to decide on AUD-12",
    actions: ["open"],
    projectId: PROJECT_ID,
    ticketId: "44444444-4444-4444-8444-444444444444",
    jobId: null,
    createdAt: "2026-11-09T10:00:00.000Z",
    readAt: null,
    snoozedUntil: null,
    handledAt: null,
    handledBy: null,
  };
  const ctx = {
    taskCodes: new Map([[base.ticketId, "AUD-12"]]),
    projectCodes: new Map([[PROJECT_ID, "AUD"]]),
  };

  it("decision.requested apre il pannello della task", () => {
    const item = inboxItemSchema.parse({ ...base, kind: "decision.requested" });
    const n = presentInboxItem(item, ctx);
    expect(n.link).toBe("#/p/AUD/tasks?task=AUD-12");
    expect(n.webHref).toBeUndefined();
    expect(n.objectCode).toBe("AUD-12");
  });

  it("una card di un kind sconosciuto ha Apri nel web e non rompe", () => {
    const raw = { ...base, kind: "something.from.the.future", url: "https://stubwise.example.com/tickets/44444444-4444-4444-8444-444444444444" };
    // Come la parsa il client condiviso: il kind ignoto diventa `__unknown__`.
    const item = { ...raw, kind: "__unknown__" } as unknown as Parameters<typeof presentInboxItem>[0];
    const n = presentInboxItem(item, { ...ctx, instanceOrigin: "https://stubwise.example.com" });
    expect(n.link).toBe("");
    expect(n.webHref).toBe("/tickets/44444444-4444-4444-8444-444444444444");
    expect(n.title).toBe(base.text);
  });

  it("una card job.pr_opened apre l'URL della PR", () => {
    const item = inboxItemSchema.parse({
      ...base,
      kind: "job.pr_opened",
      url: "https://github.com/acme/app/pull/7",
    });
    // Un'origine diversa dall'istanza: l'URL resta assoluto (si apre nel browser).
    expect(presentInboxItem(item, { ...ctx, instanceOrigin: "https://stubwise.example.com" }).webHref).toBe(
      "https://github.com/acme/app/pull/7",
    );
  });

  it("un URL dell'istanza diventa il suo percorso", () => {
    const item = inboxItemSchema.parse({
      ...base,
      kind: "job.plan_review",
      url: "https://stubwise.example.com/tickets/44444444-4444-4444-8444-444444444444?tab=plan",
    });
    expect(presentInboxItem(item, { ...ctx, instanceOrigin: "https://stubwise.example.com" }).webHref).toBe(
      "/tickets/44444444-4444-4444-8444-444444444444?tab=plan",
    );
  });

  it("una domanda di Claude apre la sessione nel web vecchio", () => {
    const item = inboxItemSchema.parse({
      ...base,
      kind: "job.awaiting_input",
      jobId: "55555555-5555-4555-8555-555555555555",
    });
    expect(presentInboxItem(item, ctx).webHref).toBe(
      "/agents/job/55555555-5555-4555-8555-555555555555?ticketId=44444444-4444-4444-8444-444444444444",
    );
  });
});
