import type { CredentialRevealResponse } from "@stubwise/shared";
import { decryptPassword, unwrapItemKey } from "@stubwise/vault-crypto";
import { vaultHttp } from "./http";
import { status, use } from "./key";

// Show e Copy nella scheda (design §6). `reveal` è registrato dal server
// (`via: browser`); la chiave della voce si apre NON estraibile e i suoi byte
// grezzi si azzerano (M2, in vault-crypto). Una password che arriva dopo la
// chiusura della cassaforte si scarta. La password in chiaro non entra mai
// in React Query: la tiene il componente che la mostra.

export async function revealPassword(
  credentialId: string,
  action: "show" | "copy",
  personId: string,
  sessionId: string,
): Promise<string> {
  const privateKey = use(personId, sessionId);
  const r = await vaultHttp<CredentialRevealResponse>(
    "POST",
    `/api/credentials/${encodeURIComponent(credentialId)}/reveal`,
    { action },
  );
  const itemKey = await unwrapItemKey(r.wrappedKey, privateKey, credentialId, r.personKeyId, { extractable: false });
  const password = await decryptPassword(credentialId, r.passwordCiphertext, itemKey);
  // Chiusa mentre la risposta arrivava: la password non esce.
  if (status().state !== "open") throw new Error("vault_locked");
  return password;
}
