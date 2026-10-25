import type { CalendarEvent, CalendarSeries, MailProposal, ProposedAction } from "../model";

// Le proposte che nascono dal calendario (area 6). Una riunione normale non
// ne produce; le producono:
// - un evento FUTURO che il modello riconosce come scadenza o consegna
//   (`deadlineProposal`): un traguardo (`createMilestone`);
// - ogni data futura di una serie ACCESA, quando entra nei suoi giorni di
//   anticipo (`seriesProposal`): un traguardo, una richiesta o un promemoria.
// Mai da una data passata o rifiutata da tutti. Il testo delle azioni è un
// modello fisso (titolo + data), mai scritto dal modello. Puro (nessuno
// stato): lo usano il seme, l'allineamento e la configurazione delle serie.

const DAY_MS = 86_400_000;

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

/** La data di un evento: la data UTC, che per un «tutto il giorno» è LA data. */
const dateOf = (e: Pick<CalendarEvent, "startsAt">) => e.startsAt.slice(0, 10);

/**
 * Non ancora passato: un «tutto il giorno» si confronta per data (quello di
 * oggi vale ancora), uno con orario per istante.
 */
export function isUpcoming(e: Pick<CalendarEvent, "startsAt" | "allDay">, now: string): boolean {
  return e.allDay ? dateOf(e) >= now.slice(0, 10) : Date.parse(e.startsAt) > Date.parse(now);
}

/** L'id della proposta di una scadenza: una per evento. */
export const calendarProposalId = (eventId: string): string => `mp-cal-${eventId}`;

/** L'id della proposta di una data di una serie: una per data. */
export const seriesProposalId = (eventId: string): string => `mp-ser-${eventId}`;

function proposal(
  id: string,
  e: CalendarEvent,
  projectId: string,
  actions: ProposedAction[],
  now: string,
): MailProposal {
  return {
    id,
    source: "calendar",
    sourceId: e.id,
    projectId,
    actions,
    excerpt: `${e.title} · ${dateOf(e)}`,
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

/**
 * La proposta di una scadenza, o `null`: serve un progetto, un titolo da
 * scadenza, un evento non passato e almeno un partecipante che non ha
 * rifiutato.
 */
export function deadlineProposal(e: CalendarEvent, now: string): MailProposal | null {
  if (e.projectId === null || !DEADLINE.test(e.title)) return null;
  if (!isUpcoming(e, now) || activeParticipants(e).length === 0) return null;
  const dueDate = dateOf(e);
  const name = milestoneName(e.title);
  return proposal(
    calendarProposalId(e.id),
    e,
    e.projectId,
    [
      {
        fn: "createMilestone",
        args: { projectId: e.projectId, name, dueDate },
        summary: `Milestone: ${name} · ${dueDate}`,
      },
    ],
    now,
  );
}

/**
 * L'azione di una serie per una sua data. «Ricordamelo» non crea nulla: è
 * una presa d'atto (`acknowledgeReminder`, come `acknowledge_reminder` del
 * web), con solo la data e il titolo. Nessuna avvia il lavoro di Claude.
 */
function seriesAction(s: CalendarSeries, projectId: string, date: string): ProposedAction {
  const label = `${s.title} · ${date}`;
  switch (s.action) {
    case "milestone":
      return {
        fn: "createMilestone",
        args: { projectId, name: label, dueDate: date },
        summary: `Milestone: ${label}`,
      };
    case "request":
      return {
        fn: "createRequest",
        args: {
          projectId,
          title: label,
          description: `From the recurring event “${s.title}” on ${date}.`,
        },
        summary: `Request: ${label}`,
      };
    case "remind":
      return {
        fn: "acknowledgeReminder",
        args: { title: s.title, date },
        summary: `Reminder: ${label}`,
      };
  }
}

/**
 * La proposta di una data di una serie, o `null`: la serie è accesa e ha un
 * progetto, la data non è passata, qualcuno non l'ha rifiutata, e mancano
 * al massimo `leadDays` giorni. Un promemoria con «Agisci da solo» non
 * produce nulla: non c'è niente da fare in automatico.
 */
export function seriesProposal(
  s: CalendarSeries,
  e: CalendarEvent,
  now: string,
): MailProposal | null {
  if (!s.enabled || s.projectId === null || e.seriesId !== s.id) return null;
  if (s.auto && s.action === "remind") return null;
  if (!isUpcoming(e, now) || activeParticipants(e).length === 0) return null;
  if (Date.parse(now) < Date.parse(e.startsAt) - s.leadDays * DAY_MS) return null;
  return proposal(
    seriesProposalId(e.id),
    e,
    s.projectId,
    [seriesAction(s, s.projectId, dateOf(e))],
    now,
  );
}

/** Le proposte di un evento: la sua scadenza e quella della sua serie. */
export function eventProposals(
  e: CalendarEvent,
  series: readonly CalendarSeries[],
  now: string,
): MailProposal[] {
  const s = series.find((x) => x.id === e.seriesId);
  return [deadlineProposal(e, now), s ? seriesProposal(s, e, now) : null].filter(
    (p): p is MailProposal => p !== null,
  );
}
