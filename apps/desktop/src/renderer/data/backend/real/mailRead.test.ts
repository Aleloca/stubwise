import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session, setAppClientForTests } from "./client";
import { installFakeServer, ME_ID, PROJECT_ID, serverProject } from "./fakeServer";
import { mail } from "./mail";

// La Posta in lettura nella build app (area 6, fetta 1): la posta TRATTATA
// per conversazione (`/api/me/mail/threads`), senza importanza né scadenza
// (F2). Un thread è della sua casella: lo stesso id Gmail su due caselle mie
// sono due conversazioni.

const ACC = "aaaaaaaa-1111-4111-8111-111111111111";
const ACC2 = "aaaaaaaa-2222-4222-8222-222222222222";
const M1 = "dddddddd-1111-4111-8111-111111111111";
const M2 = "dddddddd-2222-4222-8222-222222222222";
const P1 = "cccccccc-1111-4111-8111-111111111111";

const thread = (over: Record<string, unknown> = {}) => ({
  threadId: "t-1",
  accountId: ACC,
  accountEmail: "ada@acme.test",
  subject: "Preventivo",
  lastFrom: "Bob Rossi <bob@client.test>",
  lastReceivedAt: "2026-11-12T09:00:00.000Z",
  messageCount: 2,
  openProposals: 1,
  projectNames: ["Audin AI"],
  ...over,
});

const message = (over: Record<string, unknown> = {}) => ({
  id: M1,
  from: "Bob Rossi <bob@client.test>",
  to: ["ada@acme.test", "Carla <carla@acme.test>"],
  receivedAt: "2026-11-12T08:00:00.000Z",
  textExcerpt: "Ecco il preventivo.",
  admitted: true,
  proposalIds: [P1],
  reproposals: [],
  proposalOutcomes: [],
  ...over,
});

const detail = (over: Record<string, unknown> = {}) => ({
  threadId: "t-1",
  accountId: ACC,
  accountEmail: "ada@acme.test",
  subject: "Preventivo",
  url: "https://mail.google.com/mail/#all/t-1",
  messages: [message(), message({ id: M2, from: "ada@acme.test", to: ["bob@client.test"], receivedAt: "2026-11-12T09:00:00.000Z", textExcerpt: "Grazie!", admitted: false, proposalIds: [] })],
  ...over,
});

const original = (over: Record<string, unknown> = {}) => ({
  subject: "Preventivo",
  from: "Bob Rossi <bob@client.test>",
  to: [],
  cc: ["Dan <dan@client.test>"],
  bodyText: "Ecco il preventivo.",
  bodyHtml: "<p>Ecco il <b>preventivo</b>.</p>",
  attachments: [{ filename: "preventivo.pdf", mimeType: "application/pdf" }],
  bodySource: "cache",
  fetchedAt: "2026-11-12T08:01:00.000Z",
  ...over,
});

const account = (over: Record<string, unknown> = {}) => ({
  id: ACC,
  email: "ada@acme.test",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  workspaceName: "Acme",
  scopes: [],
  proposalsEnabled: true,
  connectedAt: "2026-11-01T09:00:00.000Z",
  lastSyncAt: "2026-11-12T09:58:00.000Z",
  disabledAt: null,
  disabledReason: null,
  missingScopes: [],
  syncRequestedAt: null,
  ...over,
});

const page = (items: unknown[], nextCursor: string | null = null) => ({ body: { items, nextCursor } });
const query = (path: string) => new URLSearchParams(path.split("?")[1] ?? "");

const common = {
  "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
  "GET /api/me/google/accounts": { body: [account(), account({ id: ACC2, email: "ada@beta.test" })] },
};

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

