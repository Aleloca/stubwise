import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import { installFakeServer, me, ME_ID, PROJECT_ID, serverProject, type SeenRequest } from "./fakeServer";

// Scrivere nella Posta della build app (area 6, fetta 3), davanti a un server
// finto: Rispondi, la bozza indirizzata dal server, Invia coi 10 s del
// server e «Annulla»; l'email nuova resta sull'elenco finché Gmail non le dà
// una conversazione. La bozza di Claude è spenta finché non c'è il suo SSE.
//
// (Dalla fetta 1:) la
// posta TRATTATA per conversazione, la lettura col corpo originale, le
// proposte della casella accanto al messaggio d'origine, letto/non letto con
// Gmail. Nascosti: scrivere (F3), l'importanza (F2), modificare i campi di
// una proposta (F2). Un allegato si apre da Gmail.
vi.mock("@backend/api", async () => await import("./index"));

const ACC = "aaaaaaaa-1111-4111-8111-111111111111";
const M1 = "dddddddd-1111-4111-8111-111111111111";
const P1 = "cccccccc-1111-4111-8111-111111111111";
const KEY = `${ACC}_t-1`;
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
  editable: true,
  origin: { threadId: "t-1", accountId: ACC, from: "Bob Rossi <bob@client.test>", subject: "Preventivo Rossi" },
};

let seen: SeenRequest[] = [];
const DRAFT = "dfdfdfdf-1111-4111-8111-111111111111";
const OUT = "0f0f0f0f-1111-4111-8111-111111111111";
let saved: unknown[] = [];
let newEmail = false;
let changedInGmail = false;
let threads: unknown[] = [];
let proposals: unknown[] = [];
let confirmAnswer: { status?: number; body: unknown } = { body: {} };
/** Come risponde Gmail (via server) a «letto / non letto». */
let readAnswer: { status?: number; body: unknown } = { body: detail };

