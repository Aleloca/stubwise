import { sql } from "drizzle-orm";
import type { Db } from "@stubwise/db";
import { users } from "@stubwise/db";

/**
 * Risolve l'utente Stubwise a cui attribuire un ticket esterno (webhook/Slack)
 * a partire dall'email del reporter. Il match è case-insensitive: le email
 * arrivano da sistemi terzi senza garanzie sul casing.
 *
 * Ritorna lo userId del match, o `null` se l'email è assente o non corrisponde
 * ad alcun utente — in quel caso il ticket resta non assegnato (la provenienza
 * viene comunque tracciata nel body dal chiamante).
 */
export async function resolveReporter(db: Db, email?: string | null): Promise<string | null> {
  if (!email) return null;
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1);
  return user?.id ?? null;
}
