import type { MailProposal as ServerProposal, MailProposalActionType } from "@stubwise/shared";
import type { MailProposal, MailProposalView, ProposedAction } from "../../types";
import { threadKey } from "./mailKeys";

// Una proposta della F2 (`MailProposal` di `@stubwise/shared`, la rotta
// `/api/me/mail/proposals`) come la legge la Posta del prototipo. Le azioni
// prendono i nomi e gli argomenti del prototipo (la scheda le dice a parole e
// le modifica sul posto), con la frase del server come riassunto. Permessi,
// incaricati fuori dal progetto, condivisione e origine li calcola il
// server: qui non si deducono.

type Args = Record<string, unknown>;

/** Il tipo del server, la funzione del prototipo e i suoi argomenti. */
const ACTION_OF: Record<
  MailProposalActionType,
  (args: Args) => { fn: ProposedAction["fn"]; args: Args }
> = {
  create_task: (a) => ({ fn: "createTask", args: a }),
  create_backlog_item: (a) => ({ fn: "createRequest", args: a }),
  update_ticket: ({ ticketId, ...rest }) => ({ fn: "updateTask", args: { id: ticketId, ...rest } }),
  comment_ticket: ({ ticketId, ...rest }) => ({
    fn: "addComment",
    args: { taskId: ticketId, ...rest },
  }),
  create_milestone: (a) => ({ fn: "createMilestone", args: a }),
  record_decision: ({ ticketId, ...rest }) => ({
    fn: "recordDecision",
    args: ticketId === undefined ? rest : { taskId: ticketId, ...rest },
  }),
  choose_project: (a) => ({ fn: "chooseProject", args: a }),
  // F3b: il promemoria di una serie del calendario, «Visto» (non crea nulla).
  acknowledge_reminder: (a) => ({ fn: "acknowledgeReminder", args: a }),
};

const person = (p: { userId: string; name: string }) => ({ personId: p.userId, name: p.name });

/**
 * F3b (task 7 di 72): le proposte del calendario nella stessa lista, con
 * `kind: "calendar"`, `messageId` null e l'origine dell'evento in
 * `calendarOrigin`. Un server di prima non manda `kind` (default «email»);
 * la build web non parsa (`as`), quindi `?? null` qui.
 */
function calendarOriginOf(
  origin: ServerProposal["calendarOrigin"] | undefined,
): MailProposalView["origin"] {
  if (!origin) return null;
  return {
    kind: "calendar",
    eventId: origin.eventId,
    title: origin.title ?? "",
    startsAt: origin.startsAt,
    allDay: origin.allDay === true,
  };
}

/**
 * F5 (bozza del piano): una proposta di una riunione registrata, con
 * `kind: "meeting"` e l'origine in `meetingOrigin` (a parte, come
 * `calendarOrigin`). Finché lo schema non la porta si legge cruda: il tipo
 * apre `kind` e il campo nuovo.
 */
type MeetingOrigin = {
  eventId: string | null;
  accountId?: string;
  threadId: string;
  title?: string | null;
  at: string;
};
function meetingOriginOf(o: MeetingOrigin | null | undefined): MailProposalView["origin"] {
  if (!o) return null;
  return {
    kind: "meeting",
    eventId: o.eventId ?? null,
    // La conversazione dell'email di Gemini, come chiave dell'app (casella + thread).
    threadId: o.accountId ? threadKey(o.accountId, o.threadId) : o.threadId,
    title: o.title ?? "",
    at: o.at,
  };
}

export function proposalViewOf(raw: ServerProposal): MailProposalView {
  const p = raw as Omit<ServerProposal, "kind"> & {
    kind?: string;
    meetingOrigin?: MeetingOrigin | null;
  };
  const fromMeeting = p.kind === "meeting";
  const fromCalendar = p.kind === "calendar";
  const calendarOrigin = fromCalendar ? calendarOriginOf(p.calendarOrigin ?? null) : null;
  const actions = p.actions.flatMap<ProposedAction>((a) => {
    const map = ACTION_OF[a.type];
    // Un tipo che questo client non conosce (`readerSchema`): non lo propone.
    if (!map) return [];
    return [{ ...map({ ...a.args }), summary: a.label }];
  });
  const proposal: MailProposal = {
    id: p.id,
    // Una riunione: la sorgente è la trascrizione, e il messaggio è l'email di Gemini.
    source: fromCalendar ? "calendar" : fromMeeting ? "transcript" : "email",
    // Il messaggio d'origine (`email_messages.id`): è il `messageId` dei messaggi della Posta;
    // per il calendario, l'evento.
    sourceId: fromCalendar ? (p.calendarOrigin?.eventId ?? "") : (p.messageId ?? ""),
    projectId: p.projectId,
    actions,
    excerpt: p.excerpt,
    createdAt: p.createdAt,
    status: p.status,
    decidedById: p.decidedBy?.userId ?? null,
    decidedAt: p.decidedAt,
    resultCodes: p.results.flatMap((r) => (r.code ? [r.code] : [])),
    error: p.error,
    handedAt: p.handedAt,
    handedById: p.handedBy?.userId ?? null,
  };
  if (p.confirmedIndices.length > 0) proposal.confirmedActions = [...p.confirmedIndices];
  return {
    proposal,
    canConfirm: p.canConfirm,
    canHand: p.canHand,
    canReassign: p.canReassign,
    outsiders: p.outsiders.map(person),
    decidedBy: p.decidedBy ? person(p.decidedBy) : null,
    sharedWith: p.sharedWith.map(person),
    editable: p.editable,
    origin: fromCalendar
      ? calendarOrigin
      : fromMeeting
        ? meetingOriginOf(p.meetingOrigin)
        : p.origin
          ? {
              kind: "email",
              threadId: threadKey(p.origin.accountId, p.origin.threadId),
              from: p.origin.from,
              subject: p.origin.subject ?? "",
            }
          : null,
  };
}
