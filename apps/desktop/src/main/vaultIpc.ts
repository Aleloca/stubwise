import type { VaultLock } from "./vaultLock";
import type { CredentialFields, ReaderTarget, VaultOps } from "./vaultOps";

// I canali della cassaforte fra renderer e main (lotto 10, design §3). Il
// renderer riceve esiti e lo stato (con l'impronta della chiave del
// dispositivo, da confrontare col browser), MAI la privata, che resta in
// `vaultLock`. Un mittente che non è l'app non ottiene niente. Le
// operazioni con la chiave (`vaultOps`: mostrare, copiare, condividere,
// togliere un lettore, gli accessi da confermare) validano gli argomenti
// PRIMA di toccare la cassaforte: id uuid, un bersaglio persona O ruolo.

export const VAULT_CHANNELS = [
  "vault:status",
  "vault:unlock",
  "vault:lock",
  "vault:forget",
  "vault:pair-start",
  "vault:pair-cancel",
  "vault:show",
  "vault:copy",
  "vault:share",
  "vault:remove-reader",
  "vault:pending",
  "vault:confirm",
  "vault:reject",
  "vault:macs",
  "vault:remove-mac",
  "vault:create",
  "vault:set-password",
  "vault:server-status",
  "vault:mine",
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

/** I limiti dei campi in chiaro (`credentialCreateBodySchema` del server). */
const FIELD_MAX = { label: 200, url: 2000, username: 500, notes: 10_000 } as const;

/** Una password scritta: non vuota, e non più lunga di quanto ha senso cifrare. */
const isPassword = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 4096;

/** I campi in chiaro dal renderer, ripuliti; `null` se uno non va (nessuna chiamata parte). */
function credentialFields(raw: unknown): CredentialFields | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.service !== "string") return null;
  const service = r.service.trim();
  if (service === "" || service.length > 200) return null;
  const out: CredentialFields = { service, label: null, url: null, username: null, notes: null };
  for (const key of ["label", "url", "username", "notes"] as const) {
    const v = r[key];
    if (v === null || v === undefined) continue;
    if (typeof v !== "string" || v.length > FIELD_MAX[key]) return null;
    out[key] = v;
  }
  return out;
}

/** Una persona O un ruolo, e niente altro. */
function readerTarget(value: unknown): ReaderTarget | null {
  if (!value || typeof value !== "object") return null;
  const keys = Object.keys(value);
  const v = value as Record<string, unknown>;
  if (keys.length !== 1) return null;
  if (isId(v.userId)) return { userId: v.userId };
  if (isId(v.roleId)) return { roleId: v.roleId };
  return null;
}

interface Ipc<E> {
  handle: (channel: string, listener: (event: E, ...args: unknown[]) => unknown) => void;
}

export interface VaultIpcDeps<E> {
  lock: VaultLock;
  pairing: {
    start: () => Promise<{ ok: true; fingerprint: string } | { ok: false; code: string }>;
    cancel: () => void;
  };
  ops: Pick<
    VaultOps,
    | "show"
    | "copy"
    | "share"
    | "removeReader"
    | "pending"
    | "confirm"
    | "reject"
    | "macs"
    | "removeMac"
    | "create"
    | "setPassword"
    | "serverStatus"
    | "mine"
  >;
  fromApp: (event: E) => boolean;
}

const refused = { ok: false as const, code: "invalid_request" };

export function registerVaultIpc<E>(ipc: Ipc<E>, deps: VaultIpcDeps<E>): void {
  const guarded =
    <T>(run: () => Promise<T> | T) =>
    async (event: E) =>
      deps.fromApp(event) ? run() : refused;

  ipc.handle("vault:status", async (event: E) =>
    deps.fromApp(event)
      ? deps.lock.status()
      : { state: "unpaired", fingerprint: null, touchId: false },
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

  /** Mittente controllato, POI gli argomenti: un canale con argomenti sbagliati non tocca niente. */
  const withArgs =
    (run: (...args: unknown[]) => Promise<unknown> | null) =>
    async (event: E, ...args: unknown[]) => {
      if (!deps.fromApp(event)) return refused;
      return (await run(...args)) ?? refused;
    };

  ipc.handle(
    "vault:show",
    withArgs((id) => (isId(id) ? deps.ops.show(id) : null)),
  );
  ipc.handle(
    "vault:copy",
    withArgs((id) => (isId(id) ? deps.ops.copy(id) : null)),
  );
  ipc.handle(
    "vault:share",
    withArgs((id, raw) => {
      const target = readerTarget(raw);
      return isId(id) && target ? deps.ops.share(id, target) : null;
    }),
  );
  ipc.handle(
    "vault:remove-reader",
    withArgs((id, readerId) =>
      isId(id) && isId(readerId) ? deps.ops.removeReader(id, readerId) : null,
    ),
  );
  ipc.handle(
    "vault:pending",
    withArgs(() => deps.ops.pending()),
  );
  ipc.handle(
    "vault:confirm",
    withArgs((keyId) => (isId(keyId) ? deps.ops.confirm(keyId) : null)),
  );
  ipc.handle(
    "vault:reject",
    withArgs((keyId) => (isId(keyId) ? deps.ops.reject(keyId) : null)),
  );
  ipc.handle(
    "vault:macs",
    withArgs(() => deps.ops.macs()),
  );
  ipc.handle(
    "vault:remove-mac",
    withArgs((macId) => (isId(macId) ? deps.ops.removeMac(macId) : null)),
  );
  ipc.handle(
    "vault:create",
    withArgs((projectId, raw, password) => {
      const fields = credentialFields(raw);
      return isId(projectId) && fields && isPassword(password)
        ? deps.ops.create(projectId, fields, password)
        : null;
    }),
  );
  ipc.handle(
    "vault:server-status",
    withArgs(() => deps.ops.serverStatus()),
  );
  ipc.handle(
    "vault:mine",
    withArgs(() => deps.ops.mine()),
  );
  ipc.handle(
    "vault:set-password",
    withArgs((id, password) =>
      isId(id) && isPassword(password) ? deps.ops.setPassword(id, password) : null,
    ),
  );
}
