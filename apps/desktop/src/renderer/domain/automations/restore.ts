import type { AutomationFlow, AutomationRun, Step } from "../../data/types";
import { initialState, type EngineState, type ResolvedTarget } from "./engine";
import { joinPath, repeatCap, stepAt } from "./fields";
import { describe, projectOf, resolve, show } from "./preview";

type SavedRun = Pick<
  AutomationRun,
  "event" | "vars" | "cursor" | "status" | "waitingUntil" | "log"
> & {
  /** `EngineState.loops`, se salvato: gli elementi dei `forEach` fissati all'ingresso. */
  loops?: Record<string, unknown[]>;
  /** `EngineState.projects`, se salvato: i clienti → progetti già risolti. */
  projects?: Record<string, string>;
};

const ACTION_KINDS = new Set<Step["kind"]>([
  "createTask",
  "createMilestone",
  "createRequest",
  "sendEmail",
  "notify",
  "startAutomation",
]);

/**
 * Lo stato di un'esecuzione salvata, ricostruito dal cursore (R-J5): le
 * liste, i giri dei cicli, cosa aspetta, i contatori dal registro.
 * - `waiting_*`: aspetta lo stesso input di prima (`waiting_event` vuole
 *   `waitingUntil`, altrimenti lancia).
 * - `done`/`cancelled`: restano finite.
 * - `failed` (per «Riprova»), `suspended`, `running`: tornano `running` e
 *   il passo del cursore riparte al prossimo input (anche solo `time`).
 * Gli elementi di un `forEach` vengono da `loops` se c'è, altrimenti dalle
 * variabili: coincidono, perché `validateFlow` vieta di ridichiarare
 * l'elenco dentro il suo ciclo.
 */
export function restoreState(flow: AutomationFlow, run: SavedRun, now: string): EngineState {
  const st = initialState(flow, now);
  st.started = true;
  st.event = structuredClone(run.event);
  st.vars = structuredClone(run.vars);
  st.loops = structuredClone(run.loops ?? {});
  st.projects = structuredClone(run.projects ?? {});
  for (const e of run.log) {
    const done = e.outcome === "ok" || e.outcome === "failed";
    if (e.kind === "sendEmail" && e.outcome === "ok") st.emailsSent++;
    if (done && (ACTION_KINDS.has(e.kind as Step["kind"]) || e.kind === "claude")) st.effectsSent++;
    if (e.effects.length > 0) st.created[e.stepId] = e.effects.map((x) => x.code);
  }
  if (run.status === "done" || run.status === "cancelled" || run.cursor === null) {
    st.status = run.status;
    st.cursor = run.cursor;
    return st;
  }
  if (run.status === "waiting_event" && run.waitingUntil === null) {
    throw new Error("Un'esecuzione in attesa di un evento senza scadenza");
  }
  const waiting = run.status.startsWith("waiting_");
  const segs = run.cursor.split("/");
  let base = "";
  let path = "";
  let step: Step | null = null;
  for (let k = 0; k < segs.length; k += 2) {
    const i = Number(segs[k]);
    const last = k === segs.length - 1;
    path = joinPath(base, String(i));
    step = stepAt(flow.steps, path);
    if (!step) throw new Error(`Percorso non valido: ${run.cursor}`);
    // Il passo del cursore: già iniziato se si aspetta, da rieseguire altrimenti.
    st.stack.push({ t: "list", base, i: last && !waiting ? i : i + 1 });
    if (last) break;
    const seg = segs[k + 1]!;
    const round = /\[(\d+)\]$/.exec(seg);
    if (step.kind === "forEach") {
      const found = st.loops[path] ?? resolve(st, step.list);
      const items = Array.isArray(found) ? found : [];
      // Riscritti in `loops`: la prossima ripresa li rilegge da lì.
      st.loops[path] = items;
      st.stack.push({
        t: "forEach",
        path,
        as: step.as,
        items,
        current: Number(round![1]),
      });
    } else if (step.kind === "repeatUntil") {
      st.stack.push(
        seg === "onLimit"
          ? { t: "repeat", path, round: repeatCap(step.max), onLimit: true }
          : { t: "repeat", path, round: Number(round![1]) + 1, onLimit: false },
      );
    }
    base = joinPath(path, seg);
  }
  st.cursor = run.cursor;
  if (!waiting) return st;

  st.status = run.status;
  if (run.status === "waiting_event" && step!.kind === "wait") {
    st.waitingUntil = run.waitingUntil;
    st.awaiting = { kind: "wait", path, until: run.waitingUntil! };
  } else if (
    run.status === "waiting_approval" &&
    "approval" in step! &&
    step.approval.mode === "ask"
  ) {
    const target = projectOf(step);
    const projectId = run.log.at(-1)?.input.progetto;
    const resolved: ResolvedTarget | null =
      target?.mode === "from_client"
        ? typeof projectId === "string"
          ? { mode: "fixed", projectId }
          : null
        : target;
    if (target?.mode === "from_client" && resolved?.mode === "fixed") {
      st.projects[show(resolve(st, target.clientRef))] = resolved.projectId;
    }
    st.awaiting = {
      kind: "approval",
      path,
      who: step.approval.who,
      preview: describe(st, step, resolved).preview,
    };
  } else if (run.status === "waiting_project" && "approval" in step!) {
    const target = projectOf(step);
    const clientKey = target?.mode === "from_client" ? show(resolve(st, target.clientRef)) : "";
    st.awaiting = { kind: "project", path, clientKey, asked: true };
  } else {
    throw new Error(`Stato ${run.status} incoerente col passo ${path}`);
  }
  return st;
}
