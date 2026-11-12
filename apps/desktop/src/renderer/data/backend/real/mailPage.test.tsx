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
const KEY = `${ACC}_t-1`;
const KEY2 = `${ACC}_t-2`;
const M2 = "dddddddd-2222-4222-8222-222222222222";

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

/** La proposta condivisa del messaggio (`/api/me/mail/proposals`, area 6 F2). */
const proposal = {
  id: P1,
  messageId: M1,
  projectId: PROJECT_ID,
  status: "open",
  createdAt: "2026-10-23T09:05:00.000Z",
  excerpt: "Ecco il preventivo per la consegna.",
  actions: [
    { type: "create_backlog_item", args: { title: "Preventivo Rossi", description: "" }, label: "Create the request «Preventivo Rossi»" },
    { type: "create_milestone", args: { name: "Consegna", dueDate: "2026-11-20" }, label: "Add a milestone «Consegna»" },
  ],
  canConfirm: true,
  canHand: false,
  canReassign: false,
  origin: { threadId: "t-1", accountId: ACC, from: "Bob Rossi <bob@client.test>", subject: "Preventivo Rossi" },
};

let seen: SeenRequest[] = [];
let threads: unknown[] = [];
let proposals: unknown[] = [];
/** Come risponde Gmail (via server) a «letto / non letto». */
let readAnswer: { status?: number; body: unknown } = { body: detail };