describe("la Posta in lettura: l'elenco per conversazione", () => {
  it("una riga per conversazione, della sua casella: mittente, progetti, proposte aperte, nessuna importanza", async () => {
    installFakeServer({ ...common, "GET /api/me/mail/threads": page([thread()]) });
    expect(await mail.listMailThreads()).toEqual([
      {
        threadId: `${ACC}_t-1`,
        subject: "Preventivo",
        lastAt: "2026-11-12T09:00:00.000Z",
        participants: [{ name: "Bob Rossi", email: "bob@client.test", personId: null }],
        projectIds: [PROJECT_ID],
        importance: null,
        dueDate: null,
        unread: 0,
        openProposals: 1,
        analysing: false,
        failed: false,
        messages: 2,
        attachments: false,
        snippet: "",
      },
    ]);
  });

  it("lo stesso thread Gmail su due mie caselle: due conversazioni", async () => {
    installFakeServer({
      ...common,
      "GET /api/me/mail/threads": page([thread(), thread({ accountId: ACC2, accountEmail: "ada@beta.test" })]),
    });
    expect((await mail.listMailThreads()).map((r) => r.threadId)).toEqual([`${ACC}_t-1`, `${ACC2}_t-1`]);
  });

  it("legge tutte le pagine; dalla più recente", async () => {
    installFakeServer({
      ...common,
      "GET /api/me/mail/threads": (req) =>
        query(req.path).get("cursor") === "c2"
          ? page([thread({ threadId: "t-0", lastReceivedAt: "2026-11-10T09:00:00.000Z" })])
          : page([thread()], "c2"),
    });
    expect((await mail.listMailThreads()).map((r) => r.threadId)).toEqual([`${ACC}_t-1`, `${ACC}_t-0`]);
  });

  it("la casella e la ricerca vanno al server (`account`, `q`); il progetto si filtra qui", async () => {
    const { seen } = installFakeServer({
      ...common,
      "GET /api/me/mail/threads": page([thread(), thread({ threadId: "t-2", projectNames: [] })]),
    });
    const rows = await mail.listMailThreads({ mailbox: "ada@beta.test", q: " preventivo ", projectId: PROJECT_ID });
    const q = query(seen.find((r) => r.path.startsWith("/api/me/mail/threads"))!.path);
    expect(q.get("account")).toBe(ACC2);
    expect(q.get("q")).toBe("preventivo");
    expect(rows.map((r) => r.threadId)).toEqual([`${ACC}_t-1`]);
  });

  it("una casella che non è mia: nessuna conversazione, senza chiedere", async () => {
    const { seen } = installFakeServer({ ...common });
    expect(await mail.listMailThreads({ mailbox: "bob@acme.test" })).toEqual([]);
    expect(seen.some((r) => r.path.startsWith("/api/me/mail/threads"))).toBe(false);
  });

  it("l'importanza è della F2: filtrare per importanza non trova nulla", async () => {
    installFakeServer({ ...common, "GET /api/me/mail/threads": page([thread()]) });
    expect(await mail.listMailThreads({ importance: "high" })).toEqual([]);
  });

  it("la ricerca (⌘K): da 2 caratteri, una riga per conversazione trovata", async () => {
    const { seen } = installFakeServer({ ...common, "GET /api/me/mail/threads": page([thread()]) });
    expect(await mail.searchMail("p")).toEqual([]);
    expect(seen).toHaveLength(0);
    expect(await mail.searchMail("prev")).toEqual([
      {
        id: `${ACC}_t-1`,
        threadId: `${ACC}_t-1`,
        subject: "Preventivo",
        from: { name: "Bob Rossi", email: "bob@client.test", personId: null },
        at: "2026-11-12T09:00:00.000Z",
        snippet: "",
      },
    ]);
  });
});

