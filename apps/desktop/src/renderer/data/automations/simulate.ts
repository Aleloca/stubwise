import {
  advance,
  initialState,
  type EngineInput,
  type EngineStep,
} from "../../domain/automations/engine";
import { stepAt } from "../../domain/automations/fields";
import type { FlowIssue } from "../../domain/automations/validate";
import { onBeforePersonaChange } from "../session";
import { copy, gate, now, onStoreReset } from "../store";
import type { Automation, SimulationView } from "../types";
import { forbidden, invalid, notFound, writer } from "../writer";
import { resolveProject } from "./plans";
import { configErrorsOf } from "./reads";
import { NO_APPROVER_REASON } from "./runner";
import {
  approvalProjectOf,
  approversFor,
  automationById,
  canManageAutomation,
  canSeeAutomation,
} from "./visibility";
import { checkEdited } from "./runWrites";
import { execute, TERMINAL, type Sim } from "./simulateExecute";
import { projectChoices, view } from "./simulateView";

// La prova di un'automazione (area 7): lo STESSO motore delle esecuzioni
// (`advance`), con un esecutore finto che produce anteprime e non scrive
// MAI nello store — nessuna task, traguardo, richiesta, email, notifica,
// esecuzione, riga di registro vera, né un contatore che si muove.
//
// - Le anteprime usano i piani dell'esecutore vero (`plans.ts`): stesso
//   incaricato, stesso progetto (tabella cliente → progetto compresa),
//   stessi testi, stessa casella; e dove la vera fallirebbe, la prova
//   fallisce allo stesso passo con lo stesso codice e la stessa motivazione.
//   Claude risponde col Claude finto delle esecuzioni.
// - Non corre da sola: si avanza solo con «Passo successivo» (`next`: un
//   effetto) o «Vai alla prossima fermata» (`run`), e si sblocca dalle
//   fermate con gli input del motore (approvazione, risposta, tempo,
//   progetto scelto). Approva chi prova, a nome suo; la fermata dice chi
//   approverebbe davvero.
// - «Avvia un'altra automazione» dice solo che partirebbe: non ne percorre
//   i passi.
// - Chi vede ma non gestisce non prova; un flusso con errori di
//   configurazione non parte (`SimulationConfigError`, con l'elenco).
// - Le prove stanno in memoria, per persona; si buttano con
//   `endSimulation`, con `resetApi` e col cambio di persona. Mai salvate:
//   l'unica traccia è `testedRev` sulla versione provata fino in fondo
//   (R-J19), che dice ad «Accendi»/«Pubblica» se è stata provata.

/** La prova non parte: il flusso ha errori di configurazione (`issues` dice dove). */
export class SimulationConfigError extends Error {
  constructor(readonly issues: FlowIssue[]) {
    super("invalid: config");
  }
}

/** Un input della prova: «Passo successivo», «Vai alla prossima fermata», o un input del motore. */
export type SimulationInput = EngineInput | { kind: "next" } | { kind: "run" };

const sims = new Map<string, Sim>();
let seq = 0;
onStoreReset(() => sims.clear());
onBeforePersonaChange(() => sims.clear());

// --- il motore ----------------------------------------------------------------------

/** Scrive nella prova un passo del motore; il progetto del cliente si cerca subito (non è un passo). */
function apply(sim: Sim, a: Automation, r: EngineStep): void {
  for (const row of r.log) sim.log.push({ at: r.state.now, ...copy(row), effects: blank(row) });
  // Un input che il motore ignora (es. `time` mentre un effetto aspetta)
  // non chiede di nuovo l'effetto: quello in sospeso resta finché il motore
  // lo aspetta, o la prova non avanzerebbe più.
  const stillAwaited =
    r.state.status === "running" &&
    (r.state.awaiting?.kind === "effect" || r.state.awaiting?.kind === "claude") &&
    sim.pending?.path === r.state.awaiting.path;
  sim.engine = r.state;
  for (const [path, items] of Object.entries(r.state.loops)) sim.loopItems[path] = copy(items);
  sim.pending = r.effects[0] ?? (stillAwaited ? sim.pending : null);
  if (sim.pending?.kind === "resolve_project") {
    const eff = sim.pending;
    sim.pending = null;
    return apply(sim, a, advance(sim.engine, resolveProject(eff, sim.ownerId).input));
  }
  failIfNoApprover(sim, a);
}

