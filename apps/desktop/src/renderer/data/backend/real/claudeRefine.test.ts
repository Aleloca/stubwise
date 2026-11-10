import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetClaudeCaches, getConversation } from "./claude";
import { closeRefine, getRefineOf, startRefineConversation } from "./claudeRefine";
import { setAppClientForTests } from "./client";
import { installFakeServer, me, PROJECT_ID, serverProject } from "./fakeServer";

// Il refinement delle richieste nella build app (integrazione area 3, fetta
// 3c): la sessione è quella del server (`backlog_refine`), avviata e chiusa
// dalle sue rotte; le scritture di Claude (design, piano, metadati) sono i
// tool del refinement, che qui diventano gli esiti del prototipo con la patch
// della richiesta.

const ITEM = "33333333-3333-4333-8333-333333333333";
const SESSION = "aaaaaaaa-0000-4000-8000-0000000000aa";
const OLD = "aaaaaaaa-0000-4000-8000-0000000000ab";

const refineSession = (over: Record<string, unknown> = {}) => ({
  id: SESSION,
  kind: "backlog_refine",
  title: "Export to CSV",
  projectId: PROJECT_ID,
  projectName: "Audin AI",
  ticketId: null,
  ticketNumber: null,
  startedAt: "2026-11-10T09:00:00.000Z",
  lastEventAt: "2026-11-10T09:05:00.000Z",
  state: "idle",
  aiJobId: null,
  backlogItemId: ITEM,
  outcome: null,
  ...over,
});

beforeEach(() => {
  setAppClientForTests(null);
  forgetClaudeCaches();
});
afterEach(() => {
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("il refinement dal server", () => {
  it("la sessione di una richiesta: quella aperta, se no la più recente chiusa; nessuna: null", async () => {
    installFakeServer({
      "GET /api/projects": { body: [serverProject()] },
      "GET /api/agent-sessions": {
        body: {
          live: [refineSession()],
          recent: [refineSession({ id: OLD, state: "ended", outcome: "completed", startedAt: "2026-11-01T09:00:00.000Z" })],
        },
      },
    });
    expect(await getRefineOf(ITEM)).toMatchObject({ id: SESSION, kind: "refine", requestId: ITEM, state: "idle" });
    installFakeServer({
      "GET /api/projects": { body: [serverProject()] },
      "GET /api/agent-sessions": {
        body: { live: [], recent: [refineSession({ id: OLD, state: "ended", outcome: "completed" })] },
      },
    });
    expect(await getRefineOf(ITEM)).toMatchObject({ id: OLD, state: "finished" });
    installFakeServer({
      "GET /api/projects": { body: [serverProject()] },
      "GET /api/agent-sessions": { body: { live: [], recent: [] } },
    });
    expect(await getRefineOf(ITEM)).toBeNull();
  });

  it("avviare e chiudere passano dalle rotte della voce", async () => {
    const { seen } = installFakeServer({
      "GET /api/projects": { body: [serverProject()] },
      [`POST /api/backlog/${ITEM}/refine-session`]: { status: 201, body: { agentSessionId: SESSION, inputId: null } },
      [`DELETE /api/backlog/${ITEM}/refine-session`]: { status: 204 },
      "GET /api/agent-sessions": { body: { live: [refineSession()], recent: [] } },
    });
    expect(await startRefineConversation(ITEM)).toMatchObject({ id: SESSION, kind: "refine", requestId: ITEM });
    await closeRefine(SESSION);
    expect(seen.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST /api/backlog/${ITEM}/refine-session`,
      `DELETE /api/backlog/${ITEM}/refine-session`,
    ]);
  });

  it("le scritture di Claude diventano esiti con la patch della richiesta; chiudere e ripartire li dice il server", async () => {
    const tool = (id: string, name: string, input: unknown) => ({
      id,
      type: "tool_use",
      segmentId: "s1",
      at: `2026-11-10T09:0${id}:00.000Z`,
      data: { toolUseId: `t${id}`, name: `mcp__stubwise_refine__${name}`, input },
    });
    const result = (id: string, of: string, content: string) => ({
      id,
      type: "tool_result",
      segmentId: "s1",
      at: `2026-11-10T09:0${id}:30.000Z`,
      data: { toolUseId: `t${of}`, isError: false, content },
    });
    installFakeServer({
      "GET /api/projects": { body: [serverProject()] },
      "GET /api/auth/me": { body: me() },
      [`GET /api/agent-sessions/${SESSION}`]: {
        body: { ...refineSession({ state: "idle" }), canWrite: true, canClose: true, questions: [], inputs: [] },
      },
      [`GET /api/agent-sessions/${SESSION}/events`]: {
        body: {
          events: [
            tool("1", "set_design", { markdown: "# Design" }),
            result("2", "1", "Design saved on the backlog item."),
            tool("3", "update_item", { effort: 2, urgency: "urgent", riskNote: "Small" }),
            result("4", "3", "Item updated: effort, urgency, riskNote."),
            tool("5", "set_plan", { markdown: "1. Do it" }),
          ],
          before: null,
        },
      },
    });
    const detail = await getConversation(SESSION);
    expect(detail).toMatchObject({ kind: "refine", canWrite: true, canClose: true, canStartNew: false });
    const results = detail!.events.filter((e) => e.type === "work_result");
    expect(results).toEqual([
      expect.objectContaining({ kind: "design_updated", requestPatch: { design: "# Design" } }),
      expect.objectContaining({ kind: "estimate_updated", requestPatch: { size: "S", urgency: "high", riskNote: "Small" } }),
    ]);
    // Una scrittura senza risultato (ancora in corso) non è un esito: resta l'azione.
    expect(results.some((e) => (e as { kind: string }).kind === "plan_updated")).toBe(false);
    expect(detail!.events.filter((e) => e.type === "action").map((e) => (e as { tool: string }).tool)).toEqual([
      "mcp__stubwise_refine__set_plan",
    ]);
  });

  it("una sessione chiusa: «Start new» se la richiesta si può ancora rifinire (lo stato della richiesta dal server)", async () => {
    installFakeServer({
      "GET /api/projects": { body: [serverProject()] },
      "GET /api/auth/me": { body: me({ projectPermissions: { [PROJECT_ID]: ["backlog.edit"] } }) },
      [`GET /api/agent-sessions/${SESSION}`]: {
        body: { ...refineSession({ state: "ended", outcome: "completed" }), canWrite: false, canClose: false, questions: [], inputs: [] },
      },
      [`GET /api/agent-sessions/${SESSION}/events`]: { body: { events: [], before: null } },
      [`GET /api/requests/${ITEM}`]: {
        body: {
          id: ITEM,
          code: "AUD-R4",
          projectId: PROJECT_ID,
          title: "Export to CSV",
          description: "",
          requesterIds: [],
          status: "ready",
          urgency: null,
          taskIds: [],
          createdAt: "2026-11-01T09:00:00.000Z",
          webHref: "/x",
        },
      },
    });
    expect(await getConversation(SESSION)).toMatchObject({ state: "finished", canStartNew: true, readOnlyReason: "finished" });
  });
});
