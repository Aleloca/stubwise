import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer, me, ME_ID, PROJECT_ID, serverProject, serverTask, STATUS_TODO } from "./fakeServer";
import { createMilestone, deleteMilestone, updateMilestone } from "./milestones";
import { listMilestones } from "./statuses";
import {
  getLatestBrief,
  listDecisionLog,
  listPortfolioActivityPage,
  listTimelinePage,
  listProjectPulses,
  projectPulse,
  recordDecision,
  setDecisionSuperseded,
} from "./overview";
import { getSessionPerson } from "./session";

// L'Overview della build app (integrazione area 2, fetta 4, Task R): traguardi,
// registro decisioni, brief, cronologia a pagine e polso dal server.

const MILESTONE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DECISION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OLDER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc";
const BRIEF = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const STATUS_ACTIVE = "99999999-9999-4999-8999-999999999992";
const AT = "2026-11-01T09:00:00.000Z";
const OTHER_PROJECT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const serverMilestone = (over: Record<string, unknown> = {}) => ({
  id: MILESTONE,
  projectId: PROJECT_ID,
  name: "Beta",
  description: null,
  dueDate: "2026-11-20T00:00:00.000Z",
  status: "open",
  closedAt: null,
  createdAt: AT,
  counts: { total: 0, completed: 0, byStatus: {} },
  ...over,
});

const serverDecision = (over: Record<string, unknown> = {}) => ({
  id: DECISION,
  projectId: PROJECT_ID,
  source: "manual",
  ticketId: null,
  ticketNumber: null,
  title: "Use Postgres",
  context: null,
  decision: "We use Postgres.",
  consequences: null,
  decidedBy: { id: ME_ID, email: "ada@example.com" },
  decidedAt: AT,
  supersededById: null,
  createdAt: AT,
  ...over,
});