describe("la Posta in lettura: una conversazione", () => {
  // L'originale di un MESSAGGIO si chiede con la source `email_triage`: con
  // `email` il server cerca una PROPOSTA (`email_proposals.id`) e risponde 404.
  // Il server finto risponde 404 a ogni rotta che non conosce, come quello vero.

  it("i messaggi dal più vecchio: l'estratto, l'originale HTML isolato, gli allegati, il contesto", async () => {
    const { seen } = installFakeServer({
      ...common,
      "GET /api/me/mail/threads/t-1": { body: detail() },
      [`GET /api/me/mail/email_triage/${M1}/original`]: { body: original() },
      [`GET /api/me/mail/email_triage/${M2}/original`]: { body: original({ bodyHtml: null, attachments: [], cc: [] }) },
    });
    const t = await mail.getMailThread(`${ACC}_t-1`);
    expect(query(seen.find((r) => r.path.startsWith("/api/me/mail/threads/t-1"))!.path).get("account")).toBe(ACC);
    expect(t.threadId).toBe(`${ACC}_t-1`);
    expect(t.subject).toBe("Preventivo");
    expect(t.messages[0]).toMatchObject({
      id: M1,
      messageId: M1,
      threadId: `${ACC}_t-1`,
      from: { name: "Bob Rossi", email: "bob@client.test", personId: null },
      to: [
        { name: "ada@acme.test", email: "ada@acme.test", personId: ME_ID },
        { name: "Carla", email: "carla@acme.test", personId: null },
      ],
      cc: [{ name: "Dan", email: "dan@client.test", personId: null }],
      subject: "Preventivo",
      at: "2026-11-12T08:00:00.000Z",
      text: "Ecco il preventivo.",
      quoted: null,
      html: "<p>Ecco il <b>preventivo</b>.</p>",
      attachments: [{ id: `${M1}:0`, name: "preventivo.pdf", sizeBytes: 0 }],
      kind: "email",
      context: false,
      read: true,
      classification: { state: "off" },
    });
    expect(t.messages[1]).toMatchObject({ id: M2, context: true, html: null, cc: null, attachments: [] });
  });

  it("l'originale che non si legge (Gmail, token): resta l'estratto", async () => {
    installFakeServer({
      ...common,
      "GET /api/me/mail/threads/t-1": { body: detail({ messages: [message()] }) },
      [`GET /api/me/mail/email_triage/${M1}/original`]: { status: 409, body: { code: "token_expired", message: "x" } },
    });
    const [m] = (await mail.getMailThread(`${ACC}_t-1`)).messages;
    expect(m).toMatchObject({ text: "Ecco il preventivo.", html: null, attachments: [], cc: null });
  });

  it("una proposta nata da questo messaggio è fallita: «Riproponi», che riparte da quella proposta", async () => {
    const { seen } = installFakeServer({
      ...common,
      "GET /api/me/mail/threads/t-1": { body: detail({
        messages: [
          message({
            reproposals: [{ source: "email", id: P1, projectName: "Audin AI" }],
            proposalOutcomes: [{ id: P1, projectName: "Audin AI", failed: true, label: "Couldn't move" }],
          }),
        ],
      }) },
      [`GET /api/me/mail/email_triage/${M1}/original`]: { body: original() },
      [`POST /api/me/mail/email/${P1}/repropose`]: { body: { ok: true } },
    });
    const [m] = (await mail.getMailThread(`${ACC}_t-1`)).messages;
    expect(m!.classification).toEqual({ state: "failed" });
    await mail.reproposeMessage(M1);
    expect(seen.filter((r) => r.method === "POST").map((r) => r.path)).toEqual([`/api/me/mail/email/${P1}/repropose`]);
  });

  it("uno smistamento fallito (nessuna proposta): «Riproponi» dello smistamento", async () => {
    const { seen } = installFakeServer({
      ...common,
      "GET /api/me/mail/threads/t-1": { body: detail({
        messages: [message({ proposalIds: [], reproposals: [{ source: "email_triage", id: M1, projectName: null }] })],
      }) },
      [`GET /api/me/mail/email_triage/${M1}/original`]: { body: original() },
      [`POST /api/me/mail/email_triage/${M1}/repropose`]: { body: { ok: true } },
    });
    const [m] = (await mail.getMailThread(`${ACC}_t-1`)).messages;
    expect(m!.classification).toEqual({ state: "failed" });
    await mail.reproposeMessage(M1);
    expect(seen.some((r) => r.path === `/api/me/mail/email_triage/${M1}/repropose`)).toBe(true);
  });

  it("una proposta ignorata si può riproporre, ma l'analisi non è «fallita»", async () => {
    installFakeServer({
      ...common,
      "GET /api/me/mail/threads/t-1": { body: detail({
        messages: [message({ reproposals: [{ source: "email", id: P1, projectName: "Audin AI" }], proposalOutcomes: [{ id: P1, projectName: "Audin AI", failed: false, label: "Ignored" }] })],
      }) },
      [`GET /api/me/mail/email_triage/${M1}/original`]: { body: original() },
    });
    const [m] = (await mail.getMailThread(`${ACC}_t-1`)).messages;
    expect(m!.classification).toEqual({ state: "off" });
  });

  it("un id che non è di una mia conversazione: `not_found`", async () => {
    installFakeServer({ ...common, "GET /api/me/mail/threads/t-9": { status: 404, body: { code: "not_found", message: "x" } } });
    await expect(mail.getMailThread(`${ACC}_t-9`)).rejects.toThrow("not_found");
    await expect(mail.getMailThread("senza-casella")).rejects.toThrow("not_found");
  });

  it("l'id di una conversazione passa per l'indirizzo dell'app (`/mail/<id>`: lettere, cifre, `-`, `_`)", async () => {
    installFakeServer({ ...common, "GET /api/me/mail/threads": page([thread({ threadId: "18c2f0a1b2" })]) });
    const [row] = await mail.listMailThreads();
    expect(row!.threadId).toMatch(/^[\w-]+$/);
  });
});

