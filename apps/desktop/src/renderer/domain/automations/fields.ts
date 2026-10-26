import type { AutomationFlow, AutomationSource, DataField, Step } from "../../data/types";
import { START_FIELDS, STUBWISE_TRIGGER_FIELDS, WAIT_REPLY_FIELDS } from "./triggerFields";

// I percorsi (grammatica R-J5 in `model.ts`) e i dati visibili in un punto
// del flusso: li usano la validazione, il costruttore e il motore.

/** I limiti di sicurezza del motore (Global Constraints del piano). */
export const AUTOMATION_LIMITS = {
  emailsPerRun: 20,
  forEachRounds: 50,
  repeatMax: 10,
} as const;

export const joinPath = (base: string, seg: string) => (base === "" ? seg : `${base}/${seg}`);

/** Le liste figlie di un passo, col segmento che le apre (i giri al giro 0). */
export function childLists(step: Step): { seg: string; steps: Step[] }[] {
  switch (step.kind) {
    case "condition":
      return [
        { seg: "then", steps: step.then },
        { seg: "else", steps: step.else },
      ];
    case "claude":
      return step.outcomes.map((o) => ({ seg: o, steps: step.branches[o] ?? [] }));
    case "forEach":
      return [{ seg: "forEach[0]", steps: step.steps }];
    case "repeatUntil":
      return [
        { seg: "repeat[0]", steps: step.steps },
        { seg: "onLimit", steps: step.onLimit },
      ];
    default:
      return [];
  }
}

/** La lista figlia di `step` aperta dal segmento `seg`, o null. */
function childList(step: Step, seg: string): Step[] | null {
  if (step.kind === "condition" && (seg === "then" || seg === "else")) return step[seg];
  if (step.kind === "claude" && step.outcomes.includes(seg)) return step.branches[seg] ?? [];
  if (step.kind === "forEach" && /^forEach\[\d+\]$/.test(seg)) return step.steps;
  if (step.kind === "repeatUntil" && /^repeat\[\d+\]$/.test(seg)) return step.steps;
  if (step.kind === "repeatUntil" && seg === "onLimit") return step.onLimit;
  return null;
}

/** Percorre un percorso: `kind: "step"` se finisce su un passo, `"list"` su una lista. */
function walk(
  steps: Step[],
  path: string,
): { kind: "step"; step: Step } | { kind: "list"; steps: Step[] } | null {
  if (path === "") return { kind: "list", steps };
  let list: Step[] | null = steps;
  let step: Step | null = null;
  for (const seg of path.split("/")) {
    if (list) {
      if (!/^\d+$/.test(seg)) return null;
      step = list[Number(seg)] ?? null;
      if (!step) return null;
      list = null;
    } else {
      list = childList(step!, seg);
      if (!list) return null;
    }
  }
  return list ? { kind: "list", steps: list } : { kind: "step", step: step! };
}

/** Il passo a cui porta un percorso, o null. */
export function stepAt(steps: Step[], path: string): Step | null {
  const w = walk(steps, path);
  return w?.kind === "step" ? w.step : null;
}

/** La lista a cui porta un percorso ("" = i passi del flusso), o null. */
export function listAt(steps: Step[], base: string): Step[] | null {
  const w = walk(steps, base);
  return w?.kind === "list" ? w.steps : null;
}

/** Visita ogni passo dell'albero col suo percorso (giri al giro 0). */
export function visitSteps(
  steps: Step[],
  visit: (step: Step, path: string) => void,
  base = "",
): void {
  steps.forEach((step, i) => {
    const path = joinPath(base, String(i));
    visit(step, path);
    for (const child of childLists(step)) visitSteps(child.steps, visit, joinPath(path, child.seg));
  });
}

/** I dati che porta l'inizio. */
export function triggerFields(flow: AutomationFlow, sources: AutomationSource[]): DataField[] {
  const t = flow.trigger;
  switch (t.kind) {
    case "source":
      return sources.find((s) => s.id === t.sourceId)?.fields ?? [];
    case "stubwise":
      return STUBWISE_TRIGGER_FIELDS[t.event];
    case "schedule":
    case "manual":
      return START_FIELDS;
  }
}

/** I dati che un passo scrive per chi viene dopo: i campi di Claude, la risposta attesa. */
function outputsOf(step: Step): DataField[] {
  if (step.kind === "claude") return step.fields;
  if (step.kind === "wait" && "replyTo" in step.for) return WAIT_REPLY_FIELDS;
  return [];
}

/** I campi dell'elemento di un `forEach`, col prefisso `as` (R-J3). */
function itemFields(
  step: Extract<Step, { kind: "forEach" }>,
  list: DataField | undefined,
): DataField[] {
  if (list?.of) return list.of.map((f) => ({ ...f, key: `${step.as}.${f.key}` }));
  return [{ key: step.as, label: list?.label ?? step.as, type: "text" }];
}

export interface Scope {
  /** I dati visibili, per chiave (un campo ridichiarato vale col tipo più recente, R-J3). */
  fields: Map<string, DataField>;
  /** I passi già eseguiti prima di questo nel suo ramo (fratelli precedenti di ogni livello). */
  preceding: Step[];
}

/**
 * Cosa vede il passo al percorso `path`: i dati dell'inizio, gli output dei
 * passi precedenti nel ramo (i fratelli precedenti a ogni livello), i campi
 * di Claude dentro i suoi rami, la variabile di un `forEach` dentro i giri.
 * Gli output di passi annidati in un ramo fratello non contano: quel ramo
 * può non essere stato preso.
 */
export function scopeAt(
  flow: AutomationFlow,
  path: string,
  sources: AutomationSource[] = [],
): Scope {
  const fields = new Map<string, DataField>();
  const add = (fs: DataField[]) => {
    for (const f of fs) {
      fields.delete(f.key);
      fields.set(f.key, f);
    }
  };
  add(triggerFields(flow, sources));
  const preceding: Step[] = [];
  let list: Step[] | null = flow.steps;
  let step: Step | null = null;
  for (const seg of path === "" ? [] : path.split("/")) {
    if (list) {
      const i = Number(seg);
      for (const s of list.slice(0, i)) {
        preceding.push(s);
        add(outputsOf(s));
      }
      step = list[i] ?? null;
      if (!step) break;
      list = null;
    } else {
      if (step!.kind === "claude") add(step!.fields);
      if (step!.kind === "forEach") add(itemFields(step!, fields.get(step!.list)));
      list = childList(step!, seg);
      if (!list) break;
    }
  }
  return { fields, preceding };
}

/** I dati che il passo al percorso `stepPath` può usare. */
export function availableFields(
  flow: AutomationFlow,
  stepPath: string,
  sources: AutomationSource[] = [],
): DataField[] {
  return [...scopeAt(flow, stepPath, sources).fields.values()];
}
