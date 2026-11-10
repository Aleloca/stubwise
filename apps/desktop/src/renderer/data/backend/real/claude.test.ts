import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConversation, getTaskWork, listConversations } from "./claude";
import { setAppClientForTests } from "./client";
import { installFakeServer, PROJECT_ID, serverProject, TICKET_ID } from "./fakeServer";

// Le sessioni di lavoro di Claude nella build app (integrazione area 3, fetta
// 3a): la pagina Claude e la sezione della task le leggono dal server, in
// lettura. La chat libera resta «in arrivo»: «mine» e «public» non leggono.

export const SESSION_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const JOB_ID = "bbbbbbbb-0000-4000-8000-000000000001";

export const serverSession = (over: Record<string, unknown> = {}) => ({
  id: SESSION_ID,
  kind: "ai_job",
  title: "Fix the CSV export",
  projectId: PROJECT_ID,
  projectName: "Audin AI",
  ticketId: TICKET_ID,
  ticketNumber: 12,
  startedAt: "2026-11-10T09:00:00.000Z",
  lastEventAt: "2026-11-10T09:05:00.000Z",
  state: "working",
  activeSegment: "execute",
  lastActivity: { kind: "edit", target: "src/export.ts" },
  aiJobId: JOB_ID,
  backlogItemId: null,
  outcome: null,
  waitsOnViewer: false,
  ...over,
});

export const serverEvent = (id: string, type: string, data: Record<string, unknown>, segmentId = "s1") => ({
  id,
  type,
  segmentId,
  at: `2026-11-10T09:0${Number(id) % 10}:00.000Z`,
  data,
});

