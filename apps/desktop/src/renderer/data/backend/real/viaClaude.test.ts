import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer, ME_ID, PROJECT_ID, serverComment, serverProject, TICKET_ID } from "./fakeServer";
import { listNotifications } from "./notifications";
import { listPeopleActivity } from "./peopleActivity";
import { addComment, listActivity } from "./taskDetail";

// «via Claude» nella build app (chat, fetta 3): il server lo DERIVA a lettura
// (`viaClaude`, `viaClaudeActionId`, `viaClaudeRequesterId`); qui diventa il
// segno del prototipo — `via: "claude"` sul registro, `viaClaude` + il nome di
// chi l'ha chiesto sulle notifiche («Claude on behalf of …»).

const ACTION = "abababab-0000-4000-8000-000000000001";
const MARTA = "55555555-5555-4555-8555-555555555555";

beforeEach(() => setAppClientForTests(null));
afterEach(() => {
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

const via = { viaClaude: true, viaClaudeActionId: ACTION, viaClaudeRequesterId: MARTA };

describe("registro della task", () => {
  it("una voce via Claude porta il segno e l'azione; una a mano no, e nessun campo del server trapela", async () => {
    installFakeServer({
      [`GET /api/tasks/${TICKET_ID}/activity`]: {
        body: [
          { id: "c1", taskId: TICKET_ID, kind: "comment", authorId: MARTA, at: "2026-11-10T10:00:00.000Z", body: "x", ...via },
          { id: "e1", taskId: TICKET_ID, kind: "field_change", authorId: ME_ID, at: "2026-11-10T10:01:00.000Z", field: "title", from: "a", to: "b" },
        ],
      },
    });
    const [byClaude, byHand] = await listActivity(TICKET_ID);
    expect(byClaude).toMatchObject({ via: "claude", claudeActionId: ACTION });
    expect(byHand!.via).toBeUndefined();
    expect(byHand!.claudeActionId).toBeUndefined();
    expect(byClaude).not.toHaveProperty("viaClaude");
    expect(byClaude).not.toHaveProperty("viaClaudeRequesterId");
  });

  it("il commento appena scritto a mano non ha il segno", async () => {
    installFakeServer({ [`POST /api/tickets/${TICKET_ID}/comments`]: { body: serverComment("Ciao") } });
    const entry = await addComment(TICKET_ID, "Ciao");
    expect(entry.via).toBeUndefined();
  });
});

function inbox(items: unknown[]) {
  return installFakeServer({
    "GET /api/inbox": ({ path }) => ({ body: { items: path.includes("status=open") ? items : [], nextCursor: null } }),
    "GET /api/projects": { body: [serverProject()] },
    "GET /api/people": {
      body: [{ id: MARTA, name: "Marta Rinaldi", initials: "MR", departmentIds: [], email: "marta@example.com" }],
    },
  });
}
const card = (over: Record<string, unknown> = {}) => ({
  id: "33333333-3333-4333-8333-333333333333",
  kind: "task.assigned",
  status: "open",
  text: "Marta assigned you AUD-12",
  actions: ["open"],
  projectId: PROJECT_ID,
  ticketId: TICKET_ID,
  taskCode: "AUD-12",
  jobId: null,
  createdAt: "2026-11-09T10:00:00.000Z",
  readAt: null,
  snoozedUntil: null,
  handledAt: null,
  handledBy: null,
  ...over,
});

describe("inbox", () => {
  it("una card via Claude: viaClaude con chi l'ha chiesta e il suo nome", async () => {
    inbox([card(via)]);
    const [n] = await listNotifications();
    expect(n).toMatchObject({ viaClaude: { personId: MARTA, actionId: ACTION }, viaClaudeName: "Marta Rinaldi" });
  });

  it("un server vecchio, senza i campi: nessun segno e nessuna lettura delle persone", async () => {
    const { seen } = inbox([card()]);
    const [n] = await listNotifications();
    expect(n!.viaClaude).toBeUndefined();
    expect(seen.some((r) => r.path.startsWith("/api/people"))).toBe(false);
  });
});

describe("By person", () => {
  it("passa il segno del server", async () => {
    installFakeServer({
      "GET /api/people/activity": {
        body: [
          {
            personId: MARTA,
            name: "Marta",
            departmentIds: [],
            tasksClosed: [],
            tasksMoved: [{ taskId: TICKET_ID, code: "AUD-12", title: "t", projectId: PROJECT_ID, at: "2026-11-10T10:00:00.000Z", field: "status", from: "a", to: "b", viaClaude: true }],
            tasksDeleted: [],
            comments: [{ id: "cccccccc-0000-4000-8000-000000000001", taskId: TICKET_ID, code: "AUD-12", projectId: PROJECT_ID, body: "x", at: "2026-11-10T10:00:00.000Z", viaClaude: true }],
            decisions: [],
            requestsCreated: [],
            commits: [],
          },
        ],
      },
    });
    const [row] = await listPeopleActivity("2026-11-10");
    expect(row!.tasksMoved[0]!.viaClaude).toBe(true);
    expect(row!.comments[0]!.viaClaude).toBe(true);
  });
});
