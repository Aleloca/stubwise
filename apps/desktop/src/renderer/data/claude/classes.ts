import { splitByVisibility, wouldNotify } from "../alerts/visibility";
import { assignedRecipientOf, nextTaskNumber, planRecipientsOf } from "../api-mutations";
import { automationsStartingOn, taskHappening } from "../automations/sources";
import type { NewTaskInput, ProposedAction, Task, TaskPatch } from "../model";
import { familyOf, state, visibleProjectIds } from "../store";
import { CLAUDE_CATALOG, declaredClassOf, isCatalogFn } from "./catalog";

// La classe calcolata di un'azione di Claude (area 10a, Task 4). Un'azione è
// A solo se NON avvisa altre persone e NON fa partire un'automazione: i soli
// due criteri della regola della conferma (maintainer). Si calcola sui dati
// di adesso, con le stesse regole delle scritture — i destinatari delle
// notifiche dirette da `api-mutations.ts`, gli avvisi del catalogo da
// `wouldNotify`, le automazioni da `automationsStartingOn` — così la scheda
// dice ciò che succede davvero. Una classe sale, mai scende sotto quella
// dichiarata (`declaredClassOf`). La pagina e il motore di intenti la
// leggono, non la deducono.

export type ClassReason =
  /** `personIds`: chi riceverebbe un avviso e chi chiede vede; `more`: ce n'è anche fuori da quelli (mai contati). */
  | { kind: "notifies"; personIds: string[]; more: boolean }
  | { kind: "automation"; projectId: string }
  | { kind: "irreversible" }
  | { kind: "reauth" };

export interface ActionClass {
  cls: "A" | "B" | "C";
  reasons: ClassReason[];
}

type Action = Pick<ProposedAction, "fn" | "args">;

const RANK = { A: 0, B: 1, C: 2 } as const;
const higher = (a: ActionClass["cls"], b: ActionClass["cls"]) => (RANK[a] >= RANK[b] ? a : b);

/**
 * I motivi in ordine di scheda (notifies, automation, irreversible, reauth),
 * con una riga sola per «Notifies» e una per progetto delle automazioni.
 */
function normalize(reasons: readonly ClassReason[]): ClassReason[] {
  const people = new Set<string>();
  let more = false;
  const projects: string[] = [];
  let irreversible = false;
  let reauth = false;
  for (const r of reasons) {
    if (r.kind === "notifies") {
      for (const id of r.personIds) people.add(id);
      more ||= r.more;
    } else if (r.kind === "automation") {
      if (!projects.includes(r.projectId)) projects.push(r.projectId);
    } else if (r.kind === "irreversible") irreversible = true;
    else reauth = true;
  }
  return [
    ...(people.size > 0 || more
      ? [{ kind: "notifies" as const, personIds: [...people].sort(), more }]
      : []),
    ...projects.map((projectId) => ({ kind: "automation" as const, projectId })),
    ...(irreversible ? [{ kind: "irreversible" as const }] : []),
    ...(reauth ? [{ kind: "reauth" as const }] : []),
  ];
}

/** Chi riceverebbe le notifiche dirette, diviso per visibilità come `wouldNotify`. */
const notifiesOf = (me: string, personIds: (string | null)[]): ClassReason => ({
  kind: "notifies",
  ...splitByVisibility(
    me,
    personIds.filter((id): id is string => id !== null),
  ),
});

/** Un'automazione attiva partirebbe per l'evento della task? */
function automationOf(
  event: "task_created" | "task_closed",
  task: Pick<Task, "code" | "title" | "projectId" | "assigneeId" | "statusId">,
): ClassReason[] {
  return automationsStartingOn(taskHappening(event, task)).length > 0
    ? [{ kind: "automation", projectId: task.projectId }]
    : [];
}

/** La task dell'azione, se chi chiede la vede: di una che non vede non si dice niente (R-G5). */
function visibleTask(me: string, id: unknown): Task | null {
  const task = typeof id === "string" ? state.tasksById.get(id) : undefined;
  return task && visibleProjectIds(me).has(task.projectId) ? task : null;
}

