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
    status: vi.fn(async () => ({ state: "open" as const, fingerprint: "fp" })),
    unlock: vi.fn(async () => ({ ok: true as const })),
    lock: vi.fn(),
    use: vi.fn(async (run) => run(SECRET)),
    forget: vi.fn(async () => ({ ok: true as const, remote: true })),
    markPaired: vi.fn(),
    sessionChanged: vi.fn(),
  };
  const pairing = {
    start: vi.fn(async () => ({ ok: true as const, fingerprint: "fp" })),
    cancel: vi.fn(),
  };
  const fromApp = (event: unknown) => (event as { app?: boolean }).app === true;
  registerVaultIpc(ipc, { lock, pairing, fromApp });
  const call = (channel: string, app = true) => handlers.get(channel)!({ app });
  return { handlers, call, lock, pairing };
}

describe("l'IPC della cassaforte", () => {
  it("registra i canali, e solo quelli", () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([...VAULT_CHANNELS].sort());
  });

  it("ogni risposta è un esito o lo stato: la chiave non attraversa mai l'IPC", async () => {
    const { call } = setup();
    for (const channel of VAULT_CHANNELS) {
      const out = await call(channel);
      expect(JSON.stringify(out), channel).not.toContain("PERSON-PRIVATE-KEY");
      expect(out, channel).not.toBe(SECRET);
    }
    expect(await call("vault:status")).toEqual({ state: "open", fingerprint: "fp" });
    expect(await call("vault:pair-start")).toEqual({ ok: true, fingerprint: "fp" });
  });

  it("un mittente che non è l'app: niente, e nessuna azione", async () => {
    const { call, lock, pairing } = setup();
    expect(await call("vault:status", false)).toEqual({ state: "unpaired", fingerprint: null });
    for (const channel of [
      "vault:unlock",
      "vault:lock",
      "vault:forget",
      "vault:pair-start",
      "vault:pair-cancel",
    ]) {
      expect(await call(channel, false), channel).toEqual({ ok: false, code: "invalid_request" });
    }
    expect(lock.unlock).not.toHaveBeenCalled();
    expect(lock.forget).not.toHaveBeenCalled();
    expect(pairing.start).not.toHaveBeenCalled();
  });
});
