import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session, setAppClientForTests } from "./client";
import { installFakeServer, ME_ID, PROJECT_ID } from "./fakeServer";
import { mail } from "./mail";

// Le proposte accanto all'email nella build app (area 6, fetta 1): le card
// `google.proposal` di `/api/inbox`, PER CASELLA (`mailbox_owner`). Ogni
// azione è un'opzione della card (la sua etichetta viene dal server); più
// azioni del modello si confermano insieme (`optionIndices`). Niente modifica
// dei campi né incaricati fuori dal progetto (F2).

const N1 = "9a9a9a9a-1111-4111-8111-111111111111";
const P1 = "cccccccc-1111-4111-8111-111111111111";
const P2 = "cccccccc-2222-4222-8222-222222222222";
const OTHER = "22222222-3333-4333-8333-333333333333";

const card = (over: Record<string, unknown> = {}, google: Record<string, unknown> = {}) => ({
  id: N1,
  kind: "google.proposal",
  status: "open",
  text: "New proposal from Bob — Preventivo",
  actions: ["open", "snooze", "handled"],
  question: {
    questionId: "7a7a7a7a-1111-4111-8111-111111111111",
    question: "What should Stubwise do?",
    options: [
      { label: "Create the request «Preventivo Rossi»" },
      { label: "Add a milestone «Consegna» on Nov 20" },
      { label: "Move to another project" },
      { label: "Do nothing" },
    ],
    allowFreeText: false,
  },
  google: {
    source: "email",
    from: "Bob Rossi <bob@client.test>",
    subject: "Preventivo",
    signal: "request",
    actions: [{ type: "create_backlog_item" }, { type: "create_milestone" }, { type: "reassign_project" }, { type: "ignore" }],
    proposalId: P1,
    sourceProposalId: P1,
    multiSelectIndices: [0, 1],
    decision: null,
    blockedIndices: [],
    handed: false,
    ...google,
  },
  projectId: PROJECT_ID,
  ticketId: null,
  jobId: null,
  createdAt: "2026-11-12T08:05:00.000Z",
  readAt: null,
  snoozedUntil: null,
  handledAt: null,
  handledBy: null,
  ...over,
});

const inbox = (open: unknown[], handled: unknown[] = []) => ({
  "GET /api/inbox": (req: { path: string }) => {
    const status = new URLSearchParams(req.path.split("?")[1] ?? "").get("status");
    return { body: { items: status === "handled" ? handled : status === "open" ? open : [], nextCursor: null } };
  },
});
const answered = () => ({ status: 200, body: { kind: "google.proposal", changedNotificationIds: [N1] } });

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

describe("le proposte della Posta: lettura", () => {
  it("una card aperta: le azioni del modello con l'etichetta del server, confermabile, spostabile", async () => {
    installFakeServer(inbox([card()]));
    const [v] = await mail.listMailProposals({});
    expect(v!.proposal).toMatchObject({
      id: N1,
      source: "email",
      sourceId: P1,
      projectId: PROJECT_ID,
      status: "open",
      excerpt: "",
      createdAt: "2026-11-12T08:05:00.000Z",
      decidedById: null,
      error: null,
    });
    expect(v!.proposal.actions).toEqual([
      { fn: "createRequest", args: {}, summary: "Create the request «Preventivo Rossi»" },
      { fn: "createMilestone", args: {}, summary: "Add a milestone «Consegna» on Nov 20" },
    ]);
    expect(v).toMatchObject({ canConfirm: true, canHand: false, canReassign: true, outsiders: [], sharedWith: [], decidedBy: null });
  });

  it("chi non ha il permesso di un'azione nel progetto la PASSA: «Passa al progetto», non conferma", async () => {
    installFakeServer(inbox([card({ actions: ["open", "snooze", "handled", "hand_to_project"] }, { blockedIndices: [1] })]));
    const [v] = await mail.listMailProposals({});
    expect(v).toMatchObject({ canConfirm: false, canHand: true });
  });

  it("decise: confermata (con le azioni scelte), ignorata, fallita, passata; chi ha deciso", async () => {
    installFakeServer(
      inbox(
        [],
        [
          card({ status: "handled", handledAt: "2026-11-12T09:00:00.000Z", handledBy: { id: ME_ID, email: "ada@acme.test" } }, { decision: { status: "actioned", chosen: ["Add a milestone «Consegna» on Nov 20"], error: null } }),
          card({ id: "9a9a9a9a-2222-4222-8222-222222222222", status: "handled" }, { sourceProposalId: P2, decision: { status: "failed", chosen: [], error: "ticket_gone" } }),
          card({ id: "9a9a9a9a-3333-4333-8333-333333333333", status: "handled" }, { decision: { status: "ignored", chosen: [], error: null } }),
          card({ id: "9a9a9a9a-4444-4444-8444-444444444444", status: "handled" }, { handed: true }),
        ],
      ),
    );
    const list = await mail.listMailProposals({});
    expect(list.map((v) => v.proposal.status)).toEqual(["confirmed", "failed", "ignored", "handed"]);
    expect(list[0]!.proposal).toMatchObject({ confirmedActions: [1], decidedById: ME_ID, decidedAt: "2026-11-12T09:00:00.000Z" });
    expect(list[0]!.decidedBy).toEqual({ personId: ME_ID, name: "ada@acme.test" });
    expect(list[1]!.proposal.error).toBe("ticket_gone");
  });

  it("filtri: per proposta d'origine (`sourceId`) e per stato; il calendario non è della Posta", async () => {
    installFakeServer(
      inbox([
        card(),
        card({ id: "9a9a9a9a-2222-4222-8222-222222222222" }, { sourceProposalId: P2 }),
        card({ id: "9a9a9a9a-5555-4555-8555-555555555555" }, { source: "calendar", sourceProposalId: null }),
      ]),
    );
    expect((await mail.listMailProposals({ sourceId: P2 })).map((v) => v.proposal.id)).toEqual(["9a9a9a9a-2222-4222-8222-222222222222"]);
    expect(await mail.listMailProposals({ status: "confirmed" })).toEqual([]);
    expect(await mail.listMailProposals({})).toHaveLength(2);
  });

  it("una proposta per id; una che non c'è è `not_found`", async () => {
    installFakeServer(inbox([card()]));
    expect((await mail.getMailProposal(N1)).proposal.id).toBe(N1);
    await expect(mail.getMailProposal(OTHER)).rejects.toThrow("not_found");
  });
});