/** I motivi che vengono dai dati di adesso: solo avvisi e automazioni. */
function dataReasons(me: string, action: Action): ClassReason[] {
  const { args } = action;
  switch (action.fn) {
    case "createTask": {
      const input = args as Partial<NewTaskInput>;
      const projectId = input.projectId;
      const project = projectId ? state.projectsById.get(projectId) : undefined;
      if (!project || !visibleProjectIds(me).has(project.id)) return [];
      const assigneeId = input.assigneeId ?? null;
      // Lo stato in cui nascerebbe: quello dato, o il primo «da fare» (`checkNewTask`).
      const statusId =
        input.statusId ??
        state.statuses
          .filter((s) => s.projectId === project.id && s.family === "todo")
          .sort((a, b) => a.order - b.order)[0]?.id ??
        "";
      return [
        // La notifica diretta `task.assigned` (decisione del maintainer, 2 nov 2026).
        notifiesOf(me, [assignedRecipientOf(me, assigneeId)]),
        { kind: "notifies", ...wouldNotify(me, { kind: "task.created", projectId: project.id }) },
        ...automationOf("task_created", {
          code: `${project.code}-${nextTaskNumber(project.id)}`,
          title: String(input.title ?? "").trim(),
          projectId: project.id,
          assigneeId,
          statusId,
        }),
      ];
    }
    case "updateTask": {
      const task = visibleTask(me, args.id);
      if (!task) return [];
      const patch = (args.patch ?? {}) as TaskPatch;
      const reasons: ClassReason[] = [];
      if (patch.assigneeId !== undefined && patch.assigneeId !== task.assigneeId)
        reasons.push(notifiesOf(me, [assignedRecipientOf(me, patch.assigneeId)]));
      const next = patch.statusId ? state.statusById.get(patch.statusId) : undefined;
      if (next?.family === "closed" && familyOf(task) !== "closed") {
        reasons.push(
          ...automationOf("task_closed", {
            ...task,
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.assigneeId !== undefined ? { assigneeId: patch.assigneeId } : {}),
            statusId: next.id,
          }),
        );
      }
      // Di chi è la task non alza la classe: contano solo avvisi e
      // automazioni (ruling (T4), decisione del maintainer).
      return reasons;
    }
    case "planTask": {
      const task = visibleTask(me, args.id);
      const plan = args.plan as { assigneeId: string | null; week: string | null } | undefined;
      if (!task || !plan) return [];
      // Le persone che `planTaskAs` avviserebbe, meno chi chiede (P9).
      const { assigned, planningChanged } = planRecipientsOf(me, task, plan);
      return [notifiesOf(me, [assigned, ...planningChanged])];
    }
    default:
      return [];
  }
}

/** La classe di un'azione adesso, a nome di `me`, coi motivi da dire nella scheda. */
export function classOf(me: string, action: Action): ActionClass {
  // Fuori dal catalogo non si esegue dal riquadro: mai A.
  if (!isCatalogFn(action.fn)) return { cls: "B", reasons: [] };
  const fn = action.fn;
  const declared = declaredClassOf(fn);
  const reasons = normalize([
    ...dataReasons(me, action),
    ...(CLAUDE_CATALOG[fn].undoable ? [] : [{ kind: "irreversible" as const }]),
    ...(declared === "C" ? [{ kind: "reauth" as const }] : []),
  ]);
  return { cls: higher(declared, reasons.length > 0 ? "B" : "A"), reasons };
}

/** La classe di un gruppo: la più alta, coi motivi di tutte. */
export function classOfGroup(me: string, actions: Action[]): ActionClass {
  const each = actions.map((a) => classOf(me, a));
  return {
    cls: each.reduce<ActionClass["cls"]>((cls, c) => higher(cls, c.cls), "A"),
    reasons: normalize(each.flatMap((c) => c.reasons)),
  };
}
