import type { CalendarEvent, MailProposal } from "../model";

// Le proposte che nascono dal calendario (area 6): una riunione normale non
// ne produce; un evento FUTURO che il modello riconosce come scadenza o
// consegna propone un traguardo (`createMilestone`) nel suo progetto. Mai da
// un evento passato o rifiutato. Puro (nessuno stato): lo usano il seme e
// l'allineamento del calendario.

/** I titoli che il modello (finto) riconosce come scadenza o consegna. */
const DEADLINE = /\b(deadline|due|delivery|consegna|scadenza)\b/i;

/** Il nome del traguardo: il titolo senza l'etichetta «Deadline:». */
const milestoneName = (title: string) =>
  title.replace(/^\s*(deadline|delivery|consegna|scadenza)\s*[:·-]\s*/i, "").trim() || title;

/**
 * Chi partecipa davvero: gli invitati del team che non hanno rifiutato; un
 * evento senza invitati è di chi lo ha in calendario. È anche chi vede la
 * proposta (insieme all'essere membro del progetto).
 */
export function activeParticipants(e: CalendarEvent): string[] {
  if (e.attendees.length === 0) return [...e.calendarPersonIds];
  return e.attendees.flatMap((a) =>
    a.personId !== null && a.response !== "declined" ? [a.personId] : [],
  );
}

/** L'id della proposta di un evento: una per evento. */
export const calendarProposalId = (eventId: string): string => `mp-cal-${eventId}`;

/**
 * La proposta di un evento, o `null`: serve un progetto, un titolo da
 * scadenza, un inizio dopo `now` e almeno un partecipante che non ha
 * rifiutato.
 */
export function deadlineProposal(e: CalendarEvent, now: string): MailProposal | null {
  if (e.projectId === null || !DEADLINE.test(e.title)) return null;
  if (Date.parse(e.startsAt) <= Date.parse(now)) return null;
  if (activeParticipants(e).length === 0) return null;
  const dueDate = e.startsAt.slice(0, 10);
  const name = milestoneName(e.title);
  return {
    id: calendarProposalId(e.id),
    source: "calendar",
    sourceId: e.id,
    projectId: e.projectId,
    actions: [
      {
        fn: "createMilestone",
        args: { projectId: e.projectId, name, dueDate },
        summary: `Milestone: ${name} · ${dueDate}`,
      },
    ],
    excerpt: `${e.title} · ${dueDate}`,
    createdAt: now,
    status: "open",
    decidedById: null,
    decidedAt: null,
    resultCodes: [],
    error: null,
    handedAt: null,
    handedById: null,
  };
}
