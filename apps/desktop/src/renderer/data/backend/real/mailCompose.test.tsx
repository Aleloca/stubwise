import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { forgetUnsavedDraftsForTests } from "../../../pages/mail/composeRequest";
import { setAppClientForTests } from "./client";
import { installFakeServer, me, ME_ID, PROJECT_ID, serverProject, type SeenRequest } from "./fakeServer";

// Scrivere nella Posta della build app (area 6, fetta 3), davanti a un server
// finto: Rispondi, la bozza indirizzata dal server, Invia coi 10 s del
// server e «Annulla»; l'email nuova resta sull'elenco finché Gmail non le dà
// una conversazione. La bozza di Claude arriva a pezzi e resta una proposta.
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
let detailOverride: unknown = null;
/** La firma che `compose` restituisce (F3). */
let signature: Record<string, unknown> = {};
/** Come risponde il server a Invia (null = lo accoda) e ad «Annulla». */
let sendAnswer: { status: number; body: unknown } | null = null;
let undoAnswer: { status?: number; body: unknown } = { body: { draft: null, droppedAttachments: [] } };
let threads: unknown[] = [];
let proposals: unknown[] = [];
let confirmAnswer: { status?: number; body: unknown } = { body: {} };
/** Come risponde Gmail (via server) a «letto / non letto». */
let readAnswer: { status?: number; body: unknown } = { body: detail };

beforeEach(() => {
  saved = [];
  newEmail = false;
  changedInGmail = false;
  detailOverride = null;
  signature = {};
  sendAnswer = null;
  undoAnswer = { body: { draft: null, droppedAttachments: [] } };
  threads = [thread];
  proposals = [proposal];
  confirmAnswer = { body: { status: "confirmed", results: [{ kind: "request", id: "r", code: "AUD-R9" }] } };
  readAnswer = { body: detail };
  setAppClientForTests(null);
  forgetUnsavedDraftsForTests();
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  seen = installFakeServerAgain();
});