beforeEach(() => {
  threads = [thread];
  proposals = [proposal];
  readAnswer = { body: detail };
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  seen = installFakeServer({
    "GET /api/auth/me": { body: me() },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
    "GET /api/me/follows": { body: { projectIds: [PROJECT_ID] } },
    "GET /api/people": { body: [{ id: ME_ID, name: "Ada", initials: "AD", departmentIds: [], email: "ada@example.com" }] },
    "GET /api/departments": { body: [] },
    "GET /api/inbox": { body: { items: [], nextCursor: null } },
    "GET /api/me/mail/proposals": () => ({ body: { items: proposals } }),
    [`POST /api/me/mail/proposals/${P1}/confirm`]: { body: { status: "confirmed", results: [{ kind: "request", id: "r", code: "AUD-R9" }] } },
    "GET /api/me/google/accounts": { body: [account] },
    "GET /api/me/mail/threads": () => ({ body: { items: threads, nextCursor: null } }),
    "GET /api/me/mail/threads/t-1": { body: detail },
    [`GET /api/me/mail/email_triage/${M1}/original`]: {
      body: { subject: "Preventivo Rossi", from: "Bob Rossi <bob@client.test>", to: [], cc: [], bodyText: null, bodyHtml: null, attachments: [{ filename: "preventivo.pdf", mimeType: "application/pdf" }] },
    },
    "POST /api/me/mail/threads/t-1/read": () => readAnswer,
    "GET /api/me/mail/threads/t-2": { body: { ...detail, threadId: "t-2", messages: [{ ...detail.messages[0], id: M2, unread: true }] } },
    [`GET /api/me/mail/email_triage/${M2}/original`]: { status: 404, body: { code: "not_found", message: "x" } },
    "POST /api/me/mail/threads/t-2/read": () => readAnswer,
    "GET /api/me/google/workspaces": { body: [] },
  }).seen;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("la Posta nella build app", () => {
  it("l'elenco per conversazione; niente «Nuova email»", async () => {
    renderRoute("/mail");
    expect(await screen.findByText("Preventivo Rossi")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New email/ })).toBeNull();
  });

  it("F2: «Importanti», il filtro per importanza e l'importanza sulla riga", async () => {
    threads = [{ ...thread, importance: "high", unread: true }];
    renderRoute("/mail");
    expect(await screen.findByText("Preventivo Rossi")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /^Important/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Importance/ })).toBeInTheDocument();
    expect(screen.getAllByTitle("High importance").length).toBeGreaterThan(0);
  });

  it("una conversazione: il messaggio, la proposta della casella accanto, nessuna risposta; «Apri in Gmail» apre Gmail", async () => {
    const open = vi.fn();
    window.open = open as never;
    renderRoute(`/mail/${KEY}`);
    expect(await screen.findByText("Ecco il preventivo per la consegna.")).toBeInTheDocument();
    expect(await screen.findByText(/Create request in AUD: “Preventivo Rossi”/)).toBeInTheDocument();
    expect(screen.getByText(/Create milestone in AUD: “Consegna”/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Reply/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Forward/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open in Gmail" }));
    expect(open).toHaveBeenCalledWith("https://mail.google.com/mail/#all/t-1", "_blank", "noopener");
  });

  it("«Conferma» decide la proposta sul server, con tutte le sue azioni", async () => {
    renderRoute(`/mail/${KEY}`);
    await screen.findByText(/Create request in AUD: “Preventivo Rossi”/);
    fireEvent.click(screen.getByRole("button", { name: /^Confirm/ }));
    await waitFor(() =>
      expect(seen.find((r) => r.method === "POST" && r.path === `/api/me/mail/proposals/${P1}/confirm`)?.body).toEqual({}),
    );
  });

  it("F2: un campo cambiato prima di confermare va al server con la conferma", async () => {
    renderRoute(`/mail/${KEY}`);
    await screen.findByText(/Create request in AUD: “Preventivo Rossi”/);
    fireEvent.click(screen.getByRole("button", { name: "Edit line 1" }));
    const title = await screen.findByLabelText("Title");
    fireEvent.change(title, { target: { value: "Preventivo Rossi v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: /^Confirm/ }));
    await waitFor(() =>
      // La riga modificata manda i suoi campi; quello cambiato col valore nuovo.
      expect(seen.find((r) => r.method === "POST" && r.path === `/api/me/mail/proposals/${P1}/confirm`)?.body).toMatchObject({
        edits: { 0: { title: "Preventivo Rossi v2" } },
      }),
    );
  });

  it("F2: una decisione da registrare senza titolo dice la frase del server", async () => {
    proposals = [{ ...proposal, actions: [{ type: "record_decision", args: {}, label: "Record the decision on the quote" }] }];
    renderRoute(`/mail/${KEY}`);
    expect(await screen.findByText(/Record the decision on the quote/)).toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).toBeNull();
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

  it("«Segna come non letta» senza il permesso nuovo: lo dice, con «Ricollega» che apre il cassetto", async () => {
    readAnswer = { status: 409, body: { code: "google_scope_missing", message: "x", missing: ["https://www.googleapis.com/auth/gmail.modify"] } };
    renderRoute(`/mail/${KEY}`);
    await screen.findByText("Ecco il preventivo per la consegna.");
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Mark as unread/ }));
    const alert = await screen.findByText("Reconnect your Google account to keep read and unread in step with Gmail.");
    fireEvent.click(within(alert.closest("[role=alert]") as HTMLElement).getByRole("button", { name: "Reconnect" }));
    expect(await screen.findByRole("dialog", { name: "Google account" })).toBeInTheDocument();
  });

  it("Gmail occupato: «riprova fra poco»", async () => {
    readAnswer = { status: 503, body: { code: "google_rate_limited", message: "x" } };
    renderRoute(`/mail/${KEY}`);
    await screen.findByText("Ecco il preventivo per la consegna.");
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Mark as unread/ }));
    expect(await screen.findByText("Gmail is busy. Try again in a moment.")).toBeInTheDocument();
  });

  it("la lettura automatica che non riesce lo dice UNA volta per casella, non a ogni apertura", async () => {
    readAnswer = { status: 409, body: { code: "google_scope_missing", message: "x" } };
    const router = renderRoute(`/mail/${KEY2}`);
    expect(await screen.findByText("Reconnect your Google account to keep read and unread in step with Gmail.", {}, { timeout: 3000 })).toBeInTheDocument();
    await waitFor(() => expect(seen.filter((r) => r.path === "/api/me/mail/threads/t-2/read")).toHaveLength(1));
    await router.navigate({ to: "/mail" } as never);
    await router.navigate({ to: `/mail/${KEY2}` } as never);
    await waitFor(() => expect(seen.filter((r) => r.path === "/api/me/mail/threads/t-2/read")).toHaveLength(2), { timeout: 3000 });
    expect(screen.getAllByText("Reconnect your Google account to keep read and unread in step with Gmail.")).toHaveLength(1);
  });
});
