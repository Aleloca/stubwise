import {
  availableFields,
  childLists,
  joinPath,
  stepAt,
  visitSteps,
} from "../../../domain/automations/fields";
import { templateRefs } from "../../../domain/automations/validate";
import type { AutomationFlow, AutomationSource, Condition, Step } from "../../../data/types";

// Le operazioni del costruttore sull'albero dei passi (shape builder §4–§6):
// pure, su copie, coi percorsi di R-J5 (i giri al giro 0). Le usano le
// righe, la tastiera, il trascinamento e «Move to…»: un solo posto decide
// dove può andare un passo.
//
// - Una **corsia** è una lista di passi: "" per i passi principali, poi
//   `<percorso del blocco>/<segmento>` (`then`, `else`, un'uscita di Claude,
//   `forEach[0]`, `repeat[0]`, `onLimit`).
// - **Profondità** di una corsia: quanti blocchi la contengono (0 = i passi
//   principali). Al massimo 5 ([A 7]): un blocco può stare solo in una
//   corsia da cui i suoi rami non superano il quinto livello.

/** Il quinto livello è l'ultimo: lì dentro solo passi senza rami. */
export const MAX_DEPTH = 5;

export type BlockKind = "condition" | "claude" | "forEach" | "repeatUntil";
const BLOCKS: ReadonlySet<Step["kind"]> = new Set([
  "condition",
  "claude",
  "forEach",
  "repeatUntil",
]);
export const isBlock = (kind: Step["kind"]) => BLOCKS.has(kind);

/** I numeri 1…N nell'ordine di lettura, su tutto l'albero ([A 6]): percorso → numero. */
export function stepNumbers(steps: Step[]): Map<string, number> {
  const out = new Map<string, number>();
  visitSteps(steps, (_, path) => out.set(path, out.size + 1));
  return out;
}

/** Il numero di ogni passo per id (stabile mentre i percorsi cambiano). */
export function numbersById(steps: Step[]): Map<string, number> {
  const out = new Map<string, number>();
  visitSteps(steps, (s) => out.set(s.id, out.size + 1));
  return out;
}

/** Il percorso di ogni passo per id. */
export function pathsById(steps: Step[]): Map<string, string> {
  const out = new Map<string, string>();
  visitSteps(steps, (s, path) => out.set(s.id, path));
  return out;
}

/** La corsia e la posizione di un passo: "2/then/0" → { lane: "2/then", index: 0 }. */
export function placeOf(path: string): { lane: string; index: number } {
  const segs = path.split("/");
  const index = Number(segs.pop());
  return { lane: segs.join("/"), index };
}

/** Quanti blocchi contengono una corsia. */
export const laneDepth = (lane: string) =>
  lane === "" ? 0 : lane.split("/").filter((s) => !/^\d+$/.test(s)).length;

/** Quanti livelli di rami porta con sé un passo (0 per un passo semplice). */
export function heightOf(step: Step): number {
  const lists = childLists(step);
  if (lists.length === 0) return 0;
  return 1 + Math.max(0, ...lists.flatMap((l) => l.steps.map(heightOf)));
}

/** Il passo può stare in una corsia di quella profondità senza superare il quinto livello. */
export const fits = (step: Step, depth: number) => depth + heightOf(step) <= MAX_DEPTH;

/** La lista vera (modificabile) di una corsia; per un'uscita di Claude la crea se manca. */
function mutableLane(steps: Step[], lane: string): Step[] {
  if (lane === "") return steps;
  const segs = lane.split("/");
  const seg = segs.pop()!;
  const block = stepAt(steps, segs.join("/"));
  if (!block) throw new Error(`no block at ${lane}`);
  switch (block.kind) {
    case "condition":
      if (seg === "then" || seg === "else") return block[seg];
      break;
    case "claude":
      if (block.outcomes.includes(seg)) return (block.branches[seg] ??= []);
      break;
    case "forEach":
      return block.steps;
    case "repeatUntil":
      return seg === "onLimit" ? block.onLimit : block.steps;
  }
  throw new Error(`no lane ${lane}`);
}

