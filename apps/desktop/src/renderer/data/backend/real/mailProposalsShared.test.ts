import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session, setAppClientForTests } from "./client";
import { installFakeServer, ME_ID, PROJECT_ID } from "./fakeServer";
import { mail } from "./mail";

// Le proposte della Posta dalla rotta della F2 (`/api/me/mail/proposals`):
// una per email e progetto, condivisa fra i destinatari membri. Leggere,
// confermare (anche in parte, coi campi cambiati, aggiungendo i Contributor),
// ignorare, passare, spostare e scegliere il progetto passano da lì.

const ACC = "aaaaaaaa-1111-4111-8111-111111111111";
const M1 = "dddddddd-1111-4111-8111-111111111111";
const P1 = "cccccccc-1111-4111-8111-111111111111";
const P2 = "cccccccc-2222-4222-8222-222222222222";
const CARLA = "88888888-2222-4222-8222-222222222222";
const OTHER = "22222222-3333-4333-8333-333333333333";

const proposal = (over: Record<string, unknown> = {}) => ({
  id: P1,
  messageId: M1,
  projectId: PROJECT_ID,
  status: "open",
  createdAt: "2026-11-12T08:05:00.000Z",
  excerpt: "Ecco il preventivo.",
  actions: [
    { type: "create_task", args: { title: "Export CSV", description: "", assigneeId: null, dueDate: null }, label: "Crea la task «Export CSV»" },
    { type: "create_milestone", args: { name: "Consegna", dueDate: "2026-11-30" }, label: "Traguardo «Consegna»" },
  ],
  canConfirm: true,
  canHand: false,
  canReassign: true,
  blockedIndices: [],
  outsiders: [],
  decidedBy: null,
  decidedAt: null,
  confirmedIndices: [],
  results: [],
  error: null,
  handedAt: null,
  handedBy: null,
  sharedWith: [{ userId: CARLA, name: "Carla" }],
  origin: { threadId: "t-1", accountId: ACC, from: "Bob <bob@client.test>", subject: "Preventivo" },
  ...over,
});

