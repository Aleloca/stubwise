import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerQuestion,
  cancelRun,
  decidePlan,
  listClaudeDecisions,
  preApprovePlan,
  relaunchWithInstructions,
  requestChanges,
  resumeCorrection,
  revokePlanApproval,
  sendMessage,
  startRun,
  stop,
  stopAndSend,
} from "./claudeActions";
import { setAppClientForTests } from "./client";
import { installFakeServer, PROJECT_ID, serverComment, serverTicketDetail, TICKET_ID } from "./fakeServer";

// Le azioni di Claude nella build app (integrazione area 3, fetta 3b): ogni
// azione è la rotta del server, e cosa si può fare dopo lo rilegge la vista
// da `/work` (mai dedotto). I rifiuti arrivano col loro `code`.

const SESSION = "aaaaaaaa-0000-4000-8000-000000000001";
const JOB = "bbbbbbbb-0000-4000-8000-000000000001";
const REPO = "cccccccc-0000-4000-8000-000000000001";
const HELD = "bbbbbbbb-0000-4000-8000-000000000009";

const session = { id: SESSION, kind: "ai_job", title: "t", projectId: PROJECT_ID, projectName: "A", ticketId: TICKET_ID, ticketNumber: 12, startedAt: "2026-11-10T09:00:00.000Z", lastEventAt: null, state: "working", questions: [], inputs: [] };
const ticket = (repos: unknown[]) => serverTicketDetail({ repositories: repos });
const repo = (over: Record<string, unknown> = {}) => ({
  repositoryId: REPO,
  repositorySlug: "app",
  branch: "stubwise/x",
  prUrl: "https://git.example/acme/app/pull/7",
  prState: "open",
  cycle: null,
  ...over,
});

