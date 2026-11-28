import { createHash } from "node:crypto";

/**
 * Il token di un invito si conserva come hash (R3, migrazione 0246): il link
 * spedito porta il token in chiaro, `invites.token` (e `invite_token` delle
 * due tabelle figlie) il suo `sha256` esadecimale. Il token in chiaro esiste
 * solo nella risposta che crea l'invito: nessuna rotta lo rilegge, quindi un
 * dump del DB non apre nessun invito.
 *
 * La stessa funzione della migrazione (`encode(sha256(convert_to(token,
 * 'UTF8')), 'hex')`): così i link spediti prima continuano a funzionare.
 * Ogni porta che riceve un token dall'esterno (lettura pubblica,
 * registrazione, revoca) lo passa di qui PRIMA di cercarlo; dentro il server
 * circola solo l'hash.
 */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
