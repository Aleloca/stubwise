import { googleAccounts, type Db } from "@stubwise/db";
import type { SendAsAddress } from "@stubwise/google";
import { normalizeAddress } from "@stubwise/notifications";
import { eq } from "drizzle-orm";

/**
 * Lotto 8, voce 2: gli ALIAS di una casella (send-as di Gmail), in UN posto.
 * Nessuno scope nuovo: `users.settings.sendAs.list` accetta `gmail.modify`
 * (decisione di 46). La copia sta in `google_accounts.send_as`, coi soli
 * indirizzi VERIFICATI e la firma di ciascuno, e si rilegge come la firma:
 * se manca o ha più di un giorno, fail-open.
 *
 * Una casella mai letta (`[]`) ha un solo indirizzo, il suo: è il
 * comportamento di prima.
 */

export const SEND_AS_MAX_AGE_MS = 24 * 3600_000;
/** Il tetto della firma di un alias, come quella della casella. */
const SIGNATURE_MAX_CHARS = 2000;

export type SendAsEntry = SendAsAddress;

/** Gli indirizzi da cui la casella può mandare: la copia, o il solo indirizzo della casella. */
export function sendAsAddressesOf(row: { email: string; sendAs: readonly SendAsEntry[] }): SendAsEntry[] {
  if (row.sendAs.length === 0) return [{ email: row.email, displayName: null, isPrimary: true, isDefault: true, signature: null }];
  return [...row.sendAs];
}

/**
 * L'indirizzo da cui parte una bozza: `from` null = il predefinito (quello
 * segnato da Gmail, altrimenti la casella); un `from` fuori elenco è `null`
 * (il chiamante risponde `invalid_from`).
 */
export function resolveFrom(row: { email: string; sendAs: readonly SendAsEntry[] }, from: string | null): SendAsEntry | null {
  const all = sendAsAddressesOf(row);
  if (from === null) return all.find((a) => a.isDefault) ?? all.find((a) => a.isPrimary) ?? all[0]!;
  const key = normalizeAddress(from);
  return all.find((a) => normalizeAddress(a.email) === key) ?? null;
}

/**
 * Rispondendo, il «Da» parte dall'alias a cui era indirizzato il messaggio (in
 * `to` o `cc`), come Gmail; `null` se nessuno lo era (il predefinito).
 */
export function aliasAddressedIn(row: { email: string; sendAs: readonly SendAsEntry[] }, message: { toAddresses: readonly string[]; ccAddresses: readonly string[] | null }): string | null {
  const addressed = new Set([...message.toAddresses, ...(message.ccAddresses ?? [])].map(normalizeAddress));
  return sendAsAddressesOf(row).find((a) => addressed.has(normalizeAddress(a.email)))?.email ?? null;
}

/** La copia è da rileggere? */
export function sendAsStale(fetchedAt: Date | null, now = Date.now()): boolean {
  return !fetchedAt || now - fetchedAt.getTime() > SEND_AS_MAX_AGE_MS;
}

/**
 * Rilegge gli alias da Gmail e aggiorna la copia. FAIL-OPEN: se Google non
 * risponde resta quella di prima. Restituisce l'elenco letto (o null).
 */
export async function refreshSendAs(
  db: Db,
  listSendAs: ((input: { accessToken: string }) => Promise<SendAsEntry[]>) | undefined,
  accessToken: string,
  accountId: string,
): Promise<SendAsEntry[] | null> {
  if (!listSendAs) return null;
  try {
    const list = (await listSendAs({ accessToken })).map((a) => ({ ...a, signature: a.signature === null ? null : a.signature.slice(0, SIGNATURE_MAX_CHARS) }));
    await db.update(googleAccounts).set({ sendAs: list, sendAsFetchedAt: new Date() }).where(eq(googleAccounts.id, accountId));
    return list;
  } catch {
    return null;
  }
}