beforeEach(() => setAppClientForTests(null));
afterEach(() => {
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("le azioni sulla task", () => {
  it("avvia: run-ai; rilancia con indicazioni: prima il commento, poi run-ai withInstructions", async () => {
    const { seen } = installFakeServer({
      [`POST /api/tickets/${TICKET_ID}/run-ai`]: { status: 202, body: { jobId: JOB, status: "queued" } },
      [`POST /api/tickets/${TICKET_ID}/comments`]: { status: 201, body: serverComment("Use the new API") },
    });
    expect(await startRun(TICKET_ID)).toMatchObject({ id: JOB, kind: "task_run", taskId: TICKET_ID });
    expect(seen[0]).toMatchObject({ method: "POST", path: `/api/tickets/${TICKET_ID}/run-ai` });
    await relaunchWithInstructions(TICKET_ID, "Use the new API");
    expect(seen.slice(1).map((r) => [r.method, r.path, r.body])).toEqual([
      ["POST", `/api/tickets/${TICKET_ID}/comments`, { body: "Use the new API" }],
      ["POST", `/api/tickets/${TICKET_ID}/run-ai`, { withInstructions: true }],
    ]);
  });

  it("riprendi la correzione: con il job fermo che il ticket dice; chiedi modifiche: sulla PR aperta", async () => {
    const { seen } = installFakeServer({
      [`GET /api/tickets/${TICKET_ID}`]: {
        body: ticket([repo({ cycle: { state: "correcting", round: 1, maxRounds: 3, pendingRequest: false, lastRequest: null, canRequestCorrection: true, heldReason: "budget", canResume: true, heldJobId: HELD } })]),
      },
      [`POST /api/tickets/${TICKET_ID}/run-ai`]: { status: 202, body: { jobId: HELD, status: "queued" } },
      [`POST /api/tickets/${TICKET_ID}/repositories/${REPO}/corrections`]: { status: 202, body: { correctionId: JOB, status: "queued" } },
      [`GET /api/tasks/${TICKET_ID}/work`]: {
        body: { claude: "done", webHref: "/x", requestChangesPerPr: [{ repo: "acme/app", number: 7, availability: "allowed" }] },
      },
    });
    await resumeCorrection(TICKET_ID);
    expect(seen.find((r) => r.method === "POST")!.body).toEqual({ resumeCorrectionJobId: HELD });
    await requestChanges(TICKET_ID, "Rename the column");
    expect(seen.at(-1)).toMatchObject({
      method: "POST",
      path: `/api/tickets/${TICKET_ID}/repositories/${REPO}/corrections`,
      body: { note: "Rename the column" },
    });
  });

  it("i rifiuti del server arrivano col loro codice", async () => {
    installFakeServer({
      [`POST /api/tickets/${TICKET_ID}/run-ai`]: { status: 409, body: { code: "job_in_flight", message: "x" } },
      [`POST /api/tasks/${TICKET_ID}/cancel-run`]: { status: 409, body: { code: "run_in_progress", message: "x" } },
    });
    await expect(startRun(TICKET_ID)).rejects.toMatchObject({ code: "job_in_flight" });
    await expect(cancelRun(TICKET_ID)).rejects.toMatchObject({ code: "run_in_progress" });
  });

  it("annulla il lavoro: la rotta della task", async () => {
    const { seen } = installFakeServer({
      [`POST /api/tasks/${TICKET_ID}/cancel-run`]: { body: { claude: "none", webHref: "/x" } },
    });
    await cancelRun(TICKET_ID);
    expect(seen[0]).toMatchObject({ method: "POST", path: `/api/tasks/${TICKET_ID}/cancel-run` });
  });
});

describe("le azioni su una sessione", () => {
  it("piano e domande passano dal ticket della sessione", async () => {
    const { seen } = installFakeServer({
      [`GET /api/agent-sessions/${SESSION}`]: { body: session },
      [`POST /api/tickets/${TICKET_ID}/approve-plan`]: { status: 202, body: { jobId: JOB } },
      [`POST /api/tickets/${TICKET_ID}/reject-plan`]: { status: 202, body: { jobId: JOB } },
      [`POST /api/tickets/${TICKET_ID}/pre-approve-plan`]: { body: {} },
      [`DELETE /api/tickets/${TICKET_ID}/pre-approve-plan`]: { body: {} },
      [`POST /api/tickets/${TICKET_ID}/questions/answer`]: { body: { ok: true } },
    });
    await decidePlan(SESSION, "approve");
    await decidePlan(SESSION, "reject", "Smaller steps");
    await preApprovePlan(SESSION).catch(() => undefined);
    await revokePlanApproval(SESSION).catch(() => undefined);
    await answerQuestion(SESSION, "dddddddd-0000-4000-8000-000000000001", { optionIndex: 1, text: null }).catch(() => undefined);
    const posts = seen.filter((r) => r.method !== "GET").map((r) => [r.method, r.path, r.body]);
    expect(posts).toEqual([
      ["POST", `/api/tickets/${TICKET_ID}/approve-plan`, undefined],
      ["POST", `/api/tickets/${TICKET_ID}/reject-plan`, { instructions: "Smaller steps" }],
      ["POST", `/api/tickets/${TICKET_ID}/pre-approve-plan`, undefined],
      ["DELETE", `/api/tickets/${TICKET_ID}/pre-approve-plan`, undefined],
      ["POST", `/api/tickets/${TICKET_ID}/questions/answer`, { optionIndex: 1, questionId: "dddddddd-0000-4000-8000-000000000001" }],
    ]);
  });

  it("scrivere, «Ferma» e «Ferma e scrivi» sono messaggi della sessione", async () => {
    const { seen } = installFakeServer({
      [`POST /api/agent-sessions/${SESSION}/messages`]: { status: 202, body: { inputId: JOB, status: "pending" } },
    });
    await sendMessage(SESSION, { text: "Also update the docs" });
    await stop(SESSION);
    await stopAndSend(SESSION, "Use Postgres");
    expect(seen.map((r) => r.body)).toEqual([
      { text: "Also update the docs" },
      { interrupt: true },
      { text: "Use Postgres", interrupt: true },
    ]);
  });
});

describe("«Da decidere» di Claude", () => {
  it("piani e domande dal server, nella forma del prototipo", async () => {
    installFakeServer({
      "GET /api/me/claude-decisions": {
        body: [
          { id: `${JOB}:plan`, kind: "plan", conversationId: SESSION, title: "Export", ownerId: null, projectId: PROJECT_ID, taskId: TICKET_ID, objectCode: "AUD-12", at: "2026-11-10T09:00:00.000Z", planId: JOB, summary: "Do it", webHref: "/x" },
          { id: `${JOB}:q`, kind: "question", conversationId: null, title: "Export", projectId: PROJECT_ID, taskId: TICKET_ID, objectCode: "AUD-12", at: "2026-11-10T09:01:00.000Z", questionId: "dddddddd-0000-4000-8000-000000000001", text: "Which one?", options: [{ label: "A" }], webHref: "/x" },
        ],
      },
    });
    const decisions = await listClaudeDecisions();
    expect(decisions[0]).toMatchObject({ kind: "plan", conversationId: SESSION, conversationKind: "task_run", ownerId: "", planId: JOB, summary: "Do it", blockedReason: null });
    expect(decisions[1]).toMatchObject({ kind: "question", questionId: "dddddddd-0000-4000-8000-000000000001", text: "Which one?", options: [{ label: "A", recommended: false }] });
    // Senza sessione la voce si riconosce dal suo id, e una risposta va comunque al ticket.
    expect(decisions[1]).toMatchObject({ conversationId: `${JOB}:q` });
  });

  it("un server senza la rotta (prima della 3b): nessuna voce, non un errore", async () => {
    installFakeServer({});
    expect(await listClaudeDecisions()).toEqual([]);
  });

  it("approvare e rifiutare dal «Da decidere» rimandano il digest del piano letto; plan_changed arriva col suo codice", async () => {
    const { seen } = installFakeServer({
      "GET /api/me/claude-decisions": {
        body: [
          { id: `${JOB}:plan`, kind: "plan", conversationId: SESSION, title: "Export", projectId: PROJECT_ID, taskId: TICKET_ID, at: "2026-11-10T09:00:00.000Z", planId: JOB, summary: "Do it", planDigest: "sha256:abc", webHref: "/x" },
        ],
      },
      [`POST /api/tickets/${TICKET_ID}/approve-plan`]: { status: 409, body: { code: "plan_changed", message: "x" } },
      [`POST /api/tickets/${TICKET_ID}/reject-plan`]: { status: 202, body: { jobId: JOB } },
    });
    await listClaudeDecisions();
    await expect(decidePlan(SESSION, "approve", undefined, JOB)).rejects.toMatchObject({ code: "plan_changed" });
    await decidePlan(SESSION, "reject", "Smaller", JOB);
    expect(seen.filter((r) => r.method === "POST").map((r) => r.body)).toEqual([
      { planDigest: "sha256:abc" },
      { instructions: "Smaller", planDigest: "sha256:abc" },
    ]);
  });
});
