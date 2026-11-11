import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import { resetStreamsForTests } from "./claudeStream";
import { forgetClaudeCaches } from "./claude";
import { DEPT_ID, installFakeServer, me, ME_ID, PROJECT_ID, serverProject, type SeenRequest } from "./fakeServer";

// La chat con Claude nella build app (chat, fetta 2): le conversazioni libere
// PRIVATE sul server vero — «New», «Mine», la pagina con rinomina, archivia ed
// elimina. Nessuna pubblica, nessuna proposta; il budget del mese finito spegne
// la casella con la sua frase. Il server finto risponde 404 a ogni rotta non
// dichiarata: il test elenca le richieste e non ammette chiamate fuori elenco.
vi.mock("@backend/api", async () => await import("./index"));

const CONV = "cccccccc-0000-4000-8000-000000000001";
let seen: SeenRequest[] = [];

const view = (over: Record<string, unknown> = {}) => ({
  id: CONV,
  title: "Who follows AUD-12?",
  archived: false,
  context: null,
  createdAt: "2026-11-10T10:00:00.000Z",
  updatedAt: "2026-11-10T10:01:00.000Z",
  state: "idle",
  lastEventAt: "2026-11-10T10:01:00.000Z",
  ...over,
});

const session = (over: Record<string, unknown> = {}) => ({
  id: CONV,
  kind: "free",
  title: "Who follows AUD-12?",
  projectId: null,
  projectName: null,
  ticketId: null,
  ticketNumber: null,
  startedAt: "2026-11-10T10:00:00.000Z",
  lastEventAt: "2026-11-10T10:01:00.000Z",
  state: "idle",
  canWrite: true,
  canIntervene: true,
  canInterrupt: false,
  canClose: false,
  questions: [],
  inputs: [],
  ...over,
});

/** Le rotte che la chat può chiamare; ogni altra risponde 404 e il test lo dice. */
const ALLOWED = [
  // Il punto della Chat sul binario (area 4, fetta 1).
  /^GET \/api\/chat\/(signal|channels)(\?|$)/,
  /^GET \/api\/auth\/me$/,
  /^GET \/api\/projects$/,
  /^GET \/api\/me\/follows$/,
  /^GET \/api\/decisions/,
  /^GET \/api\/me\/claude-decisions$/,
  /^GET \/api\/inbox/,
  /^GET \/api\/people$/,
  /^GET \/api\/departments$/,
  /^GET \/api\/tasks(\?|$)/,
  /^GET \/api\/agent-sessions(\?|$)/,
  /^GET \/api\/agent-sessions\/[^/]+(\/events.*)?$/,
  /^GET \/api\/agent-sessions\/[^/]+\/stream/,
  /^POST \/api\/agent-sessions\/[^/]+\/messages$/,
  /^(GET|POST) \/api\/claude\/conversations(\?|$)/,
  /^GET \/api\/claude\/conversations\/status$/,
  /^(GET|PATCH|DELETE) \/api\/claude\/conversations\/[^/]+$/,
  // Fetta 3: le proposte e i gruppi della conversazione (solo letture qui).
  /^GET \/api\/claude\/conversations\/[^/]+\/(proposals|groups)$/,
];
const outside = () => seen.filter((r) => !ALLOWED.some((re) => re.test(`${r.method} ${r.path}`)));

function install(over: { budgetExhausted?: boolean; detail?: Record<string, unknown>; list?: unknown[] } = {}) {
  const detail = { ...view(), ...over.detail, session: session(over.detail?.archived ? { canWrite: false } : {}) };
  seen = installFakeServer({
    "GET /api/auth/me": { body: me({ projectPermissions: { [PROJECT_ID]: ["tickets.view_all"] } }) },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
    "GET /api/me/follows": { body: { projectIds: [PROJECT_ID] } },
    "GET /api/decisions": { body: [] },
    "GET /api/me/claude-decisions": { body: [] },
    "GET /api/inbox": { body: { items: [], nextCursor: null } },
    "GET /api/people": {
      body: [{ id: ME_ID, name: "Ada", initials: "AD", departmentIds: [DEPT_ID], email: "ada@example.com" }],
    },
    "GET /api/departments": { body: [{ id: DEPT_ID, name: "General", colorToken: "--dept-1", isDefault: true }] },
    "GET /api/tasks": { body: { items: [], truncated: false } },
    "GET /api/agent-sessions": { body: { live: [], recent: [] } },
    "GET /api/claude/conversations/status": { body: { budgetExhausted: over.budgetExhausted ?? false } },
    "GET /api/claude/conversations": { body: { items: over.list ?? [view()] } },
    "POST /api/claude/conversations": { status: 201, body: view({ title: "", state: "idle", lastEventAt: null }) },
    [`GET /api/claude/conversations/${CONV}`]: { body: detail },
    [`PATCH /api/claude/conversations/${CONV}`]: (req) => ({ body: view(req.body as Record<string, unknown>) }),
    [`DELETE /api/claude/conversations/${CONV}`]: { status: 204 },
    [`GET /api/agent-sessions/${CONV}`]: { body: session() },
    [`GET /api/agent-sessions/${CONV}/events`]: {
      body: {
        events: [
          { id: "1", type: "input", segmentId: "s1", at: "2026-11-10T10:00:10.000Z", data: { inputId: "i1", text: "Who follows AUD-12?" } },
          { id: "2", type: "assistant_text", segmentId: "s1", at: "2026-11-10T10:00:30.000Z", data: { text: "Marta Rinaldi follows it." } },
        ],
        before: null,
      },
    },
    [`POST /api/agent-sessions/${CONV}/messages`]: { status: 202, body: { inputId: "eeeeeeee-0000-4000-8000-000000000001", status: "pending" } },
  }).seen;
}

