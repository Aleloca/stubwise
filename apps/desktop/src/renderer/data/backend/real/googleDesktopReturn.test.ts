import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session, setAppClientForTests } from "./client";
import { drive } from "./drive";
import { installFakeServer, ME_ID } from "./fakeServer";
import { liveMeMailboxes } from "./meMailboxes";

// Lotto 4, §6: sul desktop «Collega» lega il ritorno dal consenso di Google
// all'app (`client: "desktop"`, `returnState` dal main). Se il server dice
// `returnTo: "desktop"`, l'esito arriva da `stubwise://google`: un esito
// negativo chiude l'attesa con il motivo del prototipo, `ok` si conferma
// rileggendo le caselle. Un server di prima (senza `returnTo`) e il web: il
// polling di oggi. Il polling resta comunque, come rete.

const WS = "11111111-1111-4111-8111-111111111111";
const ACC = "aaaaaaaa-1111-4111-8111-111111111111";

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
const workspace = { id: WS, name: "Acme", domains: ["acme.test"], clientSecretSet: true };

/** Il ponte del preload: lo state, il ritorno a comando. */
function desktopBridge() {
  let returned: ((ret: { state: string; outcome: string }) => void) | null = null;
  const google = {
    prepareConnect: vi.fn(async () => ({ ok: true as const, state: "rs-0123456789abcdef" })),
    cancelConnect: vi.fn(async () => ({ ok: true })),
    onReturned: vi.fn((cb: (ret: { state: string; outcome: string }) => void) => {
      returned = cb;
      return () => {
        returned = null;
      };
    }),
  };
  vi.stubGlobal("stubwise", { google });
  vi.stubGlobal(
    "open",
    vi.fn(() => null),
  );
  return {
    google,
    back: (outcome: string, state = "rs-0123456789abcdef") => returned?.({ state, outcome }),
  };
}

function server(opts: { returnTo?: "web" | "desktop"; accounts: () => unknown[] }) {
  return installFakeServer({
    "GET /api/me/google/workspaces": { body: [workspace] },
    "POST /api/me/google/connect": {
      body: {
        authorizeUrl: "https://accounts.google.com/x",
        ...(opts.returnTo ? { returnTo: opts.returnTo } : {}),
      },
    },
    "GET /api/me/google/accounts": () => ({ body: opts.accounts() }),
  });
}

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

describe("il ritorno dal consenso di Google sul desktop", () => {
  it("manda `client: desktop` e il `returnState` del main", async () => {
    desktopBridge();
    const { seen } = server({ returnTo: "desktop", accounts: () => [] });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    void drive.connectGoogle().catch(() => undefined);
    await vi.waitFor(() =>
      expect(seen.some((r) => r.path === "/api/me/google/connect")).toBe(true),
    );
    expect(seen.find((r) => r.path === "/api/me/google/connect")!.body).toEqual({
      workspaceId: WS,
      client: "desktop",
      returnState: "rs-0123456789abcdef",
    });
  });

  it("un esito negativo chiude l'attesa subito, col motivo del prototipo", async () => {
    const bridge = desktopBridge();
    server({ returnTo: "desktop", accounts: () => [] });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const pending = drive.connectGoogle();
    await vi.waitFor(() => expect(bridge.google.onReturned).toHaveBeenCalled());
    bridge.back("domain_mismatch");
    await expect(pending).rejects.toThrow("invalid: wrong_domain");
  });

  it("gli esiti del server diventano quelli del prototipo; un ignoto è `failed`", async () => {
    for (const [outcome, reason] of [
      ["insufficient_scope", "invalid: scopes_missing"],
      ["mailbox_owned_by_other", "invalid: owned_by_other"],
      ["no_refresh_token", "failed"],
      ["error", "failed"],
    ] as const) {
      const bridge = desktopBridge();
      server({ returnTo: "desktop", accounts: () => [] });
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const pending = drive.connectGoogle();
      await vi.waitFor(() => expect(bridge.google.onReturned).toHaveBeenCalled());
      bridge.back(outcome);
      await expect(pending).rejects.toThrow(reason);
      vi.useRealTimers();
      vi.unstubAllGlobals();
      setAppClientForTests(null);
    }
  });

  it("`ok`: una rilettura delle caselle, e la casella collegata", async () => {
    const bridge = desktopBridge();
    let accounts: unknown[] = [];
    server({ returnTo: "desktop", accounts: () => accounts });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const pending = drive.connectGoogle();
    await vi.waitFor(() => expect(bridge.google.onReturned).toHaveBeenCalled());
    accounts = [account()];
    bridge.back("ok");
    await expect(pending).resolves.toMatchObject({ email: "ada@acme.test", status: "connected" });
  });

  it("un ritorno con lo state di un'altra richiesta si ignora", async () => {
    const bridge = desktopBridge();
    let accounts: unknown[] = [];
    server({ returnTo: "desktop", accounts: () => accounts });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const pending = drive.connectGoogle();
    await vi.waitFor(() => expect(bridge.google.onReturned).toHaveBeenCalled());
    bridge.back("domain_mismatch", "rs-another-state-000");
    accounts = [account()];
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toMatchObject({ email: "ada@acme.test" });
  });

  // Revisione del lotto 4, M-1: finita l'attesa (riuscita, rifiutata), lo state
  // pendente del main si dimentica subito, invece di restare valido 10 minuti.
  it("finita l'attesa, il main dimentica lo state (`cancelConnect`), riuscita o no", async () => {
    for (const outcome of ["ok", "domain_mismatch"] as const) {
      const bridge = desktopBridge();
      let accounts: unknown[] = [];
      server({ returnTo: "desktop", accounts: () => accounts });
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const pending = drive.connectGoogle().catch(() => undefined);
      await vi.waitFor(() => expect(bridge.google.onReturned).toHaveBeenCalled());
      expect(bridge.google.cancelConnect).not.toHaveBeenCalled();
      if (outcome === "ok") accounts = [account()];
      bridge.back(outcome);
      await pending;
      expect(bridge.google.cancelConnect).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
      vi.unstubAllGlobals();
      setAppClientForTests(null);
    }
  });

  it("un server di prima (senza `returnTo`): il polling di oggi, e il ritorno non conta", async () => {
    const bridge = desktopBridge();
    let accounts: unknown[] = [];
    server({ accounts: () => accounts });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const pending = drive.connectGoogle();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(bridge.google.onReturned).not.toHaveBeenCalled();
    accounts = [account()];
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toMatchObject({ email: "ada@acme.test" });
  });

  it("sul web nessun `client`: il corpo è quello di oggi", async () => {
    vi.stubGlobal(
      "open",
      vi.fn(() => null),
    );
    const { seen } = server({ accounts: () => [] });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    void drive.connectGoogle().catch(() => undefined);
    await vi.waitFor(() =>
      expect(seen.some((r) => r.path === "/api/me/google/connect")).toBe(true),
    );
    expect(seen.find((r) => r.path === "/api/me/google/connect")!.body).toEqual({
      workspaceId: WS,
    });
  });

  it("Preferenze → Account: il motivo arriva al dialogo, non solo `failed`", async () => {
    const bridge = desktopBridge();
    server({ returnTo: "desktop", accounts: () => [] });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const pending = liveMeMailboxes.connectMailbox!(WS, "connected");
    await vi.waitFor(() => expect(bridge.google.onReturned).toHaveBeenCalled());
    bridge.back("mailbox_owned_by_other");
    await expect(pending).resolves.toEqual({
      ok: false,
      error: "invalid",
      reason: "owned_by_other",
    });
  });
});
