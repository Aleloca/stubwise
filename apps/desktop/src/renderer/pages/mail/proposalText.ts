import type { TFunction } from "i18next";
import type { MailProposalView, Person, ProposedAction, Task } from "../../data/types";
import { spoken } from "../../domain/claude/answers";
import { dayLabel } from "./format";

// Le frasi e gli argomenti delle azioni di una proposta della posta: ciò che
// la scheda (`MailProposalCard`), la modifica sul posto (`EditRow`) e l'esito
// (`Outcome`) condividono.

/**
 * Una proposta che aspetta chi guarda: può confermarla (aperta o passata al
 * progetto), passarla, o sceglierne il progetto. È la scheda viva, col punto.
 */
export function isLiveProposal(view: MailProposalView): boolean {
  const p = view.proposal;
  const choose = p.actions.find((a) => a.fn === "chooseProject");
  if (choose) return p.status === "open" && ((choose.args.projectIds as string[] | undefined) ?? []).length > 0;
  return (
    ((p.status === "open" || p.status === "handed") && view.canConfirm) ||
    (p.status === "open" && view.canHand)
  );
}

export type Args = Record<string, unknown>;
export type Edits = Record<number, Args>;

/** Le funzioni che si spostano su un altro progetto (non toccano oggetti del progetto). */
export const PORTABLE: ReadonlySet<ProposedAction["fn"]> = new Set([
  "createTask",
  "createRequest",
  "recordDecision",
  "createMilestone",
]);

/** Le funzioni che si modificano sul posto. Una decisione no: il testo lo scrive il template. */
export const EDITABLE: ReadonlySet<ProposedAction["fn"]> = new Set([
  "createTask",
  "createRequest",
  "updateTask",
  "addComment",
  "createMilestone",
]);

/** Che cosa non si può fare senza il permesso dell'azione, in parole («create tasks»). */
export const ABILITY: Partial<Record<ProposedAction["fn"], string>> = {
  createTask: "createTasks",
  updateTask: "editTasks",
  createMilestone: "editTasks",
  addComment: "comment",
  createRequest: "createRequests",
  recordDecision: "recordDecisions",
};

/** Gli argomenti di un'azione con le modifiche di chi conferma (la patch si fonde). */
export function effectiveArgs(action: ProposedAction, edit: Args | undefined): Args {
  if (!edit) return action.args;
  const merged: Args = { ...action.args, ...edit };
  if (edit.patch && typeof action.args.patch === "object") {
    merged.patch = { ...(action.args.patch as Args), ...(edit.patch as Args) };
  }
  return merged;
}

export function assigneeOf(fn: ProposedAction["fn"], args: Args): string | null | undefined {
  if (fn === "createTask") return args.assigneeId as string | null | undefined;
  if (fn === "updateTask") return (args.patch as Args | undefined)?.assigneeId as string | null | undefined;
  return undefined;
}

export const reasonKey = (error: string | null) =>
  ["forbidden", "not_found", "conflict", "invalid"].includes(error ?? "") ? error! : "other";

export interface Ctx {
  t: TFunction;
  language: string;
  code: string;
  people: ReadonlyMap<string, Person>;
  tasks: ReadonlyMap<string, Task>;
}

/** La frase catalogo di un'azione (senza l'incaricato, che la riga aggiunge col suo segno). */
export function phraseOf(action: ProposedAction, args: Args, ctx: Ctx): string {
  const { t, code } = ctx;
  const task = (id: unknown) => {
    const found = ctx.tasks.get(id as string);
    return found ? `${found.code} ${found.title}` : String(id ?? "");
  };
  const date = (d: unknown) => dayLabel(String(d), ctx.language);
  switch (action.fn) {
    // La scadenza della task la aggiunge la riga, dopo l'incaricato.
    case "createTask":
      return t("mail.proposal.phrase.createTask", { code, title: args.title });
    case "createRequest":
      return t("mail.proposal.phrase.createRequest", { code, title: args.title });
    case "updateTask": {
      const patch = (args.patch ?? {}) as Args;
      if (patch.dueDate) return t("mail.proposal.phrase.updateDue", { task: task(args.id), date: date(patch.dueDate) });
      return t("mail.proposal.phrase.updateTask", { task: task(args.id) });
    }
    case "addComment":
      return t("mail.proposal.phrase.addComment", { task: task(args.taskId), body: args.body });
    case "recordDecision":
      return t("mail.proposal.phrase.recordDecision", { code, title: args.title });
    case "createMilestone": {
      const base = t("mail.proposal.phrase.createMilestone", { code, name: args.name });
      return args.dueDate ? `${base} · ${date(args.dueDate)}` : base;
    }
    default:
      return spoken(t, action.summaryText, action.summary);
  }
}
