import type { VaultStatusResponse } from "@stubwise/shared";
import { keyFingerprint } from "@stubwise/vault-crypto";
import type * as Fake from "../../../api";
import { onLoggedOut, onSessionLost } from "../../../sessionEvents";
import type { VaultStatusView } from "../../../vault/types";
import { session } from "../client";
import { partialNamespace } from "../notIntegrated";
import { request } from "../vaultBrowser/client";
import { clearNow, copyWithAutoClear } from "../vaultBrowser/clipboard";
import { revealPassword } from "../vaultBrowser/credentials";
import * as key from "../vaultBrowser/key";
import { unlockInBrowser } from "../vaultBrowser/unlock";
import * as liveVaultReads from "../vaultReads";
import { setVaultTransport } from "../vaultReads";

// La cassaforte della build web servita su `/app` (`@backend/vault`, target
// `web`, design della cassaforte nel browser; revisione di sicurezza I-1): la
// chiave, la crittografia e la rete della cassaforte stanno nel worker
// (`vaultBrowser/worker.ts`); qui gli esiti per la barra e le pagine. Questo
// modulo NON nomina il ponte del desktop (`check-vault-target.mjs`).

setVaultTransport(null);

/**
 * La sessione a cui la chiave è legata (I5, I-3): la persona di adesso e
 * un'etichetta di sessione. Finché il server non dà il suo `sessionTag`, è
 * un'epoca del client che cambia (e chiude) a sessione persa e a «Esci».
 */
let epoch = 0;
const sessionTag = () => `e${epoch}`;
const who = () => ({ personId: session.personId, sessionTag: sessionTag() });

onSessionLost(() => {
  epoch += 1;
  key.lock("session");
});
onLoggedOut(() => {
  epoch += 1;
  // I-2: «Esci» si dice alle altre schede sempre, anche a cassaforte chiusa.
  key.lock("logout");
});

/** L'ultima apertura ha usato una passkey senza PRF: la barra lo dice finché un'apertura riesce. */
let passkeyUnsupported = false;

const hasLiveKey = (s: VaultStatusResponse) =>
  s.myKey !== null && (s.myKey.status === "pending" || s.myKey.status === "confirmed");

const getVaultStatus: typeof Fake.vault.getVaultStatus = async (): Promise<VaultStatusView> => {
  const base = { touchId: false, macFingerprint: null, ownFingerprint: null, pairing: null };
  const out = await request<{ ok: true; status: VaultStatusResponse } | { ok: false; code: string }>({ t: "serverStatus" });
  if (!out.ok) {
    if (out.code === "network" || out.code === "worker_unavailable") return { ...base, state: "unreachable" };
    throw new Error(out.code);
  }
  const s = out.status;
  if (!s.activated) return { ...base, state: "inactive" };
  if (!hasLiveKey(s)) return { ...base, state: "no_key" };
  if (s.myKey!.status === "pending") {
    const pub = s.myKey!.publicKey;
    return { ...base, state: "key_pending", ownFingerprint: pub ? await keyFingerprint(pub).catch(() => null) : null };
  }
  if (key.status().state === "open") return { ...base, state: "open" };
  return { ...base, state: passkeyUnsupported ? "passkey_unsupported" : "locked" };
};

const unlock: typeof Fake.vault.unlock = async () => {
  const out = await unlockInBrowser(who);
  passkeyUnsupported = !out.ok && out.code === "passkey_unsupported";
  return out;
};

const lock: typeof Fake.vault.lock = async () => {
  key.lock("user");
  return { ok: true };
};

const subscribeVaultChanges: typeof Fake.vault.subscribeVaultChanges = (listener) => key.subscribe(() => listener());

// Alla chiusura, per qualunque motivo, gli appunti si svuotano (design §6).
key.subscribe((st) => {
  if (st.state === "locked") void clearNow();
});

const show: typeof Fake.vault.show = async (id) => {
  const w = who();
  if (!w.personId) return { ok: false, code: "unauthenticated" };
  return revealPassword(id, "show", w.personId, w.sessionTag);
};

const copy: typeof Fake.vault.copy = async (id) => {
  const w = who();
  if (!w.personId) return { ok: false, code: "unauthenticated" };
  const out = await revealPassword(id, "copy", w.personId, w.sessionTag);
  if (!out.ok) return out;
  await copyWithAutoClear(out.password);
  return { ok: true };
};

export const vault: typeof Fake.vault = partialNamespace<typeof Fake.vault>("vault", {
  getVaultStatus,
  unlock,
  lock,
  subscribeVaultChanges,
  show,
  copy,
  ...liveVaultReads,
});
