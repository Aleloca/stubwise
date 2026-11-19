import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { contextIdOf, describeContext, listCommands, resolveCodes, searchMentions, sendFreeMessage, serverContextOf } from "./claudeChat";
import { installFakeServer, ME_ID, PROJECT_ID, serverProject, serverTask, serverTicketDetail, TICKET_ID } from "./fakeServer";

// Il chip del riquadro e il contesto della chat (fetta 2): il chip rilegge
// l'oggetto con la visibilità di chi guarda; al server il contesto arriva
// come `tipo: id`, con l'id che il modello sa rileggere (il CODICE della task).

const CONV = "cccccccc-0000-4000-8000-000000000001";
const A_ID = "77777777-7777-4777-8777-777777777771";
const S_ID = "88888888-8888-4888-8888-888888888881";
const ACC = "aaaaaaaa-1111-4111-8111-111111111111";

const serverAutomationRow = () => ({
  id: A_ID,
  code: "AUD-A1",
  name: "Avvio",
  description: "",
  projectId: PROJECT_ID,
  ownerId: ME_ID,
  status: "draft",
  versions: [
    {
      n: 1,
      flow: { trigger: { kind: "manual" }, steps: [], titleTemplate: "Prova" },
      publishedAt: null,
      publishedById: null,
      savedAt: "2026-11-13T09:00:00.000Z",
      savedById: ME_ID,
      rev: 1,
      testedRev: null,
    },
  ],
  permissions: { manage: true },
});

const serverSupportConversation = () => ({
  id: S_ID,
  code: "AUD-S4",
  projectId: PROJECT_ID,
  projectCode: "AUD",
  channel: "widget",
  widgetId: null,
  widgetName: "Portal",
  identityVerified: false,
  customer: { name: "Lucia", email: "lucia@example.com" },
  messages: [],
  lastMessage: null,
  state: "open",
  rewrittenWish: null,
  confirmedAt: null,
  triage: null,
  request: null,
  task: null,
  continuedIn: null,
  continuedFrom: null,
  canReplyToCollaborator: false,
  canOpenRequest: false,
  canMarkNotConcluded: false,
  createdAt: "2026-11-14T09:59:00.000Z",
  lastMessageAt: "2026-11-14T10:00:00.000Z",
});

const serverMailThread = () => ({
  threadId: "t-1",
  accountId: ACC,
  accountEmail: "ada@acme.test",
  subject: "Preventivo",
  url: "https://mail.google.com/mail/#all/t-1",
  messages: [],
});

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

const routes = () => ({
  "GET /api/projects": { body: [serverProject()] },
  "GET /api/tasks/by-code/AUD-12": { body: serverTask() },
  [`GET /api/tickets/${TICKET_ID}`]: { body: serverTicketDetail() },
});

