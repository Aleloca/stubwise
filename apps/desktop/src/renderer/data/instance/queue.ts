import { recordChange } from "../changelog/index";
import { encodeQueue } from "../changelog/settingValues";
import type { AiBlock } from "../model";
import {
  newId,
  notifyInstanceChange,
  now,
  onStoreReset,
  state,
  storeGeneration,
  visibleProjectIds,
} from "../store";
import { writer } from "../writer";
import { aiBlockFor, budgetReached, queuePauseOf } from "./blocks";
import { canI, refuse } from "./common";
import type { InstanceResult } from "./types";

// La coda di Stubwise nel prototipo (area 9b, Task 5): i lavori che
// partirebbero ma sono fermi, e la pausa della coda di un progetto.
//
// Un lavoro fermo (`HeldJob`) aspetta su una coda in pausa (ogni avvio del
// progetto) o per il budget del mese (solo i passi d'automazione, decisione
// del maintainer del 30 ott 2026). Contiene la sua `start`, quindi sta in
// una lista del modulo, FUORI dallo stato clonabile; un ripristino
// (`resetApi`, l'istanza vuota) la svuota, e niente di ciò che aspettava
// parte più.
//
// Quando un blocco cade i lavori ripartono nell'ordine d'arrivo, ognuno una
// volta: prima di `start` si rilegge `aiBlockFor`, e se vale ancora un altro
// blocco (budget sbloccato ma coda in pausa, o il contrario) il lavoro resta
// in lista, al suo posto, col blocco nuovo. Il budget cade solo con
// `releaseBudgetHolds`, che chiamano `saveBudget` e `simulateBudgetReached`
// dopo la scrittura; la pausa con `resumeQueue`.
//
// Pause e Resume agiscono solo sulla coda di Stubwise: nessun server,
// ambiente o processo («Stubwise non fa deploy»).

export type { AiBlock } from "../model";
export { aiBlockFor, queuePauseOf } from "./blocks";

export type JobKind =
  | "task_run"
  | "correction"
  | "pr_review"
  | "server_analysis"
  | "server_fix"
  | "automation"
  | "nightly";

/**
 * Un lavoro che partirebbe ma è fermo: su una coda in pausa (ogni avvio del
 * progetto) o per il budget (solo i passi d'automazione, decisione del
 * maintainer del 30 ott 2026). `start` lo fa partire quando il blocco cade;
 * se rigetta (salvo `reset`), il lavoro diventa una ripartenza fallita con
 * il messaggio come frase (`failedHeldStarts`).
 */
export interface HeldJob {
  id: string;
  /**
   * Il progetto della coda; `null` per un passo di un'automazione generale
   * che non ha ancora agito in un progetto (lo ferma solo il budget). Lo
   * Stato dell'istanza lo mostra a chi vede l'automazione, mai fra i
   * «progetti che non vedi» (revisione finale I2).
   */
  projectId: string | null;
  kind: Exclude<JobKind, "nightly">;
  taskId: string | null;
  conversationId: string | null;
  automationRunId: string | null;
  starterId: string;
  block: AiBlock;
  since: string;
  /** `releasedBy`: chi ha ripreso la coda; `null` se è caduto il budget. */
  start: (releasedBy: string | null) => Promise<void>;
  /**
   * Il blocco è cambiato ma il lavoro resta fermo (budget tornato, coda
   * ancora in pausa; o il contrario): un passo d'automazione lo scrive nel
   * suo registro (shape EF, «Budget available again · still waiting…»).
   */
  onBlockChange?: (before: AiBlock, after: AiBlock) => void;
}

/** Un lavoro fermo la cui `start` è fallita alla ripartenza (ruling T5 I2). */
export type FailedStart = Omit<HeldJob, "start"> & { failedAt: string; summary: string };

/** I lavori fermi, nell'ordine d'arrivo. */
let held: HeldJob[] = [];
/** Le ripartenze fallite: lo Stato dell'istanza le mostra fra i lavori falliti. */
let failedStarts: FailedStart[] = [];

onStoreReset(() => {
  held = [];
  failedStarts = [];
});

const copyOf = (j: HeldJob): Omit<HeldJob, "start"> => ({
  id: j.id,
  projectId: j.projectId,
  kind: j.kind,
  taskId: j.taskId,
  conversationId: j.conversationId,
  automationRunId: j.automationRunId,
  starterId: j.starterId,
  block: { ...j.block },
  since: j.since,
});

/** Le ripartenze fallite (copie). */
export function failedHeldStarts(): FailedStart[] {
  return failedStarts.map((f) => ({ ...f, block: { ...f.block } }));
}

/** Mette in attesa un lavoro, in fondo alla fila. */
export function holdJob(job: Omit<HeldJob, "id" | "since">): HeldJob {
  const entry: HeldJob = { ...job, id: newId("held"), since: now() };
  held.push(entry);
  return entry;
}

