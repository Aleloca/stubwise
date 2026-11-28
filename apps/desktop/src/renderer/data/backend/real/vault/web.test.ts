import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// La cerimonia della passkey ha i suoi test (`vaultBrowser/page.test.ts`):
// qui la presenza fresca di conferma, rifiuto e rimozione è un doppio.
const presence = vi.hoisted(() => ({
  next: { ok: true, presence: { assertion: { id: "cred" }, credentialId: "cred" } } as
    | { ok: true; presence: { assertion: unknown; credentialId: string } }
    | { ok: false; code: string },
  calls: 0,
}));
vi.mock("../vaultBrowser/unlock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../vaultBrowser/unlock")>()),
  freshPresence: async () => {
    presence.calls += 1;
    return presence.next;
  },
}));

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
  presence.calls = 0;
  presence.next = { ok: true, presence: { assertion: { id: "cred" }, credentialId: "cred" } };
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

  it("condividi: il bersaglio del prototipo (`personId`) è un `userId` per il worker; un ruolo resta un ruolo", async () => {
    const { vault, session } = await load();
    session.personId = "p-ada";
    replies.share = { ok: true, waiting: ["cleo@example.com"] };
    expect(await vault.share("c-1", { personId: "u-bea" })).toEqual({ ok: true, waiting: ["cleo@example.com"] });
    expect(toWorker.at(-1)).toMatchObject({ t: "share", id: "c-1", target: { userId: "u-bea" }, personId: "p-ada" });
    await vault.share("c-1", { roleId: "r-dev" });
    expect(toWorker.at(-1)).toMatchObject({ t: "share", target: { roleId: "r-dev" } });
    replies.share = { ok: false, code: "vault_locked" };
    expect(await vault.share("c-1", { personId: "u-bea" })).toEqual({ ok: false, code: "vault_locked" });
    session.personId = null;
  });

  it("togli: al worker, con persona e sessione", async () => {
    const { vault, session } = await load();
    session.personId = "p-ada";
    expect(await vault.removeReader("c-1", "u-bea")).toEqual({ ok: true });
    expect(toWorker.at(-1)).toMatchObject({ t: "removeReader", id: "c-1", readerId: "u-bea", personId: "p-ada", presence: { credentialId: "cred" } });
    expect(presence.calls).toBe(1);
    session.personId = null;
  });

  it("chi aspetta: dal worker, col progetto di ogni credenziale; il nome dalla rubrica, l'email se manca", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const { vault } = await load();
    replies.pending = {
      ok: true,
      items: [
        {
          userId: "u-bea",
          email: "bea@example.com",
          personKeyId: "k-bea",
          status: "pending",
          createdAt: "2026-11-20T10:00:00.000Z",
          device: "Safari",
          fingerprint: "ABCD-EFGH",
          credentials: [{ id: "c-1", projectId: "prj-acq", service: "Aruba", label: null }],
        },
      ],
    };
    expect(await vault.listPending()).toEqual([
      {
        keyId: "k-bea",
        personId: "u-bea",
        name: "bea@example.com",
        email: "bea@example.com",
        createdAt: "2026-11-20T10:00:00.000Z",
        device: "Safari",
        fingerprint: "ABCD-EFGH",
        credentials: [{ id: "c-1", service: "Aruba", projectId: "prj-acq" }],
      },
    ]);
    expect(toWorker.at(-1)).toEqual({ t: "pending" });
    // Un errore di rete è un errore (la pagina lo dice), non «nessuno aspetta».
    replies.pending = { ok: false, code: "network" };
    await expect(vault.listPending()).rejects.toThrow("network");
  });

  it("conferma e rifiuta: al worker, con persona e sessione", async () => {
    const { vault, session } = await load();
    session.personId = "p-ada";
    replies.confirm = { ok: true, saved: 2, keyChanged: 0, notAllowed: 0, unopenable: 1 };
    expect(await vault.confirm("k-bea")).toEqual({ ok: true, saved: 2, keyChanged: 0, notAllowed: 0, unopenable: 1 });
    expect(toWorker.at(-1)).toMatchObject({ t: "confirm", keyId: "k-bea", personId: "p-ada", presence: { credentialId: "cred" } });
    expect(await vault.reject("k-bea")).toEqual({ ok: true });
    expect(toWorker.at(-1)).toMatchObject({ t: "reject", keyId: "k-bea", personId: "p-ada" });
    replies.reject = { ok: false, code: "vault_locked" };
    expect(await vault.reject("k-bea")).toEqual({ ok: false, code: "vault_locked" });
    expect(presence.calls).toBe(3);
    // Senza il tocco della passkey il worker non riceve niente.
    presence.next = { ok: false, code: "passkey_failed" };
    const before = toWorker.length;
    expect(await vault.confirm("k-bea")).toEqual({ ok: false, code: "passkey_failed" });
    expect(toWorker.length).toBe(before);
    session.personId = null;
  });
});

