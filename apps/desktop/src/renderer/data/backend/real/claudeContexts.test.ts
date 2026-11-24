import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAppClientForTests } from "./client";
import {
  clientContextOf,
  serverContextOf,
  setConversationContexts,
  warmContextCodes,
} from "./claudeChat";
import {
  installFakeServer,
  PROJECT_ID,
  serverProject,
  serverTask,
  serverTicketDetail,
  TICKET_ID,
} from "./fakeServer";

// Lotto 8, §1 (72, a5fdd0c23): i contesti si accumulano. Il server ricorda il
// gruppo (`contexts`, `{ kind, id }`, l'ultimo è il primario) e lo sostituisce
// col `PATCH { contexts }`; il renderer lo legge nella forma del prototipo.

const CONV = "cccccccc-0000-4000-8000-000000000001";

beforeEach(() => setAppClientForTests(null));
afterEach(() => setAppClientForTests(null));

describe("i contesti accumulati nella build app", () => {
  it("dal server alla forma del prototipo: una task per codice, un progetto, la posta, una PR", async () => {
    installFakeServer({
      "GET /api/projects": { body: [serverProject()] },
      "GET /api/tasks/by-code/AUD-12": { body: serverTask() },
      [`GET /api/tickets/${TICKET_ID}`]: { body: serverTicketDetail() },
    });
    const group = [
      { kind: "task", id: "AUD-12" },
      { kind: "project", id: PROJECT_ID },
      { kind: "mail", id: "acc-1/t-9" },
      { kind: "pr", id: "repo-1:42" },
    ];
    // Il codice si impara prima (una lettura), poi la traduzione è immediata.
    await warmContextCodes(group);
    expect(group.map(clientContextOf)).toEqual([
      { kind: "task", taskId: TICKET_ID },
      { kind: "page", route: "overview", projectId: PROJECT_ID },
      { kind: "mail", threadId: "acc-1_t-9" },
      { kind: "pr", prId: "repo-1#42" },
    ]);
    // Un codice che non si ritrova: niente chip.
    expect(clientContextOf({ kind: "task", id: "ZZZ-1" })).toBeNull();
  });

  it("una pagina aggiunta in questa sessione torna com'era (la rotta, non solo il progetto)", async () => {
    installFakeServer({ "GET /api/projects": { body: [serverProject()] } });
    const planning = { kind: "page" as const, route: "planning", projectId: PROJECT_ID };
    const server = await serverContextOf(planning);
    expect(clientContextOf(server!)).toEqual(planning);
  });

  it("il gruppo si sostituisce col PATCH `{ contexts }`, nella forma del server", async () => {
    const { seen } = installFakeServer({
      "GET /api/projects": { body: [serverProject()] },
      "GET /api/tasks/by-code/AUD-12": { body: serverTask() },
      [`GET /api/tickets/${TICKET_ID}`]: { body: serverTicketDetail() },
      [`PATCH /api/claude/conversations/${CONV}`]: {
        body: {
          id: CONV,
          title: "t",
          archived: false,
          context: { kind: "project", id: PROJECT_ID },
          createdAt: "2026-11-10T10:00:00.000Z",
          updatedAt: "2026-11-10T10:00:00.000Z",
          state: "idle",
          lastEventAt: null,
        },
      },
    });
    await warmContextCodes([{ kind: "task", id: "AUD-12" }]);
    await setConversationContexts(CONV, [
      { kind: "task", taskId: TICKET_ID },
      { kind: "page", route: "planning", projectId: PROJECT_ID },
    ]);
    expect(seen.find((r) => r.method === "PATCH")!.body).toEqual({
      contexts: [
        { kind: "task", id: "AUD-12" },
        { kind: "project", id: PROJECT_ID },
      ],
    });
  });
});
