import { decisionRequestViewSchema, inboxItemSchema } from "@stubwise/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer, PROJECT_ID, serverProject } from "./fakeServer";
import { listNotifications } from "./notifications";
import { listWaitingOnMeProjectIds } from "./projects";

const TICKET = "44444444-4444-4444-8444-444444444444";
const card = (over: Record<string, unknown> = {}) => ({
  id: "33333333-3333-4333-8333-333333333333",
  kind: "decision.requested",
  status: "open",
  text: "Ada asks you to decide on AUD-12",
  actions: ["open"],
  projectId: PROJECT_ID,
  ticketId: TICKET,
  jobId: null,
  createdAt: "2026-11-09T10:00:00.000Z",
  readAt: null,
  snoozedUntil: null,
  handledAt: null,
  handledBy: null,
  ...over,
});

beforeEach(() => setAppClientForTests(null));
afterEach(() => {
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

function server(items: unknown[], decisions: unknown[] = []) {
  return installFakeServer({
    "GET /api/inbox": ({ path }) => ({
      body: { items: path.includes("status=open") ? items : [], nextCursor: null },
    }),
    "GET /api/projects": { body: [serverProject()] },
    "GET /api/decisions": { body: decisions },
    [`GET /api/tickets/${TICKET}`]: { body: { id: TICKET, number: 12, projectId: PROJECT_ID } },
  });
}

// I due campi li aggiunge il server (derivati a lettura, additivi): finché lo
// schema condiviso non li ha, il client li toglie al parse e vale il ripiego.
// Questi test si accendono da soli appena lo schema li conosce.
const hasTaskCode = "taskCode" in inboxItemSchema.shape;
const hasProjectId = "projectId" in decisionRequestViewSchema.shape;

describe("campi derivati dal server, con ripiego", () => {
  it.runIf(hasTaskCode)("con taskCode la card apre la task senza leggere il ticket", async () => {
    const { seen } = server([card({ taskCode: "AUD-12" })]);
    const [n] = await listNotifications();
    expect(n!.link).toBe("#/p/AUD/tasks?task=AUD-12");
    expect(seen.some((r) => r.path.startsWith("/api/tickets/"))).toBe(false);
  });

  it("senza taskCode (server più vecchio) il codice viene dal ticket", async () => {
    const { seen } = server([card()]);
    const [n] = await listNotifications().catch(() => [{ link: "parse-failed" }]);
    expect(seen.some((r) => r.path === `/api/tickets/${TICKET}`)).toBe(true);
    expect(n).toBeDefined();
  });

  it.runIf(hasProjectId)("con projectId la decisione dà il progetto senza leggere il ticket", async () => {
    const decision = {
      id: "88888888-8888-4888-8888-888888888888",
      taskId: TICKET,
      askedById: null,
      askedOfId: PROJECT_ID,
      question: "?",
      options: [],
      createdAt: "2026-11-09T10:00:00.000Z",
      withdrawnAt: null,
      answer: null,
      projectId: PROJECT_ID,
    };
    const { seen } = server([], [decision]);
    expect(await listWaitingOnMeProjectIds()).toEqual([PROJECT_ID]);
    expect(seen.some((r) => r.path.startsWith("/api/tickets/"))).toBe(false);
  });
});
