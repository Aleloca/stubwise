import { eq, sql } from "drizzle-orm";
import type { Db } from "@stubwise/db";
import { gitIdentities, users } from "@stubwise/db";

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

/**
 * Risolve l'utente Stubwise a partire dal suo Slack user id (match esatto su
 * `users.slack_user_id`). Pensato per l'attribuzione dei ticket creati via
 * Slack quando l'utente è già stato linkato: evita una chiamata a Slack per
 * l'email. Ritorna lo userId del match, o `null` se l'id è assente/non linkato.
 */
export async function resolveReporterBySlackId(
  db: Db,
  slackUserId?: string | null,
): Promise<string | null> {
  if (!slackUserId) return null;
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.slackUserId, slackUserId))
    .limit(1);
  return user?.id ?? null;
}

/**
 * Risolve il membro Stubwise a partire da un'email autore git (match
 * case-insensitive su git_identities.email). Ritorna lo userId, o null se
 * l'email non è associata ad alcun membro.
 */
export async function resolveUserByGitEmail(db: Db, email?: string | null): Promise<string | null> {
  if (!email) return null;
  const [row] = await db
    .select({ userId: gitIdentities.userId })
    .from(gitIdentities)
    .where(sql`lower(${gitIdentities.email}) = lower(${email})`)
    .limit(1);
  return row?.userId ?? null;
}
