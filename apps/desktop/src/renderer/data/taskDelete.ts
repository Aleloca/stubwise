import { recordChange } from "./changelog/index";
import { currentVia } from "./claude/via";
// Per effetto: registra `task.deleted` (`recordChange` lancia su un tipo ignoto).
import "./projectSettings/changeTypes";
import type { Task } from "./model";
import {
  canSeeConversation,
  familyOf,
  gate,
  now,
  objectCodeOf,
  openPrLinesOf,
  reindex,
  state,
  visibleProjectIds,
} from "./store";
import { can, viewerFor } from "./viewer";
import { writer } from "./writer";

// «Elimina task» (area 10a, Task 2), livello dati.
//
// - Chi: l'autore con `tickets.edit`, o chi ha `tickets.moderate` nel
//   progetto (decisione del maintainer). Claude collega non ha
//   `tickets.moderate` (R-L9), quindi non elimina una task che non ha creato
//   (ruling del controller (pre-flight), P24).
// - Non si annulla e non chiede la riconferma: a mano basta il dialogo.
// - `busy`: una sessione di lavoro di Claude non finita (anche in attesa),
//   una PR aperta, la correzione ancora aperta di un server o di un rilascio.
// - Cosa toglie: la task, i collegamenti verso di lei dalle altre task (le
//   figlie restano, senza madre), la sua attività, gli accordi della
//   giornata e le domande. Cosa resta: richiesta, traguardo, notifiche,
//   esecuzioni d'automazione, conversazioni finite e PR chiuse, che la
//   nominano ancora e si leggono a lettura da `state.deletedTasks`.
// - Eliminata = inesistente (R-G5): il codice non si trova più, e non torna
//   (`buildTask` conta anche le eliminate).
//
// Ordine dei controlli (la forma di `admin/common.ts`): `not_found` →
// `forbidden` → `busy` → la scrittura e la sua voce del registro.

export type TaskBusyReason =
  /**
   * `code` è `null` se chi guarda non vede la sessione (`canSeeConversation`);
   * `conversationId`, per «Open the session», c'è solo se la vede (area 10a,
   * Task 10: campo nuovo, facoltativo).
   */
  | { kind: "claude_session"; code: string | null; conversationId?: string }
  /**
   * `repo` e `number` sono `null` quando il flusso non li dice (la pipeline
   * scrive «Pull request opened for ACQ-7», senza numero né link): la PR è
   * aperta lo stesso, e la task resta occupata.
   */
  | { kind: "open_pr"; repo: string | null; number: number | null }
  | { kind: "server_fix"; serverCode: string }
  | { kind: "release_fix"; releaseCode: string }
  /**
   * Una correzione della sua PR ancora aperta (in attesa o in coda): la dice
   * il server vero (integrazione, fetta 3.0 della chat); il prototipo non la
   * produce.
   */
  | { kind: "open_correction" };

export interface TaskDeletionPreview {
  taskId: string;
  code: string;
  title: string;
  canDelete: boolean;
  /** Il «Who?» quando `canDelete` è falso per un permesso: `editTasks` (autore) o `deleteTasks`. */
  whoAction: "editTasks" | "deleteTasks" | null;
  busy: TaskBusyReason[];
  /** Le figlie che restano, senza madre. */
  children: { code: string; title: string }[];
}

export type TaskDeleteResult =
  | { ok: true }
  | { ok: false; error: "not_found" | "forbidden" }
  | { ok: false; error: "busy"; reasons: TaskBusyReason[] };

/** Una task che chi guarda vede; `undefined` se invisibile o inesistente (R-G5). */
function seenTask(me: string, taskId: string): Task | undefined {
  const task = state.tasksById.get(taskId);
  return task && visibleProjectIds(me).has(task.projectId) ? task : undefined;
}

/** Chi elimina: l'autore con `tickets.edit`, o chi ha `tickets.moderate` nel progetto. */
export function canDeleteTask(me: string, task: Task): boolean {
  const viewer = viewerFor(me);
  if (can(viewer, "tickets.moderate", task.projectId)) return true;
  return task.createdById === me && can(viewer, "tickets.edit", task.projectId);
}

/**
 * Perché la task non si elimina adesso, viste da `me`: le sessioni di
 * lavoro non finite (il codice solo se `me` le vede), le PR aperte, la
 * correzione aperta di un server o di un rilascio.
 */
