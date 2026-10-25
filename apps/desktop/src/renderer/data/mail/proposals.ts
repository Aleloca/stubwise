import { applyActions } from "../api-mutations";
import { PEOPLE } from "../seed/people";
import { copy, gate, now, state, storeGeneration } from "../store";
import type { MailProposal, MailProposalFilters, MailProposalView, ProposedAction } from "../types";
import { can, grantProjectRole, viewerFor } from "../viewer";
import {
  canSeeMailProposal,
  isProjectMember,
  isProposalRecipient,
  permissionForAction,
} from "./visibility";

// Le proposte della posta (area 6): una per email (Message-ID) e progetto,
// condivisa fra i destinatari membri del progetto. Chi la vede lo decide
// `canSeeMailProposal` (visibility.ts); una proposta che chi agisce non vede
// è `not_found`, come una che non esiste (R-G5).
//
// Chi decide per primo la chiude per tutti: dopo `gate()` ogni scrittura
// controlla lo stato e lo cambia senza altre attese, quindi la seconda di due
// decisioni quasi insieme trova la proposta già chiusa (`already_handled`,
// con chi l'ha decisa). Una proposta passata al progetto (`handed`) resta da
// decidere, ma solo per chi ha il permesso (come `google.proposal_handed`).
// La conferma esegue le azioni con `applyActions` di `api-mutations.ts`, lo
// stesso «tutto o niente» delle proposte di Claude.

const notFound = () => new Error("not_found");
const forbidden = () => new Error("forbidden");
const invalid = (what: string) => new Error(`invalid: ${what}`);
const invalidAction = () => new Error("invalid_action");

function alreadyHandled(p: MailProposal): Error {
  return Object.assign(new Error("already_handled"), { byId: p.decidedById });
}

/** Le funzioni che una proposta della posta può eseguire. */
const MAIL_FNS: ReadonlySet<ProposedAction["fn"]> = new Set([
  "createTask",
  "updateTask",
  "addComment",
  "createRequest",
  "recordDecision",
  "createMilestone",
]);

/** Quelle che si spostano su un altro progetto (non puntano a oggetti del progetto). */
const PORTABLE_FNS: ReadonlySet<ProposedAction["fn"]> = new Set([
  "createTask",
  "createRequest",
  "recordDecision",
  "createMilestone",
]);

/** Campi che chi conferma non cambia: il progetto, l'oggetto e le parole dell'email. */
const FIXED_ARGS = new Set(["projectId", "id", "taskId", "subject", "sender", "excerpt"]);

const personName = (id: string) => PEOPLE.find((p) => p.id === id)?.name ?? id;

const isChoosing = (p: MailProposal) => p.actions.some((a) => a.fn === "chooseProject");

/** Ancora da decidere: aperta, o passata al progetto (per chi ha il permesso). */
const isPending = (p: MailProposal) => p.status === "open" || p.status === "handed";

/** Chi agisce ha nel progetto il permesso di ognuna delle azioni. */
function canDo(me: string, p: MailProposal, actions: ProposedAction[]): boolean {
  const viewer = viewerFor(me);
  return actions.every((a) => {
    const perm = permissionForAction(a.fn);
    return perm !== null && can(viewer, perm, p.projectId);
  });
}

/** Gli incaricati delle azioni che non sono nel progetto. */
function outsidersOf(p: MailProposal, actions: ProposedAction[]): string[] {
  const ids = new Set<string>();
  for (const a of actions) {
    const assignee =
      a.fn === "createTask"
        ? a.args.assigneeId
        : a.fn === "updateTask"
          ? (a.args.patch as Record<string, unknown> | undefined)?.assigneeId
          : undefined;
    if (typeof assignee === "string" && !isProjectMember(assignee, p.projectId)) ids.add(assignee);
  }
  return [...ids];
}

function canConfirmNow(me: string, p: MailProposal): boolean {
  return isPending(p) && !isChoosing(p) && canDo(me, p, p.actions);
}

/**
 * La proposta come la vede chi guarda. Di una `chooseProject` restano solo
 * i progetti di cui è membro (e le loro azioni): gli altri non li nomina.
 */
