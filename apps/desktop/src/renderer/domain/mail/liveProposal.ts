import type { MailProposalView } from "../../data/types";

// Quando una proposta della posta aspetta chi guarda: la regola UNA, per la
// scheda (il punto), la Posta e «Da decidere» della Home, nel prototipo e
// nella build app.

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