function busyOf(me: string, task: Task): TaskBusyReason[] {
  const sessions = state.conversations
    .filter((c) => c.kind === "task_run" && c.taskId === task.id && c.state !== "finished")
    .map((c): TaskBusyReason => {
      const seen = canSeeConversation(me, c);
      return {
        kind: "claude_session",
        code: seen ? objectCodeOf(c) : null,
        ...(seen ? { conversationId: c.id } : {}),
      };
    });
  const prs = openPrLinesOf(task).map(
    (line): TaskBusyReason => ({ kind: "open_pr", repo: line.repo, number: line.number }),
  );
  const open = familyOf(task) !== "closed";
  const fixes: TaskBusyReason[] = [];
  if (open && task.serverRef)
    fixes.push({ kind: "server_fix", serverCode: task.serverRef.serverCode });
  const release =
    open && task.releaseRef
      ? state.releases.find((r) => r.id === task.releaseRef!.releaseId)
      : undefined;
  if (release) fixes.push({ kind: "release_fix", releaseCode: release.code });
  return [...sessions, ...prs, ...fixes];
}

/** Toglie la task e ciò che è solo suo; lascia ciò che la nomina (si legge a lettura). */
function removeTask(me: string, task: Task): void {
  const id = task.id;
  state.tasks = state.tasks.filter((t) => t.id !== id);
  state.deletedTasks.push({
    id,
    code: task.code,
    projectId: task.projectId,
    title: task.title,
    deletedAt: now(),
    deletedById: me,
    // Il segno «per conto di» (area 10a, Task 3): solo dentro `runAsClaude`.
    ...(currentVia() ? { via: "claude" as const } : {}),
  });
  // I collegamenti salvati sulle altre task (`blocks`, `relates`, `parent`):
  // quelli salvati su di lei se ne vanno con lei.
  for (const t of state.tasks)
    if (t.links.some((l) => l.taskId === id)) t.links = t.links.filter((l) => l.taskId !== id);
  state.activity = state.activity.filter((a) => a.taskId !== id);
  state.arrangements = state.arrangements.filter((a) => a.taskId !== id);
  state.decisions = state.decisions.filter((d) => d.taskId !== id);
  reindex();
  recordChange({
    kind: "task.deleted",
    actorId: me,
    projectId: task.projectId,
    object: { type: "task", id, label: task.code },
    params: { title: task.title },
  });
}

/** Elimina la task a nome di `me`, senza cancello (la forma sincrona del catalogo). */
export function deleteTaskAs(me: string, taskId: string): TaskDeleteResult {
  const task = seenTask(me, taskId);
  if (!task) return { ok: false, error: "not_found" };
  if (!canDeleteTask(me, task)) return { ok: false, error: "forbidden" };
  const reasons = busyOf(me, task);
  if (reasons.length > 0) return { ok: false, error: "busy", reasons };
  removeTask(me, task);
  return { ok: true };
}

export async function deleteTask(taskId: string): Promise<TaskDeleteResult> {
  return deleteTaskAs(await writer("deleteTask"), taskId);
}

/**
 * Cosa dice il dialogo prima di eliminare: se si può (e, se no per un
 * permesso, quale «Who?»), cosa la occupa e le figlie che restano senza
 * madre. `null` per una task invisibile o inesistente (R-G5).
 */
export async function getTaskDeletion(taskId: string): Promise<TaskDeletionPreview | null> {
  const me = await gate("getTaskDeletion");
  const task = seenTask(me, taskId);
  if (!task) return null;
  const visible = visibleProjectIds(me);
  const canDelete = canDeleteTask(me, task);
  const author = task.createdById === me;
  return {
    taskId: task.id,
    code: task.code,
    title: task.title,
    canDelete,
    whoAction: canDelete ? null : author ? "editTasks" : "deleteTasks",
    busy: busyOf(me, task),
    // Solo le figlie che chi guarda vede (R-G5), anche se di solito stanno nello stesso progetto.
    children: state.tasks
      .filter(
        (t) =>
          visible.has(t.projectId) &&
          t.links.some((l) => l.kind === "parent" && l.taskId === task.id),
      )
      .map((t) => ({ code: t.code, title: t.title })),
  };
}