describe("il contesto della chat nella build app", () => {
  it("una task dell'indirizzo: id, chip «task AUD-12», e al server il codice", async () => {
    installFakeServer(routes());
    expect(await contextIdOf("task", "AUD-12")).toBe(TICKET_ID);
    expect(await describeContext({ kind: "task", taskId: TICKET_ID })).toEqual({
      code: "AUD-12",
      labelKey: "claude.panel.chip.kind.task",
      projectId: PROJECT_ID,
    });
    expect(await serverContextOf({ kind: "task", taskId: TICKET_ID })).toEqual({ kind: "task", id: "AUD-12" });
  });

  it("una task invisibile: nessun id, nessun chip, nessun contesto", async () => {
    installFakeServer({ "GET /api/projects": { body: [serverProject()] } });
    expect(await contextIdOf("task", "ACQ-7")).toBeNull();
    expect(await describeContext({ kind: "task", taskId: "ffffffff-0000-4000-8000-000000000009" })).toBeNull();
    expect(await serverContextOf({ kind: "task", taskId: "ffffffff-0000-4000-8000-000000000009" })).toBeNull();
  });

  it("le aree non integrate (rilascio, PR) non danno chip né contesto, senza chiamate", async () => {
    const { seen } = installFakeServer({});
    expect(await contextIdOf("release", "AUD-V1")).toBeNull();
    expect(await describeContext({ kind: "release", releaseId: "r1" })).toBeNull();
    expect(await serverContextOf({ kind: "release", releaseId: "r1" })).toBeNull();
    expect(await serverContextOf({ kind: "pr", prId: "p1" })).toBeNull();
    expect(seen).toEqual([]);
  });

  // Area 10, F1 (piano di 72): i chip degli oggetti che Claude ora sa
  // rileggere, con l'id che il tool vuole (`read_automation`,
  // `read_support_conversation`, `read_mail_thread` con `ref`).
  it("un'automazione dell'indirizzo: id, chip «automation AUD-A1», e al server il codice", async () => {
    installFakeServer({ "GET /api/automations": { body: { items: [serverAutomationRow()] } } });
    expect(await contextIdOf("automation", "AUD-A1")).toBe(A_ID);
    expect(await describeContext({ kind: "automation", automationId: A_ID })).toEqual({
      code: "AUD-A1",
      labelKey: "claude.panel.chip.kind.automation",
      projectId: PROJECT_ID,
    });
    expect(await serverContextOf({ kind: "automation", automationId: A_ID })).toEqual({
      kind: "automation",
      id: "AUD-A1",
    });
  });

  it("un'automazione che non si vede: nessun id, nessun chip, nessun contesto", async () => {
    installFakeServer({ "GET /api/automations": { body: { items: [] } } });
    expect(await contextIdOf("automation", "AUD-A9")).toBeNull();
    expect(await describeContext({ kind: "automation", automationId: A_ID })).toBeNull();
    expect(await serverContextOf({ kind: "automation", automationId: A_ID })).toBeNull();
  });

  it("una conversazione di supporto: id, chip «support AUD-S4», e al server il codice", async () => {
    installFakeServer({
      "GET /api/support/conversations/by-code/AUD-S4": { body: serverSupportConversation() },
    });
    expect(await contextIdOf("support", "AUD-S4")).toBe(S_ID);
    expect(await describeContext({ kind: "support", conversationId: S_ID })).toEqual({
      code: "AUD-S4",
      labelKey: "claude.panel.chip.kind.support",
      projectId: PROJECT_ID,
    });
    expect(await serverContextOf({ kind: "support", conversationId: S_ID })).toEqual({
      kind: "support",
      id: "AUD-S4",
    });
  });

  it("una conversazione di supporto che non si vede (404): niente", async () => {
    installFakeServer({});
    expect(await contextIdOf("support", "AUD-S9")).toBeNull();
    expect(await describeContext({ kind: "support", conversationId: S_ID })).toBeNull();
    expect(await serverContextOf({ kind: "support", conversationId: S_ID })).toBeNull();
  });

  it("una conversazione della propria posta: chip «email» e al server `<casella>/<thread>`", async () => {
    installFakeServer({ "GET /api/me/mail/threads/t-1": { body: serverMailThread() } });
    const key = `${ACC}_t-1`;
    expect(await describeContext({ kind: "mail", threadId: key })).toEqual({
      code: null,
      labelKey: "claude.panel.chip.kind.mail",
      projectId: null,
    });
    expect(await serverContextOf({ kind: "mail", threadId: key })).toEqual({ kind: "mail", id: `${ACC}/t-1` });
  });

  it("la posta di un altro (404), una chiave malformata, l'email nuova: nessun contesto", async () => {
    const { seen } = installFakeServer({});
    expect(await describeContext({ kind: "mail", threadId: `${ACC}_t-x` })).toBeNull();
    expect(await serverContextOf({ kind: "mail", threadId: `${ACC}_t-x` })).toBeNull();
    const calls = seen.length;
    expect(await describeContext({ kind: "mail", threadId: "nope" })).toBeNull();
    expect(await serverContextOf({ kind: "mail", threadId: null })).toBeNull();
    expect(seen).toHaveLength(calls);
  });

  it("un messaggio col chip aggiorna PRIMA il contesto, poi scrive", async () => {
    const { seen } = installFakeServer({
      ...routes(),
      [`PATCH /api/claude/conversations/${CONV}`]: {
        body: {
          id: CONV,
          title: "t",
          archived: false,
          context: { kind: "task", id: "AUD-12" },
          createdAt: "2026-11-10T10:00:00.000Z",
          updatedAt: "2026-11-10T10:00:00.000Z",
          state: "idle",
          lastEventAt: null,
        },
      },
      [`POST /api/agent-sessions/${CONV}/messages`]: { status: 202, body: { inputId: "eeeeeeee-0000-4000-8000-000000000001", status: "pending" } },
    });
    await sendFreeMessage(CONV, "Who follows it?", { kind: "task", taskId: TICKET_ID });
    expect(seen.filter((r) => r.method !== "GET").map((r) => [r.method, r.body])).toEqual([
      ["PATCH", { context: { kind: "task", id: "AUD-12" } }],
      ["POST", { text: "Who follows it?" }],
    ]);
  });

  it("budget finito sul messaggio: l'errore del prototipo (`isBudgetRefusal`)", async () => {
    installFakeServer({
      [`POST /api/agent-sessions/${CONV}/messages`]: { status: 409, body: { code: "budget_exhausted", message: "x" } },
    });
    await expect(sendFreeMessage(CONV, "Ciao", null)).rejects.toThrow("invalid: monthly_budget");
  });

  it("i codici nel testo: solo quelli che chi guarda vede", async () => {
    installFakeServer(routes());
    const views = await resolveCodes(["AUD-12", "ACQ-7"]);
    expect(views).toMatchObject([
      { kind: "task", visible: true, code: "AUD-12", name: "Export the report", route: "#/p/AUD/tasks?task=AUD-12" },
    ]);
  });

  it("«/»: i comandi di lettura e, dalla fetta 3, quelli d'azione (con una proposta), con la descrizione tradotta", async () => {
    const commands = await listCommands(null);
    expect(commands.map((c) => c.label)).toEqual(["/explain", "/docs", "/plan", "/new-task", "/new-request", "/run"]);
    expect(commands[0]!.description).toBe("Explain a task or a request, by its code");
    expect(commands.find((c) => c.label === "/new-task")!.description).toBe("Create a task, with a proposal to confirm");
  });
});

