import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer, ME_ID, PROJECT_ID, serverTask } from "./fakeServer";
import { convertRequest, listRequestsToConvert } from "./requests";

// Le richieste da trasformare in task nella build app (integrazione area 2,
// fetta 3, Task J): «Da decidere» e il blocco «Richieste nuove». La sezione
// Requests è della fetta 4: una richiesta si apre nel web vecchio.

const ITEM = "33333333-3333-4333-8333-333333333333";
const view = (over: Record<string, unknown> = {}) => ({
  id: ITEM,
  code: "AUD-R4",
  projectId: PROJECT_ID,
  title: "Export to CSV",
  status: "new",
  urgency: "urgent",
  requesterIds: [ME_ID],
  requestCount: 1,
  createdAt: "2026-11-01T09:00:00.000Z",
  webHref: "/backlog/" + ITEM,
  ...over,
});

beforeEach(() => setAppClientForTests(null));
afterEach(() => {
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("le richieste da trasformare dal server", () => {
  it("nella forma del prototipo, col link al web; «urgent» si legge «high», senza stima «medium»", async () => {
    installFakeServer({
      "GET /api/requests/to-convert": { body: [view(), view({ id: "33333333-3333-4333-8333-333333333334", urgency: null })] },
    });
    const [first, second] = await listRequestsToConvert();
    expect(first).toMatchObject({
      id: ITEM,
      code: "AUD-R4",
      projectId: PROJECT_ID,
      title: "Export to CSV",
      status: "new",
      urgency: "high",
      requesterIds: [ME_ID],
      taskIds: [],
      similarToId: null,
      mergedIntoId: null,
      webHref: "/backlog/" + ITEM,
    });
    expect(second!.urgency).toBe("medium");
  });

  it("trasformare in task: la task nasce nel progetto della richiesta, collegata", async () => {
    const { seen } = installFakeServer({
      "GET /api/requests/to-convert": { body: [view()] },
      "POST /api/tasks": { body: serverTask({ requestId: ITEM }) },
    });
    await listRequestsToConvert();
    const task = await convertRequest(ITEM, { title: "Export to CSV", type: "feature", size: "S" });
    const post = seen.find((r) => r.method === "POST")!;
    expect(post.body).toMatchObject({ projectId: PROJECT_ID, requestId: ITEM, title: "Export to CSV", type: "feature", size: "S" });
    expect(task.code).toBe("AUD-12");
    // Il progetto viene dalla richiesta già letta: nessuna lettura in più.
    expect(seen.map((r) => `${r.method} ${r.path.split("?")[0]}`)).toEqual([
      "GET /api/requests/to-convert",
      "POST /api/tasks",
    ]);
  });
});
