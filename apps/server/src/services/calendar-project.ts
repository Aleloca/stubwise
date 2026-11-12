import { calendarEvents, googleAccounts, notifications, type Db } from "@stubwise/db";
import { projectPermissionsByProject, projectPermissionsOfUser } from "@stubwise/notifications";
import { and, eq, inArray, ne, sql } from "drizzle-orm";

/**
 * IL PROGETTO DELL'EVENTO, A MANO (area 6, F4, task 4). Nessuna chiamata a
 * Google: il progetto è un dato di Stubwise.
 *
 * - **Chi**: chi vede l'evento (una riga della SUA casella), se è membro del
 *   progetto scelto (un progetto che non vede è `not_found`, come se non
 *   esistesse). Un progetto ATTUALE che non vede non lo cambia né lo toglie
 *   (`project_hidden`, 403): non si sposta il lavoro di un progetto altrui.
 * - **Dove** (Q1 = a): sulle righe dello stesso evento (`ical_uid`) degli
 *   altri invitati, coi limiti della review F4 (sotto, nel codice): solo
 *   righe senza progetto o con un progetto che chi lo mette vede, mai una
 *   messa a mano da un altro, e solo se il proprietario vede il progetto
 *   nuovo. Una riga di prima della F4, senza iCalUID, vale solo per sé. Le
 *   date di una serie hanno lo stesso iCalUID: il progetto di una riunione
 *   ricorrente vale per tutte le sue date.
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

  // Le altre righe dello stesso evento (Q1 = a), con i limiti della review F4
  // (punti 1 e 2): mai una riga il cui progetto attuale chi lo mette non vede
  // (sarebbe la regola «un progetto che non vedi non si cambia», aggirata
  // dalla riga di un altro), mai una messa a mano da un altro, e solo se il
  // PROPRIETARIO della riga vede il progetto (altrimenti gliene faremmo
  // vedere il nome). Togliere il progetto vale solo per la propria riga.
  // ⚠️ L'iCalUID di un invito esterno lo sceglie chi lo manda: per questo il
  // filtro sta sulle righe, non sulla fiducia nell'id.
  const others =
    projectId !== null && event.icalUid
      ? await db
          .select({ id: calendarEvents.id, projectId: calendarEvents.projectId, projectBy: calendarEvents.projectBy, ownerId: googleAccounts.userId })
          .from(calendarEvents)
          .innerJoin(googleAccounts, eq(googleAccounts.id, calendarEvents.accountId))
          .where(and(eq(calendarEvents.icalUid, event.icalUid), ne(calendarEvents.id, event.id)))
      : [];
  const currentIds = [...new Set(others.flatMap((o) => (o.projectId ? [o.projectId] : [])))];
  const setterSees = currentIds.length > 0 ? await projectPermissionsByProject(db, userId, currentIds) : new Map();
  const ownerSees = new Map<string, boolean>();
  for (const ownerId of new Set(others.map((o) => o.ownerId))) ownerSees.set(ownerId, (await projectPermissionsOfUser(db, ownerId, projectId!)) !== null);
  const followers = others
    .filter((o) => (o.projectBy !== "manual" || o.ownerId === userId) && (o.projectId === null || Boolean(setterSees.get(o.projectId))) && ownerSees.get(o.ownerId) === true)
    .map((o) => o.id);

  await db.transaction(async (tx) => {
    const projectBy = projectId === null ? null : ("manual" as const);
    await tx.update(calendarEvents).set({ projectId, projectBy }).where(inArray(calendarEvents.id, [event.id, ...followers]));
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