describe("«#» nella build app: le pagine Docs (area 5, fetta 1)", () => {
  const docHit = (over: Record<string, unknown>) => ({
    slug: "sync",
    title: "Sincronizzazione",
    kind: "page",
    snippet: "",
    repositoryId: "33333333-3333-4333-8333-333333333333",
    repositorySlug: "audin",
    repositoryName: "Audin",
    code: "AUD-D3",
    ...over,
  });
  const empty = { items: [], hasMore: false };

  it("dalla ricerca globale con citable=true; le pagine senza codice (server vecchio) no", async () => {
    const { seen } = installFakeServer({
      "GET /api/projects": { body: [serverProject({ memberIds: [] })] },
      "GET /api/tasks": { body: { items: [], truncated: false } },
      "GET /api/search": {
        body: {
          tickets: empty,
          projects: empty,
          repositories: empty,
          docs: { items: [docHit({}), docHit({ slug: "releases", title: "Note", kind: "releases", code: null })], hasMore: false },
        },
      },
    });
    const rows = await searchMentions("sinc", "objects");
    const search = seen.find((r) => r.path.startsWith("/api/search"));
    expect(new URL(`http://x${search!.path}`).searchParams.get("citable")).toBe("true");
    expect(rows.filter((r) => r.ref.kind === "doc")).toEqual([
      { ref: { kind: "doc", id: "AUD-D3" }, code: "AUD-D3", label: "Sincronizzazione", detail: "AUD · Audin", projectId: PROJECT_ID },
    ]);
  });

  it("senza testo nessuna ricerca globale", async () => {
    const { seen } = installFakeServer({ "GET /api/projects": { body: [serverProject({ memberIds: [] })] } });
    await searchMentions("", "objects");
    expect(seen.some((r) => r.path.startsWith("/api/search"))).toBe(false);
  });
});

describe("«#» nella build app: i file del Drive (area 5, fetta 2)", () => {
  const FILE = "44444444-4444-4444-8444-444444444444";
  it("dall'elenco globale per nome e codice (`q`): il riferimento porta il codice, la riga tipo e progetto", async () => {
    const { seen } = installFakeServer({
      "GET /api/projects": { body: [serverProject({ memberIds: [] })] },
      "GET /api/tasks": { body: { items: [], truncated: false } },
      "GET /api/search": { body: { tickets: { items: [], hasMore: false }, projects: { items: [], hasMore: false }, repositories: { items: [], hasMore: false }, docs: { items: [], hasMore: false } } },
      "GET /api/drive/files": {
        body: {
          items: [
            {
              id: FILE,
              code: "AUD-F3",
              projectId: PROJECT_ID,
              projectCode: "AUD",
              name: "spec.pdf",
              mime: "application/pdf",
              type: "pdf",
              sizeBytes: 4,
              addedById: null,
              addedAt: "2026-11-10T09:00:00.000Z",
            },
          ],
        },
      },
    });
    const rows = await searchMentions("spec", "objects");
    expect(new URL(`http://x${seen.find((r) => r.path.startsWith("/api/drive/files"))!.path}`).searchParams.get("q")).toBe("spec");
    expect(rows.filter((r) => r.ref.kind === "drive")).toEqual([
      {
        ref: { kind: "drive", id: FILE, code: "AUD-F3" },
        code: "AUD-F3",
        label: "spec.pdf",
        detail: "AUD",
        projectId: PROJECT_ID,
        drive: { type: "pdf", google: false },
      },
    ]);
  });
});