beforeEach(() => setAppClientForTests(null));
afterEach(() => {
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("le sessioni di lavoro dal server", () => {
  it("dal vivo: le sessioni non concluse, nella forma del prototipo, col codice della task", async () => {
    const { seen } = installFakeServer({
      "GET /api/projects": { body: [serverProject()] },
      "GET /api/agent-sessions": {
        body: {
          live: [serverSession(), serverSession({ id: "aaaaaaaa-0000-4000-8000-000000000002", state: "waiting_input", waitsOnViewer: true })],
          recent: [serverSession({ id: "aaaaaaaa-0000-4000-8000-000000000003", state: "ended", outcome: "completed" })],
        },
      },
    });
    const rows = await listConversations({ scope: "live", projectId: PROJECT_ID });
    expect(seen.find((r) => r.path.startsWith("/api/agent-sessions"))!.path).toBe(
      `/api/agent-sessions?projectId=${PROJECT_ID}`,
    );
    expect(rows.map((r) => r.id)).toEqual([SESSION_ID, "aaaaaaaa-0000-4000-8000-000000000002"]);
    expect(rows[0]).toMatchObject({
      kind: "task_run",
      title: "Fix the CSV export",
      projectId: PROJECT_ID,
      taskId: TICKET_ID,
      objectCode: "AUD-12",
      state: "working",
      outcome: null,
      visibility: "project",
      activity: { kind: "action", label: "src/export.ts" },
      waitsOnViewer: false,
      createdAt: "2026-11-10T09:00:00.000Z",
      updatedAt: "2026-11-10T09:05:00.000Z",
    });
    expect(rows[1]).toMatchObject({ state: "awaiting_answer", activity: { kind: "question" }, waitsOnViewer: true });
  });

  it("concluse: l'esito del server nella scala del prototipo; per task e per tipo", async () => {
    const { seen } = installFakeServer({
      "GET /api/projects": { body: [serverProject()] },
      "GET /api/agent-sessions": {
        body: {
          live: [serverSession()],
          recent: [
            serverSession({ id: "aaaaaaaa-0000-4000-8000-000000000003", state: "ended", outcome: "completed" }),
            serverSession({ id: "aaaaaaaa-0000-4000-8000-000000000004", state: "ended", outcome: "skipped" }),
            serverSession({ id: "aaaaaaaa-0000-4000-8000-000000000005", kind: "pr_review", state: "ended", outcome: "failed" }),
          ],
        },
      },
    });
    const rows = await listConversations({ scope: "finished", taskId: TICKET_ID, kind: "task_run" });
    const query = new URLSearchParams(seen.find((r) => r.path.startsWith("/api/agent-sessions"))!.path.split("?")[1]);
    expect(query.get("ticketId")).toBe(TICKET_ID);
    expect(query.get("kind")).toBe("ai_job");
    expect(rows.map((r) => [r.state, r.outcome])).toEqual([
      ["finished", "ok"],
      ["finished", "stopped"],
    ]);
  });

  it("la chat libera non è integrata: «mine» e «public» non leggono niente", async () => {
    const { seen } = installFakeServer({});
    expect(await listConversations({ scope: "mine" })).toEqual([]);
    expect(await listConversations({ scope: "public" })).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it("il dettaglio: gli eventi tradotti, tutto in lettura; una sessione invisibile è null", async () => {
    installFakeServer({
      "GET /api/projects": { body: [serverProject()] },
      [`GET /api/agent-sessions/${SESSION_ID}`]: { body: { ...serverSession(), canWrite: true, questions: [], inputs: [] } },
      [`GET /api/agent-sessions/${SESSION_ID}/events`]: {
        body: {
          events: [
            serverEvent("1", "segment_start", { label: "execute", interactive: false }),
            serverEvent("2", "assistant_text", { text: "Looking at the export." }),
          ],
          before: null,
        },
      },
      [`GET /api/tasks/${TICKET_ID}/work`]: { body: { claude: "working", webHref: "/tickets/x", runs: [] } },
      "GET /api/agent-sessions/aaaaaaaa-0000-4000-8000-00000000dead": {
        status: 404,
        body: { code: "not_found", message: "x" },
      },
    });
    const detail = await getConversation(SESSION_ID);
    expect(detail).toMatchObject({
      id: SESSION_ID,
      objectCode: "AUD-12",
      // Nella 3a non si agisce: niente casella, risposte o piani da decidere.
      canWrite: false,
      canAnswer: false,
      canDecidePlan: false,
      isOwner: false,
      continuesFrom: null,
      planPreApproved: false,
    });
    expect(detail!.events.map((e) => e.type)).toEqual(["phase", "assistant"]);
    expect(await getConversation("aaaaaaaa-0000-4000-8000-00000000dead")).toBeNull();
  });

  it("il piano del job entra nel flusso, dal lavoro della task", async () => {
    installFakeServer({
      "GET /api/projects": { body: [serverProject()] },
      [`GET /api/agent-sessions/${SESSION_ID}`]: {
        body: { ...serverSession({ state: "awaiting_approval" }), questions: [], inputs: [] },
      },
      [`GET /api/agent-sessions/${SESSION_ID}/events`]: {
        body: { events: [serverEvent("1", "segment_start", { label: "plan", interactive: false })], before: null },
      },
      [`GET /api/tasks/${TICKET_ID}/work`]: {
        body: {
          claude: "awaiting_approval",
          webHref: "/tickets/x",
          runs: [
            {
              id: JOB_ID,
              sessionId: SESSION_ID,
              createdAt: "2026-11-10T09:00:00.000Z",
              state: "awaiting_approval",
              plan: { text: "1. Do it", summary: "Do it", status: "pending", at: "2026-11-10T09:04:00.000Z" },
            },
          ],
        },
      },
    });
    const detail = await getConversation(SESSION_ID);
    expect(detail!.state).toBe("awaiting_approval");
    expect(detail!.activity).toEqual({ kind: "plan" });
    expect(detail!.events.at(-1)).toMatchObject({ type: "plan", planText: "1. Do it", status: "pending" });
  });
});

describe("il lavoro di una task dal server", () => {
  const run = (over: Record<string, unknown> = {}) => ({
    id: JOB_ID,
    sessionId: SESSION_ID,
    ownerId: null,
    createdAt: "2026-11-10T09:00:00.000Z",
    state: "finished",
    outcome: "ok",
    provider: { kind: "account", name: "Team Max" },
    ...over,
  });

  it("sessioni con i loro eventi (dalla sessione, non da /work), PR, decisioni e azioni del server", async () => {
    installFakeServer({
      [`GET /api/tasks/${TICKET_ID}/work`]: {
        body: {
          claude: "done",
          webHref: "/tickets/x",
          runs: [run()],
          prEvents: [{ id: "pr1", kind: "pr_opened", at: "2026-11-10T09:06:00.000Z", number: 7, repo: "acme/app" }],
          prFacts: [{ repo: "acme/app", number: 7, review: { verdict: "approved", at: "2026-11-10T10:00:00.000Z" } }],
          planDecisions: [{ decidedById: null, decidedAt: "2026-11-10T09:03:00.000Z", decision: "Approved", status: "approved" }],
          software: true,
          openPr: true,
          waitsOnViewer: false,
          actions: { start: "unavailable", relaunch: "allowed", resume: "forbidden", requestChanges: "allowed" },
          correctionCap: 2,
        },
      },
      [`GET /api/agent-sessions/${SESSION_ID}`]: {
        body: { ...serverSession({ state: "ended", outcome: "completed" }), questions: [], inputs: [] },
      },
      [`GET /api/agent-sessions/${SESSION_ID}/events`]: {
        body: { events: [serverEvent("1", "assistant_text", { text: "Done." })], before: null },
      },
    });
    const work = await getTaskWork(TICKET_ID);
    expect(work).toMatchObject({
      software: true,
      openPr: true,
      correctionCap: 2,
      actions: { start: "unavailable", relaunch: "allowed", resume: "forbidden", requestChanges: "allowed" },
      pullRequests: [{ kind: "pr_opened", number: 7, repo: "acme/app", taskId: TICKET_ID }],
      prFacts: [{ repo: "acme/app", number: 7, review: { verdict: "approved", byId: null, on: null } }],
      planDecisions: [{ status: "approved" }],
      blocked: null,
    });
    expect(work!.runs).toHaveLength(1);
    expect(work!.runs[0]).toMatchObject({
      id: SESSION_ID,
      ownerId: "",
      state: "finished",
      outcome: "ok",
      provider: { kind: "account", name: "Team Max" },
    });
    expect(work!.runs[0]!.events.map((e) => e.type)).toEqual(["assistant"]);
  });

  it("un server della fetta 1 (senza i campi della 3a): un lavoro vuoto, non un errore", async () => {
    installFakeServer({ [`GET /api/tasks/${TICKET_ID}/work`]: { body: { claude: "none", webHref: "/tickets/x" } } });
    expect(await getTaskWork(TICKET_ID)).toMatchObject({
      runs: [],
      pullRequests: [],
      prFacts: [],
      software: false,
      hiddenRuns: false,
      actions: { start: "unavailable", relaunch: "unavailable", resume: "unavailable", requestChanges: "unavailable" },
    });
  });

  it("una sessione che chi guarda non vede: la sessione c'è, senza eventi; una task invisibile è null", async () => {
    installFakeServer({
      [`GET /api/tasks/${TICKET_ID}/work`]: { body: { claude: "done", webHref: "/x", runs: [run()] } },
      [`GET /api/agent-sessions/${SESSION_ID}`]: { status: 404, body: { code: "not_found", message: "x" } },
      [`GET /api/agent-sessions/${SESSION_ID}/events`]: { status: 404, body: { code: "not_found", message: "x" } },
      "GET /api/tasks/44444444-4444-4444-8444-44444444dead/work": { status: 404, body: { code: "not_found", message: "x" } },
    });
    expect((await getTaskWork(TICKET_ID))!.runs[0]!.events).toEqual([]);
    expect(await getTaskWork("44444444-4444-4444-8444-44444444dead")).toBeNull();
  });
});
