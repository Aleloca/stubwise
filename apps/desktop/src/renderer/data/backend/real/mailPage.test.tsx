import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import { installFakeServer, me, ME_ID, PROJECT_ID, serverProject, type SeenRequest } from "./fakeServer";

// La Posta nella build app (area 6, fetta 1), davanti a un server finto: la
// posta TRATTATA per conversazione, la lettura col corpo originale, le
// proposte della casella accanto al messaggio d'origine, letto/non letto con
// Gmail. Nascosti: scrivere (F3), l'importanza (F2), modificare i campi di
// una proposta (F2). Un allegato si apre da Gmail.
vi.mock("@backend/api", async () => await import("./index"));

const ACC = "aaaaaaaa-1111-4111-8111-111111111111";
const M1 = "dddddddd-1111-4111-8111-111111111111";
const P1 = "cccccccc-1111-4111-8111-111111111111";
const N1 = "9a9a9a9a-1111-4111-8111-111111111111";
const KEY = `${ACC}_t-1`;

const account = {
  id: ACC,
  email: "ada@acme.test",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  workspaceName: "Acme",
  scopes: [],
  proposalsEnabled: true,
  connectedAt: "2026-10-01T09:00:00.000Z",
  lastSyncAt: new Date().toISOString(),
  disabledAt: null,
  disabledReason: null,
  missingScopes: [],
  syncRequestedAt: null,
};

const thread = {
  threadId: "t-1",
  accountId: ACC,
  accountEmail: "ada@acme.test",
  subject: "Preventivo Rossi",
  lastFrom: "Bob Rossi <bob@client.test>",
  lastReceivedAt: "2026-10-23T09:00:00.000Z",
  messageCount: 1,
  openProposals: 1,
  projectNames: ["Audin AI"],
  unread: false,
};

const detail = {
  threadId: "t-1",
  accountId: ACC,
  accountEmail: "ada@acme.test",
  subject: "Preventivo Rossi",
  url: "https://mail.google.com/mail/#all/t-1",
  messages: [
    {
      id: M1,
      from: "Bob Rossi <bob@client.test>",
      to: ["ada@acme.test"],
      receivedAt: "2026-10-23T09:00:00.000Z",
      textExcerpt: "Ecco il preventivo per la consegna.",
      admitted: true,
      proposalIds: [P1],
      reproposals: [],
      proposalOutcomes: [],
      unread: false,
    },
  ],
};

const card = {
  id: N1,
  kind: "google.proposal",
  status: "open",
  text: "New proposal from Bob — Preventivo Rossi",
  actions: ["open", "snooze", "handled"],
  question: {
    questionId: "7a7a7a7a-1111-4111-8111-111111111111",
    question: "What should Stubwise do?",
    options: [
      { label: "Create the request «Preventivo Rossi»" },
      { label: "Add a milestone «Consegna»" },
      { label: "Do nothing" },
    ],
    allowFreeText: false,
  },
  google: {
    source: "email",
    from: "Bob Rossi <bob@client.test>",
    subject: "Preventivo Rossi",
    signal: "request",
    actions: [{ type: "create_backlog_item" }, { type: "create_milestone" }, { type: "ignore" }],
    proposalId: P1,
    sourceProposalId: P1,
    multiSelectIndices: [0, 1],
    decision: null,
    blockedIndices: [],
    handed: false,
  },
  projectId: PROJECT_ID,
  ticketId: null,
  jobId: null,
  createdAt: "2026-10-23T09:05:00.000Z",
  readAt: null,
  snoozedUntil: null,
  handledAt: null,
  handledBy: null,
};

let seen: SeenRequest[] = [];

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  seen = installFakeServer({
    "GET /api/auth/me": { body: me() },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
    "GET /api/me/follows": { body: { projectIds: [PROJECT_ID] } },
    "GET /api/people": { body: [{ id: ME_ID, name: "Ada", initials: "AD", departmentIds: [], email: "ada@example.com" }] },
    "GET /api/departments": { body: [] },
    "GET /api/inbox": (req) =>
      new URLSearchParams(req.path.split("?")[1] ?? "").get("status") === "open"
        ? { body: { items: [card], nextCursor: null } }
        : { body: { items: [], nextCursor: null } },
    [`POST /api/inbox/${N1}/actions/answer`]: { body: { kind: "google.proposal", changedNotificationIds: [N1] } },
    "GET /api/me/google/accounts": { body: [account] },
    "GET /api/me/mail/threads": { body: { items: [thread], nextCursor: null } },
    "GET /api/me/mail/threads/t-1": { body: detail },
    [`GET /api/me/mail/email/${M1}/original`]: {
      body: { subject: "Preventivo Rossi", from: "Bob Rossi <bob@client.test>", to: [], cc: [], bodyText: null, bodyHtml: null, attachments: [{ filename: "preventivo.pdf", mimeType: "application/pdf" }] },
    },
    "POST /api/me/mail/threads/t-1/read": { body: detail },
  }).seen;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("la Posta nella build app", () => {
  it("l'elenco per conversazione; niente «Nuova email» né «Importanti»", async () => {
    renderRoute("/mail");
    expect(await screen.findByText("Preventivo Rossi")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New email/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /^Important/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Importance/ })).toBeNull();
  });

  it("una conversazione: il messaggio, la proposta della casella accanto, nessuna risposta; «Apri in Gmail» apre Gmail", async () => {
    const open = vi.fn();
    window.open = open as never;
    renderRoute(`/mail/${KEY}`);
    expect(await screen.findByText("Ecco il preventivo per la consegna.")).toBeInTheDocument();
    expect(await screen.findByText(/Create the request «Preventivo Rossi»/)).toBeInTheDocument();
    expect(screen.getByText(/Add a milestone «Consegna»/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Reply/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Forward/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open in Gmail" }));
    expect(open).toHaveBeenCalledWith("https://mail.google.com/mail/#all/t-1", "_blank", "noopener");
  });

  it("«Conferma» decide la proposta sul server, con tutte le sue azioni", async () => {
    renderRoute(`/mail/${KEY}`);
    await screen.findByText(/Create the request «Preventivo Rossi»/);
    fireEvent.click(screen.getByRole("button", { name: /^Confirm/ }));
    await waitFor(() =>
      expect(seen.find((r) => r.method === "POST" && r.path === `/api/inbox/${N1}/actions/answer`)?.body).toEqual({ optionIndices: [0, 1] }),
    );
  });

  it("«Segna come non letta» scrive su Gmail", async () => {
    renderRoute(`/mail/${KEY}`);
    await screen.findByText("Ecco il preventivo per la consegna.");
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Mark as unread/ }));
    await waitFor(() =>
      expect(seen.find((r) => r.path === "/api/me/mail/threads/t-1/read")?.body).toEqual({ account: ACC, read: false }),
    );
  });

  it("un allegato si apre da Gmail; niente «Salva nel Drive»", async () => {
    const open = vi.fn();
    window.open = open as never;
    renderRoute(`/mail/${KEY}`);
    const attachment = await screen.findByRole("button", { name: /preventivo\.pdf/ });
    expect(screen.queryByRole("button", { name: /Save to Drive/ })).toBeNull();
    fireEvent.click(attachment);
    expect(open).toHaveBeenCalledWith("https://mail.google.com/mail/#all/t-1", "_blank", "noopener");
    expect(within(document.body).queryByText(/The prototype stays in Stubwise|opens from Gmail/)).toBeNull();
  });
});
