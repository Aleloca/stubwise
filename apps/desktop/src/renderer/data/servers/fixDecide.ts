import { planDigest } from "../../domain/servers/fixPlan";
import { decidePlan } from "../api-mutations";
import { eventsOf, gate, state, storeGeneration, visibleProjectIds } from "../store";
import { stopServerFixAs } from "./fix";
import { canStopServerFix } from "./fixPermissions";
import type { Conversation, ConversationEvent, Task } from "../types";
import { forbidden, invalid, notFound } from "../writer";

// Il piano di una correzione si decide dalla task (area 8, F4b, decisione
// del maintainer del 15 nov 2026): la sezione Server legge la vista della
// correzione e decide con queste tre, come le rotte del server
// (`/api/tasks/:id/server-fix/approve|reject|stop`). La sessione di Claude
// resta da leggere; il motore sotto è lo stesso di prima (`decidePlan`,
// `stop` sulla sessione), con i suoi controlli di permesso.

type PlanEvent = Extract<ConversationEvent, { type: "plan" }>;

/** La task, vista da chi chiama, e la sua ultima sessione di correzione. */
async function fixOf(fn: Parameters<typeof gate>[0], taskId: string) {
  const gen = storeGeneration();
  const me = await gate(fn);
  const task: Task | undefined = state.tasksById.get(taskId);
  if (!task || !visibleProjectIds(me).has(task.projectId) || !task.serverRef) throw notFound();
  const run: Conversation | undefined = state.conversations
    .filter((c) => c.kind === "task_run" && c.taskId === task.id && c.serverFix)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
  return { me, task, run, gen };
}

/** Il piano che aspetta, o `not_awaiting_approval`. */
function pendingOf(run: Conversation | undefined): { run: Conversation; plan: PlanEvent } {
  const plan = run
    ? eventsOf(run.id)
        .filter((e): e is PlanEvent => e.type === "plan")
        .at(-1)
    : undefined;
  if (!run || !plan || plan.status !== "pending" || !plan.serverPlan)
    throw invalid("not_awaiting_approval");
  return { run, plan };
}

/** «Approve»: col digest del piano MOSTRATO; cambiato nel frattempo, `plan_changed`. */
export async function approveServerFix(taskId: string, digest: string): Promise<void> {
  const { run } = await fixOf("servers.approveServerFix", taskId);
  const { plan } = pendingOf(run);
  if (planDigest(plan.serverPlan!) !== digest) throw invalid("plan_changed");
  await decidePlan(run!.id, "approve", undefined, plan.id);
}

/** «Reject» con la nota per Claude (le indicazioni del piano dopo). */
export async function rejectServerFix(taskId: string, note: string): Promise<void> {
  const { run } = await fixOf("servers.rejectServerFix", taskId);
  const { plan } = pendingOf(run);
  await decidePlan(run!.id, "reject", note.trim() || undefined, plan.id);
}

/** «Stop»: ferma la correzione; una già chiusa è `not_running`. */
export async function stopServerFix(taskId: string): Promise<void> {
  const { me, task, run, gen } = await fixOf("servers.stopServerFix", taskId);
  if (!run || run.state === "finished") throw invalid("not_running");
  if (!canStopServerFix(me, task.projectId)) throw forbidden();
  await stopServerFixAs(me, run, gen);
}