/** Nel registro della prova nessun codice: non nasce niente. */
const blank = (row: EngineStep["log"][number]) =>
  row.effects.map((x) => ({ kind: x.kind, code: "" }));

/** R-J11 come nell'esecuzione vera: un'approvazione che nessuno può dare fallisce `no_approver`. */
function failIfNoApprover(sim: Sim, a: Automation): void {
  const st = sim.engine;
  const aw = st.awaiting;
  if (st.status !== "waiting_approval" || aw?.kind !== "approval") return;
  if (approversFor(a, aw.who, approvalProjectOf(aw.preview, a)).length > 0) return;
  const step = stepAt(st.flow.steps, aw.path);
  sim.log.push({
    at: st.now,
    stepId: step?.id ?? "trigger",
    path: aw.path,
    kind: step?.kind ?? "trigger",
    input: copy(aw.preview),
    output: {},
    reason: NO_APPROVER_REASON,
    byId: null,
    effects: [],
    outcome: "failed",
  });
  sim.engine = {
    ...st,
    status: "failed",
    error: "no_approver",
    awaiting: null,
    waitingUntil: null,
  };
}

/** «Passo successivo»: l'effetto in sospeso, eseguito per finta. */
function stepOnce(sim: Sim, a: Automation): void {
  if (TERMINAL.has(sim.engine.status)) throw invalid("finished");
  // Ferma (attesa, approvazione, progetto): il motore non chiede effetti.
  const eff = sim.pending;
  if (!eff) throw invalid("stopped");
  sim.pending = null;
  apply(sim, a, advance(sim.engine, execute(sim, a, eff)));
}

function handle(me: string, sim: Sim, a: Automation, input: SimulationInput): void {
  const st = sim.engine;
  switch (input.kind) {
    case "next":
      return stepOnce(sim, a);
    case "run":
      stepOnce(sim, a);
      while (sim.pending) stepOnce(sim, a);
      return;
    case "approved":
    case "rejected": {
      if (st.status !== "waiting_approval" || st.cursor === null) throw invalid("not_waiting");
      // Nella prova approva chi prova, a nome suo, e il passo è quello che aspetta.
      if (input.kind === "approved" && input.edited) {
        checkEdited(stepAt(st.flow.steps, st.cursor)?.kind, input.edited);
      }
      const decided =
        input.kind === "approved"
          ? {
              kind: "approved" as const,
              path: st.cursor,
              byId: me,
              ...(input.edited ? { edited: { ...input.edited } } : {}),
            }
          : { kind: "rejected" as const, path: st.cursor, byId: me };
      return apply(sim, a, advance(st, decided));
    }
    case "project_chosen": {
      if (st.status !== "waiting_project") throw invalid("not_waiting");
      // Come nell'esecuzione vera, un progetto che il proprietario vede; e che vede chi prova (R-G5).
      if (!projectChoices(me, sim.ownerId).some((p) => p.id === input.projectId)) throw notFound();
      return apply(sim, a, advance(st, { ...input, byId: me }));
    }
    case "event":
      if (st.status !== "waiting_event") throw invalid("not_waiting");
      return apply(sim, a, advance(st, input));
    case "time":
      // «Avanti» vale solo per un'attesa: altrove il tempo della prova non si sposta.
      if (st.status !== "waiting_event") throw invalid("not_waiting");
      if (Number.isNaN(Date.parse(input.now))) throw invalid("time");
      return apply(sim, a, advance(st, input));
    default:
      // Gli esiti degli effetti e di Claude li produce solo l'esecutore finto.
      throw invalid("input");
  }
}

/**
 * R-J19: una prova finita bene segna la revisione provata sulla versione —
 * se è ancora quella provata (una bozza salvata nel frattempo ha un `rev`
 * nuovo, e la prova non vale per lei). È l'unica scrittura della prova.
 */
function markTested(sim: Sim): void {
  const v = automationById(sim.automationId)?.versions.find((x) => x.n === sim.version);
  if (v && (v.rev ?? null) === sim.rev) v.testedRev = sim.rev;
}

