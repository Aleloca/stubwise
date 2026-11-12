import { ApiError } from "@stubwise/api-client";
import type { MailProposal as ServerProposal } from "@stubwise/shared";
import type * as Fake from "../../api";
import { appClient } from "./client";
import { proposalViewOf } from "./mailProposalView";

// Le proposte accanto all'email nella build app (area 6, fetta 2): la rotta
// `/api/me/mail/proposals`, una proposta per email e progetto condivisa fra i
// destinatari membri, più le proposte di prima (per casella). Leggere e
// decidere passano tutti da lì: confermare (anche in parte, coi campi
// cambiati, aggiungendo gli incaricati fuori dal progetto come Contributor),
// ignorare, passare al progetto, spostare, scegliere il progetto. Chi decide
// per primo la chiude per tutti; il secondo ha `already_handled` con chi.

type Mail = typeof Fake.mail;

/** L'esito di una decisione come lo legge il client (gli stati ignoti via `readerSchema`). */
type Decision = Awaited<ReturnType<ReturnType<typeof appClient>["mail"]["confirmProposal"]>>;

const viewsOf = (items: readonly unknown[]) => items.map((p) => proposalViewOf(p as ServerProposal));

const listMailProposals: Mail["listMailProposals"] = async (filters = {}) => {
  const { items } = await appClient().mail.proposals({ message: filters.sourceId, status: filters.status });
  return viewsOf(items);
};

const getMailProposal: Mail["getMailProposal"] = async (id) => {
  try {
    return proposalViewOf((await appClient().mail.proposal(id)) as ServerProposal);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) throw new Error("not_found");
    throw error;
  }
};

/**
 * «Da decidere» della Home: le proposte aperte che posso confermare o
 * passare, con l'origine (la conversazione della mia casella, se c'è).
 */
const listMailDecisions: Mail["listMailDecisions"] = async () => {
  const { items } = await appClient().mail.proposals({ status: "open" });
  return viewsOf(items).filter((v) => v.canConfirm || v.canHand);
};

/** I 400 del server con le parole del prototipo. */
const INVALID: Readonly<Record<string, string>> = {
  invalid_assignee: "invalid: assignee",
  invalid_edits: "invalid: edits",
  invalid_selection: "invalid: selection",
  invalid_target: "invalid: target",
};

/** Un errore del server su una decisione, come lo dice il prototipo. */
function decisionError(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  if (error.code === "already_handled") {
    const by = (error.details as { decidedBy?: { userId?: string } | null } | undefined)?.decidedBy;
    return Object.assign(new Error("already_handled"), { byId: by?.userId ?? null });
  }
  if (error.status === 404) return new Error("not_found");
  if (error.code && INVALID[error.code]) return new Error(INVALID[error.code]);
  if (error.code === "forbidden") return new Error("forbidden");
  return error;
}

async function decide(run: () => Promise<Decision>): Promise<Decision> {
  try {
    return await run();
  } catch (error) {
    throw decisionError(error);
  }
}

/** Gli argomenti cambiati prima di confermare, per indice d'azione (i nomi sono già quelli del server). */
type Edits = Record<string, Record<string, unknown>>;

/**
 * Conferma, tutta o in parte, coi campi cambiati. Con incaricati fuori dal
 * progetto da aggiungere come Contributor, la rotta che lo fa: chiede la
 * riconferma (il rifiuto che `useReauth` riconosce) e le regole di Membri
 * (`escalation`; `target_above` è un permesso che manca), e niente cambia se
 * rifiuta.
 */
const confirmMailProposal: Mail["confirmMailProposal"] = async (id, input = {}) => {
  const body: { indices?: number[]; edits?: Edits } = {};
  if (input.actionIndexes !== undefined) body.indices = [...input.actionIndexes];
  if (input.edits && Object.keys(input.edits).length > 0) body.edits = input.edits as Edits;
  const adding = input.addOutsiders ?? [];
  let result: Decision;
  try {
    result =
      adding.length > 0
        ? await appClient().mail.confirmProposalWithMembers(id, { ...body, addOutsiders: [...adding] })
        : await appClient().mail.confirmProposal(id, body);
  } catch (error) {
    if (error instanceof ApiError && adding.length > 0) {
      if (error.code === "reauth_required") return { status: "refused", ok: false, error: "reauth_required" };
      if (error.code === "escalation") {
        const missing = (error.details as { missing?: unknown } | undefined)?.missing;
        return { status: "refused", ok: false, error: "escalation", missing: Array.isArray(missing) ? missing.map(String) : [] };
      }
      if (error.code === "target_above") return { status: "refused", ok: false, error: "forbidden" };
    }
    throw decisionError(error);
  }
  if (result.status === "confirmed") {
    return { status: "confirmed", resultCodes: result.results.flatMap((r) => (r.code ? [r.code] : [])) };
  }
  if (result.status === "failed" && "error" in result) return { status: "failed", error: result.error };
  // Un esito diverso a una conferma non c'è: è di un server che non conosco.
  return { status: "failed", error: result.status };
};

const ignoreMailProposal: Mail["ignoreMailProposal"] = async (id) => {
  await decide(() => appClient().mail.ignoreProposal(id));
};

/** «Passa al progetto»: la decide chi nel progetto ha i permessi di ogni azione. */
const handMailProposal: Mail["handMailProposal"] = async (id) => {
  await decide(() => appClient().mail.handProposal(id));
};

/** «Sposta su un altro progetto»: la proposta nuova, sul progetto scelto, è in analisi. */
const reassignMailProposal: Mail["reassignMailProposal"] = async (id, projectId) => {
  await decide(() => appClient().mail.reassignProposal(id, projectId));
};

/** «Quale progetto?»: come «Sposta», sul progetto scelto fra quelli incerti. */
const chooseProjectFor: Mail["chooseProjectFor"] = async (id, projectId) => {
  await decide(() => appClient().mail.chooseProposalProject(id, projectId));
};

export const mailProposalFunctions: Partial<Mail> = {
  listMailProposals,
  getMailProposal,
  listMailDecisions,
  confirmMailProposal,
  ignoreMailProposal,
  handMailProposal,
  reassignMailProposal,
  chooseProjectFor,
};