const query = (path: string) => new URLSearchParams(path.split("?")[1] ?? "");
const list = (items: unknown[]) => ({ body: { items } });

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  session.personId = ME_ID;
});
afterEach(() => {
  session.personId = null;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("le proposte condivise: lettura", () => {
  it("dalla rotta della F2, coi filtri del messaggio d'origine e dello stato", async () => {
    const { seen } = installFakeServer({ "GET /api/me/mail/proposals": list([proposal()]) });
    const [v] = await mail.listMailProposals({ sourceId: M1, status: "open" });
    expect(v!.proposal).toMatchObject({ id: P1, sourceId: M1, status: "open" });
    expect(v!.sharedWith).toEqual([{ personId: CARLA, name: "Carla" }]);
    const q = query(seen[0]!.path);
    expect(q.get("message")).toBe(M1);
    expect(q.get("status")).toBe("open");
  });

  it("una proposta per id; non mia o inesistente è `not_found`", async () => {
    installFakeServer({
      [`GET /api/me/mail/proposals/${P1}`]: { body: proposal() },
      [`GET /api/me/mail/proposals/${P2}`]: { status: 404, body: { code: "not_found", message: "x" } },
    });
    expect((await mail.getMailProposal(P1)).proposal.id).toBe(P1);
    await expect(mail.getMailProposal(P2)).rejects.toThrow("not_found");
  });

  it("«Da decidere»: le aperte che posso confermare o passare, le PASSATE che posso confermare, «Quale progetto?»; con l'origine", async () => {
    const P3 = "cccccccc-3333-4333-8333-333333333333";
    const P4 = "cccccccc-4444-4444-8444-444444444444";
    const { seen } = installFakeServer({
      "GET /api/me/mail/proposals": (req: { path: string }) => {
        const status = query(req.path).get("status");
        if (status === "handed") return list([proposal({ id: P2, status: "handed", canConfirm: true, canHand: false, origin: null })]);
        return list([
          proposal(),
          proposal({
            id: P3,
            actions: [{ type: "choose_project", args: { projectIds: [PROJECT_ID] }, label: "Which project?" }],
            canConfirm: false,
            canHand: false,
            canReassign: false,
          }),
          proposal({ id: P4, canConfirm: false, canHand: false }),
        ]);
      },
    });
    const items = await mail.listMailDecisions();
    expect(items.map((v) => v.proposal.id).sort()).toEqual([P1, P2, P3].sort());
    expect(items.find((v) => v.proposal.id === P1)!.origin).toMatchObject({ kind: "email", threadId: `${ACC}_t-1` });
    expect(seen.map((r) => query(r.path).get("status")).sort()).toEqual(["handed", "open"]);
  });
});

describe("le proposte condivise: confermare e ignorare", () => {
  const confirm = (body: unknown = { status: "confirmed", results: [{ kind: "task", id: "x", code: "AUD-12" }] }) => ({
    [`POST /api/me/mail/proposals/${P1}/confirm`]: { body },
  });

  it("tutta: nessun indice; il codice nato", async () => {
    const { seen } = installFakeServer(confirm());
    expect(await mail.confirmMailProposal(P1, {})).toEqual({ status: "confirmed", resultCodes: ["AUD-12"] });
    expect(seen[0]!.body).toEqual({});
  });

  it("in parte e coi campi cambiati: gli indici e le modifiche per indice", async () => {
    const { seen } = installFakeServer(confirm());
    await mail.confirmMailProposal(P1, { actionIndexes: [0], edits: { 0: { title: "Export XLSX" } } });
    expect(seen[0]!.body).toEqual({ indices: [0], edits: { 0: { title: "Export XLSX" } } });
  });

  it("le modifiche d'una scadenza o d'un commento coi nomi del server", async () => {
    const { seen } = installFakeServer(confirm());
    await mail.confirmMailProposal(P1, { edits: { 1: { patch: { dueDate: "2026-11-22" } }, 2: { body: "Ok" } } });
    expect(seen[0]!.body).toEqual({ edits: { 1: { patch: { dueDate: "2026-11-22" } }, 2: { body: "Ok" } } });
  });

  it("un'azione che fallisce: non riuscita, col motivo (tutto o niente)", async () => {
    installFakeServer(confirm({ status: "failed", error: "ticket_gone" }));
    expect(await mail.confirmMailProposal(P1, {})).toEqual({ status: "failed", error: "ticket_gone" });
  });

  it("già decisa da altri: `already_handled` con chi", async () => {
    installFakeServer({
      [`POST /api/me/mail/proposals/${P1}/confirm`]: {
        status: 409,
        body: { code: "already_handled", message: "x", decidedBy: { userId: CARLA, name: "Carla" } },
      },
    });
    await expect(mail.confirmMailProposal(P1, {})).rejects.toMatchObject({ message: "already_handled", byId: CARLA });
  });

  it("i rifiuti del server: permesso, incaricato fuori dal progetto, campi, selezione, bersaglio", async () => {
    const cases: [number, string, string][] = [
      [403, "forbidden", "forbidden"],
      [400, "invalid_assignee", "invalid: assignee"],
      [400, "invalid_edits", "invalid: edits"],
      [400, "invalid_selection", "invalid: selection"],
      [400, "invalid_target", "invalid: target"],
    ];
    for (const [status, code, error] of cases) {
      installFakeServer({ [`POST /api/me/mail/proposals/${P1}/confirm`]: { status, body: { code, message: "x" } } });
      await expect(mail.confirmMailProposal(P1, {})).rejects.toThrow(error);
    }
  });

  it("«Ignora»", async () => {
    const { seen } = installFakeServer({ [`POST /api/me/mail/proposals/${P1}/ignore`]: { body: { status: "ignored" } } });
    await mail.ignoreMailProposal(P1);
    expect(seen.map((r) => r.path)).toEqual([`/api/me/mail/proposals/${P1}/ignore`]);
  });
});

describe("passare, spostare, scegliere il progetto, aggiungere i Contributor", () => {
  it("«Passa al progetto»", async () => {
    const { seen } = installFakeServer({ [`POST /api/me/mail/proposals/${P1}/hand`]: { body: { status: "handed" } } });
    await mail.handMailProposal(P1);
    expect(seen.map((r) => r.path)).toEqual([`/api/me/mail/proposals/${P1}/hand`]);
  });

  it("«Sposta su un altro progetto», col progetto", async () => {
    const { seen } = installFakeServer({
      [`POST /api/me/mail/proposals/${P1}/reassign`]: { body: { status: "moved", projectId: OTHER } },
    });
    await mail.reassignMailProposal(P1, OTHER);
    expect(seen[0]!.body).toEqual({ projectId: OTHER });
  });

  it("«Quale progetto?»: la scelta va al server", async () => {
    const { seen } = installFakeServer({
      [`POST /api/me/mail/proposals/${P1}/choose-project`]: { body: { status: "moved", projectId: OTHER } },
    });
    await mail.chooseProjectFor(P1, OTHER);
    expect(seen[0]!.body).toEqual({ projectId: OTHER });
  });

  it("già decisa da altri, anche per «Passa»: `already_handled` con chi", async () => {
    installFakeServer({
      [`POST /api/me/mail/proposals/${P1}/hand`]: { status: 409, body: { code: "already_handled", message: "x", decidedBy: { userId: CARLA, name: "Carla" } } },
    });
    await expect(mail.handMailProposal(P1)).rejects.toMatchObject({ message: "already_handled", byId: CARLA });
  });

  it("con gli incaricati fuori dal progetto: la rotta che li aggiunge come Contributor", async () => {
    const { seen } = installFakeServer({
      [`POST /api/me/mail/proposals/${P1}/confirm-with-members`]: { body: { status: "confirmed", results: [] } },
    });
    expect(await mail.confirmMailProposal(P1, { actionIndexes: [0], addOutsiders: [OTHER] })).toEqual({ status: "confirmed", resultCodes: [] });
    expect(seen[0]!.body).toEqual({ indices: [0], addOutsiders: [OTHER] });
  });

  it("aggiungere i Contributor chiede la riconferma: il rifiuto che `useReauth` riconosce", async () => {
    installFakeServer({
      [`POST /api/me/mail/proposals/${P1}/confirm-with-members`]: { status: 403, body: { code: "reauth_required", message: "x" } },
    });
    expect(await mail.confirmMailProposal(P1, { addOutsiders: [OTHER] })).toEqual({ status: "refused", ok: false, error: "reauth_required" });
  });

  it("le regole di Membri (escalation, sopra di me): rifiutata, niente cambia", async () => {
    installFakeServer({
      [`POST /api/me/mail/proposals/${P1}/confirm-with-members`]: { status: 403, body: { code: "escalation", message: "x", permission: "project.members.manage" } },
    });
    expect(await mail.confirmMailProposal(P1, { addOutsiders: [OTHER] })).toEqual({ status: "refused", ok: false, error: "escalation", missing: ["project.members.manage"] });
  });
});
