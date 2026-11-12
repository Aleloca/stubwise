import { ApiError } from "@stubwise/api-client";
import type { InboxGoogleActionType, InboxItem } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { MailProposal, MailProposalView, ProposedAction } from "../../types";
import { appClient } from "./client";

// Le proposte accanto all'email nella build app (area 6, fetta 1): le card
// `google.proposal` di `/api/inbox`, PER CASELLA (`mailbox_owner`: le vede
// solo chi possiede la casella). Ogni azione della proposta è un'opzione
// della card, con l'etichetta che scrive il server; le azioni del modello si
// confermano insieme (`optionIndices`) o una per volta (`optionIndex`).
// Niente modifica dei campi, niente incaricati fuori dal progetto, niente
// condivisione fra destinatari (F2). La scelta del progetto di un'email
// incerta (`choose_project`) il worker non la produce più: qui non c'è.

type Mail = typeof Fake.mail;

/** Le azioni del modello e la loro funzione nel prototipo; le altre opzioni sono gesti della card. */
const FN_OF: Partial<Record<InboxGoogleActionType, ProposedAction["fn"]>> = {
  create_backlog_item: "createRequest",
  create_milestone: "createMilestone",
  update_ticket: "updateTask",
  comment_ticket: "addComment",
  record_decision: "recordDecision",
  acknowledge_reminder: "acknowledgeReminder",
};

type Card = InboxItem & { google: NonNullable<InboxItem["google"]>; question: NonNullable<InboxItem["question"]> };

const isMailCard = (i: InboxItem): i is Card =>
  i.kind === "google.proposal" && i.google?.source === "email" && i.question !== undefined;

/** Gli indici delle opzioni della card che sono azioni del modello, nell'ordine. */
const modelIndices = (c: Card) => c.google.actions.flatMap((a, i) => (FN_OF[a.type] ? [i] : []));
const optionOf = (c: Card, type: InboxGoogleActionType) => c.google.actions.findIndex((a) => a.type === type);

function statusOf(c: Card): MailProposal["status"] {
  if (c.status !== "handled") return "open";
  if (c.google.handed) return "handed";
  const d = c.google.decision;
  if (d?.status === "actioned") return "confirmed";
  if (d?.status === "failed") return "failed";
  return "ignored";
}

function viewOf(c: Card): MailProposalView {
  const indices = modelIndices(c);
  const actions = indices.map<ProposedAction>((i) => ({
    fn: FN_OF[c.google.actions[i]!.type]!,
    args: {},
    summary: c.question.options[i]?.label ?? "",
  }));
  const status = statusOf(c);
  const chosen = new Set(c.google.decision?.chosen ?? []);
  const proposal: MailProposal = {
    id: c.id,
    source: "email",
    // La proposta del server (`email_proposals.id`): il messaggio d'origine la elenca in `proposalIds`.
    sourceId: c.google.sourceProposalId ?? c.id,
    projectId: c.projectId ?? "",
    actions,
    // Il server non dà l'estratto letto sulla card: lo mostra il messaggio sopra.
    excerpt: "",
    createdAt: c.createdAt,
    status,
    decidedById: c.handledBy?.id ?? null,
    decidedAt: c.handledAt,
    resultCodes: [],
    error: c.google.decision?.error ?? null,
    handedAt: null,
    handedById: null,
  };
  if (status === "confirmed" && chosen.size > 0) {
    proposal.confirmedActions = indices.flatMap((i, k) => (chosen.has(c.question.options[i]?.label ?? "") ? [k] : []));
  }
  const handable = c.actions.includes("hand_to_project");
  return {
    proposal,
    // Si conferma la proposta intera: un'azione senza permesso (bloccata) la fa passare al progetto.
    canConfirm: status === "open" && indices.every((i) => !c.google.blockedIndices.includes(i)),
    canHand: status === "open" && handable,
    canReassign: status === "open" && optionOf(c, "reassign_project") !== -1,
    outsiders: [],
    decidedBy: c.handledBy ? { personId: c.handledBy.id, name: c.handledBy.email } : null,
    sharedWith: [],
  };
}

/** Le card della Posta che vedo: le aperte e le decise di recente. */
async function cards(): Promise<Card[]> {
  const client = appClient();
  const [open, handled] = await Promise.all([
    client.inbox.list({ status: "open" }, undefined, 100),
    client.inbox.list({ status: "handled" }, undefined, 50),
  ]);
  return [...open.items, ...handled.items].filter((i): i is Card => isMailCard(i as InboxItem));
}

async function cardOf(id: string): Promise<Card> {
  const found = (await cards()).find((c) => c.id === id);
  if (!found) throw new Error("not_found");
  return found;
}

const listMailProposals: Mail["listMailProposals"] = async (filters = {}) =>
  (await cards())
    .map(viewOf)
    .filter(
      (v) =>
        (filters.sourceId === undefined || v.proposal.sourceId === filters.sourceId) &&
        (filters.status === undefined || v.proposal.status === filters.status),
    );

const getMailProposal: Mail["getMailProposal"] = async (id) => viewOf(await cardOf(id));

/** Già decisa da altri, o non più valida: non riuscita, col motivo del server. */
const STALE = new Set(["already_handled", "proposal_stale", "question_not_pending"]);

const confirmMailProposal: Mail["confirmMailProposal"] = async (id, input = {}) => {
  if (input.edits && Object.keys(input.edits).length > 0) throw new Error("invalid: edits");
  const c = await cardOf(id);
  const indices = modelIndices(c);
  const chosen = (input.actionIndexes ?? indices.map((_, k) => k)).map((k) => indices[k]);
  if (chosen.length === 0 || chosen.some((i) => i === undefined)) throw new Error("invalid: actions");
  const body = chosen.length === 1 ? { optionIndex: chosen[0]! } : { optionIndices: chosen as number[] };
  try {
    await appClient().inbox.answer(id, body);
  } catch (error) {
    if (error instanceof ApiError && error.code && STALE.has(error.code)) return { status: "failed", error: error.code };
    throw error;
  }
  return { status: "confirmed", resultCodes: [] };
};

/** «Ignora»: l'opzione «non fare nulla» della card. */
const ignoreMailProposal: Mail["ignoreMailProposal"] = async (id) => {
  const c = await cardOf(id);
  const index = optionOf(c, "ignore");
  if (index === -1) throw new Error("invalid: ignore");
  await appClient().inbox.answer(id, { optionIndex: index });
};

/** «Passa al progetto»: la card nuova va a chi nel progetto può decidere. */
const handMailProposal: Mail["handMailProposal"] = async (id) => {
  await appClient().inbox.act(id, "hand_to_project");
};

/** «Sposta su un altro progetto»: l'opzione apposta, col progetto scelto. */
const reassignMailProposal: Mail["reassignMailProposal"] = async (id, projectId) => {
  const c = await cardOf(id);
  const index = optionOf(c, "reassign_project");
  if (index === -1) throw new Error("invalid: reassign");
  await appClient().inbox.answer(id, { optionIndex: index, projectId });
};

export const mailProposalFunctions: Partial<Mail> = {
  listMailProposals,
  getMailProposal,
  confirmMailProposal,
  ignoreMailProposal,
  handMailProposal,
  reassignMailProposal,
};
