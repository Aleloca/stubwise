import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session, setAppClientForTests } from "./client";
import { installFakeServer, ME_ID } from "./fakeServer";
import { liveMeMailboxes as me } from "./meMailboxes";

// Registro, A9 r.1200 (decisione del maintainer del 23 nov 2026: «Anche in
// Preferenze»): le caselle Google in Preferenze → Account nella build app,
// sulle stesse rotte del cassetto Google (`/api/me/google`). Collegare e
// ricollegare passano dallo stesso consenso nel browser del cassetto
// (`connectGoogle`); scollegare e «Proposals» dalle rotte della casella.

const WS = "11111111-1111-4111-8111-111111111111";
const WS2 = "22222222-2222-4222-8222-222222222222";
const ACC = "aaaaaaaa-1111-4111-8111-111111111111";
const ACC2 = "aaaaaaaa-2222-4222-8222-222222222222";

const account = (over: Record<string, unknown> = {}) => ({
  id: ACC,
  email: "ada@acme.test",
  workspaceId: WS,
  workspaceName: "Acme",
  scopes: [],
  proposalsEnabled: true,
  connectedAt: "2026-11-01T09:00:00.000Z",
  lastSyncAt: "2026-11-12T09:58:00.000Z",
  lastSyncError: null,
  disabledAt: null,
  disabledReason: null,
  missingScopes: [],
  ...over,
});
const workspace = (over: Record<string, unknown> = {}) => ({
  id: WS,
  name: "Acme",
  domains: ["acme.test"],
  clientSecretSet: true,
  ...over,
});

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  session.personId = ME_ID;
});
afterEach(() => {
  session.personId = null;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("Preferenze → Account: le caselle Google nella build app", () => {
  it("le mie caselle con il loro stato, e i Workspace utilizzabili fra cui scegliere", async () => {
    installFakeServer({
      "GET /api/me/google/accounts": {
        body: [
          account(),
          account({
            id: ACC2,
            email: "ada@old.test",
            workspaceName: "Old",
            disabledAt: "2026-11-10T08:00:00.000Z",
            proposalsEnabled: false,
          }),
        ],
      },
      "GET /api/me/google/workspaces": {
        body: [workspace(), workspace({ id: WS2, name: "Senza segreto", clientSecretSet: false })],
      },
    });
    const r = await me.listMyMailboxes!();
    expect(r.workspaces).toEqual([{ id: WS, name: "Acme" }]);
    expect(r.mailboxes).toEqual([
      {
        id: ACC,
        email: "ada@acme.test",
        workspaceName: "Acme",
        status: "connected",
        sync: "ok",
        syncedAt: "2026-11-12T09:58:00.000Z",
        proposalsEnabled: true,
      },
      expect.objectContaining({ id: ACC2, status: "needs_reconnect", proposalsEnabled: false }),
    ]);
  });

  it("una casella a cui mancano gli scope nuovi va ricollegata", async () => {
    installFakeServer({
      "GET /api/me/google/accounts": {
        body: [account({ missingScopes: ["https://www.googleapis.com/auth/calendar.events"] })],
      },
      "GET /api/me/google/workspaces": { body: [workspace()] },
    });
    expect((await me.listMyMailboxes!()).mailboxes[0]!.status).toBe("needs_reconnect");
  });

  it("Google non configurato sull'istanza (403 sulle caselle): nessuna casella; i Workspace dicono il resto", async () => {
    installFakeServer({
      "GET /api/me/google/accounts": { status: 403, body: { code: "forbidden", message: "x" } },
      "GET /api/me/google/workspaces": { body: [] },
    });
    expect(await me.listMyMailboxes!()).toEqual({ mailboxes: [], workspaces: [] });
  });

  it("«Collega» col Workspace scelto: il consenso fuori dall'app, poi la casella nuova", async () => {
    let accounts: unknown[] = [];
    const { seen } = installFakeServer({
      "GET /api/me/google/workspaces": {
        body: [workspace(), workspace({ id: WS2, name: "Beta" })],
      },
      "POST /api/me/google/connect": { body: { authorizeUrl: "https://accounts.google.com/x" } },
      "GET /api/me/google/accounts": () => ({ body: accounts }),
    });
    vi.stubGlobal(
      "open",
      vi.fn(() => null),
    );
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const pending = me.connectMailbox!(WS2, "connected");
    await vi.waitFor(() =>
      expect(seen.some((r) => r.path === "/api/me/google/connect")).toBe(true),
    );
    // Senza ponte (la build web): il ritorno va sulla nuova app.
    expect(seen.find((r) => r.path === "/api/me/google/connect")!.body).toEqual({
      workspaceId: WS2,
      client: "web",
    });
    accounts = [account({ workspaceId: WS2, workspaceName: "Beta", email: "ada@beta.test" })];
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toMatchObject({
      ok: true,
      mailbox: { id: ACC, email: "ada@beta.test", workspaceName: "Beta", status: "connected" },
    });
  });

  it("«Collega» che non va (Google non risponde in tempo, Workspace sparito): un rifiuto in parole, non un'eccezione", async () => {
    installFakeServer({ "GET /api/me/google/workspaces": { body: [workspace()] } });
    await expect(me.connectMailbox!(WS2, "connected")).resolves.toEqual({
      ok: false,
      error: "invalid",
      reason: "failed",
    });
  });

  it("«Reconnect» sulla casella: lo stesso consenso, sul suo Workspace", async () => {
    let accounts: unknown[] = [account({ disabledAt: "2026-11-10T08:00:00.000Z" })];
    const { seen } = installFakeServer({
      "GET /api/me/google/workspaces": { body: [workspace()] },
      "POST /api/me/google/connect": { body: { authorizeUrl: "https://accounts.google.com/x" } },
      "GET /api/me/google/accounts": () => ({ body: accounts }),
    });
    vi.stubGlobal(
      "open",
      vi.fn(() => null),
    );
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const pending = me.reconnectMailbox!(ACC, "connected");
    await vi.waitFor(() =>
      expect(seen.some((r) => r.path === "/api/me/google/connect")).toBe(true),
    );
    // Senza ponte (la build web): il ritorno va sulla nuova app.
    expect(seen.find((r) => r.path === "/api/me/google/connect")!.body).toEqual({
      workspaceId: WS,
      client: "web",
    });
    accounts = [account({ connectedAt: "2026-11-23T10:00:00.000Z" })];
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("«Reconnect», «Disconnect» e «Proposals» su una casella che non è mia: `not_found`", async () => {
    installFakeServer({ "GET /api/me/google/accounts": { body: [account()] } });
    expect(await me.reconnectMailbox!("acc-x", "connected")).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await me.disconnectMailbox!("acc-x")).toEqual({ ok: false, error: "not_found" });
    expect(await me.setProposals!("acc-x", false)).toEqual({ ok: false, error: "not_found" });
  });

  it("«Disconnect» e «Proposals»: le rotte della casella", async () => {
    const { seen } = installFakeServer({
      "GET /api/me/google/accounts": { body: [account()] },
      [`DELETE /api/me/google/accounts/${ACC}`]: { status: 204 },
      [`PATCH /api/me/google/accounts/${ACC}`]: { body: account({ proposalsEnabled: false }) },
    });
    expect(await me.setProposals!(ACC, false)).toEqual({ ok: true });
    expect(seen.find((r) => r.method === "PATCH")!.body).toEqual({ proposalsEnabled: false });
    expect(await me.disconnectMailbox!(ACC)).toEqual({ ok: true });
    expect(
      seen.some((r) => r.method === "DELETE" && r.path === `/api/me/google/accounts/${ACC}`),
    ).toBe(true);
  });
});