/** Un passo in più nella corsia, alla posizione data. */
export function insertAt(steps: Step[], lane: string, index: number, step: Step): Step[] {
  const out = structuredClone(steps);
  mutableLane(out, lane).splice(index, 0, step);
  return out;
}

/** Toglie il passo al percorso (con tutti i suoi rami). */
export function removeAt(steps: Step[], path: string): { steps: Step[]; removed: Step } {
  const out = structuredClone(steps);
  const { lane, index } = placeOf(path);
  const [removed] = mutableLane(out, lane).splice(index, 1);
  if (!removed) throw new Error(`no step at ${path}`);
  return { steps: out, removed };
}

/** Sostituisce il passo al percorso. */
export function replaceAt(steps: Step[], path: string, step: Step): Step[] {
  const out = structuredClone(steps);
  const { lane, index } = placeOf(path);
  mutableLane(out, lane)[index] = step;
  return out;
}

/** Ogni punto in cui si può mettere un passo, nell'ordine di lettura. */
export function insertionPoints(steps: Step[]): { lane: string; index: number; depth: number }[] {
  const out: { lane: string; index: number; depth: number }[] = [];
  const walk = (list: Step[], lane: string) => {
    const depth = laneDepth(lane);
    out.push({ lane, index: 0, depth });
    list.forEach((s, i) => {
      const path = joinPath(lane, String(i));
      for (const child of childLists(s)) walk(child.steps, joinPath(path, child.seg));
      out.push({ lane, index: i + 1, depth });
    });
  };
  walk(steps, "");
  return out;
}

/**
 * ↑/↓ in modalità presa, ⌥↑/⌥↓ ([A 13], [A 14]): una posizione alla volta
 * nell'ordine di lettura, entrando e uscendo dalle corsie. Le posizioni dove
 * il passo supererebbe il quinto livello si saltano. `null` = è già in cima
 * (o in fondo).
 */
export function moveByOne(
  steps: Step[],
  path: string,
  dir: -1 | 1,
): { steps: Step[]; path: string } | null {
  const { steps: without, removed } = removeAt(steps, path);
  const here = placeOf(path);
  const points = insertionPoints(without).filter((p) => fits(removed, p.depth));
  const at = points.findIndex((p) => p.lane === here.lane && p.index === here.index);
  const to = points[at + dir];
  if (at < 0 || !to) return null;
  return {
    steps: insertAt(without, to.lane, to.index, removed),
    path: joinPath(to.lane, String(to.index)),
  };
}

/**
 * Dove lasciare un passo trascinato o spostato con «Move to…», detto coi
 * passi e non coi percorsi (che cambiano togliendo il passo): prima o dopo
 * un passo, o in una corsia di un blocco (in fondo o alla posizione data).
 */
export type DropTarget =
  | { before: string }
  | { after: string }
  | { block: string | null; seg: string; index?: number };

/** Il percorso della corsia di un blocco (per id; null = i passi principali). */
function laneOfBlock(steps: Step[], block: string | null, seg: string): string | null {
  if (block === null) return "";
  const path = pathsById(steps).get(block);
  return path === undefined ? null : joinPath(path, seg);
}

/** Sposta il passo `path` a `target`; null se il posto non esiste, è dentro sé stesso o troppo profondo. */
export function moveTo(
  steps: Step[],
  path: string,
  target: DropTarget,
): { steps: Step[]; path: string } | null {
  const moving = stepAt(steps, path);
  if (!moving) return null;
  const inside = new Set<string>();
  visitSteps([moving], (s) => inside.add(s.id));
  const anchor =
    "before" in target ? target.before : "after" in target ? target.after : target.block;
  if (anchor !== null && inside.has(anchor)) return null;
  const { steps: without, removed } = removeAt(steps, path);
  let lane: string | null;
  let index: number;
  if ("before" in target || "after" in target) {
    const p = pathsById(without).get(anchor!);
    if (p === undefined) return null;
    const place = placeOf(p);
    lane = place.lane;
    index = place.index + ("after" in target ? 1 : 0);
  } else {
    lane = laneOfBlock(without, target.block, target.seg);
    if (lane === null) return null;
    const list = target.block === null ? without : mutableLane(structuredClone(without), lane);
    index = Math.min(target.index ?? list.length, list.length);
  }
  if (!fits(removed, laneDepth(lane))) return null;
  return { steps: insertAt(without, lane, index, removed), path: joinPath(lane, String(index)) };
}

