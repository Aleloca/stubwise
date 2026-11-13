import { automationEvents, automationRuns, automations, type Db } from "@stubwise/db";
import { and, eq, sql } from "drizzle-orm";
import { wakeReplyWaits } from "./waits.js";

/**
 * LA POSTA CHE ENTRA NELLE AUTOMAZIONI (area 7, F2, S8; piano C-F2-0). Il
 * poller Google la chiama per OGNI messaggio RICEVUTO da una casella (non per
 * la posta mandata dalla casella stessa), prima del cancello dell'ammissione:
 * F2-1 = tutte le email *(M)*, ammesse o no.
 *
 * - Se nessuna automazione accesa ascolta quella casella e nessuna esecuzione
 *   aspetta una risposta in quella conversazione, non fa niente: la posta non
 *   si legge per le automazioni (il testo non si scarica).
 * - Altrimenti scarica il testo (una volta), sveglia le attese della risposta
 *   e scrive l'evento `mail_received` della casella: una fotografia (mittente,
 *   oggetto, testo tagliato), deduplicata per messaggio. Le automazioni che
 *   partono le decide il consumatore (solo del proprietario della casella,
 *   C-F2-5 compreso).
 *
 * Il testo è contenuto non fidato: entra come dato, mai come istruzione.
 */

export const MAIL_TEXT_MAX = 20_000;

export interface IncomingMail {
  accountId: string;
  gmailMessageId: string;
  threadId: string;
  from: string;
  subject: string;
}

export async function automationMailIn(db: Db, mail: IncomingMail, loadText: () => Promise<string>): Promise<void> {
  const [listener] = await db
    .select({ id: automations.id })
    .from(automations)
    .where(and(eq(automations.status, "active"), eq(automations.listensMail, true), eq(automations.mailboxAccountId, mail.accountId)))
    .limit(1);
  const [waiter] = await db
    .select({ id: automationRuns.id })
    .from(automationRuns)
    .where(and(eq(automationRuns.waitingThread, `${mail.accountId}:${mail.threadId}`), eq(automationRuns.mailboxAccountId, mail.accountId)))
    .limit(1);
  if (!listener && !waiter) return;
  const text = (await loadText()).slice(0, MAIL_TEXT_MAX);
  if (waiter) await wakeReplyWaits(db, { accountId: mail.accountId, threadId: mail.threadId, text });
  if (!listener) return;
  await db
    .insert(automationEvents)
    .values({
      kind: "mail_received",
      accountId: mail.accountId,
      projectId: null,
      objectId: null,
      dedupeKey: `mail:${mail.accountId}:${mail.gmailMessageId}`,
      payload: { email: { mittente: mail.from, oggetto: mail.subject, testo: text }, gmailMessageId: mail.gmailMessageId, threadId: mail.threadId },
    })
    .onConflictDoNothing({ target: automationEvents.dedupeKey, where: sql`${automationEvents.dedupeKey} is not null` });
}
