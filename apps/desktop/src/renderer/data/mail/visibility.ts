import { eventParticipants } from "../calendar/visibility";
import { state } from "../store";
import type { Mailbox, MailMessage, MailProposal, ProposedAction } from "../types";
import { can, viewerFor, type Permission } from "../viewer";

// Chi vede che cosa nella Posta (area 6): UNA regola, per ogni lettura e ogni
// scrittura. Un messaggio lo vedono solo i suoi destinatari in Stubwise —
// mittente, `to`, `cc`, proprietari delle caselle che lo contengono — e
// nessun altro: admin e full admin NON fanno eccezione. Un messaggio, un
// thread o una casella che chi guarda non vede risponde come uno che non
// esiste (R-G5): elenchi vuoti, `not_found` — mai `forbidden`.

/** Le persone del team fra i destinatari: mittente, `to`, `cc` e caselle. */
export function stubwiseRecipients(m: MailMessage): Set<string> {
  const ids = new Set<string>(m.mailboxPersonIds);
  for (const a of [m.from, ...m.to, ...(m.cc ?? [])]) if (a.personId) ids.add(a.personId);
  return ids;
}

/**
 * Chi guarda vede il messaggio: ne è un destinatario in Stubwise. Un invio
 * non ancora partito (`sending`, nei 5 s dell'«Annulla») o fallito non è
 * arrivato a nessuno: lo vede solo chi l'ha scritto.
 */
export function canSeeMessage(me: string, m: MailMessage): boolean {
  if (m.delivery && m.delivery.state !== "sent") return m.delivery.sentById === me;
  return (
    m.from.personId === me ||
    m.to.some((a) => a.personId === me) ||
    (m.cc ?? []).some((a) => a.personId === me) ||
    m.mailboxPersonIds.includes(me)
  );
}

/** I messaggi che chi guarda vede. */
export const visibleMessages = (me: string): MailMessage[] =>
  state.mailMessages.filter((m) => canSeeMessage(me, m));

/** Una casella di chi guarda, per indirizzo: quella di un altro non c'è. */
export const myMailbox = (me: string, email: string): Mailbox | undefined =>
  state.mailboxes.find((b) => b.email === email && b.personId === me);

/**
 * Il permesso che conferma un'azione proposta, nel progetto della proposta.
 * `chooseProject` non si conferma: si sceglie (`chooseProjectFor`).
 */
export function permissionForAction(fn: ProposedAction["fn"]): Permission | null {
  switch (fn) {
    case "createTask":
    case "convertRequest":
      return "tickets.create";
    case "updateTask":
    case "planTask":
    case "createMilestone":
      return "tickets.edit";
    case "addComment":
      return "tickets.comment";
    case "createRequest":
      return "backlog.create";
    case "archiveRequest":
      return "backlog.edit";
    case "startRun":
      return "runs.start";
    case "recordDecision":
      return "decisions.record";
    case "chooseProject":
      return null;
  }
}

/**
 * I partecipanti in Stubwise di un evento del calendario che non l'hanno
 * rifiutato (`eventParticipants` di `calendar/visibility.ts`). Un oggetto,
 * così un test può sostituire `of`.
 */
export const calendarParticipants: { of: (eventId: string) => string[] } = {
  of: eventParticipants,
};

export const isProjectMember = (me: string, projectId: string): boolean =>
  !!state.projectsById.get(projectId)?.memberIds.includes(me);

/**
 * I progetti fra cui sceglie una proposta `chooseProject` (`args.projectIds`);
 * per ogni altra, il suo progetto.
 */
export function proposalProjectIds(p: MailProposal): string[] {
  const choose = p.actions.find((a) => a.fn === "chooseProject");
  return choose ? ((choose.args.projectIds as string[] | undefined) ?? []) : [p.projectId];
}

/** Chi agisce ha nel progetto della proposta il permesso di ognuna delle azioni. */
export function canDoActions(me: string, p: MailProposal, actions: ProposedAction[]): boolean {
  const viewer = viewerFor(me);
  return actions.every((a) => {
    const perm = permissionForAction(a.fn);
    return perm !== null && can(viewer, perm, p.projectId);
  });
}

/** Chi guarda è un destinatario dell'email da cui nasce la proposta. */
export const isProposalRecipient = (me: string, p: MailProposal): boolean =>
  p.source !== "calendar" &&
  state.mailMessages.some((m) => m.messageId === p.sourceId && canSeeMessage(me, m));

/**
 * Chi vede una proposta della posta — l'unica regola, per ogni lettura e
 * scrittura. Email e trascrizione: chi vede il messaggio (`messageId ===
 * sourceId`) ED è membro del progetto (`memberIds`: un admin non membro non
 * la vede, anche se vede ogni progetto); per `chooseProject` basta essere
 * membro di uno dei progetti fra cui sceglie. Passata al progetto (una
 * volta passata lo resta, anche decisa: `handedAt`): anche chi ha nel
 * progetto il permesso di ogni sua azione — la stessa regola di
 * `canConfirm` — senza essere destinatario (vede l'estratto, non il
 * messaggio). Calendario: partecipante dell'evento e membro.
 */
export function canSeeMailProposal(me: string, p: MailProposal): boolean {
  if (p.source === "calendar") {
    return isProjectMember(me, p.projectId) && calendarParticipants.of(p.sourceId).includes(me);
  }
  if (proposalProjectIds(p).some((id) => isProjectMember(me, id)) && isProposalRecipient(me, p)) {
    return true;
  }
  return p.handedAt !== null && canDoActions(me, p, p.actions);
}
