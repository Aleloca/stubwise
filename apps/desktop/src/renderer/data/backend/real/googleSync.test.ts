import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calendar } from "./calendar";
import { session, setAppClientForTests } from "./client";
import { installFakeServer, ME_ID } from "./fakeServer";
import { mail } from "./mail";

// «Aggiorna ora» nella build app (area 6, F1.2): `POST
// /api/me/google/accounts/:id/sync` accoda il giro della casella; la fine si
// vede sulla riga della casella — `syncRequestedAt` torna null, riuscito se
// `lastSyncAt` è avanzato, non riuscito se no.

const ACC = "aaaaaaaa-1111-4111-8111-111111111111";
const ACC2 = "aaaaaaaa-2222-4222-8222-222222222222";
const BEFORE = "2026-11-12T09:58:00.000Z";
const AFTER = "2026-11-12T10:00:05.000Z";

const account = (over: Record<string, unknown> = {}) => ({
  id: ACC,
  email: "ada@acme.test",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  workspaceName: "Acme",
  scopes: [],
  proposalsEnabled: true,
  connectedAt: "2026-11-01T09:00:00.000Z",
  lastSyncAt: BEFORE,
  disabledAt: null,
  disabledReason: null,
  missingScopes: [],
  syncRequestedAt: null,
  ...over,
});

/** Le caselle del server finto: cambiano mentre il giro va. */
let rows: Record<string, unknown>[] = [];

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  session.personId = ME_ID;
  rows = [account()];
});
afterEach(() => {
  session.personId = null;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

function server(sync: (id: string) => { status?: number; body?: unknown }) {
  return installFakeServer({
    "GET /api/me/google/accounts": () => ({ body: rows }),
    [`POST /api/me/google/accounts/${ACC}/sync`]: () => sync(ACC),
    [`POST /api/me/google/accounts/${ACC2}/sync`]: () => sync(ACC2),
  });
}

const queued = (id: string) => {
  // Il server scrive l'istante della richiesta.
  rows = rows.map((r) => (r["id"] === id ? { ...r, syncRequestedAt: new Date().toISOString() } : r));
  return { status: 202, body: { status: "queued" } };
};

describe("«Aggiorna ora» della Posta", () => {
  it("accoda il giro della casella dell'email; la casella è «in allineamento» finché il server non ha finito", async () => {
    const { seen } = server(queued);
    await mail.syncMailbox("ada@acme.test");
    expect(seen.filter((r) => r.method === "POST").map((r) => r.path)).toEqual([`/api/me/google/accounts/${ACC}/sync`]);
    expect((await mail.listMailboxes())[0]!.sync).toBe("syncing");
  });

  it("finito con `lastSyncAt` avanzato: `ok`, aggiornata adesso; `whenMailSynced` aspetta la fine", async () => {
    vi.useFakeTimers();
    server(queued);
    await mail.syncMailbox("ada@acme.test");
    let synced = false;
    void mail.whenMailSynced().then(() => (synced = true));
    await vi.advanceTimersByTimeAsync(2_500);
    expect(synced).toBe(false);
    rows = [account({ lastSyncAt: AFTER })];
    await vi.advanceTimersByTimeAsync(2_500);
    expect(synced).toBe(true);
    expect((await mail.listMailboxes())[0]).toMatchObject({ sync: "ok", syncedAt: AFTER });
  });

  it("finito SENZA che `lastSyncAt` avanzi: non riuscito («Riprova»)", async () => {
    server(queued);
    await mail.syncMailbox("ada@acme.test");
    rows = [account()];
    expect((await mail.listMailboxes())[0]!.sync).toBe("failed");
  });

  it("una richiesta già in attesa (`already_queued`) o di meno di un minuto fa (429) non è un errore", async () => {
    server(() => ({ status: 202, body: { status: "already_queued" } }));
    await expect(mail.syncMailbox("ada@acme.test")).resolves.toBeUndefined();
    server(() => ({ status: 429, body: { code: "sync_too_soon", message: "x", retryAfterSeconds: 30 } }));
    await expect(mail.syncMailbox("ada@acme.test")).resolves.toBeUndefined();
  });

  it("una casella scaduta è `google_not_connected` (Ricollega)", async () => {
    server(() => ({ status: 409, body: { code: "account_disabled", message: "x" } }));
    await expect(mail.syncMailbox("ada@acme.test")).rejects.toThrow("google_not_connected");
  });

  it("un'email che non è fra le mie caselle: `not_found`, senza chiamare il server", async () => {
    const { seen } = server(queued);
    await expect(mail.syncMailbox("bob@acme.test")).rejects.toThrow("not_found");
    expect(seen.some((r) => r.method === "POST")).toBe(false);
  });

  it("la Posta smette di aspettare dopo 2 minuti (la casella dice com'è andata)", async () => {
    vi.useFakeTimers();
    server(queued);
    await mail.syncMailbox("ada@acme.test");
    let synced = false;
    void mail.whenMailSynced().then(() => (synced = true));
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 3_000);
    expect(synced).toBe(true);
  });
});

describe("«Aggiorna ora» del Calendario", () => {
  it("accoda il giro delle mie caselle collegate, anche con le proposte spente (non le scadute)", async () => {
    rows = [
      account(),
      account({ id: ACC2, email: "ada@beta.test", proposalsEnabled: false }),
      account({ id: "aaaaaaaa-3333-4333-8333-333333333333", email: "ada@gamma.test", disabledAt: BEFORE }),
    ];
    const { seen } = server(queued);
    await calendar.syncCalendar();
    expect(seen.filter((r) => r.method === "POST").map((r) => r.path)).toEqual([
      `/api/me/google/accounts/${ACC}/sync`,
      `/api/me/google/accounts/${ACC2}/sync`,
    ]);
    expect((await calendar.listCalendars())[0]!.sync).toBe("syncing");
  });

  it("nessuna casella da allineare: `google_not_connected`", async () => {
    rows = [account({ disabledAt: BEFORE })];
    server(queued);
    await expect(calendar.syncCalendar()).rejects.toThrow("google_not_connected");
  });
});

describe("una richiesta che il server non chiude", () => {
  it("oltre 2 minuti da `syncRequestedAt` la casella è «non riuscita» (e smette di rileggersi)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T10:05:00Z"));
    rows = [
      account({ syncRequestedAt: "2026-11-12T10:02:30.000Z" }),
      account({ id: ACC2, email: "ada@beta.test", syncRequestedAt: "2026-11-12T10:04:00.000Z" }),
    ];
    server(queued);
    expect((await mail.listMailboxes()).map((b) => b.sync)).toEqual(["failed", "syncing"]);
  });
});