// --- l'api --------------------------------------------------------------------------

/** La prova di chi agisce, con l'automazione vista dal proprietario che avrebbe. */
function mine(me: string, id: string): { sim: Sim; a: Automation } {
  const sim = sims.get(id);
  const a = sim ? automationById(sim.automationId) : undefined;
  if (!sim || sim.personId !== me || !a || !canSeeAutomation(me, a)) throw notFound();
  if (!canManageAutomation(me, a)) throw forbidden();
  return { sim, a: { ...a, ownerId: sim.ownerId } };
}

/**
 * Comincia la prova di una versione (`"draft"`: la bozza) su un evento
 * d'esempio. La prova si ferma subito sul primo passo che farebbe qualcosa.
 * Solo chi gestisce l'automazione; con errori di configurazione non parte
 * (`SimulationConfigError`). Il proprietario della prova è chi lo
 * diventerebbe: per una bozza chi prova (accenderla o pubblicarla lo fa
 * proprietario), per una versione pubblicata quello di adesso.
 */
export async function startSimulation(
  automationId: string,
  version: number | "draft",
  event: Record<string, unknown>,
): Promise<string> {
  const me = await writer("automations.startSimulation");
  const found = automationById(automationId);
  if (!found || !canSeeAutomation(me, found)) throw notFound();
  if (!canManageAutomation(me, found)) throw forbidden();
  const last = found.versions.at(-1)!;
  const v =
    version === "draft"
      ? last.publishedAt === null
        ? last
        : undefined
      : found.versions.find((x) => x.n === version);
  if (!v) throw invalid(version === "draft" ? "no_draft" : "version");
  if (event === null || typeof event !== "object" || Array.isArray(event)) throw invalid("event");
  const draft = v.publishedAt === null;
  const ownerId = draft ? me : (found.ownerId ?? me);
  const issues = configErrorsOf(found, v.flow, ownerId);
  if (issues.length > 0) throw new SimulationConfigError(issues);
  const a = { ...found, ownerId };
  const flow = copy(v.flow);
  const sim: Sim = {
    id: `sim-${++seq}`,
    personId: me,
    automationId: a.id,
    version: v.n,
    rev: v.rev ?? null,
    draft,
    ownerId,
    event: copy(event),
    engine: initialState(flow, now()),
    loopItems: {},
    pending: null,
    log: [],
    milestoneRefs: new Map(),
    preview: {
      tasks: [],
      milestones: [],
      requests: [],
      emails: [],
      notifications: [],
      starts: [],
      claude: [],
    },
  };
  apply(sim, a, advance(sim.engine, { kind: "start", event: copy(event) }));
  // Un flusso che con questo esempio non fa niente finisce già qui: è finito bene.
  if (sim.engine.status === "done") markTested(sim);
  sims.set(sim.id, sim);
  return sim.id;
}

/**
 * Fa avanzare la prova: `next` esegue per finta l'effetto in sospeso, `run`
 * va fino alla prossima fermata (attesa, approvazione, progetto, fine,
 * errore); gli input del motore sbloccano le fermate (`approved`/`rejected`
 * a nome di chi prova, `event` con la risposta scritta, `time` per
 * «Avanti», `project_chosen`). Restituisce la prova aggiornata.
 */
export async function simulationStep(id: string, input: SimulationInput): Promise<SimulationView> {
  const me = await writer("automations.simulationStep");
  const { sim, a } = mine(me, id);
  const was = sim.engine.status;
  handle(me, sim, a, input);
  if (was !== "done" && sim.engine.status === "done") markTested(sim);
  return view(me, sim, a);
}

/** La prova; `null` se non c'è (buttata, di un'altra persona, o di un'automazione che non gestisco). */
export async function getSimulation(id: string): Promise<SimulationView | null> {
  const me = await gate("automations.getSimulation");
  try {
    const { sim, a } = mine(me, id);
    return view(me, sim, a);
  } catch {
    return null;
  }
}

/** Butta la prova: non lascia traccia. */
export async function endSimulation(id: string): Promise<void> {
  const me = await writer("automations.endSimulation");
  mine(me, id);
  sims.delete(id);
}