function viewOf(me: string, p: MailProposal): MailProposalView {
  const proposal = copy(p);
  for (const a of proposal.actions) {
    if (a.fn !== "chooseProject") continue;
    const ids = ((a.args.projectIds as string[] | undefined) ?? []).filter((id) =>
      isProjectMember(me, id),
    );
    const byProject = (a.args.actionsByProject ?? {}) as Record<string, ProposedAction[]>;
    a.args = {
      ...a.args,
      projectIds: ids,
      actionsByProject: Object.fromEntries(ids.map((id) => [id, byProject[id] ?? []])),
    };
  }
  const canConfirm = canConfirmNow(me, p);
  return {
    proposal,
    canConfirm,
    canHand: p.status === "open" && p.source !== "calendar" && !isChoosing(p) && !canConfirm,
    outsiders: outsidersOf(p, p.actions).map((personId) => ({
      personId,
      name: personName(personId),
    })),
    decidedBy: p.decidedById ? { personId: p.decidedById, name: personName(p.decidedById) } : null,
  };
}

function proposalFor(me: string, id: string): MailProposal {
  const p = state.mailProposals.find((x) => x.id === id);
  if (!p || !canSeeMailProposal(me, p)) throw notFound();
  return p;
}

/**
 * Il cancello di una scrittura: chi agisce, letto quando parte. Un
 * ripristino (`resetApi`) durante l'attesa la ferma prima che scriva.
 */
async function writer(fnName: Parameters<typeof gate>[0]): Promise<string> {
  const gen = storeGeneration();
  const me = await gate(fnName);
  if (gen !== storeGeneration()) throw new Error("reset");
  return me;
}

function decide(p: MailProposal, me: string, status: MailProposal["status"]): void {
  p.status = status;
  p.decidedById = me;
  p.decidedAt = now();
}

// --- letture ------------------------------------------------------------------