describe("le proposte della Posta in «Da decidere» della Home", () => {
  it("le aperte che posso confermare o passare; non le decise", async () => {
    installFakeServer(
      inbox(
        [card(), card({ id: "9a9a9a9a-2222-4222-8222-222222222222", actions: ["open", "hand_to_project"] }, { blockedIndices: [0] })],
        [card({ id: "9a9a9a9a-3333-4333-8333-333333333333", status: "handled" }, { decision: { status: "ignored", chosen: [], error: null } })],
      ),
    );
    const list = await mail.listMailDecisions();
    expect(list.map((v) => v.proposal.id)).toEqual([N1, "9a9a9a9a-2222-4222-8222-222222222222"]);
    expect(list.every((v) => v.origin === null)).toBe(true);
  });
});

describe("le proposte della Posta: decidere", () => {
  it("confermare tutte le azioni: le loro opzioni insieme", async () => {
    const { seen } = installFakeServer({ ...inbox([card()]), [`POST /api/inbox/${N1}/actions/answer`]: answered() });
    await mail.listMailProposals({});
    expect(await mail.confirmMailProposal(N1, {})).toEqual({ status: "confirmed", resultCodes: [] });
    expect(seen.find((r) => r.method === "POST")!.body).toEqual({ optionIndices: [0, 1] });
  });

  it("confermarne una sola: la sua opzione", async () => {
    const { seen } = installFakeServer({ ...inbox([card()]), [`POST /api/inbox/${N1}/actions/answer`]: answered() });
    await mail.confirmMailProposal(N1, { actionIndexes: [1] });
    expect(seen.find((r) => r.method === "POST")!.body).toEqual({ optionIndex: 1 });
  });

  it("modificare i campi non c'è (F2): `invalid: edits`, senza decidere", async () => {
    const { seen } = installFakeServer(inbox([card()]));
    await expect(mail.confirmMailProposal(N1, { edits: { 0: { title: "x" } } })).rejects.toThrow("invalid: edits");
    expect(seen.some((r) => r.method === "POST")).toBe(false);
  });

  it("già decisa da altri (409 `already_handled`): non riuscita, con il motivo", async () => {
    installFakeServer({
      ...inbox([card()]),
      [`POST /api/inbox/${N1}/actions/answer`]: { status: 409, body: { code: "already_handled", message: "x" } },
    });
    expect(await mail.confirmMailProposal(N1, {})).toEqual({ status: "failed", error: "already_handled" });
  });

  it("«Ignora» è l'opzione «non fare nulla»; «Passa al progetto» l'azione della card; «Sposta» col progetto", async () => {
    const { seen } = installFakeServer({
      ...inbox([card()]),
      [`POST /api/inbox/${N1}/actions/answer`]: answered(),
      [`POST /api/inbox/${N1}/actions/hand_to_project`]: answered(),
    });
    await mail.ignoreMailProposal(N1);
    await mail.handMailProposal(N1);
    await mail.reassignMailProposal(N1, OTHER);
    expect(seen.filter((r) => r.method === "POST").map((r) => [r.path, r.body])).toEqual([
      [`/api/inbox/${N1}/actions/answer`, { optionIndex: 3 }],
      [`/api/inbox/${N1}/actions/hand_to_project`, undefined],
      [`/api/inbox/${N1}/actions/answer`, { optionIndex: 2, projectId: OTHER }],
    ]);
  });
});