// --- passi nuovi e copie ----------------------------------------------------------

/** Un id nuovo, diverso da tutti quelli del flusso. */
export function freshId(steps: Step[], taken: Set<string> = new Set()): string {
  visitSteps(steps, (s) => taken.add(s.id));
  let n = taken.size + 1;
  while (taken.has(`st-${n}`)) n += 1;
  taken.add(`st-${n}`);
  return `st-${n}`;
}

/** Una condizione nuova: un gruppo «tutte» con un confronto vuoto (un solo livello di gruppo, [A 18]). */
export const emptyCondition = (): Condition => ({ all: [{}] });

/**
 * Un passo nuovo del tipo scelto: i campi obbligatori vuoti (sono già
 * problemi «Incomplete», così non si dimenticano); «Send an email» nasce
 * con «Asks the owner» ([A 15]), gli altri «Runs by itself»; «Repeat until»
 * nasce a 3 giri. «Where» di base: il progetto dell'automazione, o del
 * cliente per le generali ([A 19]).
 */
export function newStep(kind: Step["kind"], id: string, general: boolean): Step {
  const auto = { mode: "auto" } as const;
  const project = general
    ? ({ mode: "from_client", clientRef: "" } as const)
    : ({ mode: "own" } as const);
  switch (kind) {
    case "createTask":
      return {
        id,
        kind,
        title: "",
        description: "",
        assignee: { personId: "" },
        dueInDays: null,
        project,
        milestoneRef: null,
        approval: auto,
      };
    case "createMilestone":
      return { id, kind, name: "", dueInDays: null, project, approval: auto };
    case "createRequest":
      return { id, kind, title: "", description: "", project, approval: auto };
    case "sendEmail":
      return {
        id,
        kind,
        to: "",
        subject: "",
        body: "",
        attachRefs: [],
        approval: { mode: "ask", who: { owner: true } },
      };
    case "notify":
      return { id, kind, who: { personId: "" }, text: "", approval: auto };
    case "startAutomation":
      return { id, kind, automationId: "", approval: auto };
    case "wait":
      return { id, kind, for: { days: 1 } };
    case "claude":
      return { id, kind, instruction: "", inputs: [], outcomes: [], fields: [], branches: {} };
    case "condition":
      return { id, kind, when: emptyCondition(), then: [], else: [] };
    case "forEach":
      return { id, kind, list: "", as: "", steps: [] };
    case "repeatUntil":
      return { id, kind, until: emptyCondition(), max: 3, steps: [], onLimit: [] };
  }
}

/**
 * «Duplicate» (⌘D): la copia subito sotto, con «(copy)» nel titolo, le
 * corsie intere e id nuovi; i riferimenti interni alla copia (traguardo,
 * email o task attesi) puntano ai passi copiati.
 */
export function duplicateAt(
  steps: Step[],
  path: string,
  copyLabel: string,
): { steps: Step[]; path: string } {
  const original = stepAt(steps, path);
  if (!original) throw new Error(`no step at ${path}`);
  const copy = structuredClone(original);
  const taken = new Set<string>();
  const ids = new Map<string, string>();
  visitSteps([copy], (s) => {
    const id = freshId(steps, taken);
    ids.set(s.id, id);
    s.id = id;
  });
  visitSteps([copy], (s) => {
    if (s.kind === "createTask" && s.milestoneRef)
      s.milestoneRef = ids.get(s.milestoneRef) ?? s.milestoneRef;
    if (s.kind === "wait" && "replyTo" in s.for)
      s.for = { ...s.for, replyTo: ids.get(s.for.replyTo) ?? s.for.replyTo };
    if (s.kind === "wait" && "taskClosed" in s.for)
      s.for = { ...s.for, taskClosed: ids.get(s.for.taskClosed) ?? s.for.taskClosed };
  });
  const suffix = (text: string) => `${text} ${copyLabel}`.trim();
  if (copy.kind === "createTask" || copy.kind === "createRequest") copy.title = suffix(copy.title);
  if (copy.kind === "createMilestone") copy.name = suffix(copy.name);
  if (copy.kind === "sendEmail") copy.subject = suffix(copy.subject);
  const { lane, index } = placeOf(path);
  return { steps: insertAt(steps, lane, index + 1, copy), path: joinPath(lane, String(index + 1)) };
}