/** Il server finto di ogni test, con le rotte in più (o diverse) di un test. */
function installFakeServerAgain(extra: Record<string, unknown> = {}): SeenRequest[] {
  return installFakeServer({
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
    "GET /api/me/mail/threads/t-1": () => ({ body: detailOverride ?? detail }),
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
          ...signature,
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
    [`POST /api/me/mail/drafts/${DRAFT}/send`]: () => sendAnswer ?? ({
      status: 202,
      body: { messageId: OUT, threadId: newEmail ? null : "t-1", state: "queued", undoUntil: new Date(Date.now() + 10_000).toISOString(), error: null, sentAt: null },
    }),
    [`POST /api/me/mail/outgoing/${OUT}/undo`]: () => undoAnswer,
    [`GET /api/me/mail/outgoing/${OUT}`]: { body: { messageId: OUT, threadId: "t-1", state: "queued", undoUntil: new Date(Date.now() + 10_000).toISOString(), error: null, sentAt: null } },
    "GET /api/me/mail/recipients": { body: { items: [] } },
    "POST /api/me/mail/drafts/claude": {
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify({ type: "delta", text: "Arriva " })}\n\ndata: ${JSON.stringify({ type: "done", text: "Arriva lunedì.", projectId: null, used: [] })}\n\n`,
    },
    "GET /api/me/mail/threads/t-2": { body: { ...detail, threadId: "t-2", messages: [{ ...detail.messages[0], id: M2, unread: true }] } },
    [`GET /api/me/mail/email_triage/${M2}/original`]: { status: 404, body: { code: "not_found", message: "x" } },
    "POST /api/me/mail/threads/t-2/read": () => readAnswer,
    "GET /api/me/google/workspaces": { body: [] },
    ...extra,
  } as Parameters<typeof installFakeServer>[0]).seen;
}

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

  it("«Ask Claude»: la bozza arriva nel campo e resta una proposta (nessun salvataggio da sola)", async () => {
    renderRoute(`/mail/${KEY}`);
    await screen.findByText("Ecco il preventivo per la consegna.");
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const form = await screen.findByRole("form", { name: /Reply to Bob Rossi/ });
    fireEvent.click(within(form).getByRole("button", { name: "Ask Claude" }));
    const hint = within(form).getByRole("textbox", { name: "What should it say? (optional)" });
    // Lo stesso tetto del server e del main.
    expect(hint).toHaveAttribute("maxLength", "2000");
    fireEvent.change(hint, { target: { value: "digli che arriva lunedì" } });
    fireEvent.keyDown(hint, { key: "Enter" });
    await waitFor(() => expect(within(form).getByRole("textbox", { name: "Message" })).toHaveValue("Arriva lunedì."));
    const post = seen.find((r) => r.method === "POST" && r.path === "/api/me/mail/drafts/claude")!;
    expect(post.body).toMatchObject({ accountId: ACC, threadId: "t-1", mode: "reply", hint: "digli che arriva lunedì" });
    // Oltre gli 800 ms del salvataggio da sé: il testo di Claude non va su Gmail da solo.
    await new Promise((r) => setTimeout(r, 1_100));
    expect(saved).toHaveLength(0);
    // Toccato dalla persona, è suo: si salva.
    fireEvent.change(within(form).getByRole("textbox", { name: "Message" }), { target: { value: "Arriva lunedì, a presto." } });
    await waitFor(() => expect(saved.at(-1)).toMatchObject({ body: "Arriva lunedì, a presto." }), { timeout: 2_000 });
  });

  it("«Ask Claude» in «Forward»: la bozza chiesta è un inoltro", async () => {
    renderRoute(`/mail/${KEY}`);
    await screen.findByText("Ecco il preventivo per la consegna.");
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    const form = await screen.findByRole("form", { name: /Forward/ });
    fireEvent.click(within(form).getByRole("button", { name: "Ask Claude" }));
    const hint = within(form).getByRole("textbox", { name: "What should it say? (optional)" });
    fireEvent.keyDown(hint, { key: "Enter" });
    await waitFor(() => expect(seen.some((r) => r.method === "POST" && r.path === "/api/me/mail/drafts/claude")).toBe(true));
    expect(seen.find((r) => r.path === "/api/me/mail/drafts/claude")!.body).toMatchObject({ mode: "forward" });
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

describe("la review della F3: l'«Annulla» dura quanto la finestra del server", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("l'avviso con «Undo» e ⌘Z restano per i 10 s di `undoUntil`, non per i 5 s di un avviso qualunque", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const form = await reply();
    fireEvent.click(within(form).getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: "Undo" });
    await act(() => vi.advanceTimersByTimeAsync(7_000));
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(3_500));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("i salvataggi vanno in fila: Invia aspetta il salvataggio da sé ancora in volo (mai due PUT insieme)", async () => {
    let live = 0;
    let most = 0;
    seen = installFakeServerAgain({
      "PUT /api/me/mail/drafts": async (req: SeenRequest) => {
        live += 1;
        most = Math.max(most, live);
        saved.push(req.body);
        await new Promise((r) => setTimeout(r, 300));
        live -= 1;
        return { body: { ...(req.body as Record<string, unknown>), id: DRAFT, attachments: [], updatedAt: new Date().toISOString() } };
      },
    });
    renderRoute(`/mail/${KEY}`);
    await screen.findByText("Ecco il preventivo per la consegna.");
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const form = await screen.findByRole("form", { name: /Reply to Bob Rossi/ });
    fireEvent.change(within(form).getByRole("textbox", { name: "Message" }), { target: { value: "Ricevuto." } });
    // Il salvataggio da sé parte a 800 ms e resta in volo 300 ms: Invia arriva in mezzo.
    await waitFor(() => expect(live).toBe(1), { timeout: 2_000 });
    fireEvent.click(within(form).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends()).toHaveLength(1), { timeout: 3_000 });
    expect(saved).toHaveLength(2);
    expect(most).toBe(1);
  });

  it("una bozza cambiata su Gmail scoperta da Invia: il conflitto con «Keep mine», non «Couldn't send: other»", async () => {
    changedInGmail = true;
    renderRoute(`/mail/${KEY}`);
    await screen.findByText("Ecco il preventivo per la consegna.");
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const form = await screen.findByRole("form", { name: /Reply to Bob Rossi/ });
    fireEvent.change(within(form).getByRole("textbox", { name: "Message" }), { target: { value: "Subito." } });
    fireEvent.click(within(form).getByRole("button", { name: "Send" }));
    expect(await within(form).findByText("This draft was changed in Gmail.")).toBeInTheDocument();
    expect(within(form).queryByText(/^Couldn't send/)).toBeNull();
    expect(within(form).getByRole("button", { name: "Keep mine" })).toBeInTheDocument();
    expect(sends()).toHaveLength(0);
  });

  it("«Retry» dopo un ricaricamento (la casella dell'invio non si sa): l'«Undo» chiude prima la casella aperta di QUESTA conversazione", async () => {
    const OUT2 = "0f0f0f0f-2222-4222-8222-222222222222";
    detailOverride = {
      ...detail,
      messages: [
        ...detail.messages,
        {
          ...detail.messages[0],
          id: OUT2,
          from: "Ada <ada@acme.test>",
          to: ["bob@client.test"],
          receivedAt: "2026-10-23T10:00:00.000Z",
          textExcerpt: "La mia risposta.",
          proposalIds: [],
          delivery: { state: "failed", error: "quota", outgoingId: OUT2 },
        },
      ],
    };
    seen = installFakeServerAgain({
      [`POST /api/me/mail/outgoing/${OUT2}/retry`]: () => ({
        body: { messageId: OUT2, threadId: "t-1", state: "queued", undoUntil: new Date(Date.now() + 10_000).toISOString(), error: null, sentAt: null },
      }),
      [`POST /api/me/mail/outgoing/${OUT2}/undo`]: { body: { draft: null, droppedAttachments: [] } },
    });
    // Finestra larga: casella e messaggi insieme (in quella stretta la casella copre la conversazione).
    vi.stubGlobal("matchMedia", (media: string) => ({
      matches: true,
      media,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
    renderRoute(`/mail/${KEY}`);
    await screen.findByText("Ecco il preventivo per la consegna.");
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const form = await screen.findByRole("form", { name: /Reply to Bob Rossi/ });
    fireEvent.change(within(form).getByRole("textbox", { name: "Message" }), { target: { value: "Altro testo." } });
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(seen.some((r) => r.path === `/api/me/mail/outgoing/${OUT2}/undo`)).toBe(true));
    const put = seen.findIndex((r) => r.method === "PUT" && (r.body as { body?: string }).body === "Altro testo.");
    const undo = seen.findIndex((r) => r.path === `/api/me/mail/outgoing/${OUT2}/undo`);
    expect(put).toBeGreaterThan(-1);
    expect(put).toBeLessThan(undo);
  });

  it("Gmail l'ha mandata ma lo stato non è registrato (`sent_unrecorded`): «Sent, status to verify», senza Retry, Edit né Delete", async () => {
    const OUT2 = "0f0f0f0f-2222-4222-8222-222222222222";
    detailOverride = {
      ...detail,
      messages: [
        ...detail.messages,
        {
          ...detail.messages[0],
          id: OUT2,
          from: "Ada <ada@acme.test>",
          to: ["bob@client.test"],
          receivedAt: "2026-10-23T10:00:00.000Z",
          textExcerpt: "La mia risposta.",
          proposalIds: [],
          delivery: { state: "failed", error: "sent_unrecorded", outgoingId: OUT2 },
        },
      ],
    };
    renderRoute(`/mail/${KEY}`);
    expect(await screen.findByText(/Sent, status to verify/)).toBeInTheDocument();
    expect(screen.queryByText(/^Not sent/)).toBeNull();
    for (const name of ["Retry", "Edit", "Delete"]) expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("Invia su una bozza il cui ultimo invio è FALLITO (il server ridà quello): non sembra riuscito; la casella resta, lo dice, e il fuoco va al messaggio fallito", async () => {
    detailOverride = {
      ...detail,
      messages: [
        ...detail.messages,
        {
          ...detail.messages[0],
          id: OUT,
          from: "Ada <ada@acme.test>",
          to: ["bob@client.test"],
          receivedAt: "2026-10-23T10:00:00.000Z",
          textExcerpt: "La mia risposta.",
          proposalIds: [],
          delivery: { state: "failed", error: "quota", outgoingId: OUT },
        },
      ],
    };
    sendAnswer = {
      status: 200,
      body: { messageId: OUT, threadId: "t-1", state: "failed", undoUntil: new Date(Date.now() - 60_000).toISOString(), error: "quota", sentAt: null },
    };
    vi.stubGlobal("matchMedia", (media: string) => ({
      matches: true,
      media,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
    const form = await reply();
    fireEvent.click(within(form).getByRole("button", { name: "Send" }));
    expect(await within(form).findByText("This email hadn't gone out: use Retry or edit it.")).toBeInTheDocument();
    expect(screen.getByRole("form", { name: /Reply to Bob Rossi/ })).toBe(form);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    await waitFor(() => expect(document.activeElement?.closest(`[data-message="${OUT}"]`)).not.toBeNull());
  });

  it("ogni salvataggio dice da quale versione parte (`baseUpdatedAt`): quella letta, poi quella dell'ultimo salvataggio", async () => {
    const READ_AT = "2026-11-12T09:00:00.000Z";
    seen = installFakeServerAgain({
      "GET /api/me/mail/drafts/compose": {
        body: {
          id: DRAFT,
          accountId: ACC,
          threadId: "t-1",
          mode: "reply",
          replyToMessageId: M1,
          to: [{ email: "bob@client.test", name: "Bob Rossi" }],
          cc: [],
          subject: "Re: Preventivo Rossi",
          body: "Bozza di prima.",
          attachments: [],
          quote: true,
          updatedAt: READ_AT,
        },
      },
    });
    renderRoute(`/mail/${KEY}`);
    await screen.findByText("Ecco il preventivo per la consegna.");
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const form = await screen.findByRole("form", { name: /Reply to Bob Rossi/ });
    await waitFor(() => expect(within(form).getByRole("textbox", { name: "Message" })).toHaveValue("Bozza di prima."));
    fireEvent.change(within(form).getByRole("textbox", { name: "Message" }), { target: { value: "Uno." } });
    await waitFor(() => expect(saved).toHaveLength(1), { timeout: 2_000 });
    expect(saved[0]).toMatchObject({ body: "Uno.", baseUpdatedAt: READ_AT });
    fireEvent.change(within(form).getByRole("textbox", { name: "Message" }), { target: { value: "Due." } });
    await waitFor(() => expect(saved).toHaveLength(2), { timeout: 2_000 });
    const second = saved[1] as { baseUpdatedAt?: string };
    expect(second.baseUpdatedAt).toBeDefined();
    expect(second.baseUpdatedAt).not.toBe(READ_AT);
  });

  it("una bozza mai salvata non ha una versione da cui partire: nessun `baseUpdatedAt`", async () => {
    const form = await reply();
    await waitFor(() => expect(saved).toHaveLength(1), { timeout: 2_000 });
    expect(saved[0]).not.toHaveProperty("baseUpdatedAt");
    void form;
  });

  it("la bozza di Claude oltre il tetto del giorno (429 `daily_limit`): lo dice, senza «Try again»", async () => {
    seen = installFakeServerAgain({
      "POST /api/me/mail/drafts/claude": { status: 429, body: { code: "daily_limit", message: "x" } },
    });
    renderRoute(`/mail/${KEY}`);
    await screen.findByText("Ecco il preventivo per la consegna.");
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const form = await screen.findByRole("form", { name: /Reply to Bob Rossi/ });
    fireEvent.click(within(form).getByRole("button", { name: "Ask Claude" }));
    fireEvent.keyDown(within(form).getByRole("textbox", { name: "What should it say? (optional)" }), { key: "Enter" });
    expect(await within(form).findByText(/Claude has written enough drafts for today/)).toBeInTheDocument();
    expect(within(form).queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("«Retry» di un invio fallito che il server manda subito (`undoUntil` già passato): nessun «Undo» che non funzionerebbe", async () => {
    const OUT2 = "0f0f0f0f-2222-4222-8222-222222222222";
    detailOverride = {
      ...detail,
      messages: [
        ...detail.messages,
        {
          ...detail.messages[0],
          id: OUT2,
          from: "Ada <ada@acme.test>",
          to: ["bob@client.test"],
          receivedAt: "2026-10-23T10:00:00.000Z",
          textExcerpt: "La mia risposta.",
          proposalIds: [],
          delivery: { state: "failed", error: "quota", outgoingId: OUT2 },
        },
      ],
    };
    seen = installFakeServerAgain({
      [`POST /api/me/mail/outgoing/${OUT2}/retry`]: {
        body: { messageId: OUT2, threadId: "t-1", state: "queued", undoUntil: new Date(Date.now() - 1).toISOString(), error: null, sentAt: null },
      },
    });
    renderRoute(`/mail/${KEY}`);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(seen.some((r) => r.path === `/api/me/mail/outgoing/${OUT2}/retry`)).toBe(true));
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});

/** Il contenuto di un invio annullato con lo slot già occupato da un'altra bozza (f181115c). */
function unsavedRestore() {
  return {
    draft: {
      id: null,
      accountId: ACC,
      threadId: "t-1",
      mode: "reply",
      replyToMessageId: M1,
      to: [{ email: "bob@client.test", name: "Bob Rossi" }],
      cc: [],
      subject: "Re: Preventivo Rossi",
      body: "Ricevuto, grazie.",
      attachments: [],
      quote: true,
      updatedAt: null,
    },
    droppedAttachments: ["preventivo.pdf"],
    unsaved: true,
  };
}

/** Apre «Rispondi» sulla conversazione e scrive il corpo. */
async function reply(text = "Ricevuto, grazie.") {
  renderRoute(`/mail/${KEY}`);
  await screen.findByText("Ecco il preventivo per la consegna.");
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  const form = await screen.findByRole("form", { name: /Reply to Bob Rossi/ });
  fireEvent.change(within(form).getByRole("textbox", { name: "Message" }), { target: { value: text } });
  return form;
}
const sends = () => seen.filter((r) => r.method === "POST" && r.path === `/api/me/mail/drafts/${DRAFT}/send`);

/** Un file del peso dato, senza allocarlo davvero. */
function fileOf(name: string, size: number): File {
  const f = new File(["x"], name);
  Object.defineProperty(f, "size", { value: size });
  return f;
}

describe("scrivere nella build app: i casi limite", () => {
  it("un doppio clic su Invia manda una volta sola", async () => {
    const form = await reply();
    const send = within(form).getByRole("button", { name: "Send" });
    fireEvent.click(send);
    fireEvent.click(send);
    await waitFor(() => expect(sends()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(sends()).toHaveLength(1);
  });

  it("10 allegati sì, l'undicesimo no; 25 MB esatti sì, un byte in più no (e Invia si spegne)", async () => {
    const form = await reply();
    const input = form.querySelector<HTMLInputElement>("input[type=file]")!;
    const MB25 = 25 * 1024 * 1024;
    fireEvent.change(input, { target: { files: [fileOf("a.pdf", MB25 - 9), ...Array.from({ length: 9 }, (_, i) => fileOf(`f${i}.txt`, 1))] } });
    expect(within(form).queryByText("Too large: Gmail accepts up to 25 MB per email")).toBeNull();
    expect(within(form).getByRole("button", { name: "Send" })).toBeEnabled();
    fireEvent.change(input, { target: { files: [fileOf("undicesimo.txt", 1)] } });
    expect(within(form).getByText("You can attach up to 10 files")).toBeInTheDocument();
    expect(within(form).queryByText("undicesimo.txt")).toBeNull();
  });

  it("oltre 25 MB: lo dice e Invia è spento", async () => {
    const form = await reply();
    const input = form.querySelector<HTMLInputElement>("input[type=file]")!;
    fireEvent.change(input, { target: { files: [fileOf("grosso.pdf", 25 * 1024 * 1024 + 1)] } });
    expect(await within(form).findAllByText("Too large: Gmail accepts up to 25 MB per email")).not.toHaveLength(0);
    expect(within(form).getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("un destinatario malformato incollato: «Not a valid address» e Invia spento; uno che rifiuta il server lo dice", async () => {
    newEmail = true;
    renderRoute("/mail");
    fireEvent.click(await screen.findByRole("button", { name: /New email/ }));
    const form = await screen.findByRole("form", { name: /New email/ });
    const to = within(form).getByRole("combobox", { name: "To" });
    fireEvent.change(to, { target: { value: "bob@" } });
    fireEvent.keyDown(to, { key: "Enter" });
    fireEvent.change(within(form).getByRole("textbox", { name: "Subject" }), { target: { value: "Ciao" } });
    expect(await within(form).findAllByText(/Not a valid address/)).not.toHaveLength(0);
    expect(within(form).getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("l'indirizzo che il server rifiuta prima di accodare: «Couldn't send: one of the addresses isn't valid», la bozza resta", async () => {
    sendAnswer = { status: 400, body: { code: "invalid_address", message: "x", address: "bob@client" } };
    const form = await reply();
    fireEvent.click(within(form).getByRole("button", { name: "Send" }));
    expect(await within(form).findByText("Couldn't send: one of the addresses isn't valid")).toBeInTheDocument();
    expect(within(form).getByRole("textbox", { name: "Message" })).toHaveValue("Ricevuto, grazie.");
  });

  it("senza il permesso nuovo all'invio: «ricollega l'account»", async () => {
    sendAnswer = { status: 409, body: { code: "google_scope_missing", message: "x", missing: ["https://www.googleapis.com/auth/gmail.modify"] } };
    const form = await reply();
    fireEvent.click(within(form).getByRole("button", { name: "Send" }));
    expect(await within(form).findByText("Couldn't send: your Google account needs to be reconnected")).toBeInTheDocument();
  });

  it("offline: l'invio non parte, lo dice, la bozza resta", async () => {
    const form = await reply();
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes(`/drafts/${DRAFT}/send`)) throw new TypeError("Failed to fetch");
      return (realFetch as typeof fetch)(input, init);
    });
    fireEvent.click(within(form).getByRole("button", { name: "Send" }));
    expect(await within(form).findByText(/^Couldn't send: /)).toBeInTheDocument();
    expect(within(form).getByRole("textbox", { name: "Message" })).toHaveValue("Ricevuto, grazie.");
  });

  it("«Annulla» a 9,9 s quando il server l'ha già mandata (409 too_late): «Too late to undo»", async () => {
    undoAnswer = { status: 409, body: { code: "too_late", message: "x" } };
    const form = await reply();
    fireEvent.click(within(form).getByRole("button", { name: "Send" }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Too late to undo: the email was sent.")).toBeInTheDocument();
  });

  it("«Annulla» con un'altra bozza nella conversazione: l'invio è fermo, il testo torna NON salvato; nessun salvataggio da solo; «Save» la scrive sopra", async () => {
    undoAnswer = { body: unsavedRestore() };
    const form = await reply();
    fireEvent.click(within(form).getByRole("button", { name: "Send" }));
    const undo = await screen.findByRole("button", { name: "Undo" });
    const before = saved.length;
    fireEvent.click(undo);
    const again = await screen.findByRole("form", { name: /Reply to Bob Rossi/ });
    await waitFor(() => expect(within(again).getByRole("textbox", { name: "Message" })).toHaveValue("Ricevuto, grazie."));
    expect(within(again).getByText(/Not saved: this conversation already has another draft/)).toBeInTheDocument();
    expect(within(again).getByText(/preventivo\.pdf/)).toBeInTheDocument();
    expect(screen.queryByText(/will be sent/)).toBeNull();
    // Scrivere non salva da sé: salvare sostituirebbe l'altra bozza.
    fireEvent.change(within(again).getByRole("textbox", { name: "Message" }), { target: { value: "Ricevuto, grazie mille." } });
    await new Promise((r) => setTimeout(r, 1_000));
    expect(saved).toHaveLength(before);
    expect(within(again).getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.click(within(again).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved.at(-1)).toMatchObject({ body: "Ricevuto, grazie mille.", overwrite: true }));
    await waitFor(() => expect(within(again).queryByText(/Not saved:/)).toBeNull());
    expect(within(again).getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("«Annulla» con un'altra bozza: Esc non butta il testo; «Reply» lo riapre non salvato", async () => {
    undoAnswer = { body: unsavedRestore() };
    const form = await reply();
    fireEvent.click(within(form).getByRole("button", { name: "Send" }));
    const undo = await screen.findByRole("button", { name: "Undo" });
    const before = saved.length;
    fireEvent.click(undo);
    let again = await screen.findByRole("form", { name: /Reply to Bob Rossi/ });
    await within(again).findByText(/Not saved:/);
    fireEvent.change(within(again).getByRole("textbox", { name: "Message" }), { target: { value: "Testo cambiato." } });
    fireEvent.keyDown(within(again).getByRole("textbox", { name: "Message" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("form", { name: /Reply to Bob Rossi/ })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    again = await screen.findByRole("form", { name: /Reply to Bob Rossi/ });
    await waitFor(() => expect(within(again).getByRole("textbox", { name: "Message" })).toHaveValue("Testo cambiato."));
    expect(within(again).getByText(/Not saved:/)).toBeInTheDocument();
    expect(saved).toHaveLength(before);
  });

  it("«Annulla» con un'altra bozza: «Discard» chiude senza salvare nulla", async () => {
    undoAnswer = { body: unsavedRestore() };
    const form = await reply();
    fireEvent.click(within(form).getByRole("button", { name: "Send" }));
    const undo = await screen.findByRole("button", { name: "Undo" });
    const before = saved.length;
    fireEvent.click(undo);
    const again = await screen.findByRole("form", { name: /Reply to Bob Rossi/ });
    await within(again).findByText(/Not saved:/);
    fireEvent.click(within(again).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("form", { name: /Reply to Bob Rossi/ })).toBeNull());
    await new Promise((r) => setTimeout(r, 1_000));
    expect(saved).toHaveLength(before);
  });

  it("una risposta su una conversazione di 50 messaggi: i più vecchi raccolti, Rispondi funziona", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      ...detail.messages[0],
      id: `dddddddd-0000-4000-8000-${String(i).padStart(12, "0")}`,
      receivedAt: new Date(Date.parse("2026-10-01T09:00:00.000Z") + i * 3_600_000).toISOString(),
      textExcerpt: `Messaggio ${i}`,
      proposalIds: [],
    }));
    threads = [{ ...thread, messageCount: 50 }];
    detailOverride = { ...detail, messages: many };
    renderRoute(`/mail/${KEY}`);
    expect(await screen.findByText("Messaggio 49")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /earlier messages/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(await screen.findByRole("form", { name: /Reply to Bob Rossi/ })).toBeInTheDocument();
  });

  it("la firma di Gmail sotto il campo, in sola lettura, mai nel corpo", async () => {
    signature = { signature: "Ada Lovelace\nAcme S.p.A.", signatureStatus: "present" };
    const form = await reply();
    const shown = within(form).getByLabelText("Your Gmail signature");
    expect(shown).toHaveTextContent("Ada Lovelace");
    expect(within(form).getByRole("textbox", { name: "Message" })).toHaveValue("Ricevuto, grazie.");
  });

  it("senza il permesso per leggerla: l'email parte senza firma, e lo dice", async () => {
    signature = { signature: null, signatureStatus: "scope_missing" };
    const form = await reply();
    expect(within(form).getByText("This email goes without your Gmail signature: reconnect your Google account to add it.")).toBeInTheDocument();
  });
});

