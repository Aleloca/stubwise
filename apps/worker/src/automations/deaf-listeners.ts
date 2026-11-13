import { automations, type Db } from "@stubwise/db";
import { publishNotification } from "@stubwise/notifications";
import { and, eq, isNull, sql } from "drizzle-orm";

/**
 * «Email in arrivo» senza casella (review F2, M5): una casella scollegata
 * (`ON DELETE SET NULL`) lascerebbe l'automazione accesa a non fare niente,
 * senza dirlo. A ogni giro del poller le accese che ascoltano la posta senza
 * più una casella vanno in pausa con `mailbox_lost` (F2-4 = a), e il
 * proprietario riceve l'avviso. L'UPDATE è guardato sullo stato: una volta
 * sola per automazione.
 */
export async function pauseDeafListeners(db: Db, log: (msg: string) => void = () => {}): Promise<number> {
  const paused = await db
    .update(automations)
    .set({ status: "paused", pausedReason: "mailbox_lost", pausedBy: null, pausedAt: sql`now()`, activeSince: null })
    .where(and(eq(automations.status, "active"), eq(automations.listensMail, true), isNull(automations.mailboxAccountId)))
    .returning();
  for (const a of paused) {
    log(`[automations] ${a.code}: in pausa, la casella che ascoltava non c'è più`);
    if (!a.ownerId) continue;
    await publishNotification(
      db,
      { kind: "automation.paused", projectId: a.projectId, automationId: a.id, automationCode: a.code, automationName: a.name, runId: null, runNumber: null },
      { projectId: a.projectId, accountUserId: a.ownerId },
    );
  }
  return paused.length;
}
