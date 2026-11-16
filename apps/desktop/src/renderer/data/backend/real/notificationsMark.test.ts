import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer } from "./fakeServer";
import { markNotification } from "./notifications";

// Area 9, F1, R10: «Restore», «Move to New» e «non letta» dell'Inbox sulle
// rotte nuove del server (`POST /api/inbox/:id/restore|move-to-new|unread`).

const ID = "55555555-5555-4555-8555-555555555555";

beforeEach(() => setAppClientForTests(null));
afterEach(() => setAppClientForTests(null));

describe("i cambi di una card dell'Inbox sul server (area 9, R10)", () => {
  it("da archiviata a nuova è restore; da rinviata a nuova è move-to-new; non letta è unread", async () => {
    const { seen } = installFakeServer({
      [`POST /api/inbox/${ID}/restore`]: { status: 204 },
      [`POST /api/inbox/${ID}/move-to-new`]: { status: 204 },
      [`POST /api/inbox/${ID}/unread`]: { status: 204 },
    });
    await markNotification(ID, { archived: false });
    await markNotification(ID, { snoozedUntil: null });
    await markNotification(ID, { read: false });
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST /api/inbox/${ID}/restore`,
      `POST /api/inbox/${ID}/move-to-new`,
      `POST /api/inbox/${ID}/unread`,
    ]);
  });

  it("un passaggio che dallo stato attuale non ha senso (409 invalid_state) non rompe: il pannello rilegge", async () => {
    installFakeServer({
      [`POST /api/inbox/${ID}/restore`]: {
        status: 409,
        body: { code: "invalid_state", message: "x" },
      },
    });
    await expect(markNotification(ID, { archived: false })).resolves.toBeUndefined();
  });
});
