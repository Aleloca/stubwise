import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session, setAppClientForTests } from "./client";
import { installFakeServer, ME_ID, PROJECT_ID, serverProject } from "./fakeServer";
import { mail } from "./mail";

// La classificazione nuova nella Posta della build app (area 6, fetta 2):
// importanza e scadenza delle conversazioni, «in analisi» e «fallita», i
// progetti per id, l'estratto; la classificazione di ogni messaggio;
// «Importanti» (un messaggio alto non letto).

const ACC = "aaaaaaaa-1111-4111-8111-111111111111";
const M1 = "dddddddd-1111-4111-8111-111111111111";
const OTHER = "22222222-9999-4999-8999-999999999999";

const thread = (over: Record<string, unknown> = {}) => ({
  threadId: "t-1",
  accountId: ACC,
  accountEmail: "ada@acme.test",
  subject: "Preventivo",
  lastFrom: "Bob Rossi <bob@client.test>",
  lastReceivedAt: "2026-11-12T09:00:00.000Z",
  messageCount: 2,
  openProposals: 0,
  projectNames: ["Audin AI"],
  unread: true,
  importance: "high",
  dueDate: "2026-11-20",
  analysing: false,
  failed: false,
  projectIds: [PROJECT_ID],
  snippet: "Ecco il preventivo per la consegna.",
  ...over,
});

const message = (over: Record<string, unknown> = {}) => ({
  id: M1,
  from: "Bob Rossi <bob@client.test>",
  to: ["ada@acme.test"],
  receivedAt: "2026-11-12T08:00:00.000Z",
  textExcerpt: "Ecco il preventivo.",
  admitted: true,
  proposalIds: [],
  reproposals: [],
  proposalOutcomes: [],
  unread: false,
  ...over,
});

const detail = (messages: unknown[]) => ({
  body: { threadId: "t-1", accountId: ACC, accountEmail: "ada@acme.test", subject: "Preventivo", url: "https://mail.google.com/x", messages },
});

const account = {
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
};
const page = (items: unknown[]) => ({ body: { items, nextCursor: null } });
const query = (path: string) => new URLSearchParams(path.split("?")[1] ?? "");
const common = {
  "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
  "GET /api/me/google/accounts": { body: [account] },
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

describe("le conversazioni classificate", () => {
  it("importanza, scadenza, i progetti per id, l'estratto, non letta", async () => {
    installFakeServer({ ...common, "GET /api/me/mail/threads": page([thread()]) });
    expect((await mail.listMailThreads())[0]).toMatchObject({
      importance: "high",
      dueDate: "2026-11-20",
      projectIds: [PROJECT_ID],
      snippet: "Ecco il preventivo per la consegna.",
      unread: 1,
      analysing: false,
      failed: false,
    });
  });

  it("i progetti per id anche se non li vedo per nome; un server senza id: per nome", async () => {
    installFakeServer({
      ...common,
      "GET /api/me/mail/threads": page([thread({ projectIds: [OTHER], projectNames: [] }), thread({ threadId: "t-2", projectIds: [] })]),
    });
    expect((await mail.listMailThreads()).map((r) => r.projectIds)).toEqual([[OTHER], [PROJECT_ID]]);
  });

  it("coi progetti per id dal server, i progetti non si rileggono a ogni elenco", async () => {
    const { seen } = installFakeServer({ ...common, "GET /api/me/mail/threads": page([thread()]) });
    await mail.listMailThreads();
    expect(seen.some((r) => r.path === "/api/projects")).toBe(false);
  });

  it("in analisi e fallita", async () => {
    installFakeServer({ ...common, "GET /api/me/mail/threads": page([thread({ analysing: true, failed: true })]) });
    expect((await mail.listMailThreads())[0]).toMatchObject({ analysing: true, failed: true });
  });

  it("importanza e progetto vanno al server", async () => {
    const { seen } = installFakeServer({ ...common, "GET /api/me/mail/threads": page([thread()]) });
    await mail.listMailThreads({ importance: "high", projectId: PROJECT_ID });
    const q = query(seen.find((r) => r.path.startsWith("/api/me/mail/threads"))!.path);
    expect(q.get("importance")).toBe("high");
    expect(q.get("project")).toBe(PROJECT_ID);
  });

  it("un progetto che non si riconosce (`unknown:<codice>` dall'indirizzo): niente al server, elenco vuoto, non un errore", async () => {
    const { seen } = installFakeServer({ ...common, "GET /api/me/mail/threads": page([thread()]) });
    expect(await mail.listMailThreads({ projectId: "unknown:XYZ" })).toEqual([]);
    expect(query(seen.find((r) => r.path.startsWith("/api/me/mail/threads"))!.path).get("project")).toBeNull();
  });

  it("«Importanti» contro un server di prima (che ignora `important`): si riguarda qui, alta e non letta", async () => {
    installFakeServer({
      ...common,
      "GET /api/me/mail/threads": page([
        thread({ importance: null }),
        thread({ threadId: "t-2", importance: "high", unread: false }),
        thread({ threadId: "t-3", importance: "high", unread: true }),
      ]),
    });
    expect((await mail.listImportantMail()).map((r) => r.threadId)).toEqual([`${ACC}_t-3`]);
  });

  it("«Importanti»: le conversazioni con un messaggio alto non letto, dal server", async () => {
    const { seen } = installFakeServer({ ...common, "GET /api/me/mail/threads": page([thread()]) });
    expect((await mail.listImportantMail()).map((r) => r.threadId)).toEqual([`${ACC}_t-1`]);
    expect(query(seen.find((r) => r.path.startsWith("/api/me/mail/threads"))!.path).get("important")).toBe("true");
  });
});

describe("la classificazione di un messaggio", () => {
  const thread1 = (m: unknown) => ({
    ...common,
    "GET /api/me/mail/threads/t-1": detail([m]),
    [`GET /api/me/mail/email_triage/${M1}/original`]: { status: 404, body: { code: "not_found", message: "x" } },
  });

  it("classificato: i progetti, l'importanza, la scadenza, i progetti incerti", async () => {
    installFakeServer(
      thread1(message({ classification: { state: "done", projectIds: [PROJECT_ID], importance: "low", dueDate: "2026-11-20", uncertainProjectIds: [OTHER] } })),
    );
    expect((await mail.getMailThread(`${ACC}_t-1`)).messages[0]!.classification).toEqual({
      state: "done",
      projectIds: [PROJECT_ID],
      importance: "low",
      dueDate: "2026-11-20",
      uncertainProjectIds: [OTHER],
    });
  });

  it("in analisi; fallita; un server di prima (spenta) resta com'era", async () => {
    installFakeServer(thread1(message({ classification: { state: "pending" } })));
    expect((await mail.getMailThread(`${ACC}_t-1`)).messages[0]!.classification).toEqual({ state: "pending" });
    installFakeServer(thread1(message({ classification: { state: "failed" } })));
    expect((await mail.getMailThread(`${ACC}_t-1`)).messages[0]!.classification).toEqual({ state: "failed" });
    installFakeServer(thread1(message()));
    expect((await mail.getMailThread(`${ACC}_t-1`)).messages[0]!.classification).toEqual({ state: "off" });
  });

  it("classificato senza importanza detta: normale", async () => {
    installFakeServer(thread1(message({ classification: { state: "done", projectIds: [] } })));
    expect((await mail.getMailThread(`${ACC}_t-1`)).messages[0]!.classification).toMatchObject({ state: "done", importance: "normal" });
  });
});
