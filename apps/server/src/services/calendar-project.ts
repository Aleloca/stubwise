import { calendarEvents, googleAccounts, notifications, type Db } from "@stubwise/db";
import { projectPermissionsOfUser } from "@stubwise/notifications";
import { and, eq, sql } from "drizzle-orm";

/**
 * IL PROGETTO DELL'EVENTO, A MANO (area 6, F4, task 4). Nessuna chiamata a
 * Google: il progetto è un dato di Stubwise.
 *
 * - **Chi**: chi vede l'evento (una riga della SUA casella), se è membro del
 *   progetto scelto (un progetto che non vede è `not_found`, come se non
 *   esistesse). Un progetto ATTUALE che non vede non lo cambia né lo toglie
 *   (`project_hidden`, 403): non si sposta il lavoro di un progetto altrui.
 * - **Dove** (Q1 = a): su TUTTE le righe dello stesso evento (`ical_uid`),
 *   cioè per ogni persona che lo vede — una riga di prima della F4, senza
 *   iCalUID, vale solo per sé. Le date di una serie hanno lo stesso iCalUID:
 *   il progetto di una riunione ricorrente vale per tutte le sue date.
 * - **La proposta aperta**: quella di una SCADENZA (un evento singolo) segue
 *   il progetto — la card della mia riga, progetto e azioni; quella di una
 *   DATA DI SERIE no, perché il suo progetto è quello scelto sulla serie
 *   (`calendar_series`). Le card degli ALTRI invitati non si toccano: sono
 *   nella loro inbox, e il progetto della card vince su quello della riga in
 *   lettura (`mail-proposals-calendar.ts`). Togliere il progetto (`null`)
 *   lascia la card com'è: «nessun progetto» non è un posto in cui una
 *   proposta possa andare.
 */

export type CalendarProjectOutcome = { ok: true; rowId: string } | { error: "not_found" } | { error: "project_hidden" };

export async function setCalendarEventProject(db: Db, userId: string, rowId: string, projectId: string | null): Promise<CalendarProjectOutcome> {
  const [row] = await db
    .select({ event: calendarEvents })
    .from(calendarEvents)
    .innerJoin(googleAccounts, eq(googleAccounts.id, calendarEvents.accountId))
    .where(and(eq(calendarEvents.id, rowId), eq(googleAccounts.userId, userId)));
  if (!row) return { error: "not_found" };
  const event = row.event;
  if (event.projectId !== null && (await projectPermissionsOfUser(db, userId, event.projectId)) === null) return { error: "project_hidden" };
  if (projectId !== null && (await projectPermissionsOfUser(db, userId, projectId)) === null) return { error: "not_found" };

  await db.transaction(async (tx) => {
    const projectBy = projectId === null ? null : ("manual" as const);
    const sameEvent = event.icalUid ? eq(calendarEvents.icalUid, event.icalUid) : eq(calendarEvents.id, event.id);
    await tx.update(calendarEvents).set({ projectId, projectBy }).where(sameEvent);
    const followsCard = projectId !== null && event.recurringEventId === null && event.proposalNotificationId !== null && event.outcome === null;
    if (followsCard) {
      // La card e le sue azioni puntano al progetto nuovo (`projectId` di ogni azione che ne ha uno).
      await tx
        .update(notifications)
        .set({
          projectId,
          event: sql`case when jsonb_typeof(${notifications.event} -> 'actions') = 'array' then jsonb_set(
            jsonb_set(${notifications.event}, '{projectId}', to_jsonb(${projectId}::text)),
            '{actions}',
            coalesce((
              select jsonb_agg(case when a ? 'projectId' then jsonb_set(a, '{projectId}', to_jsonb(${projectId}::text)) else a end order by ord)
              from jsonb_array_elements(${notifications.event} -> 'actions') with ordinality as t(a, ord)
            ), '[]'::jsonb)
          ) else jsonb_set(${notifications.event}, '{projectId}', to_jsonb(${projectId}::text)) end`,
        })
        .where(and(eq(notifications.id, event.proposalNotificationId!), eq(notifications.status, "open")));
    }
  });
  return { ok: true, rowId: event.id };
}
