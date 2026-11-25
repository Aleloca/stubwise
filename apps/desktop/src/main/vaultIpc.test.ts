// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { registerVaultIpc, VAULT_CHANNELS } from "./vaultIpc";
import type { VaultLock } from "./vaultLock";

// Lotto 10, design §3: il renderer chiede alla cassaforte del main stato,
// apertura, chiusura, «Dimentica questo Mac» e l'associazione. Riceve esiti
// e l'impronta del dispositivo, MAI la chiave; un mittente che non è l'app
// non ottiene niente.

const SECRET = {
  type: "private",
  extractable: false,
  marker: "PERSON-PRIVATE-KEY",
} as unknown as CryptoKey;

function setup() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc = {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(channel, fn),
  };
  const lock: VaultLock = {
    status: vi.fn(async () => ({ state: "open" as const, fingerprint: "fp", touchId: true })),
    unlock: vi.fn(async () => ({ ok: true as const })),
    lock: vi.fn(),
    use: vi.fn(async (run) => run(SECRET, "pk-1")),
    useWithTouch: vi.fn(async (run) => run(SECRET, "pk-1")),
    forget: vi.fn(async () => ({ ok: true as const, remote: true })),
    adopt: vi.fn(),
    epoch: vi.fn(() => 0),
    sessionChanged: vi.fn(),
    markRevoked: vi.fn(),
    markDisabled: vi.fn(),
  };
  const pairing = {
    start: vi.fn(async () => ({ ok: true as const, fingerprint: "fp" })),
    cancel: vi.fn(),
  };
  const ok = async () => ({ ok: true as const });
  const ops = {
    show: vi.fn(async () => ({ ok: true as const, password: "pw" })),
    copy: vi.fn(ok),
    share: vi.fn(async () => ({ ok: true as const, waiting: [] })),
    removeReader: vi.fn(ok),
    pending: vi.fn(async () => ({ ok: true as const, items: [] })),
    confirm: vi.fn(async () => ({
      ok: true as const,
      saved: 1,
      keyChanged: 0,
      notAllowed: 0,
      unopenable: 0,
    })),
    reject: vi.fn(ok),
    macs: vi.fn(async () => ({ ok: true as const, items: [] })),
    removeMac: vi.fn(ok),
    create: vi.fn(async () => ({ ok: true as const, id: CRED })),
    setPassword: vi.fn(ok),
    serverStatus: vi.fn(async () => ({ ok: true as const, activated: true, myKey: null })),
    mine: vi.fn(async () => ({ ok: true as const, items: [] })),
  };
  const fromApp = (event: unknown) => (event as { app?: boolean }).app === true;
  registerVaultIpc(ipc, { lock, pairing, ops, fromApp });
  const call = (channel: string, app = true, ...args: unknown[]) =>
    handlers.get(channel)!({ app }, ...args);
  return { handlers, call, lock, pairing, ops };
}

const CRED = "cccccccc-0000-4000-8000-000000000001";
const USER = "dddddddd-0000-4000-8000-000000000001";

