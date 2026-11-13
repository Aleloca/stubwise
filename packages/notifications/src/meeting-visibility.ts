import { calendarEvents, emailMessages, googleAccounts, meetingNotes, type Db } from "@stubwise/db";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { resolveRecipientUserIds } from "./mail-recipients.js";

/**
 * CHI VEDE UNA RIUNIONE REGISTRATA (area 6, F5a, C4 del piano). Riassunto,
 * proposte e `MeetingNote` li vedono le persone di Stubwise che risultano da
 * qui, e nessun altro: è l'ECCEZIONE DICHIARATA a «Posta e Calendario
 * personali» (decisione del maintainer, `docs/invariants/mail-calendar.md`).
 *
 * - Con un evento collegato: gli invitati ATTUALI di QUELLA occorrenza
 *   (stesso iCalUID e stessa data: una serie li condivide), con qualunque
 *   risposta (anche declined), più l'organizzatore — dalla riga
 *   dell'organizzatore, o la più recente, non cancellata, in
 *   QUALUNQUE casella (un invitato senza casella collegata vede lo stesso:
 *   l'elenco viene dalla riga di un altro); lo snapshot `attendee_emails`
 *   solo se non resta nessuna riga. Un invitato tolto da Google smette di
 *   vedere al giro dopo del poller.
 * - Senza evento: chi ha RICEVUTO l'email di Gemini (i `to`/`cc` delle sue
 *   copie e i proprietari delle caselle che le hanno; non il mittente).
 * - Nessun ruolo nel calcolo: un admin non c'è se non è invitato.
 *
 * Un posto solo, condiviso da server (le letture) e worker (a chi pubblicare
 * le proposte): due copie divergerebbero, e la copia sbagliata mostrerebbe
 * una riunione a chi non c'era.
 */
export async function meetingAudienceEmails(db: Db, noteId: string): Promise<string[] | null> {
  const [note] = await db.select().from(meetingNotes).where(eq(meetingNotes.id, noteId));
  if (!note) return null;
  if (note.icalUid) {
    // ⚠️ Review F5a, punto 1 (CRITICO): le occorrenze di una serie hanno lo
    // STESSO iCalUID (`singleEvents=true`). Senza la DATA, chi è invitato a
    // un'altra occorrenza vedrebbe tutte le riunioni registrate della serie.
    // Senza la data della riunione si resta allo snapshot.
    if (!note.eventStartsAt) return [...note.attendeeEmails];
    const [latest] = await db
      .select({ attendees: calendarEvents.attendees, organizer: calendarEvents.organizer })
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.icalUid, note.icalUid),
          eq(calendarEvents.startsAt, note.eventStartsAt),
          sql`${calendarEvents.status} is distinct from 'cancelled'`,
        ),
      )
      // Punto 8: la riga dell'ORGANIZZATORE prima (è la sua copia dell'evento
      // a dire chi è invitato); poi la più recente. Limite: senza la riga
      // dell'organizzatore, «più recente» è l'ora della NOSTRA riga.
      .orderBy(desc(calendarEvents.organizerSelf), desc(calendarEvents.updatedAt))
      .limit(1);
    if (latest) return [...latest.attendees.map((a) => a.email), ...(latest.organizer ? [latest.organizer] : [])];
    return [...note.attendeeEmails];
  }
  const copies = await db
    .select({ to: emailMessages.toAddresses, cc: emailMessages.ccAddresses, owner: googleAccounts.email })
    .from(emailMessages)
    .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
    .where(note.rfcMessageId ? or(eq(emailMessages.rfcMessageId, note.rfcMessageId), eq(emailMessages.id, note.sourceMessageId)) : eq(emailMessages.id, note.sourceMessageId));
  return copies.flatMap((c) => [...c.to, ...(c.cc ?? []), c.owner]);
}

/** Le persone di Stubwise che vedono la riunione (vedi {@link meetingAudienceEmails}). */
export async function meetingViewerIds(db: Db, noteId: string): Promise<string[]> {
  const emails = await meetingAudienceEmails(db, noteId);
  return emails === null ? [] : resolveRecipientUserIds(db, emails);
}

export async function canSeeMeeting(db: Db, noteId: string, userId: string): Promise<boolean> {
  return (await meetingViewerIds(db, noteId)).includes(userId);
}
