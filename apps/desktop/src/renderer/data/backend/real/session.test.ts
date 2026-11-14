import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inboxItemSchema } from "@stubwise/shared";
import { setAppClientForTests } from "./client";
import { installFakeServer, me, ME_ID, PROJECT_ID } from "./fakeServer";
import { presentInboxItem } from "./notifications";
import { listPeople } from "./people";
import { getSessionPerson, getViewer, auth } from "./session";
import { peekRevealedAddress, revealAddress } from "../../revealedAddress";

const DEPT = "66666666-6666-4666-8666-666666666666";

beforeEach(() => setAppClientForTests(null));
afterEach(() => {
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("sessione e permessi dal server", () => {
  it("i permessi del viewer vengono dal server, non dedotti", async () => {
    const { seen } = installFakeServer({
      "GET /api/auth/me": { body: me({ departmentPermissions: { [DEPT]: ["department.home.manage"] } }) },
    });
    const viewer = await getViewer();
    expect(viewer).toEqual({
      personId: ME_ID,
      instancePermissions: ["users.view_all"],
      projectPermissions: { [PROJECT_ID]: ["tickets.create", "tickets.edit"] },
      departmentPermissions: { [DEPT]: ["department.home.manage"] },
    });
    // Nel browser: il cookie del web, nessun bearer dal renderer.
    expect(seen[0]).toMatchObject({ credentials: "include", authorization: null });
  });

  it("fuori (401 su /me) la sessione è «nessuno» e il cancello dice login", async () => {
    installFakeServer({ "GET /api/auth/me": { status: 401, body: { code: "unauthenticated" } } });
    expect(await getSessionPerson()).toBeNull();
    expect(auth.readEntry()).toEqual({ stage: "out", empty: false });
  });

  it("cambiando persona il segreto di un webhook appena visto si dimentica (review F4, I2)", async () => {
    installFakeServer({ "GET /api/auth/me": { body: me() } });
    await getSessionPerson();
    revealAddress("src-1", "https://x.test/hooks/in/SEGRETO");
    installFakeServer({
      "GET /api/auth/me": {
        body: me({ user: { ...me().user, id: "99999999-9999-4999-8999-000000000001" } }),
      },
    });
    await getSessionPerson();
    expect(peekRevealedAddress("src-1")).toBeUndefined();
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

  it("una card di una task ELIMINATA: il codice in testo, nessun link né «Open in web», objectGone", () => {
    const item = inboxItemSchema.parse({
      ...base,
      kind: "ticket.activity",
      ticketId: null,
      taskCode: "AUD-12",
      objectGone: true,
    });
    const n = presentInboxItem(item, ctx);
    expect(n).toMatchObject({ link: "", objectGone: true, objectCode: "AUD-12" });
    expect(n.webHref).toBeUndefined();
  });

  it("senza objectGone (server più vecchio) il campo vale false", () => {
    expect(inboxItemSchema.parse({ ...base, kind: "decision.requested" }).objectGone).toBe(false);
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

  // Area 8, F2 (R4): le card dei tipi del catalogo arrivano senza ticket, col
  // link all'app nel campo `url` (`/app/#/…`, S1): aprono la pagina nell'app
  // se quella pagina è accesa, altrimenti restano «Open in web».
  describe("tipi del catalogo, nella build app", () => {
    beforeEach(() => vi.stubEnv("VITE_STUBWISE_BUILD", "app"));
    afterEach(() => vi.unstubAllEnvs());

    const REPO = "77777777-7777-4777-8777-777777777777";
    const catalogCard = (kind: string, url?: string) =>
      inboxItemSchema.parse({ ...base, kind, ticketId: null, ...(url !== undefined ? { url } : {}) });
    const origin = { ...ctx, instanceOrigin: "https://stubwise.example.com" };

    it("release.merged apre il dettaglio del rilascio nell'app", () => {
      const n = presentInboxItem(catalogCard("release.merged", "/app/#/p/AUD/releases/AUD-V3"), origin);
      expect(n.link).toBe("#/p/AUD/releases/AUD-V3");
      expect(n.webHref).toBeUndefined();
      expect(n.objectCode).toBe("AUD");
    });

    it("pr.opened apre il pannello della PR (id = repository#numero)", () => {
      const n = presentInboxItem(catalogCard("pr.opened", `/app/#/p/AUD/releases?pr=${REPO}%237`), origin);
      expect(n.link).toBe(`#/p/AUD/releases?pr=${REPO}%237`);
      expect(n.webHref).toBeUndefined();
    });

    it("docs.release_note apre i Docs del progetto, anche da un URL assoluto dell'istanza", () => {
      const n = presentInboxItem(
        catalogCard("docs.release_note", "https://stubwise.example.com/app/#/p/AUD/docs"),
        origin,
      );
      expect(n.link).toBe("#/p/AUD/docs");
    });

    it("una pagina dell'app non ancora accesa resta «Open in web»", () => {
      const n = presentInboxItem(catalogCard("monitor.alert", "/app/#/p/AUD/servers/SRV-1"), origin);
      expect(n.link).toBe("");
      expect(n.webHref).toBe("/app/#/p/AUD/servers/SRV-1");
    });

    it("un /app/# di un'altra origine non apre mai una pagina dell'app", () => {
      const n = presentInboxItem(catalogCard("release.merged", "https://evil.example.com/app/#/p/AUD/docs"), origin);
      expect(n.link).toBe("");
      expect(n.webHref).toBe("https://evil.example.com/app/#/p/AUD/docs");
    });

    it("una card arrivata da obbligatorio porta il suo motivo (alertMandatory), per chi legge", () => {
      const item = inboxItemSchema.parse({
        ...base,
        kind: "release.failed",
        ticketId: null,
        url: "/app/#/p/AUD/releases/AUD-V3",
        alertMandatory: "merged",
      });
      const n = presentInboxItem(item, { ...origin, viewerId: ME_ID });
      expect(n.mandatory).toEqual([{ personId: ME_ID, reason: "merged" }]);
    });

    it("senza alertMandatory (o con un motivo che l'app non conosce) nessun obbligo", () => {
      const plain = catalogCard("release.failed", "/app/#/p/AUD/releases/AUD-V3");
      expect(presentInboxItem(plain, { ...origin, viewerId: ME_ID }).mandatory).toBeUndefined();
      const future = inboxItemSchema.parse({
        ...base,
        kind: "release.failed",
        ticketId: null,
        alertMandatory: "something_new",
      });
      expect(presentInboxItem(future, { ...origin, viewerId: ME_ID }).mandatory).toBeUndefined();
    });

    it("una card del catalogo senza url (server più vecchio) non rompe", () => {
      const n = presentInboxItem(catalogCard("release.succeeded"), origin);
      expect(n.link).toBe("");
      expect(n.title).toBe(base.text);
    });
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
