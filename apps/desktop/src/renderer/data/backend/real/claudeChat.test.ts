import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { contextIdOf, describeContext, listCommands, resolveCodes, searchMentions, sendFreeMessage, serverContextOf } from "./claudeChat";
import { installFakeServer, PROJECT_ID, serverProject, serverTask, serverTicketDetail, TICKET_ID } from "./fakeServer";

// Il chip del riquadro e il contesto della chat (fetta 2): il chip rilegge
// l'oggetto con la visibilità di chi guarda; al server il contesto arriva
// come `tipo: id`, con l'id che il modello sa rileggere (il CODICE della task).

const CONV = "cccccccc-0000-4000-8000-000000000001";

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

  it("le aree non integrate (rilascio, automazione) non danno chip né contesto, senza chiamate", async () => {
    const { seen } = installFakeServer({});
    expect(await contextIdOf("release", "AUD-V1")).toBeNull();
    expect(await describeContext({ kind: "automation", automationId: "a1" })).toBeNull();
    expect(await serverContextOf({ kind: "release", releaseId: "r1" })).toBeNull();
    expect(seen).toEqual([]);
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
