import { t, type Language } from "@stubwise/i18n";
import type { GoogleProposalAction } from "./format.js";

/**
 * Le opzioni di una proposta CONDIVISA della posta (area 6, F2): un'opzione per
 * azione della classificazione nuova, nell'ordine, con l'etichetta da template
 * (`mailProposal.action.*`); un'azione senza i campi che servono si salta. In
 * un posto solo perché la usano il worker (la card dei destinatari,
 * `buildSharedProposalEvent`) e il server (la card di chi decide una passata,
 * rimandi lotto 4, §2): le due card devono avere gli STESSI indici, che
 * `/api/inbox/:id/act` legge come indici delle azioni.
 */
export function sharedProposalOptions(
  lang: Language,
  projectId: string,
  actions: readonly { type: string; args: Record<string, unknown> }[],
): { label: string; action: GoogleProposalAction }[] {
  const str = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : undefined);
  const options: { label: string; action: GoogleProposalAction }[] = [];
  for (const raw of actions) {
    const a = raw.args;
    const label = t(lang, `mailProposal.action.${raw.type}`, { title: String(a.title ?? ""), name: String(a.name ?? ""), ticket: "" });
    let action: GoogleProposalAction | null = null;
    if (raw.type === "create_task" && str(a.title)) {
      action = {
        type: "create_task",
        projectId: projectId,
        title: String(a.title),
        ...(str(a.description) ? { body: String(a.description) } : {}),
        ...(str(a.assigneeId) ? { assigneeId: String(a.assigneeId) } : {}),
        ...(str(a.dueDate) ? { dueDate: String(a.dueDate) } : {}),
      };
    } else if (raw.type === "create_backlog_item" && str(a.title)) {
      action = { type: "create_backlog_item", projectId: projectId, title: String(a.title), ...(str(a.description) ? { body: String(a.description) } : {}) };
    } else if (raw.type === "create_milestone" && str(a.name)) {
      action = { type: "create_milestone", projectId: projectId, name: String(a.name), ...(str(a.dueDate) ? { dueDate: String(a.dueDate) } : {}) };
    } else if (raw.type === "comment_ticket" && str(a.ticketId) && str(a.body)) {
      action = { type: "comment_ticket", ticketId: String(a.ticketId), body: String(a.body) };
    } else if (raw.type === "update_ticket" && str(a.ticketId)) {
      const patch = (a.patch ?? {}) as Record<string, unknown>;
      action = {
        type: "update_ticket",
        ticketId: String(a.ticketId),
        ...(str(patch.status) ? { status: patch.status as "open" } : {}),
        ...(str(patch.priority) ? { priority: patch.priority as "low" } : {}),
      };
    } else if (raw.type === "record_decision" && str(a.title) && str(a.decision)) {
      action = {
        type: "record_decision",
        projectId: projectId,
        title: String(a.title),
        decision: String(a.decision),
        ...(str(a.ticketId) ? { ticketId: String(a.ticketId) } : {}),
      };
    }
    if (action) options.push({ label, action });
  }
  return options;
}

/** «Non fare nulla»: l'ultima opzione di ogni proposta. */
export function ignoreProposalOption(lang: Language): { label: string; consequence: string; action: GoogleProposalAction } {
  return { label: t(lang, "email.proposal.ignore"), consequence: t(lang, "email.proposal.ignoreConsequence"), action: { type: "ignore" } };
}