/** Le proposte che chi guarda vede, dalla più recente; per email (`sourceId`) e stato. */
export async function listMailProposals(
  filters: MailProposalFilters = {},
): Promise<MailProposalView[]> {
  const me = await gate("mail.listMailProposals");
  return state.mailProposals
    .filter(
      (p) =>
        (filters.sourceId === undefined || p.sourceId === filters.sourceId) &&
        (filters.status === undefined || p.status === filters.status) &&
        canSeeMailProposal(me, p),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((p) => viewOf(me, p));
}

/** Una proposta. Invisibile o inesistente → `not_found`. */
export async function getMailProposal(id: string): Promise<MailProposalView> {
  const me = await gate("mail.getMailProposal");
  return viewOf(me, proposalFor(me, id));
}

/**
 * Le proposte che aspettano chi guarda («Da decidere» della Home): le aperte
 * che vede, e le passate al progetto che può confermare. Dalla più vecchia.
 */
export async function listMailDecisions(): Promise<MailProposalView[]> {
  const me = await gate("mail.listMailDecisions");
  return state.mailProposals
    .filter(
      (p) =>
        canSeeMailProposal(me, p) &&
        (p.status === "open" || (p.status === "handed" && canConfirmNow(me, p))),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((p) => viewOf(me, p));
}

// --- scritture ----------------------------------------------------------------

/** L'esito di una conferma: i codici di ciò che è nato, o il motivo per cui non è stata eseguita. */
export type MailProposalOutcome =
  | { status: "confirmed"; resultCodes: string[] }
  | { status: "failed"; error: string };

export interface ConfirmMailProposalInput {
  /** Le azioni da eseguire (conferma parziale); senza, tutte. */
  actionIndexes?: number[];
  /** I campi cambiati prima di confermare, per indice d'azione. */
  edits?: Record<number, Partial<Record<string, unknown>>>;
  /** Gli incaricati fuori dal progetto da aggiungere come Contributor (`project.members.manage`). */
  addOutsiders?: string[];
}

/** Le azioni scelte, con le modifiche applicate. Ogni errore prima di toccare lo stato. */
function chosenActions(
  p: MailProposal,
  input: ConfirmMailProposalInput,
): { actions: ProposedAction[]; indexes: number[] | null } {
  const all = p.actions.map((_, i) => i);
  const indexes =
    input.actionIndexes === undefined
      ? all
      : [...new Set(input.actionIndexes)].sort((a, b) => a - b);
  if (indexes.length === 0 || indexes.some((i) => !Number.isInteger(i) || !p.actions[i])) {
    throw invalid("selection");
  }
  const edits = input.edits ?? {};
  for (const [key, edit] of Object.entries(edits)) {
    if (!indexes.includes(Number(key))) throw invalid("edits");
    if (Object.keys(edit).some((k) => FIXED_ARGS.has(k))) throw invalid("edits");
  }
  const actions = indexes.map((i) => {
    const action = copy(p.actions[i]!);
    action.args = { ...action.args, ...(edits[i] ?? {}) };
    return action;
  });
  return { actions, indexes: indexes.length === p.actions.length ? null : indexes };
}

/**
 * Le parole dell'email per il registro: oggetto, mittente ed estratto, letti
 * dal messaggio e dalla proposta (mai dagli argomenti del modello).
 */
function withEmailWords(p: MailProposal, actions: ProposedAction[]): ProposedAction[] {
  const message = state.mailMessages.find((m) => m.messageId === p.sourceId);
  return actions.map((a) =>
    a.fn === "recordDecision"
      ? {
          ...a,
          args: {
            ...a.args,
            projectId: p.projectId,
            subject: message?.subject ?? "",
            sender: message?.from.name ?? "",
            excerpt: p.excerpt,
          },
        }
      : a,
  );
}

/**
 * Conferma una proposta: chi ha nel progetto il permesso di ogni azione
 * scelta (altrimenti `forbidden`), finché è aperta o passata al progetto
 * (altrimenti `already_handled`, con chi l'ha decisa). Si può confermarne
 * solo una parte e cambiarne i campi. Un incaricato fuori dal progetto va
 * aggiunto (`addOutsiders`, con `project.members.manage`: entra come
 * Contributor) o tolto con una modifica, altrimenti `invalid: assignee`.
 * Le azioni girano tutte o nessuna; le persone si aggiungono solo se tutte
 * sono riuscite.
 */
export async function confirmMailProposal(
  id: string,
  input: ConfirmMailProposalInput = {},
): Promise<MailProposalOutcome> {
  const me = await writer("mail.confirmProposal");
  const p = proposalFor(me, id);
  if (!isPending(p)) throw alreadyHandled(p);
  if (p.actions.some((a) => !MAIL_FNS.has(a.fn))) throw invalidAction();
  const { actions, indexes } = chosenActions(p, input);
  if (!canDo(me, p, actions)) throw forbidden();
  const outsiders = outsidersOf(p, actions);
  const adding = [...new Set(input.addOutsiders ?? [])];
  if (adding.some((x) => !outsiders.includes(x))) throw invalid("addOutsiders");
  if (outsiders.some((x) => !adding.includes(x))) throw invalid("assignee");
  if (adding.length > 0 && !can(viewerFor(me), "project.members.manage", p.projectId)) {
    throw forbidden();
  }
  const result = applyActions(me, withEmailWords(p, actions));
  if (!result.ok) {
    decide(p, me, "failed");
    p.error = result.code;
    return { status: "failed", error: result.code };
  }
  const project = state.projectsById.get(p.projectId)!;
  for (const personId of adding) {
    project.memberIds.push(personId);
    grantProjectRole(personId, p.projectId, "contributor");
  }
  decide(p, me, "confirmed");
  p.resultCodes = result.codes;
  if (indexes) p.confirmedActions = indexes;
  return { status: "confirmed", resultCodes: [...result.codes] };
}

/**
 * Ignora una proposta, per tutti: aperta, chi la vede; passata al progetto,
 * solo chi potrebbe confermarla.
 */
export async function ignoreMailProposal(id: string): Promise<void> {
  const me = await writer("mail.ignoreProposal");
  const p = proposalFor(me, id);
  if (!isPending(p)) throw alreadyHandled(p);
  if (p.status === "handed" && !canConfirmNow(me, p)) throw forbidden();
  decide(p, me, "ignored");
}

/**
 * «Passa al progetto»: chi non può confermarla la affida a chi ha il
 * permesso nel progetto, che la vede con l'estratto (non il messaggio). Le
 * proposte di calendario e le scelte di progetto non si passano.
 */
export async function handMailProposal(id: string): Promise<void> {
  const me = await writer("mail.handProposal");
  const p = proposalFor(me, id);
  if (p.source === "calendar" || isChoosing(p)) throw invalidAction();
  if (p.status !== "open") throw alreadyHandled(p);
  if (canConfirmNow(me, p)) throw invalidAction();
  decide(p, me, "handed");
  p.handedAt = p.decidedAt;
}

/** Una proposta per email e progetto: un'altra sullo stesso progetto non nasce. */
function checkUnique(p: MailProposal, projectId: string): void {
  const taken = state.mailProposals.some(
    (x) => x !== p && x.sourceId === p.sourceId && x.projectId === projectId,
  );
  if (taken) throw invalid("duplicate");
}

/** L'email ora appartiene (anche) al progetto `projectId`. */
function labelMessage(p: MailProposal, projectId: string, drop: string | null): void {
  for (const m of state.mailMessages) {
    if (m.messageId !== p.sourceId || m.classification.state !== "done") continue;
    const c = m.classification;
    const keep = drop
      ? state.mailProposals.some(
          (x) => x !== p && x.sourceId === p.sourceId && x.projectId === drop,
        )
      : true;
    const ids = c.projectIds.filter((id) => keep || id !== drop);
    if (!ids.includes(projectId)) ids.push(projectId);
    m.classification = { ...c, projectIds: ids, uncertainProjectIds: [] };
  }
}

/**
 * Sceglie il progetto di un'email incerta: la proposta `chooseProject`
 * diventa quella del progetto scelto (le azioni già pronte per lui), e
 * l'email ne prende l'etichetta. Solo un progetto fra i candidati di cui chi
 * sceglie è membro; la seconda scelta è `already_handled`.
 */
export async function chooseProjectFor(id: string, projectId: string): Promise<void> {
  const me = await writer("mail.chooseProject");
  const p = proposalFor(me, id);
  if (p.status !== "open") throw alreadyHandled(p);
  const choose = p.actions.find((a) => a.fn === "chooseProject");
  if (!choose) {
    throw Object.assign(new Error("already_handled"), { byId: p.projectChosenById ?? null });
  }
  if (!isProjectMember(me, projectId)) throw notFound();
  const candidates = (choose.args.projectIds as string[] | undefined) ?? [];
  if (!candidates.includes(projectId)) throw invalid("project");
  const byProject = (choose.args.actionsByProject ?? {}) as Record<string, ProposedAction[]>;
  const actions = byProject[projectId] ?? [];
  if (actions.length === 0) throw invalid("project");
  checkUnique(p, projectId);
  p.projectId = projectId;
  p.actions = copy(actions);
  p.projectChosenById = me;
  labelMessage(p, projectId, null);
}

/**
 * Sposta una proposta aperta su un altro progetto di cui chi la sposta è
 * membro (solo un destinatario dell'email): task, richieste, decisioni e
 * traguardi nascono lì. Una proposta che tocca oggetti del progetto
 * (aggiornare o commentare una task) non si sposta.
 */
export async function reassignMailProposal(id: string, projectId: string): Promise<void> {
  const me = await writer("mail.reassignProposal");
  const p = proposalFor(me, id);
  if (p.source === "calendar" || isChoosing(p)) throw invalidAction();
  if (p.status !== "open") throw alreadyHandled(p);
  if (!isProposalRecipient(me, p)) throw forbidden();
  if (!isProjectMember(me, projectId)) throw notFound();
  if (projectId === p.projectId) throw invalid("project");
  if (p.actions.some((a) => !PORTABLE_FNS.has(a.fn))) throw invalidAction();
  checkUnique(p, projectId);
  const from = p.projectId;
  p.projectId = projectId;
  for (const a of p.actions) a.args = { ...a.args, projectId };
  labelMessage(p, projectId, from);
}
