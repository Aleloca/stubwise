import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetClaudeCaches } from "./claude";
import { setAppClientForTests } from "./client";
import { installFakeServer, me, ME_ID, PROJECT_ID, serverProject, serverTask, STATUS_TODO, TICKET_ID } from "./fakeServer";
import { projectPulse } from "./overview";
import { listProjects, listWaitingOnMeProjectIds } from "./projects";
import { getSessionPerson } from "./session";
import { forgetTaskCodes } from "./tasks";

// Claude nel polso della build app (integrazione area 3, 3e.2): «Claude al
// lavoro» dalle sessioni di lavoro dal vivo del progetto (`/api/agent-sessions`,
// le sole `ai_job` al lavoro o in coda), «Claude aspetta te» dalle voci di
// Claude in «Da decidere» (`/api/me/claude-decisions`: piani a chi li approva,
// domande a chi risponde). Fail-open: senza quelle letture il polso resta.

const OTHER_PROJECT = "66666666-6666-4666-8666-666666666666";

const serverSession = (over: Record<string, unknown> = {}) => ({
  id: "aaaaaaaa-0000-4000-8000-000000000001",
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
  aiJobId: "bbbbbbbb-0000-4000-8000-000000000001",
  backlogItemId: null,
  outcome: null,
  waitsOnViewer: false,
  ...over,
});

const decision = (projectId = PROJECT_ID) => ({
  id: `job:${projectId}:q`,
  kind: "question",
  conversationId: null,
  title: "Export",
  projectId,
  taskId: TICKET_ID,
  objectCode: "AUD-12",
  at: "2026-11-10T09:01:00.000Z",
  questionId: "dddddddd-0000-4000-8000-000000000001",
  text: "Which one?",
  options: [{ label: "A" }],
  webHref: "/x",
});

type Route = Parameters<typeof installFakeServer>[0][string];

function server(routes: Record<string, Route>) {
  return installFakeServer({
    "GET /api/auth/me": { body: me() },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
    "GET /api/tasks": { body: { items: [serverTask()], truncated: false } },
    "GET /api/tasks/stalled": { body: [] },
    [`GET /api/projects/${PROJECT_ID}/statuses`]: {
      body: [{ id: STATUS_TODO, projectId: PROJECT_ID, name: "To do", family: "todo", position: 0 }],
    },
    "GET /api/milestones": { body: [] },
    "GET /api/decisions": { body: [] },
    "GET /api/requests/to-convert": { body: [] },
    ...routes,
  });
}

beforeEach(() => {
  setAppClientForTests(null);
  forgetClaudeCaches();
  forgetTaskCodes();
});
afterEach(() => {
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("Claude nel polso", () => {
  it("una sessione di lavoro dal vivo nel progetto: «Claude al lavoro»; una domanda per me: «aspetta te»", async () => {
    server({
      "GET /api/agent-sessions": { body: { live: [serverSession()], recent: [] } },
      "GET /api/me/claude-decisions": { body: [decision()] },
    });
    await getSessionPerson();
    expect(await projectPulse(PROJECT_ID)).toMatchObject({ claudeWorking: true, waitingOnMe: true });
  });

  it("niente di Claude nel progetto (sessioni d'altro tipo o d'altri progetti, in attesa, una voce d'altro progetto): niente", async () => {
    server({
      "GET /api/agent-sessions": {
        body: {
          live: [
            serverSession({ id: "aaaaaaaa-0000-4000-8000-000000000011", kind: "doc_generation" }),
            serverSession({ id: "aaaaaaaa-0000-4000-8000-000000000012", projectId: OTHER_PROJECT }),
            serverSession({ id: "aaaaaaaa-0000-4000-8000-000000000013", state: "waiting_input" }),
          ],
          recent: [],
        },
      },
      "GET /api/me/claude-decisions": { body: [decision(OTHER_PROJECT)] },
    });
    await getSessionPerson();
    expect(await projectPulse(PROJECT_ID)).toMatchObject({ claudeWorking: false, waitingOnMe: false });
  });

  it("senza le letture di Claude (un errore, o un server più vecchio): il polso c'è lo stesso", async () => {
    server({ "GET /api/agent-sessions": { status: 500, body: { code: "x", message: "x" } } });
    await getSessionPerson();
    expect(await projectPulse(PROJECT_ID)).toMatchObject({ claudeWorking: false, waitingOnMe: false });
  });
});

describe("Claude sulle tessere del binario", () => {
  it("il progetto dice «Claude al lavoro», e una voce di Claude per me lo mette fra quelli che aspettano me", async () => {
    server({
      "GET /api/agent-sessions": { body: { live: [serverSession()], recent: [] } },
      "GET /api/me/claude-decisions": { body: [decision()] },
    });
    const [project] = await listProjects();
    expect(project!.signals.claudeWorking).toBe(true);
    expect(await listWaitingOnMeProjectIds()).toEqual([PROJECT_ID]);
  });

  it("senza sessioni né voci: nessun segnale", async () => {
    server({
      "GET /api/agent-sessions": { body: { live: [], recent: [] } },
      "GET /api/me/claude-decisions": { body: [] },
    });
    const [project] = await listProjects();
    expect(project!.signals.claudeWorking).toBe(false);
    expect(await listWaitingOnMeProjectIds()).toEqual([]);
  });
});
