import { googleAccounts, users, type Db } from "@stubwise/db";
import { and, eq, inArray } from "drizzle-orm";
import { normalizeAddress } from "./email-routing.js";

/**
 * I destinatari di un'email che sono persone di Stubwise (area 6, F2, D4):
 * dall'email dell'utente o da quella di una sua casella Google collegata,
 * normalizzate come le confronta il resto della posta (`normalizeAddress`).
 *
 * È UN posto, condiviso da worker (progetti candidati, destinatari della
 * proposta) e server (chi la vede, `sharedWith`): due copie della regola di
 * «chi è destinatario» divergerebbero, e la copia sbagliata sarebbe una
 * proposta mostrata a chi non l'ha ricevuta. L'utente di sistema di Claude
 * (`users.is_agent`) non è mai un destinatario.
 *
 * Non distingue mittente, `to` e `cc` (D4: tutti destinatari); `bcc` non
 * arriva mai qui, perché Gmail non lo mostra a chi riceve.
 */
export async function resolveRecipientUserIds(db: Db, addresses: readonly (string | null | undefined)[]): Promise<string[]> {
  const normalized = [...new Set(addresses.map((a) => normalizeAddress(a)).filter((a) => a.includes("@")))];
  if (normalized.length === 0) return [];
  const byUser = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.isAgent, false), inArray(users.email, normalized)));
  const byMailbox = await db
    .select({ id: googleAccounts.userId })
    .from(googleAccounts)
    .innerJoin(users, eq(users.id, googleAccounts.userId))
    .where(and(eq(users.isAgent, false), inArray(googleAccounts.email, normalized)));
  return [...new Set([...byUser, ...byMailbox].map((row) => row.id))];
}
