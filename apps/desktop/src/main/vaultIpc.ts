import type { VaultLock } from "./vaultLock";

// I canali della cassaforte fra renderer e main (lotto 10, design §3). Il
// renderer riceve esiti e lo stato (con l'impronta della chiave del
// dispositivo, da confrontare col browser), MAI la privata, che resta in
// `vaultLock`. Un mittente che non è l'app non ottiene niente. Le
// operazioni con la chiave (mostrare una password, condividere, confermare)
// entrano qui con le rotte del PAT desktop.

export const VAULT_CHANNELS = [
  "vault:status",
  "vault:unlock",
  "vault:lock",
  "vault:forget",
  "vault:pair-start",
  "vault:pair-cancel",
] as const;

interface Ipc<E> {
  handle: (channel: string, listener: (event: E) => unknown) => void;
}

export interface VaultIpcDeps<E> {
  lock: VaultLock;
  pairing: {
    start: () => Promise<{ ok: true; fingerprint: string } | { ok: false; code: string }>;
    cancel: () => void;
  };
  fromApp: (event: E) => boolean;
}

const refused = { ok: false as const, code: "invalid_request" };

export function registerVaultIpc<E>(ipc: Ipc<E>, deps: VaultIpcDeps<E>): void {
  const guarded =
    <T>(run: () => Promise<T> | T) =>
    async (event: E) =>
      deps.fromApp(event) ? run() : refused;

  ipc.handle("vault:status", async (event: E) =>
    deps.fromApp(event) ? deps.lock.status() : { state: "unpaired", fingerprint: null },
  );
  ipc.handle(
    "vault:unlock",
    guarded(() => deps.lock.unlock()),
  );
  ipc.handle(
    "vault:lock",
    guarded(() => {
      deps.lock.lock();
      return { ok: true };
    }),
  );
  ipc.handle(
    "vault:forget",
    guarded(() => deps.lock.forget()),
  );
  ipc.handle(
    "vault:pair-start",
    guarded(() => deps.pairing.start()),
  );
  ipc.handle(
    "vault:pair-cancel",
    guarded(() => {
      deps.pairing.cancel();
      return { ok: true };
    }),
  );
}