/**
 * Il blocco del primo lavoro fermo del progetto, se ce n'è uno (rail e
 * polso: «Claude aspetta», non «Claude lavora»). Una copia.
 */
export function waitingBlockIn(projectId: string): AiBlock | null {
  const job = held.find((j) => j.projectId === projectId);
  return job ? { ...job.block } : null;
}

/** I lavori fermi adesso, nell'ordine d'arrivo (copie, senza `start`: per le letture). */
export function heldJobs(): Omit<HeldJob, "start">[] {
  return held.map(copyOf);
}

/**
 * ruling del controller (pre-flight): Stop su un lavoro in attesa (EF 2) lo
 * toglie dalla lista. Anche `start` riparte solo se la sessione è ancora in
 * attesa.
 */
export function dropHeld(conversationIdOrRunId: string): void {
  held = held.filter(
    (j) =>
      j.conversationId !== conversationIdOrRunId && j.automationRunId !== conversationIdOrRunId,
  );
}

/**
 * Rilegge i lavori fermi da `fell` (il blocco appena caduto): chi non ha più
 * blocchi esce dalla lista e parte, nell'ordine; chi ne ha un altro resta al
 * suo posto, col blocco nuovo.
 */
function release(fell: (job: HeldJob) => boolean, by: string | null): void {
  const ready: HeldJob[] = [];
  for (const job of held) {
    if (!fell(job)) continue;
    const block = aiBlockFor(job.projectId);
    if (!block) {
      ready.push(job);
      continue;
    }
    const before = job.block;
    job.block = block;
    if (before.reason !== block.reason) job.onBlockChange?.(before, block);
    // La sessione in attesa dice il blocco che vale adesso (shape EF §5).
    const session = job.conversationId
      ? state.conversations.find((c) => c.id === job.conversationId)
      : undefined;
    if (session?.waiting) session.waiting = { ...block };
  }
  if (ready.length === 0) return;
  held = held.filter((j) => !ready.includes(j));
  // Fuori dalla lista PRIMA di partire: ognuno parte una volta sola. Un avvio
  // che non riesce non ferma gli altri e non sparisce senza traccia (ruling
  // T5 I2): diventa un lavoro fallito, con la frase. Passa in silenzio solo
  // un ripristino nel frattempo (`reset`): lo stato di quel lavoro non c'è più.
  const gen = storeGeneration();
  for (const job of ready) {
    void job.start(by).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "reset" || gen !== storeGeneration()) return;
      failedStarts.push({ ...copyOf(job), failedAt: now(), summary: message });
    });
  }
}

/** Fa ripartire i lavori fermi per budget, se `budgetReached()` è falso; altrimenti non fa niente. */
export function releaseBudgetHolds(): void {
  if (budgetReached()) return;
  release((j) => j.block.reason === "monthly_budget", null);
}

const projectCode = (projectId: string): string =>
  state.projectsById.get(projectId)?.code ?? projectId;
const objectOf = (projectId: string) => ({
  type: "project",
  id: projectId,
  label: projectCode(projectId),
});

/** Mette in pausa la coda di un progetto (`settings.manage`): il lavoro nuovo aspetta, quello partito finisce. */
export async function pauseQueue(projectId: string): Promise<InstanceResult> {
  const me = await writer("instance.pauseQueue");
  if (!visibleProjectIds(me).has(projectId)) return refuse.notFound();
  if (!canI(me, "settings.manage")) return refuse.forbidden();
  if (queuePauseOf(projectId)) return refuse.invalid("already_paused");
  state.instance.queuePauses.push({ projectId, byId: me, at: now() });
  recordChange({
    kind: "queue.paused",
    actorId: me,
    projectId,
    object: objectOf(projectId),
  });
  notifyInstanceChange();
  return { ok: true };
}

/** Riprende la coda di un progetto (`settings.manage`): i lavori fermi per la pausa partono, nell'ordine. */
export async function resumeQueue(projectId: string): Promise<InstanceResult> {
  const me = await writer("instance.resumeQueue");
  if (!visibleProjectIds(me).has(projectId)) return refuse.notFound();
  if (!canI(me, "settings.manage")) return refuse.forbidden();
  const pause = queuePauseOf(projectId);
  if (!pause) return refuse.invalid("not_paused");
  state.instance.queuePauses = state.instance.queuePauses.filter((p) => p.projectId !== projectId);
  // Valori stabili (Ruling T3): «paused:<da quando>» → «running».
  recordChange({
    kind: "queue.resumed",
    actorId: me,
    projectId,
    object: objectOf(projectId),
    before: encodeQueue(pause.at),
    after: encodeQueue(null),
  });
  release((j) => j.projectId === projectId && j.block.reason === "queue_paused", me);
  notifyInstanceChange();
  return { ok: true };
}