beforeEach(() => setAppClientForTests(null));
afterEach(() => {
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("i traguardi dal server", () => {
  it("crea, modifica (chiudere = status closed), elimina; la data resta un giorno", async () => {
    const { seen } = installFakeServer({
      "POST /api/milestones": { body: serverMilestone() },
      [`PATCH /api/milestones/${MILESTONE}`]: { body: serverMilestone({ status: "closed", closedAt: AT }) },
      [`DELETE /api/milestones/${MILESTONE}`]: { status: 204 },
    });
    const created = await createMilestone(PROJECT_ID, { name: "Beta", dueDate: "2026-11-20" });
    expect(seen[0]!.body).toEqual({
      projectId: PROJECT_ID,
      name: "Beta",
      description: null,
      // A mezzogiorno UTC come il web vecchio: il giorno è lo stesso in ogni fuso vicino.
      dueDate: "2026-11-20T12:00:00.000Z",
    });
    expect(created).toEqual({
      id: MILESTONE,
      projectId: PROJECT_ID,
      name: "Beta",
      description: "",
      dueDate: "2026-11-20",
      closed: false,
    });
    const closed = await updateMilestone(MILESTONE, { closed: true, description: "", dueDate: "2026-12-01" });
    expect(seen[1]!.body).toEqual({ status: "closed", description: null, dueDate: "2026-12-01T12:00:00.000Z" });
    expect(closed.closed).toBe(true);
    await deleteMilestone(MILESTONE);
    expect(seen.map((r) => r.method)).toEqual(["POST", "PATCH", "DELETE"]);
  });

  it("la scadenza si legge come giorno, scritta a mezzanotte o a mezzogiorno UTC", async () => {
    installFakeServer({
      "GET /api/milestones": {
        body: [
          serverMilestone({ dueDate: "2026-11-20T12:00:00.000Z" }),
          serverMilestone({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab", dueDate: "2026-11-21T00:00:00.000Z" }),
        ],
      },
    });
    expect((await listMilestones(PROJECT_ID)).map((m) => m.dueDate)).toEqual(["2026-11-20", "2026-11-21"]);
  });
});

describe("il registro decisioni dal server", () => {
  it("le voci nella forma del prototipo; registrare con «supera»; segnare superata", async () => {
    const { seen } = installFakeServer({
      [`GET /api/projects/${PROJECT_ID}/decisions`]: {
        body: [serverDecision({ ticketId: "44444444-4444-4444-8444-444444444444", source: "plan_review" })],
      },
      [`POST /api/projects/${PROJECT_ID}/decisions`]: { body: serverDecision({ id: OLDER }) },
      [`PATCH /api/projects/${PROJECT_ID}/decisions/${DECISION}`]: {
        body: serverDecision({ supersededById: OLDER }),
      },
    });
    const [entry] = await listDecisionLog(PROJECT_ID);
    expect(entry).toEqual({
      id: DECISION,
      projectId: PROJECT_ID,
      source: "plan_review",
      taskId: "44444444-4444-4444-8444-444444444444",
      title: "Use Postgres",
      context: null,
      decision: "We use Postgres.",
      decidedById: ME_ID,
      decidedAt: AT,
      supersededById: null,
    });
    await recordDecision(PROJECT_ID, { title: "Use SQLite", decision: "Smaller.", supersedesId: DECISION });
    expect(seen[1]!.body).toEqual({ title: "Use SQLite", decision: "Smaller.", supersedesId: DECISION });
    const superseded = await setDecisionSuperseded(DECISION, OLDER);
    expect(seen[2]!.body).toEqual({ supersededById: OLDER });
    expect(superseded.supersededById).toBe(OLDER);
  });

  it("un ciclo di «superata da» è rifiutato dal server e arriva così com'è", async () => {
    installFakeServer({
      [`GET /api/projects/${PROJECT_ID}/decisions`]: { body: [serverDecision()] },
      [`PATCH /api/projects/${PROJECT_ID}/decisions/${DECISION}`]: {
        status: 400,
        body: { code: "decision_cycle", message: "x" },
      },
    });
    await listDecisionLog(PROJECT_ID);
    await expect(setDecisionSuperseded(DECISION, OLDER)).rejects.toMatchObject({ code: "decision_cycle" });
  });
});

describe("brief e cronologia dal server", () => {
  it("il brief più recente; senza brief, null", async () => {
    installFakeServer({
      [`GET /api/projects/${PROJECT_ID}/briefs/latest`]: {
        body: {
          id: BRIEF,
          projectId: PROJECT_ID,
          periodStart: "2026-10-26",
          periodEnd: "2026-11-01",
          headline: "On track",
          summary: "## Where we are\\nOn track",
          createdAt: AT,
          generated: true,
        },
      },
    });
    expect(await getLatestBrief(PROJECT_ID)).toEqual({
      id: BRIEF,
      projectId: PROJECT_ID,
      periodStart: "2026-10-26",
      periodEnd: "2026-11-01",
      headline: "On track",
      summary: "## Where we are\\nOn track",
      createdAt: AT,
    });
    installFakeServer({ [`GET /api/projects/${PROJECT_ID}/briefs/latest`]: { body: null } });
    expect(await getLatestBrief(PROJECT_ID)).toBeNull();
  });

  it("una pagina di cronologia: gli eventi del prototipo, il segno della pagina dopo; un evento monco si scarta", async () => {
    const { seen } = installFakeServer({
      [`GET /api/projects/${PROJECT_ID}/chronology`]: {
        body: {
          events: [
            { kind: "milestone", at: "2026-11-20T00:00:00.000Z", milestoneId: MILESTONE },
            { kind: "task_opened", at: AT, taskId: "44444444-4444-4444-8444-444444444444" },
            { kind: "decision", at: AT },
            { kind: "pr_merged", at: AT, prId: BRIEF, taskId: "44444444-4444-4444-8444-444444444444", number: 7 },
            // Una PR senza numero si mostra senza numero, non si scarta.
            { kind: "pr_opened", at: AT, prId: DECISION, taskId: "44444444-4444-4444-8444-444444444444" },
          ],
          nextBefore: "2026-10-04T00:00:00.000Z",
        },
      },
    });
    const page = await listTimelinePage(PROJECT_ID, "2026-11-01T00:00:00.000Z");
    expect(seen[0]!.path).toBe(`/api/projects/${PROJECT_ID}/chronology?before=2026-11-01T00%3A00%3A00.000Z`);
    expect(page).toEqual({
      events: [
        { kind: "milestone", at: "2026-11-20T00:00:00.000Z", milestoneId: MILESTONE },
        { kind: "task_opened", at: AT, taskId: "44444444-4444-4444-8444-444444444444" },
        { kind: "pr_merged", at: AT, prId: BRIEF, taskId: "44444444-4444-4444-8444-444444444444", number: 7 },
        { kind: "pr_opened", at: AT, prId: DECISION, taskId: "44444444-4444-4444-8444-444444444444" },
      ],
      nextBefore: "2026-10-04T00:00:00.000Z",
    });
  });

  it("l'attività del portafoglio porta il progetto; senza progetto si scarta", async () => {
    installFakeServer({
      "GET /api/activity/portfolio": {
        body: {
          events: [
            { kind: "task_closed", at: AT, taskId: "44444444-4444-4444-8444-444444444444", projectId: PROJECT_ID },
            { kind: "task_closed", at: AT, taskId: "44444444-4444-4444-8444-444444444445" },
          ],
          nextBefore: null,
        },
      },
    });
    expect(await listPortfolioActivityPage()).toEqual({
      events: [
        { kind: "task_closed", at: AT, taskId: "44444444-4444-4444-8444-444444444444", projectId: PROJECT_ID },
      ],
      nextBefore: null,
    });
  });
});

describe("il polso dal server", () => {
  it("aperte per famiglia, ferme, «aspetta te», il prossimo traguardo: pulseOf sui dati letti", async () => {
    installFakeServer({
      "GET /api/auth/me": { body: me() },
      "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
      "GET /api/tasks": {
        body: {
          items: [
            serverTask(),
            serverTask({ id: "44444444-4444-4444-8444-444444444445", code: "AUD-13", statusId: STATUS_ACTIVE }),
          ],
          truncated: false,
        },
      },
      "GET /api/tasks/stalled": {
        body: [{ task: serverTask(), stall: { reason: { kind: "unassigned" }, since: AT, days: 9 } }],
      },
      [`GET /api/projects/${PROJECT_ID}/statuses`]: {
        body: [
          { id: STATUS_TODO, projectId: PROJECT_ID, name: "To do", family: "todo", position: 0 },
          { id: STATUS_ACTIVE, projectId: PROJECT_ID, name: "Doing", family: "active", position: 1 },
        ],
      },
      "GET /api/milestones": { body: [serverMilestone()] },
      "GET /api/decisions": { body: [] },
      "GET /api/requests/to-convert": {
        body: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            code: "AUD-R4",
            projectId: PROJECT_ID,
            title: "Export",
            status: "new",
            urgency: null,
            requesterIds: [],
            requestCount: 1,
            createdAt: AT,
            webHref: "/backlog/x",
          },
        ],
      },
    });
    await getSessionPerson();
    expect(await projectPulse(PROJECT_ID)).toMatchObject({
      projectId: PROJECT_ID,
      open: { todo: 1, active: 1 },
      stalled: 1,
      waitingOnMe: true,
      claudeWorking: false,
      nextMilestone: { id: MILESTONE, dueDate: "2026-11-20" },
    });
  });

  it("il polso legge le sole task aperte; oltre il tetto lo dice, e le ferme vengono dalla loro lettura", async () => {
    const { seen } = installFakeServer({
      "GET /api/auth/me": { body: me() },
      "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
      "GET /api/tasks": { body: { items: [serverTask()], truncated: true } },
      // Una ferma che la lista troncata non ha.
      "GET /api/tasks/stalled": {
        body: [
          {
            task: serverTask({ id: "44444444-4444-4444-8444-444444444449", code: "AUD-19" }),
            stall: { reason: { kind: "unassigned" }, since: AT, days: 9 },
          },
        ],
      },
      [`GET /api/projects/${PROJECT_ID}/statuses`]: {
        body: [{ id: STATUS_TODO, projectId: PROJECT_ID, name: "To do", family: "todo", position: 0 }],
      },
      "GET /api/milestones": { body: [] },
      "GET /api/decisions": { body: [] },
      "GET /api/requests/to-convert": { body: [] },
    });
    await getSessionPerson();
    expect(await projectPulse(PROJECT_ID)).toMatchObject({ stalled: 1, truncated: true });
    const reads = seen.filter((r) => r.path.startsWith("/api/tasks"));
    expect(reads).toHaveLength(2);
    for (const r of reads) {
      expect(new URLSearchParams(r.path.split("?")[1]).get("families")).toBe("todo,active");
    }
  });

  it("il polso del portafoglio legge i progetti una volta sola", async () => {
    const { seen } = installFakeServer({
      "GET /api/auth/me": { body: me() },
      "GET /api/projects": {
        body: [serverProject({ memberIds: [ME_ID] }), serverProject({ id: OTHER_PROJECT, code: "BRN", memberIds: [ME_ID] })],
      },
      "GET /api/tasks": { body: { items: [], truncated: false } },
      "GET /api/tasks/stalled": { body: [] },
      [`GET /api/projects/${PROJECT_ID}/statuses`]: { body: [] },
      [`GET /api/projects/${OTHER_PROJECT}/statuses`]: { body: [] },
      "GET /api/milestones": { body: [] },
      "GET /api/decisions": { body: [] },
      "GET /api/requests/to-convert": { body: [] },
    });
    await getSessionPerson();
    const pulses = await listProjectPulses();
    expect(pulses).toHaveLength(2);
    expect(pulses[0]).not.toHaveProperty("truncated");
    expect(seen.filter((r) => r.path === "/api/projects")).toHaveLength(1);
  });
});
