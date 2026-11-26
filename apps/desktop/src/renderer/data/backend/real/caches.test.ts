import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer, me, TICKET_ID } from "./fakeServer";
import { getSessionPerson } from "./session";
import { editComment, listActivity } from "./taskDetail";

const OTHER_USER = "22222222-2222-4222-8222-000000000002";
const COMMENT = "13131313-1313-4131-8131-131313131313";

beforeEach(() => setAppClientForTests(null));
afterEach(() => {
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("cache del client al cambio di persona", () => {
  it("i commenti letti dalla persona di prima non si modificano più a nome della nuova", async () => {
    let who = me();
    installFakeServer({
      "GET /api/auth/me": () => ({ body: who }),
      [`GET /api/tasks/${TICKET_ID}/activity`]: {
        body: [{ id: COMMENT, taskId: TICKET_ID, kind: "comment", authorId: null, at: "2026-11-09T10:00:00.000Z", body: "x" }],
      },
      [`PATCH /api/tickets/${TICKET_ID}/comments/${COMMENT}`]: {
        body: { id: COMMENT, ticketId: TICKET_ID, authorType: "user", authorId: null, body: "y", createdAt: "2026-11-09T10:00:00.000Z" },
      },
    });
    await getSessionPerson();
    await listActivity(TICKET_ID);
    await expect(editComment(COMMENT, "y")).resolves.toMatchObject({ body: "y" });
    who = me({ user: { ...me().user, id: OTHER_USER } });
    await getSessionPerson();
    await expect(editComment(COMMENT, "y")).rejects.toThrow("not_found");
  });
});
