import type { StoredLinkKind, Task, TaskLinkKind } from "../data/model";

// I collegamenti fra task: una riga sola, salvata sulla task che «blocca»,
// che «è correlata» o che ha un «padre» (come la relazione del web). Ogni
// inverso — «bloccata da», «figlia», la correlazione vista dall'altra
// parte — si ricava qui, in lettura, dalle task che si vedono: così una riga
// tolta sparisce da entrambe le parti, e nessun inverso resta appeso.

export interface StoredLink {
  kind: StoredLinkKind;
  taskId: string;
}

/** Un collegamento come lo vede una task, con la riga e la task che lo tiene. */
export interface LinkView {
  kind: TaskLinkKind;
  /** L'altra task. */
  taskId: string;
  /** La task che tiene la riga: è lei che si modifica per toglierlo. */
  holderId: string;
  row: StoredLink;
}

const INVERSE: Record<StoredLinkKind, TaskLinkKind> = {
  blocks: "blocked_by",
  parent: "child",
  relates: "relates",
};

/**
 * Il punto di vista di `task`: prima le sue righe, poi gli inversi ricavati
 * dalle righe delle altre task di `all`. Un inverso che viene da una task
 * fuori da `all` (che chi guarda non vede) non c'è.
 */
export function linksOf(task: Task, all: Iterable<Task>): LinkView[] {
  const own: LinkView[] = task.links.map((row) => ({
    kind: row.kind,
    taskId: row.taskId,
    holderId: task.id,
    row,
  }));
  const derived: LinkView[] = [];
  for (const other of all) {
    if (other.id === task.id) continue;
    for (const row of other.links) {
      if (row.taskId !== task.id) continue;
      derived.push({ kind: INVERSE[row.kind], taskId: other.id, holderId: other.id, row });
    }
  }
  return [...own, ...derived];
}

/** Le task che bloccano `taskId`: quelle che tengono una riga «blocks» verso di lei. */
export function blockerIdsOf(taskId: string, all: Iterable<Task>): string[] {
  const out: string[] = [];
  for (const other of all) {
    if (other.links.some((l) => l.kind === "blocks" && l.taskId === taskId)) out.push(other.id);
  }
  return out;
}

/** Le righe di `holder` senza `row`. */
export function withoutLink(holder: Task, row: StoredLink): Task["links"] {
  return holder.links.filter((l) => !(l.kind === row.kind && l.taskId === row.taskId));
}
