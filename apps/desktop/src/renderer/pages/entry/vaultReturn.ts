import { vaultPagePath, type VaultPage } from "@stubwise/shared";

/**
 * Il ritorno dal login alla pagina a sé della cassaforte (revisione della
 * fase 2, I-2): la pagina a sé non ha un login suo, e senza sessione manda
 * al login dell'app con `next`. Un elenco CHIUSO: il valore sceglie una delle
 * quattro pagine, e l'indirizzo lo compone l'helper dei link, mai `next`
 * stesso. Tutto il resto (un URL, `//host`, un valore ignoto) è `null`: la
 * Home, come sempre.
 */
const NEXT: Readonly<Record<string, VaultPage>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, VaultPage>, {
    "vault-setup": "setup",
    "vault-recover": "recover",
    "vault-passkeys": "passkeys",
    "vault-pair": "pair",
  }),
);

const STATE_RE = /^[A-Za-z0-9_-]{1,200}$/;

export function vaultReturn(next?: string, state?: string): string | null {
  if (typeof next !== "string" || !Object.prototype.hasOwnProperty.call(NEXT, next)) return null;
  const page = NEXT[next]!;
  if (page !== "pair") return vaultPagePath(page);
  return typeof state === "string" && STATE_RE.test(state) ? vaultPagePath("pair", { state }) : null;
}
