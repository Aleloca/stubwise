import type { VaultStatusResponse } from "@stubwise/shared";
import { keyFingerprint } from "@stubwise/vault-crypto";
import type * as Fake from "../../../api";
import { onLoggedOut, onSessionLost } from "../../../sessionEvents";
import type { VaultStatusView } from "../../../vault/types";
import { session } from "../client";
import { partialNamespace } from "../notIntegrated";
import { clearNow, copyWithAutoClear } from "../vaultBrowser/clipboard";
import { revealPassword } from "../vaultBrowser/credentials";
import { VaultHttpError, vaultHttp } from "../vaultBrowser/http";
import * as key from "../vaultBrowser/key";
import { hasLiveKey, unlockInBrowser } from "../vaultBrowser/unlock";
import * as liveVaultReads from "../vaultReads";
import { setVaultTransport } from "../vaultReads";

// La cassaforte della build web servita su `/app` (`@backend/vault`, target
// `web`, design della cassaforte nel browser): la chiave sta nella scheda
// (`vaultBrowser/key.ts`), sbloccata con la passkey (`vaultBrowser/unlock.ts`).
// Questo modulo NON nomina il ponte del desktop (`check-vault-target.mjs`).

setVaultTransport(null);

/**
 * La sessione a cui la chiave è legata (I5): la persona di adesso e un'epoca
 * che cambia quando la sessione si perde (401) o con «Esci». La chiave si
 * chiude in quei momenti; una `use` con un'epoca diversa la chiude comunque.
 */
let epoch = 0;
const sessionId = () => `e${epoch}`;
onSessionLost(() => {
  epoch += 1;
  key.lock("session");
});
onLoggedOut(() => {
  epoch += 1;
  key.lock("logout");
});

/** L'ultima apertura ha usato una passkey senza PRF: la barra lo dice finché un'apertura riesce. */
let passkeyUnsupported = false;

const getVaultStatus: typeof Fake.vault.getVaultStatus = async (): Promise<VaultStatusView> => {
  const base = { touchId: false, macFingerprint: null, ownFingerprint: null, pairing: null };
  let s: VaultStatusResponse;
  try {
    s = await vaultHttp<VaultStatusResponse>("GET", "/api/vault/status");
  } catch (error) {
    if (error instanceof VaultHttpError && error.status !== 0) throw error;
    return { ...base, state: "unreachable" };
  }
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
  if (!session.personId) return { ok: false, code: "unauthenticated" };
  const out = await unlockInBrowser(session.personId, sessionId());
  passkeyUnsupported = !out.ok && out.code === "passkey_unsupported";
  if (out.ok) passkeyUnsupported = false;
  return out.ok ? { ok: true } : { ok: false, code: out.code };
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

/** Un rifiuto di Show o Copy nella forma del ponte del desktop (il 429 coi suoi secondi). */
function revealFailure(error: unknown): { ok: false; code: string; retryAfterSeconds?: number } {
  if (error instanceof VaultHttpError) {
    return error.code === "vault_reveal_rate_limited" && error.retryAfterSeconds !== undefined
      ? { ok: false, code: error.code, retryAfterSeconds: error.retryAfterSeconds }
      : { ok: false, code: error.code };
  }
  if (error instanceof Error && error.message === "vault_locked") return { ok: false, code: "vault_locked" };
  return { ok: false, code: "open_failed" };
}

const show: typeof Fake.vault.show = async (id) => {
  if (!session.personId) return { ok: false, code: "unauthenticated" };
  try {
    return { ok: true, password: await revealPassword(id, "show", session.personId, sessionId()) };
  } catch (error) {
    return revealFailure(error);
  }
};

const copy: typeof Fake.vault.copy = async (id) => {
  if (!session.personId) return { ok: false, code: "unauthenticated" };
  try {
    await copyWithAutoClear(await revealPassword(id, "copy", session.personId, sessionId()));
    return { ok: true };
  } catch (error) {
    return revealFailure(error);
  }
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
