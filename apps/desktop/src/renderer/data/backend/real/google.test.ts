import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session, setAppClientForTests } from "./client";
import { drive } from "./drive";
import { installFakeServer, ME_ID } from "./fakeServer";
import { mail } from "./mail";

// Il cassetto Google nella build app (area 6, fetta 1): le caselle vere di
// `/api/me/google`. Il cassetto mostra UNA casella (quella da ricollegare, se
// c'è, altrimenti la prima: decisione B(a) dell'orchestratrice), la Posta le
// mostra tutte. «Collega» apre l'URL di consenso di Google fuori dall'app e
// rilegge le caselle finché quella nuova (o ricollegata) non c'è.

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
});
afterEach(() => {
  session.personId = null;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("il cassetto Google: l'account", () => {
  it("nessuna casella: nessun account", async () => {
    installFakeServer({ "GET /api/me/google/accounts": { body: [] } });
    session.personId = ME_ID;
    expect(await drive.getGoogleAccount()).toBeNull();
  });

  it("una casella collegata: l'account con la sua email, da quando", async () => {
    installFakeServer({ "GET /api/me/google/accounts": { body: [account()] } });
    session.personId = ME_ID;
    expect(await drive.getGoogleAccount()).toEqual({
      personId: ME_ID,
      email: "ada@acme.test",
      status: "connected",
      since: "2026-11-01T09:00:00.000Z",
    });
  });

  it("più caselle: il cassetto mostra quella da ricollegare (scaduta o senza gli scope nuovi), altrimenti la prima", async () => {
    installFakeServer({
      "GET /api/me/google/accounts": {
        body: [
          account(),
          account({ id: ACC2, email: "ada@other.test", missingScopes: ["https://www.googleapis.com/auth/gmail.modify"] }),
        ],
      },
    });
    session.personId = ME_ID;
    expect(await drive.getGoogleAccount()).toMatchObject({ email: "ada@other.test", status: "expired" });
  });

  it("senza gli scope nuovi: da ricollegare per i permessi, con le funzioni che mancano, prese da missingScopes", async () => {
    installFakeServer({
      "GET /api/me/google/accounts": {
        body: [
          account({
            missingScopes: [
              "https://www.googleapis.com/auth/gmail.modify",
              "https://www.googleapis.com/auth/drive.readonly",
            ],
          }),
        ],
      },
    });
    session.personId = ME_ID;
    expect(await drive.getGoogleAccount()).toMatchObject({ status: "expired", reconnect: "scopes", missing: ["markRead"] });
  });

  it("uno scope mancante di una funzione che non c'è ancora (Drive, F5): da ricollegare, senza funzioni elencate", async () => {
    installFakeServer({
      "GET /api/me/google/accounts": {
        body: [account({ missingScopes: ["https://www.googleapis.com/auth/drive.readonly"] })],
      },
    });
    session.personId = ME_ID;
    expect(await drive.getGoogleAccount()).toMatchObject({ status: "expired", reconnect: "scopes", missing: [] });
  });

  it("una casella disattivata è scaduta da quando è stata disattivata", async () => {
    installFakeServer({
      "GET /api/me/google/accounts": {
        body: [account({ disabledAt: "2026-11-10T08:00:00.000Z", disabledReason: "invalid_grant" })],
      },
    });
    session.personId = ME_ID;
    expect(await drive.getGoogleAccount()).toMatchObject({ status: "expired", reconnect: "expired", since: "2026-11-10T08:00:00.000Z" });
  });

  it("scollegare toglie la casella del cassetto", async () => {
    const { seen } = installFakeServer({
      "GET /api/me/google/accounts": { body: [account()] },
      [`DELETE /api/me/google/accounts/${ACC}`]: { status: 204 },
    });
    session.personId = ME_ID;
    await drive.disconnectGoogle();
    expect(seen.some((r) => r.method === "DELETE" && r.path === `/api/me/google/accounts/${ACC}`)).toBe(true);
  });
});

describe("il cassetto Google: «Collega»", () => {
  it("un solo Workspace utilizzabile: nessuna domanda; l'URL di Google fuori dall'app; collegata quando la casella c'è", async () => {
    let accounts: unknown[] = [];
    const { seen } = installFakeServer({
      "GET /api/me/google/workspaces": { body: [workspace(), workspace({ id: WS2, name: "Old", clientSecretSet: false })] },
      "POST /api/me/google/connect": { body: { authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1" } },
      "GET /api/me/google/accounts": () => ({ body: accounts }),
    });
    const opened = vi.fn(() => null);
    vi.stubGlobal("open", opened);
    session.personId = ME_ID;
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const pending = drive.connectGoogle();
    await vi.waitFor(() => expect(opened).toHaveBeenCalled());
    expect(opened).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?x=1", "_blank", "noopener");
    expect(seen.find((r) => r.path === "/api/me/google/connect")!.body).toEqual({ workspaceId: WS });
    // Il consenso nel browser: la casella arriva dopo qualche rilettura.
    await vi.advanceTimersByTimeAsync(3_000);
    accounts = [account()];
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toMatchObject({ email: "ada@acme.test", status: "connected" });
  });

  it("ricollegare: la stessa casella che non ha più scope mancanti è collegata", async () => {
    let accounts: unknown[] = [account({ missingScopes: ["https://www.googleapis.com/auth/gmail.modify"] })];
    installFakeServer({
      "GET /api/me/google/workspaces": { body: [workspace()] },
      "POST /api/me/google/connect": { body: { authorizeUrl: "https://accounts.google.com/x" } },
      "GET /api/me/google/accounts": () => ({ body: accounts }),
    });
    vi.stubGlobal("open", vi.fn(() => null));
    session.personId = ME_ID;
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const pending = drive.connectGoogle();
    await vi.advanceTimersByTimeAsync(3_000);
    accounts = [account()];
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toMatchObject({ status: "connected" });
  });

  it("più Workspace utilizzabili: senza una scelta non parte; con la scelta usa quello", async () => {
    let accounts: unknown[] = [];
    const { seen } = installFakeServer({
      "GET /api/me/google/workspaces": { body: [workspace(), workspace({ id: WS2, name: "Beta" })] },
      "POST /api/me/google/connect": () => {
        accounts = [account({ workspaceId: WS2 })];
        return { body: { authorizeUrl: "https://accounts.google.com/x" } };
      },
      "GET /api/me/google/accounts": () => ({ body: accounts }),
    });
    vi.stubGlobal("open", vi.fn(() => null));
    session.personId = ME_ID;
    expect(await drive.listGoogleWorkspaces()).toEqual([
      { id: WS, name: "Acme", domains: ["acme.test"] },
      { id: WS2, name: "Beta", domains: ["acme.test"] },
    ]);
    await expect(drive.connectGoogle()).rejects.toThrow("invalid: workspace");
    expect(seen.some((r) => r.path === "/api/me/google/connect")).toBe(false);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const pending = drive.connectGoogle({ workspaceId: WS2 });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toMatchObject({ status: "connected" });
    expect(seen.find((r) => r.path === "/api/me/google/connect")!.body).toEqual({ workspaceId: WS2 });
  });

  it("nessun Workspace utilizzabile: l'errore, senza aprire niente", async () => {
    installFakeServer({ "GET /api/me/google/workspaces": { body: [workspace({ clientSecretSet: false })] } });
    const opened = vi.fn(() => null);
    vi.stubGlobal("open", opened);
    session.personId = ME_ID;
    await expect(drive.connectGoogle()).rejects.toThrow("invalid: google_not_configured");
    expect(opened).not.toHaveBeenCalled();
  });

  it("dopo 10 minuti senza esito: l'errore («Try again»)", async () => {
    installFakeServer({
      "GET /api/me/google/workspaces": { body: [workspace()] },
      "POST /api/me/google/connect": { body: { authorizeUrl: "https://accounts.google.com/x" } },
      "GET /api/me/google/accounts": { body: [] },
    });
    vi.stubGlobal("open", vi.fn(() => null));
    session.personId = ME_ID;
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const pending = drive.connectGoogle();
    const caught = pending.catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 3_000);
    expect(await caught).toMatchObject({ message: "failed" });
  });
});

describe("le caselle nella Posta", () => {
  it("tutte le caselle, con allineamento, vecchiaia e «da ricollegare»", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T10:00:00.000Z"));
    installFakeServer({
      "GET /api/me/google/accounts": {
        body: [
          account(),
          account({
            id: ACC2,
            email: "ada@other.test",
            proposalsEnabled: false,
            lastSyncAt: "2026-11-12T09:00:00.000Z",
            disabledAt: "2026-11-11T08:00:00.000Z",
          }),
        ],
      },
    });
    session.personId = ME_ID;
    expect(await mail.listMailboxes()).toEqual([
      { personId: ME_ID, email: "ada@acme.test", proposalsEnabled: true, syncedAt: "2026-11-12T09:58:00.000Z", sync: "ok", stale: false, expired: false },
      { personId: ME_ID, email: "ada@other.test", proposalsEnabled: false, syncedAt: "2026-11-12T09:00:00.000Z", sync: "ok", stale: true, expired: true },
    ]);
  });

  it("una casella a cui mancano solo gli scope nuovi legge ancora: non è scaduta", async () => {
    installFakeServer({
      "GET /api/me/google/accounts": { body: [account({ missingScopes: ["https://www.googleapis.com/auth/gmail.modify"] })] },
    });
    session.personId = ME_ID;
    expect((await mail.listMailboxes())[0]!.expired).toBe(false);
  });

  it("«Proposte attive» si scrive sulla casella della sua email; una che non è mia è not_found", async () => {
    const { seen } = installFakeServer({
      "GET /api/me/google/accounts": { body: [account()] },
      [`PATCH /api/me/google/accounts/${ACC}`]: { body: account({ proposalsEnabled: false }) },
    });
    session.personId = ME_ID;
    await mail.setProposalsEnabled("ada@acme.test", false);
    expect(seen.find((r) => r.method === "PATCH")!.body).toEqual({ proposalsEnabled: false });
    await expect(mail.setProposalsEnabled("bob@acme.test", true)).rejects.toThrow("not_found");
  });
});
