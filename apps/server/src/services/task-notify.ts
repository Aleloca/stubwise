import { projects, tickets } from "@stubwise/db";
import { publishNotification, type DbOrTx, type TicketActivityChange } from "@stubwise/notifications";
import { eq } from "drizzle-orm";

/**
 * L'attività di una task seguita (integrazione area 2, fetta 1): pubblica
 * `ticket.activity` ai follower della task tranne chi ha fatto il cambio.
 *
 * La chiamano SOLO le scritture UMANE: un cambio di stato o di assegnatario
 * dall'app nuova (`services/task-writes.ts`) e un commento
 * (`POST /api/tickets/:ticketId/comments`). Mai gli scrittori di sistema
 * (pipeline, webhook, triage, intake): hanno già le loro notifiche.
 *
 * Gira nella transazione della scrittura; `publishNotification` non lancia
 * mai, quindi la scrittura non fallisce per una notifica.
 */
export async function notifyTaskActivity(
  tx: DbOrTx,
  input: {
    ticketId: string;
    actorUserId: string | null;
    change: TicketActivityChange;
    summary: string;
    /** Solo per un commento: il riferimento, mai il testo. */
    commentId?: string;
    /** Chi ha già una card più precisa per la stessa azione (decisioni). */
    excludeUserIds?: string[];
  },
): Promise<void> {
  const [row] = await tx
    .select({ number: tickets.number, projectId: tickets.projectId, code: projects.code })
    .from(tickets)
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .where(eq(tickets.id, input.ticketId));
  if (!row) return;
  await publishNotification(
    tx,
    {
      kind: "ticket.activity",
      ticketId: input.ticketId,
      ticketNumber: row.number,
      projectId: row.projectId,
      projectCode: row.code,
      change: input.change,
      summary: input.summary,
      actorUserId: input.actorUserId,
      ...(input.commentId ? { commentId: input.commentId } : {}),
    },
    {
      projectId: row.projectId,
      ticketId: input.ticketId,
      ...(input.excludeUserIds ? { excludeUserIds: input.excludeUserIds } : {}),
    },
  );
}

/** L'inizio di un testo, su una riga: il dato di un `ticket.activity` di commento. */
export function excerpt(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Gli avvisi PERSONALI della pianificazione (fetta 2): `task.assigned` a chi
 * riceve una task da un altro, `planning.changed` a chi la aveva quando un
 * altro la sposta, la toglie dal piano o la dà a qualcun altro. CHI li riceve
 * lo decide la scrittura con `planRecipientsOf` di `@stubwise/shared`;
 * `publishNotification` li riduce a chi vede la task e toglie l'attore.
 */
export async function notifyTaskPeople(
  tx: DbOrTx,
  input:
    | { kind: "task.assigned"; ticketId: string; actorUserId: string; recipientUserId: string }
    | {
        kind: "planning.changed";
        ticketId: string;
        actorUserId: string;
        recipientUserId: string;
        fromWeek: string | null;
        toWeek: string | null;
        fromAssigneeId: string | null;
        toAssigneeId: string | null;
        toAssigneeName: string | null;
      },
): Promise<void> {
  const [row] = await tx
    .select({ number: tickets.number, projectId: tickets.projectId, code: projects.code })
    .from(tickets)
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .where(eq(tickets.id, input.ticketId));
  if (!row) return;
  const base = {
    ticketId: input.ticketId,
    ticketNumber: row.number,
    projectId: row.projectId,
    projectCode: row.code,
    actorUserId: input.actorUserId,
  };
  await publishNotification(
    tx,
    input.kind === "task.assigned"
      ? { kind: "task.assigned", ...base }
      : {
          kind: "planning.changed",
          ...base,
          fromWeek: input.fromWeek,
          toWeek: input.toWeek,
          fromAssigneeId: input.fromAssigneeId,
          toAssigneeId: input.toAssigneeId,
          toAssigneeName: input.toAssigneeName,
        },
    { projectId: row.projectId, ticketId: input.ticketId, recipientUserIds: [input.recipientUserId] },
  );
}
