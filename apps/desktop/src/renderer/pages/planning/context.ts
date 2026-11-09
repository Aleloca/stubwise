import { createContext, useContext, type MutableRefObject } from "react";
import type { Project, Task } from "../../data/types";
import type { PlanBlock, PlanRights } from "../../domain/planning";

// Ciò che vasca, matrice e carte condividono dentro la pagina Planning: i
// permessi per task, la task trascinata e la cella sotto il puntatore (per
// l'anteprima del carico), le azioni sulla task.

/** Dove sta una task nella pagina: la vasca, o una cella persona × settimana. */
export type Spot = { kind: "pool" } | { kind: "cell"; personId: string; week: string };

export interface PlanningContextValue {
  /** Il progetto della pagina; `undefined` nella vista trasversale. */
  projectId: string | undefined;
  projectOf: (projectId: string) => Project | undefined;
  rightsOf: (task: Task) => PlanRights;
  /** Perché chi guarda non può spostare la task (`null` = può). */
  lockReason: (task: Task) => string | null;
  /** La task trascinata col puntatore, e la cella che ha sotto. */
  dragging: Task | null;
  over: Spot | null;
  /** Apre il menu «Plan» della task, accanto all'elemento. */
  openPlanMenu: (task: Task, anchor: HTMLElement) => void;
  openTask: (code: string) => void;
  openCode: string | undefined;
  /** Il codice della carta spostata da tastiera: rinasce altrove e riprende il fuoco. */
  refocus: MutableRefObject<string | null>;
  /** Il motivo di `planBlock`, a parole. */
  blockText: (block: PlanBlock, task: Task) => string;
}

export const PlanningContext = createContext<PlanningContextValue | null>(null);

export function usePlanning(): PlanningContextValue {
  const value = useContext(PlanningContext);
  if (!value) throw new Error("usePlanning outside PlanningPage");
  return value;
}

/** L'id del bersaglio di trascinamento di una cella o della vasca. */
export function spotId(spot: Spot): string {
  return spot.kind === "pool" ? "pool" : `cell:${spot.personId}:${spot.week}`;
}

/**
 * L'id di trascinamento di una carta: posto + task. Una slittata ancora
 * nella settimana corrente si vede due volte (vasca e cella della persona),
 * e dnd-kit vuole id unici: con lo stesso id le due copie si sovrascrivono.
 * La task si legge da `data.taskId`, mai dall'id.
 */
export function dragId(spot: Spot, taskId: string): string {
  return `drag:${spotId(spot)}:${taskId}`;
}

/** La task di un trascinamento, dai dati del draggable (`useDraggable({ data })`). */
export function dragTaskId(active: {
  data: { current?: Record<string, unknown> | null };
}): string | null {
  const id = active.data.current?.taskId;
  return typeof id === "string" ? id : null;
}

/** La chiave di una copia di carta: posto e codice, per riprendere il fuoco su quella giusta. */
export function chipKey(spot: Spot, code: string): string {
  return `${spotId(spot)}|${code}`;
}

export function spotOf(id: unknown): Spot | null {
  if (id === "pool") return { kind: "pool" };
  if (typeof id !== "string" || !id.startsWith("cell:")) return null;
  const [, personId, week] = id.split(":");
  return personId && week ? { kind: "cell", personId, week } : null;
}