// --- i dati che un passo usa ------------------------------------------------------

function conditionRefs(c: Condition, out: string[]) {
  c.all?.forEach((x) => conditionRefs(x, out));
  c.any?.forEach((x) => conditionRefs(x, out));
  for (const o of [c.left, c.right]) if (o && "ref" in o) out.push(o.ref);
}

/** Le chiavi dei dati che un passo cita (senza i suoi rami). */
export function refsOf(step: Step): string[] {
  const out: string[] = [];
  const text = (...ts: string[]) => ts.forEach((t) => out.push(...templateRefs(t)));
  switch (step.kind) {
    case "createTask":
      text(step.title, step.description);
      if (step.assignee && "personRef" in step.assignee && step.assignee.personRef)
        out.push(step.assignee.personRef);
      break;
    case "createMilestone":
      text(step.name);
      break;
    case "createRequest":
      text(step.title, step.description);
      break;
    case "sendEmail":
      text(step.to, step.subject, step.body);
      out.push(...step.attachRefs);
      break;
    case "notify":
      text(step.text);
      if ("personRef" in step.who && step.who.personRef) out.push(step.who.personRef);
      break;
    case "claude":
      text(step.instruction);
      out.push(...step.inputs);
      break;
    case "condition":
      conditionRefs(step.when, out);
      break;
    case "forEach":
      if (step.list) out.push(step.list);
      break;
    case "repeatUntil":
      conditionRefs(step.until, out);
      break;
  }
  if ("project" in step && step.project.mode === "from_client" && step.project.clientRef)
    out.push(step.project.clientRef);
  return out;
}

/** Gli id di altri passi che un passo cita (traguardo, email o task attesi). */
function stepRefsOf(step: Step): string[] {
  if (step.kind === "createTask" && step.milestoneRef) return [step.milestoneRef];
  if (step.kind === "wait" && "replyTo" in step.for) return [step.for.replyTo];
  if (step.kind === "wait" && "taskClosed" in step.for) return [step.for.taskClosed];
  return [];
}

/**
 * I passi (per id) che dopo la modifica perdono un dato che prima vedevano
 * — un riferimento che diventa «non disponibile» — o il passo che citavano
 * (eliminato). Il dialogo di eliminazione li nomina.
 */
export function brokenBy(
  before: AutomationFlow,
  after: AutomationFlow,
  sources: AutomationSource[] = [],
): string[] {
  const beforePaths = pathsById(before.steps);
  const afterIds = new Set(pathsById(after.steps).keys());
  const out: string[] = [];
  visitSteps(after.steps, (step, path) => {
    const old = beforePaths.get(step.id);
    if (old === undefined) return;
    const was = new Set(availableFields(before, old, sources).map((f) => f.key));
    const now = new Set(availableFields(after, path, sources).map((f) => f.key));
    const lost = refsOf(step).some((k) => was.has(k) && !now.has(k));
    const gone = stepRefsOf(step).some((id) => beforePaths.has(id) && !afterIds.has(id));
    if (lost || gone) out.push(step.id);
  });
  return out;
}

/** Quanti passi stanno dentro un blocco (i suoi rami, a ogni livello). */
export function innerCount(step: Step): number {
  let n = -1;
  visitSteps([step], () => (n += 1));
  return n;
}
