import { createContext, useContext } from "react";
import { stepAt } from "../../../domain/automations/fields";
import type { FlowIssue } from "../../../domain/automations/validate";
import type {
  AutomationFlow,
  AutomationRow,
  AutomationSourceView,
  DataField,
  Step,
} from "../../../data/types";
import type { Names } from "../format";

// Lo stato del costruttore che righe, pannello e campi condividono: il
// flusso che si modifica (la bozza locale, salvata da sola), la selezione,
// gli errori di `validateFlow` (via `checkDraft`) già legati ai passi per id.

export interface BuilderState {
  automation: AutomationRow;
  flow: AutomationFlow;
  /** Ogni modifica passa da qui: la bozza si salva da sola ([A 8]). */
  update(next: (flow: AutomationFlow) => AutomationFlow): void;
  readOnly: boolean;
  names: Names;
  sources: AutomationSourceView[];
  /** Le automazioni che chi costruisce vede (per «Start another automation» e i loro codici). */
  otherAutomations: AutomationRow[];
  /** Le etichette di tutti i dati del flusso, per chiave. */
  labels: Map<string, DataField>;
  /** Percorso → numero 1…N ([A 6]). */
  numbers: Map<string, number>;
  /** Id del passo → percorso, nel flusso di adesso. */
  paths: Map<string, string>;
  /** Gli errori per passo (id), dell'inizio e del flusso intero. */
  issues: {
    byStep: Map<string, FlowIssue[]>;
    start: FlowIssue[];
    flow: FlowIssue[];
    total: number;
  };
  /** Il passo selezionato (id), "trigger" per l'inizio, null = nessuno (il pannello mostra l'inizio). */
  selected: string | null;
  select(id: string | null, opts?: { focusPanel?: boolean }): void;
  /** I blocchi chiusi (per id), preferenza della vista. */
  collapsed: ReadonlySet<string>;
  toggleCollapsed(id: string, open?: boolean): void;
  /** Aggiungere un passo in una corsia, alla posizione data (apre il menu dei passi). */
  requestAdd(lane: string, index: number, anchor: HTMLElement | null): void;
  /** Eliminare un passo (con conferma se è un blocco con passi dentro). */
  requestDelete(id: string): void;
  duplicate(id: string): void;
  /** «Move to…»: il dialogo con l'albero delle corsie. */
  requestMoveTo(id: string): void;
  move(id: string, dir: -1 | 1): void;
  announce(text: string): void;
}

export const BuilderContext = createContext<BuilderState | null>(null);

export function useBuilder(): BuilderState {
  const ctx = useContext(BuilderContext);
  if (!ctx) throw new Error("useBuilder outside the builder");
  return ctx;
}

/** Il passo selezionato e il suo percorso, se c'è. */
export function selectedStep(b: BuilderState): { step: Step; path: string } | null {
  if (b.selected === null || b.selected === "trigger") return null;
  const path = b.paths.get(b.selected);
  const step = path === undefined ? null : stepAt(b.flow.steps, path);
  return step && path !== undefined ? { step, path } : null;
}
