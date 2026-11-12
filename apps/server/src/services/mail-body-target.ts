import { emailMessages, googleAccounts, type Db } from "@stubwise/db";
import { GMAIL_MODIFY_SCOPE } from "@stubwise/google";
import { and, eq } from "drizzle-orm";

/**
 * Il bersaglio di `fillMailBody` (azione di Claude, area 6, F3): SOLO letture
 * del DB, perché gira nella transazione (anche a secco) dell'esecutore delle
 * azioni — la scrittura su Gmail è un seguito dopo il commit
 * (`effects.mailBody`). La casella dev'essere di chi conferma, viva e con
 * gmail.modify; la conversazione, se c'è, in QUELLA casella.
 */
export async function mailBodyTarget(
  db: Db,
  userId: string,
  args: { accountId: string; threadId: string | null },
): Promise<"ok" | "not_found" | "forbidden"> {
  const [account] = await db
    .select({ scopes: googleAccounts.scopes, disabledAt: googleAccounts.disabledAt })
    .from(googleAccounts)
    .where(and(eq(googleAccounts.id, args.accountId), eq(googleAccounts.userId, userId)));
  if (!account) return "not_found";
  if (account.disabledAt || !account.scopes.includes(GMAIL_MODIFY_SCOPE)) return "forbidden";
  if (args.threadId) {
    const [message] = await db
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .where(and(eq(emailMessages.accountId, args.accountId), eq(emailMessages.threadId, args.threadId)))
      .limit(1);
    if (!message) return "not_found";
  }
  return "ok";
}