describe("letto / non letto, sincronizzato con Gmail (F1.3)", () => {
  it("una conversazione con un messaggio non letto conta come non letta; i messaggi dicono il loro stato", async () => {
    installFakeServer({
      ...common,
      "GET /api/me/mail/threads": page([thread({ unread: true }), thread({ threadId: "t-2", unread: false })]),
      "GET /api/me/mail/threads/t-1": { body: detail({ messages: [message({ unread: true })] }) },
      [`GET /api/me/mail/email_triage/${M1}/original`]: { body: original() },
    });
    expect((await mail.listMailThreads()).map((r) => [r.threadId, r.unread])).toEqual([
      [`${ACC}_t-1`, 1],
      [`${ACC}_t-2`, 0],
    ]);
    expect((await mail.getMailThread(`${ACC}_t-1`)).messages[0]!.read).toBe(false);
  });

  it("«Segna come letta» e «come non letta» scrivono su Gmail, con la casella della conversazione", async () => {
    const { seen } = installFakeServer({ "POST /api/me/mail/threads/t-1/read": { body: detail() } });
    await mail.markRead(`${ACC}_t-1`);
    await mail.markUnread(`${ACC}_t-1`);
    expect(seen.map((r) => [r.path, r.body])).toEqual([
      ["/api/me/mail/threads/t-1/read", { account: ACC, read: true }],
      ["/api/me/mail/threads/t-1/read", { account: ACC, read: false }],
    ]);
  });

  it("senza il permesso nuovo (409 `google_scope_missing`): «Ricollega»; scaduta: `google_not_connected`; non mia: `not_found`", async () => {
    installFakeServer({
      "POST /api/me/mail/threads/t-1/read": { status: 409, body: { code: "google_scope_missing", message: "x", missing: ["https://www.googleapis.com/auth/gmail.modify"] } },
      "POST /api/me/mail/threads/t-2/read": { status: 409, body: { code: "token_expired", message: "x" } },
      "POST /api/me/mail/threads/t-3/read": { status: 404, body: { code: "not_found", message: "x" } },
    });
    await expect(mail.markRead(`${ACC}_t-1`)).rejects.toThrow("google_scope_missing");
    await expect(mail.markRead(`${ACC}_t-2`)).rejects.toThrow("google_not_connected");
    await expect(mail.markUnread(`${ACC}_t-3`)).rejects.toThrow("not_found");
    await expect(mail.markRead("senza-casella")).rejects.toThrow("not_found");
  });
});