describe("l'IPC della cassaforte", () => {
  it("registra i canali, e solo quelli", () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([...VAULT_CHANNELS].sort());
  });

  it("ogni risposta è un esito o lo stato: la chiave non attraversa mai l'IPC", async () => {
    const { call } = setup();
    for (const channel of VAULT_CHANNELS) {
      const out = await call(channel, true, CRED, { userId: USER });
      expect(JSON.stringify(out), channel).not.toContain("PERSON-PRIVATE-KEY");
      expect(out, channel).not.toBe(SECRET);
    }
    expect(await call("vault:status")).toEqual({ state: "open", fingerprint: "fp", touchId: true });
    // «Copy» non restituisce la password: gli appunti li scrive il main.
    expect(await call("vault:copy", true, CRED)).toEqual({ ok: true });
    expect(await call("vault:pair-start")).toEqual({ ok: true, fingerprint: "fp" });
  });

  it("un mittente che non è l'app: niente, e nessuna azione", async () => {
    const { call, lock, pairing, ops } = setup();
    expect(await call("vault:status", false)).toEqual({
      state: "unpaired",
      fingerprint: null,
      touchId: false,
    });
    // Ogni canale tranne lo stato, anche con argomenti validi.
    for (const channel of VAULT_CHANNELS.filter((c) => c !== "vault:status")) {
      expect(await call(channel, false, CRED, { userId: USER }), channel).toEqual({
        ok: false,
        code: "invalid_request",
      });
    }
    expect(ops.show).not.toHaveBeenCalled();
    expect(lock.unlock).not.toHaveBeenCalled();
    expect(lock.forget).not.toHaveBeenCalled();
    expect(pairing.start).not.toHaveBeenCalled();
  });

  it("le operazioni con la chiave: argomenti validati prima di toccare la cassaforte", async () => {
    const { call, ops } = setup();
    expect(await call("vault:show", true, CRED)).toEqual({ ok: true, password: "pw" });
    expect(ops.show).toHaveBeenCalledWith(CRED);
    expect(await call("vault:share", true, CRED, { roleId: USER })).toMatchObject({ ok: true });
    expect(ops.share).toHaveBeenCalledWith(CRED, { roleId: USER });
    for (const [channel, args] of [
      ["vault:show", ["../../etc"]],
      ["vault:copy", [42]],
      ["vault:share", [CRED, { userId: USER, roleId: USER }]],
      ["vault:share", [CRED, { email: "x@y" }]],
      ["vault:remove-reader", [CRED, "not-a-uuid"]],
      ["vault:confirm", ["x"]],
      ["vault:reject", [undefined]],
      ["vault:remove-mac", ["../mine"]],
      // Creare: il progetto, i campi in chiaro coi limiti del server, una password.
      [
        "vault:create",
        ["x", { service: "S", label: null, url: null, username: null, notes: null }, "pw"],
      ],
      [
        "vault:create",
        [CRED, { service: "  ", label: null, url: null, username: null, notes: null }, "pw"],
      ],
      [
        "vault:create",
        [CRED, { service: "S", label: 3, url: null, username: null, notes: null }, "pw"],
      ],
      [
        "vault:create",
        [
          CRED,
          { service: "S".repeat(201), label: null, url: null, username: null, notes: null },
          "pw",
        ],
      ],
      [
        "vault:create",
        [CRED, { service: "S", label: null, url: null, username: null, notes: null }, ""],
      ],
      ["vault:set-password", [CRED, ""]],
      ["vault:set-password", ["x", "pw"]],
    ] as const) {
      expect(await call(channel, true, ...args), channel).toEqual({
        ok: false,
        code: "invalid_request",
      });
    }
    expect(ops.copy).not.toHaveBeenCalled();
    expect(ops.removeReader).not.toHaveBeenCalled();
    expect(ops.confirm).not.toHaveBeenCalled();
    expect(ops.reject).not.toHaveBeenCalled();
    expect(ops.removeMac).not.toHaveBeenCalled();
    expect(ops.create).not.toHaveBeenCalled();
    expect(ops.setPassword).not.toHaveBeenCalled();
  });

  it("creare e la password nuova: argomenti validi arrivano alle operazioni (i campi ripuliti)", async () => {
    const { call, ops } = setup();
    expect(
      await call(
        "vault:create",
        true,
        CRED,
        { service: " Brevo ", label: null, url: null, username: "pm", notes: null, extra: 1 },
        "pw",
      ),
    ).toEqual({ ok: true, id: CRED });
    expect(ops.create).toHaveBeenCalledWith(
      CRED,
      { service: "Brevo", label: null, url: null, username: "pm", notes: null },
      "pw",
    );
    expect(await call("vault:set-password", true, CRED, "Nn1!")).toEqual({ ok: true });
    expect(ops.setPassword).toHaveBeenCalledWith(CRED, "Nn1!");
  });
});
