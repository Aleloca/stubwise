import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// La cassaforte della build web (design §5, §8, §9; revisione I-1): la barra
// dagli esiti del worker; la sessione persa e «Esci» la chiudono; Show e Copy
// passano dal worker, coi rifiuti nella forma del desktop.

let server: Record<string, unknown>;
let reveal: unknown;
let toWorker: { t: string }[];
/** Le risposte del worker per tipo di richiesta, oltre a stato e reveal. */
let replies: Record<string, unknown>;

class FakeWorker extends EventTarget {
  postMessage(m: { id: number; req: { t: string } }) {
    toWorker.push(m.req);
    const res =
      m.req.t === "serverStatus"
        ? { ok: true, status: server }
        : m.req.t === "reveal"
          ? reveal
          : (replies[m.req.t] ?? { ok: true });
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: { id: m.id, res } })));
  }
}

let worker: FakeWorker;

beforeEach(async () => {
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  vi.stubEnv("VITE_STUBWISE_TARGET", "web");
  toWorker = [];
  replies = {};
  server = {
    activated: true,
    myKey: { id: "11111111-1111-4111-8111-111111111111", status: "confirmed", createdAt: "2026-11-01T00:00:00.000Z" },
    seals: [],
    passkeys: [],
  };
  reveal = { ok: true, password: "Kx4!pa-77Wq" };
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const load = async () => {
  const client = await import("../vaultBrowser/client");
  worker = new FakeWorker();
  client.__setWorkerForTests(worker as unknown as Worker);
  const key = await import("../vaultBrowser/key");
  key.__resetKeyForTests();
  key.wireVault();
  const { vault } = await import("./web");
  const events = await import("../../../sessionEvents");
  const real = await import("../client");
  return { vault, key, events, session: real.session };
};

const opened = () =>
  worker.dispatchEvent(new MessageEvent("message", { data: { event: { t: "state", state: "open", closesAt: 1 } } }));

describe("la cassaforte della build web", () => {
  it("gli stati dal server: non attivata, senza chiave, chiave da confermare", async () => {
    const { vault } = await load();
    server = { ...server, activated: false };
    expect((await vault.getVaultStatus()).state).toBe("inactive");
    server = { ...server, activated: true, myKey: null };
    expect((await vault.getVaultStatus()).state).toBe("no_key");
    server = { ...server, myKey: { id: "11111111-1111-4111-8111-111111111111", status: "pending", createdAt: "2026-11-01T00:00:00.000Z" } };
    expect((await vault.getVaultStatus()).state).toBe("key_pending");
  });

  it("con la chiave confermata decide il worker: chiusa, aperta, chiusa dopo «Lock»", async () => {
    const { vault } = await load();
    expect((await vault.getVaultStatus()).state).toBe("locked");
    opened();
    expect((await vault.getVaultStatus()).state).toBe("open");
    await vault.lock();
    expect((await vault.getVaultStatus()).state).toBe("locked");
    expect(toWorker).toContainEqual({ t: "lock", reason: "user" });
  });

  it("I5: la sessione persa (401) e «Esci» chiudono la cassaforte", async () => {
    const { key, events } = await load();
    opened();
    events.emitSessionLost();
    expect(key.status().state).toBe("locked");
    events.emitLoggedOut();
    expect(toWorker).toContainEqual({ t: "lock", reason: "logout" });
  });

  it("Show: la sola password dal worker, con persona e sessione; un 429 arriva coi suoi secondi", async () => {
    const { vault, session } = await load();
    session.personId = "p-ada";
    expect(await vault.show("c-1")).toEqual({ ok: true, password: "Kx4!pa-77Wq" });
    expect(toWorker.at(-1)).toMatchObject({ t: "reveal", id: "c-1", action: "show", personId: "p-ada" });
    reveal = { ok: false, code: "vault_reveal_rate_limited", retryAfterSeconds: 600 };
    expect(await vault.copy("c-1")).toEqual({ ok: false, code: "vault_reveal_rate_limited", retryAfterSeconds: 600 });
    session.personId = null;
  });

  it("crea: i campi e la password al worker, che cifra; alla pagina l'id", async () => {
    const { vault } = await load();
    replies.create = { ok: true, id: "c-new", resaved: false };
    const input = { service: "Aruba", label: "Pannello", username: "ada", url: null, notes: null, password: "N3w!pass" };
    expect(await vault.createCredential("prj-acq", input as never)).toEqual({ ok: true, id: "c-new", resaved: false });
    expect(toWorker.at(-1)).toEqual({
      t: "create",
      projectId: "prj-acq",
      fields: { service: "Aruba", label: "Pannello", username: "ada", url: null, notes: null },
      password: "N3w!pass",
    });
    replies.create = { ok: false, code: "forbidden" };
    expect(await vault.createCredential("prj-acq", input as never)).toEqual({ ok: false, code: "forbidden" });
  });

  it("cambia: la password nuova al worker con persona e sessione; chiusa, il rifiuto del worker", async () => {
    const { vault, session } = await load();
    session.personId = "p-ada";
    replies.setPassword = { ok: true, resaved: true };
    expect(await vault.updateCredential("c-1", { password: "Ch4nged!" } as never)).toEqual({ ok: true, resaved: true });
    expect(toWorker.at(-1)).toMatchObject({ t: "setPassword", id: "c-1", password: "Ch4nged!", personId: "p-ada" });
    replies.setPassword = { ok: false, code: "vault_locked" };
    expect(await vault.updateCredential("c-1", { password: "Ch4nged!" } as never)).toEqual({ ok: false, code: "vault_locked" });
    session.personId = null;
  });
});

