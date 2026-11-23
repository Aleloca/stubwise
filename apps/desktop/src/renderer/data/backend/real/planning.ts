import type { TaskViewData } from "@stubwise/shared";
import type * as Fake from "../../api";
import { appClient, session } from "./client";
import { assigneeOf, toTask } from "./tasks";

// La pianificazione della build app (integrazione area 2, fetta 2): persona e
// settimana insieme dalla rotta `plan`, il giorno nella propria settimana da
// `PUT /api/tasks/:id/day`. Chi può farlo lo decide il server (`planBlock`,
// 403 `forbidden`, 400 `invalid_assignee`, 409 `not_in_week`): un errore
// arriva così com'è, e l'ottimistico di `usePlanTask`/`useSetDay` torna indietro.
// Eventi e avvisi (`planning.changed`, `task.assigned`) li scrive il server.

export const planTask: typeof Fake.planTask = async (id, plan) => {
  // Registro, A11 r.1414: un `assigneeId` omesso vuol dire «invariato» (la
  // pagina lo omette quando ha solo il segnaposto): il server lo accetta così
  // (regola in docs/invariants/permissions.md, da 72).
  const body = plan.assigneeId === undefined ? { week: plan.week } : plan;
  return toTask(
    (await appClient().tasks.plan(id, body as { assigneeId: string | null; week: string | null })) as TaskViewData,
  );
};

/**
 * Solo l'assegnatario sistema i giorni (come il finto): una task che so non
 * mia non parte nemmeno. Una che non ho mai letto la decide il server.
 */
export const setDay: typeof Fake.setDay = async (taskId, week, day) => {
  const assignee = assigneeOf(taskId);
  if (assignee !== undefined && assignee !== session.personId) throw new Error("forbidden");
  await appClient().tasks.setDay(taskId, { week, day });
};

/** Il server dà solo le mie, e solo delle task ancora in quella settimana. */
export const listDayArrangements: typeof Fake.listDayArrangements = async (week) => {
  const personId = session.personId ?? "";
  const rows = await appClient().me.dayArrangements(week);
  return rows.map((a) => ({
    personId,
    taskId: a.taskId,
    week: a.week,
    day: a.day as 1 | 2 | 3 | 4 | 5 | null,
  }));
};