beforeEach(() => {
  saved = [];
  newEmail = false;
  changedInGmail = false;
  threads = [thread];
  proposals = [proposal];
  confirmAnswer = { body: { status: "confirmed", results: [{ kind: "request", id: "r", code: "AUD-R9" }] } };
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
    [`POST /api/me/mail/proposals/${P1}/choose-project`]: { body: { status: "moved", projectId: PROJECT_ID } },
    [`POST /api/me/mail/proposals/${P1}/confirm`]: () => confirmAnswer,
    "GET /api/me/google/accounts": { body: [account] },
    "GET /api/me/mail/threads": () => ({ body: { items: threads, nextCursor: null } }),
    "GET /api/me/mail/threads/t-1": { body: detail },
    [`GET /api/me/mail/email_triage/${M1}/original`]: {
      body: { subject: "Preventivo Rossi", from: "Bob Rossi <bob@client.test>", to: [], cc: [], bodyText: null, bodyHtml: null, attachments: [{ filename: "preventivo.pdf", mimeType: "application/pdf" }] },
    },
    "POST /api/me/mail/threads/t-1/read": () => readAnswer,
    "GET /api/me/mail/drafts": { body: { items: [] } },
    "GET /api/me/mail/drafts/compose": (req) => {
      const q = new URLSearchParams(req.path.split("?")[1] ?? "");
      const isNew = q.get("mode") === "new";
      return {
        body: {
          id: null,
          accountId: ACC,
          threadId: isNew ? null : "t-1",
          mode: q.get("mode"),
          replyToMessageId: isNew ? null : M1,
          to: isNew ? [] : [{ email: "bob@client.test", name: "Bob Rossi" }],
          cc: [],
          subject: isNew ? "" : "Re: Preventivo Rossi",
          body: "",
          attachments: [],
          quote: true,
          updatedAt: null,
        },
      };
    },
    "PUT /api/me/mail/drafts": (req) => {
      saved.push(req.body);
      if (changedInGmail && !(req.body as { overwrite?: boolean }).overwrite) {
        return { status: 409, body: { code: "draft_changed", message: "x" } };
      }
      const b = req.body as Record<string, unknown>;
      return { body: { ...b, id: DRAFT, attachments: [], updatedAt: new Date().toISOString() } };
    },
    [`POST /api/me/mail/drafts/${DRAFT}/send`]: () => ({
      status: 202,
      body: { messageId: OUT, threadId: newEmail ? null : "t-1", state: "queued", undoUntil: new Date(Date.now() + 10_000).toISOString(), error: null, sentAt: null },
    }),
    [`POST /api/me/mail/outgoing/${OUT}/undo`]: { body: { draft: null, droppedAttachments: [] } },
    [`GET /api/me/mail/outgoing/${OUT}`]: { body: { messageId: OUT, threadId: "t-1", state: "queued", undoUntil: new Date(Date.now() + 10_000).toISOString(), error: null, sentAt: null } },
    "GET /api/me/mail/recipients": { body: { items: [] } },
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

describe("scrivere nella Posta della build app", () => {
  it("Rispondi: la bozza indirizzata dal server; Invia la salva e la manda, coi 10 s dell'«Annulla»", async () => {
    renderRoute(`/mail/${KEY}`);
    await screen.findByText("Ecco il preventivo per la consegna.");
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const form = await screen.findByRole("form", { name: /Reply to Bob Rossi/ });
    expect(within(form).getByRole("list", { name: "To" })).toHaveTextContent("Bob Rossi");
    fireEvent.change(within(form).getByRole("textbox", { name: "Message" }), { target: { value: "Ricevuto, grazie." } });
    fireEvent.click(within(form).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(seen.some((r) => r.method === "POST" && r.path === `/api/me/mail/drafts/${DRAFT}/send`)).toBe(true));
    expect(saved.at(-1)).toMatchObject({ accountId: ACC, threadId: "t-1", mode: "reply", body: "Ricevuto, grazie." });
    expect(await screen.findByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("la bozza di Claude non c'è ancora", async () => {
    renderRoute(`/mail/${KEY}`);
    await screen.findByText("Ecco il preventivo per la consegna.");
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const form = await screen.findByRole("form", { name: /Reply to Bob Rossi/ });
    expect(within(form).queryByRole("button", { name: /Claude/ })).toBeNull();
  });

  it("l'email nuova: dopo Invia si resta sull'elenco, con «Annulla» (la conversazione arriva quando Gmail la crea)", async () => {
    newEmail = true;
    const router = renderRoute("/mail");
    fireEvent.click(await screen.findByRole("button", { name: /New email/ }));
    const form = await screen.findByRole("form", { name: /New email/ });
    const to = within(form).getByRole("combobox", { name: "To" });
    fireEvent.change(to, { target: { value: "bob@client.test" } });
    fireEvent.keyDown(to, { key: "Enter" });
    fireEvent.change(within(form).getByRole("textbox", { name: "Subject" }), { target: { value: "Ciao" } });
    fireEvent.change(within(form).getByRole("textbox", { name: "Message" }), { target: { value: "Una domanda." } });
    fireEvent.click(within(form).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(seen.some((r) => r.method === "POST" && r.path === `/api/me/mail/drafts/${DRAFT}/send`)).toBe(true));
    expect(await screen.findByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/mail");
  });

  it("una bozza cambiata su Gmail nel frattempo: lo dice; «Tieni la mia» la scrive sopra", async () => {
    changedInGmail = true;
    renderRoute(`/mail/${KEY}`);
    await screen.findByText("Ecco il preventivo per la consegna.");
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const form = await screen.findByRole("form", { name: /Reply to Bob Rossi/ });
    fireEvent.change(within(form).getByRole("textbox", { name: "Message" }), { target: { value: "La mia versione." } });
    expect(await within(form).findByText("This draft was changed in Gmail.", {}, { timeout: 4000 })).toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "Open in Gmail" })).toBeInTheDocument();
    fireEvent.click(within(form).getByRole("button", { name: "Keep mine" }));
    await waitFor(() => expect(saved.at(-1)).toMatchObject({ body: "La mia versione.", overwrite: true }));
    await waitFor(() => expect(within(form).queryByText("This draft was changed in Gmail.")).toBeNull());
  });
});

