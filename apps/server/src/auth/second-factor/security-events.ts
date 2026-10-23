import { desc, eq, lt } from "drizzle-orm";
import { securityEvents, type Db } from "@stubwise/db";
import type { SecurityEventKind, SecurityEventView } from "@stubwise/shared";

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type { SecurityEventKind };

const RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Scrive un evento del registro di sicurezza. Chi subisce e chi agisce
 * restano come id E email in testo (le FK vanno a NULL se l'utente sparisce).
 * La conservazione (1 anno) si applica qui, alla scrittura: niente job.
 *
 * `actor.id` è `null` quando chi agisce non è un utente (lo script di
 * recupero: resta solo il testo, «server script»).
 */
export async function recordSecurityEvent(
  db: DbOrTx,
  e: {
    kind: SecurityEventKind;
    user: { id: string; email: string };
    actor?: { id: string | null; email: string } | null;
  },
): Promise<void> {
  await db.insert(securityEvents).values({
    userId: e.user.id,
    userEmail: e.user.email,
    actorUserId: e.actor?.id ?? null,
    actorEmail: e.actor?.email ?? null,
    kind: e.kind,
  });
  await db
    .delete(securityEvents)
    .where(lt(securityEvents.createdAt, new Date(Date.now() - RETENTION_MS)));
}

export async function listSecurityEvents(db: Db, userId: string, limit = 50) {
  return db
    .select()
    .from(securityEvents)
    .where(eq(securityEvents.userId, userId))
    .orderBy(desc(securityEvents.createdAt))
    .limit(limit);
}

/** Le righe di {@link listSecurityEvents} nella forma delle risposte. */
export function toSecurityEventView(
  row: Awaited<ReturnType<typeof listSecurityEvents>>[number],
): SecurityEventView {
  return {
    id: row.id,
    kind: row.kind as SecurityEventKind,
    actorEmail: row.actorEmail,
    createdAt: row.createdAt.toISOString(),
  };
}
