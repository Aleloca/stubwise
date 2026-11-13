import { gate, onStoreReset } from "../store";
import { onBeforePersonaChange } from "../session";
import { visiblePeopleFor } from "../access/whoCan";
import type { Automation, SimulationView, TrialOutcome } from "../types";
import { forbidden, invalid, notFound, writer } from "../writer";
import {
  SimulationConfigError,
  TERMINAL,
  type Sim,
  type SimulationInput,
} from "../../domain/automations/simCore";
import { simulator } from "./simulateExecute";
import { approvalProjectOf, automationById, canManageAutomation, canSeeAutomation } from "./visibility";

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

export { SimulationConfigError, type SimulationInput };

const sims = new Map<string, Sim>();
let seq = 0;
onStoreReset(() => sims.clear());
onBeforePersonaChange(() => sims.clear());

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
  return startSimulationAs(me, automationId, version, event);
}

/** La forma sincrona di `startSimulation` (area 10b: la prova di Claude). */
export function startSimulationAs(
  me: string,
  automationId: string,
  version: number | "draft",
  event: Record<string, unknown>,
): string {
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
  const draft = v.publishedAt === null;
  const ownerId = draft ? me : (found.ownerId ?? me);
  const sim = simulator.start(me, `sim-${++seq}`, found, v, event, ownerId);
  // Un flusso che con questo esempio non fa niente finisce già qui: è finito bene.
  if (simulator.finishedWell(sim)) markTested(sim);
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
  simulator.handle(me, sim, a, input);
  if (was !== "done" && simulator.finishedWell(sim)) markTested(sim);
  return simulator.view(me, sim, a);
}

/**
 * La prova di Claude (area 10b): avvia la prova della bozza su `event` e la
 * porta alla prima fermata come «Vai alla prossima fermata» (`run`), mai
 * oltre. Claude non approva e non rifiuta (`approved`/`rejected` qui non ci
 * sono), e non esegue un passo di Claude: si ferma prima, e lo dice
 * (`stoppedAtClaude`). Non scrive niente: la prova resta in `sims` (il
 * costruttore la apre) e, finita bene, segna `testedRev` come quella a mano.
 */
export function trialAs(
  me: string,
  automationId: string,
  event: Record<string, unknown>,
  example?: NonNullable<SimulationView["claudeExample"]>,
): TrialOutcome {
  const simId = startSimulationAs(me, automationId, "draft", event);
  const { sim, a } = mine(me, simId);
  if (example) sims.get(simId)!.claudeExample = { ...example };
  const was = sim.engine.status;
  while (sim.pending && sim.pending.kind !== "claude") simulator.stepOnce(sim, a);
  if (was !== "done" && simulator.finishedWell(sim)) markTested(sim);
  const aw = sim.engine.awaiting;
  // Chi approverebbe davvero, se chi chiede lo vede (R-G5).
  const approverId =
    sim.engine.status === "waiting_approval" && aw?.kind === "approval"
      ? (simulator.approversFor(a, aw.who, approvalProjectOf(aw.preview, a)).find((id) =>
          visiblePeopleFor(me).has(id),
        ) ?? null)
      : null;
  const p = sim.preview;
  return {
    simId,
    status: sim.filteredOut ? "filtered_out" : sim.engine.status,
    tasks: p.tasks.length,
    notifications: p.notifications.length,
    emails: p.emails.length,
    requests: p.requests.length,
    milestones: p.milestones.length,
    approverId,
    stoppedAtClaude: !TERMINAL.has(sim.engine.status) && sim.pending?.kind === "claude",
  };
}

/** La prova; `null` se non c'è (buttata, di un'altra persona, o di un'automazione che non gestisco). */
export async function getSimulation(id: string): Promise<SimulationView | null> {
  const me = await gate("automations.getSimulation");
  try {
    const { sim, a } = mine(me, id);
    return simulator.view(me, sim, a);
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
