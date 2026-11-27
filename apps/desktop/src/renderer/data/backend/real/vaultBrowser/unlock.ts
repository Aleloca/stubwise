import type { VaultMyKeyResponse, VaultStatusResponse } from "@stubwise/shared";
import { openPrivateKey } from "@stubwise/vault-crypto";
import { VaultHttpError, vaultHttp } from "./http";
import { open } from "./key";
import { VaultBrowserError, assertWithPrf, wipe } from "./webauthn";

// Lo sblocco della cassaforte nella scheda (design §3, §5, fase 1): la
// passkey con la PRF, la verifica, poi la chiave viva aperta col suo sigillo
// e consegnata a `key.ts` (non estraibile, legata a persona e sessione). La
// prima chiave, l'attivazione e il recupero sono la fase 2: qui no.

export type UnlockCode =
  | "inactive"
  | "no_key"
  | "no_seal"
  | "passkey_failed"
  | "passkey_unsupported"
  | "open_failed"
  | string;

/** Una chiave «viva»: si apre col sigillo. */
export const hasLiveKey = (s: Pick<VaultStatusResponse, "myKey">): boolean =>
  s.myKey !== null && (s.myKey.status === "pending" || s.myKey.status === "confirmed");

export async function unlockInBrowser(
  personId: string,
  sessionId: string,
): Promise<{ ok: true } | { ok: false; code: UnlockCode }> {
  try {
    const status = await vaultHttp<VaultStatusResponse>("GET", "/api/vault/status");
    if (!status.activated) return { ok: false, code: "inactive" };
    if (!hasLiveKey(status)) return { ok: false, code: "no_key" };
    const only = status.seals.map((s) => s.credentialIdB64url);
    if (only.length === 0) return { ok: false, code: "no_seal" };
    const assertion = await assertWithPrf(only);
    if (!assertion) return { ok: false, code: "passkey_unsupported" };
    try {
      const mine = await vaultHttp<VaultMyKeyResponse>("GET", "/api/vault/keys/mine");
      const seal = mine.seals.find((s) => s.credentialIdB64url === assertion.credentialId);
      if (!seal) return { ok: false, code: "no_seal" };
      let privateKey: CryptoKey;
      try {
        // Il sigillo ha come AAD la pubblica: una pubblica che non è la metà
        // della privata non apre niente (`open_failed`), e si fallisce chiusi.
        privateKey = await openPrivateKey(assertion.prfOutput, seal.sealedPrivateKey, mine.publicKey);
      } catch {
        return { ok: false, code: "open_failed" };
      }
      open(privateKey, personId, sessionId);
      return { ok: true };
    } finally {
      wipe(assertion.prfOutput);
    }
  } catch (error) {
    if (error instanceof VaultBrowserError) return { ok: false, code: error.code };
    if (error instanceof VaultHttpError) return { ok: false, code: error.code };
    throw error;
  }
}
