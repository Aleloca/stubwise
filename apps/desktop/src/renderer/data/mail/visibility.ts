import { state, visibleProjectIds } from "../store";
import type { Mailbox, MailMessage, MailProposal } from "../types";

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

/** Chi guarda vede il messaggio: ne è un destinatario in Stubwise. */
export function canSeeMessage(me: string, m: MailMessage): boolean {
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
 * Una proposta aperta che chi guarda vede, nella forma minima che serve al
 * conteggio della riga: vede il messaggio da cui nasce ed è membro del
 * progetto. La regola intera (`canSeeMailProposal`: passate, calendario) è
 * del Task 3, che la sostituisce qui.
 */
export function canSeeMailProposal(me: string, p: MailProposal): boolean {
  if (p.source === "calendar") return false;
  if (!visibleProjectIds(me).has(p.projectId)) return false;
  return state.mailMessages.some((m) => m.messageId === p.sourceId && canSeeMessage(me, m));
}