beforeEach(() => {
  setAppClientForTests(null);
  resetStreamsForTests();
  forgetClaudeCaches();
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("la chat con Claude nella build app", () => {
  it("«New conversation»: la casella crea la conversazione e manda la domanda; il benvenuto è quello del prototipo", async () => {
    install();
    const ue = userEvent.setup();
    renderRoute("/claude");
    // Fetta 3: Claude propone e il server esegue, la riga di benvenuto è quella del prototipo.
    expect(await screen.findByText(/ask Claude to do it for you/)).toBeInTheDocument();
    await ue.type(await screen.findByLabelText("Your question for Claude"), "Who follows AUD-12?");
    await ue.click(screen.getByRole("button", { name: "Start conversation" }));
    await waitFor(() =>
      expect(seen.filter((r) => r.method === "POST").map((r) => [r.path, r.body])).toEqual([
        ["/api/claude/conversations", {}],
        [`/api/agent-sessions/${CONV}/messages`, { text: "Who follows AUD-12?" }],
      ]),
    );
    expect(outside()).toEqual([]);
  });

  it("«Mine» elenca le proprie; «Public» non c'è (fetta a sé)", async () => {
    install();
    renderRoute("/claude?scope=mine");
    expect((await screen.findAllByText("Who follows AUD-12?")).length).toBeGreaterThan(0);
    const nav = screen.getByRole("navigation", { name: "Claude views" });
    expect(within(nav).queryByText("Public")).toBeNull();
    expect(seen.some((r) => r.path === "/api/claude/conversations?scope=mine&limit=100")).toBe(true);
    expect(outside()).toEqual([]);
  });

  it("la pagina: il flusso, il messaggio alla sessione; rinomina sul posto; nessun «Make public» da un server senza canPublish", async () => {
    install();
    const ue = userEvent.setup();
    renderRoute(`/claude/${CONV}`);
    expect(await screen.findByText("Marta Rinaldi follows it.")).toBeInTheDocument();
    // Un server più vecchio non manda `canPublish` (fetta 5): non saprebbe pubblicare.
    expect(screen.queryByRole("button", { name: "Make public" })).toBeNull();
    // La conservazione del server, detta nella casella.
    expect(screen.getByText("Conversations inactive for 14 days are deleted.")).toBeInTheDocument();
    await ue.type(screen.getByLabelText("Message to Claude"), "And AUD-13?");
    await ue.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(seen.filter((r) => r.method === "POST").map((r) => r.body)).toEqual([{ text: "And AUD-13?" }]),
    );
    await ue.click(screen.getByRole("button", { name: "More actions" }));
    await ue.click(screen.getByRole("menuitem", { name: "Rename" }));
    const field = screen.getByLabelText("Conversation title");
    await ue.clear(field);
    await ue.type(field, "AUD follow-ups{Enter}");
    await waitFor(() =>
      expect(seen.filter((r) => r.method === "PATCH").map((r) => r.body)).toEqual([{ title: "AUD follow-ups" }]),
    );
    expect(outside()).toEqual([]);
  });

  it("archiviare e eliminare passano dalla conversazione", async () => {
    install();
    const ue = userEvent.setup();
    renderRoute(`/claude/${CONV}`);
    await screen.findByText("Marta Rinaldi follows it.");
    await ue.click(screen.getByRole("button", { name: "More actions" }));
    await ue.click(screen.getByRole("menuitem", { name: "Archive" }));
    await waitFor(() => expect(seen.filter((r) => r.method === "PATCH").map((r) => r.body)).toEqual([{ archived: true }]));
    await ue.click(screen.getByRole("button", { name: "More actions" }));
    await ue.click(screen.getByRole("menuitem", { name: "Delete" }));
    await ue.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(seen.some((r) => r.method === "DELETE" && r.path === `/api/claude/conversations/${CONV}`)).toBe(true));
    expect(outside()).toEqual([]);
  });

  it("il riquadro (⌘J): una conversazione nuova dalla casella, senza chiamate fuori elenco", async () => {
    install({ list: [] });
    const ue = userEvent.setup();
    renderRoute("/claude?scope=mine");
    await screen.findByRole("navigation", { name: "Claude views" });
    await ue.keyboard("{Control>}j{/Control}");
    const panel = await screen.findByRole("complementary", { name: "Claude" });
    const box = await within(panel).findByRole("textbox");
    await ue.type(box, "Where does AUD stand?{Enter}");
    await waitFor(() =>
      expect(seen.filter((r) => r.method === "POST").map((r) => [r.path, r.body])).toEqual([
        ["/api/claude/conversations", {}],
        [`/api/agent-sessions/${CONV}/messages`, { text: "Where does AUD stand?" }],
      ]),
    );
    expect(outside()).toEqual([]);
  });

  it("budget del mese finito: la casella dice perché e non manda niente", async () => {
    install({ budgetExhausted: true });
    const ue = userEvent.setup();
    renderRoute("/claude");
    expect(await screen.findByText(/The monthly AI budget is used up: Claude can't answer/)).toBeInTheDocument();
    await ue.type(await screen.findByLabelText("Your question for Claude"), "Hello");
    const send = screen.getByRole("button", { name: "Start conversation" });
    await ue.click(send);
    expect(seen.filter((r) => r.method === "POST")).toEqual([]);
  });
});
