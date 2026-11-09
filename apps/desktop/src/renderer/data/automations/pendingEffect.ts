import type { ResolvedTarget } from "../../domain/automations/engine";
import { describe, projectOf, type ActionStep } from "../../domain/automations/preview";
import { restoreState } from "../../domain/automations/restore";
import { state, visibleProjectIds } from "../store";
import type { AutomationRun, SimulationEffectPreview, SimulationProject } from "../types";
import { planMilestone, planTask, type ActionEffect } from "./plans";
import { runNow } from "./runner";
import { approvalProjectOf, automationById, flowOf, stepOfRun } from "./visibility";

// L'anteprima condivisa del passo che un'esecuzione vera aspetta di far
// approvare (shape automations.md §3/§7): la stessa forma della prova
// (`SimulationEffectPreview`), così il riquadro «Now», «Da decidere» e la
// prova mostrano la stessa task e la stessa email. I testi vengono
// dall'anteprima dell'esecuzione COME LA VEDE chi guarda (`viewRun`: R-J12,
// R-J13, R-J16, R-J14); dal passo si risolvono solo incaricato, reparto e
// scadenza, con le regole dell'esecutore (`plans.ts`). Non scrive niente.

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Un progetto per l'anteprima; uno che chi guarda non vede resta senza id né nome (R-G5). */
function projectFor(me: string, id: string | null): SimulationProject {
  const p = id ? state.projectsById.get(id) : undefined;
  return p && visibleProjectIds(me).has(p.id)
    ? { id: p.id, code: p.code, name: p.name }
    : { id: "", code: "", name: "" };
}

/** L'effetto che l'approvazione sbloccherebbe, coi dati di adesso (come `currentOf` della prova). */
function effectOf(run: AutomationRun, step: ActionStep): ActionEffect | null {
  const flow = flowOf(run);
  if (!flow || !run.cursor) return null;
  const progetto = run.pending?.preview.progetto;
  const target: ResolvedTarget | null =
    typeof progetto === "string"
      ? { mode: "fixed", projectId: progetto }
      : projectOf(step)
        ? { mode: "own" }
        : null;
  try {
    const st = restoreState(flow, run, runNow(run));
    const { args } = describe(st, step, target);
    return {
      kind: step.kind,
      stepId: step.id,
      path: run.cursor,
      args,
      ...(target ? { projectTarget: target } : {}),
    } as ActionEffect;
  } catch {
    return null;
  }
}

/**
 * L'anteprima del passo in attesa di approvazione di `source`, per `me`;
 * `viewed` è la stessa esecuzione già passata da `viewRun(me, …)`. `null`
 * se non aspetta un'approvazione, se l'anteprima a `me` è nascosta, o per i
 * passi senza un'anteprima condivisa (avvisi, avvii: restano le righe).
 */
export function pendingEffectOf(
  me: string,
  source: AutomationRun,
  viewed: AutomationRun,
): SimulationEffectPreview | null {
  if (source.status !== "waiting_approval" || !source.cursor) return null;
  const preview = viewed.pending?.preview ?? {};
  if (Object.keys(preview).length === 0) return null;
  const a = automationById(source.automationId);
  const step = stepOfRun(source);
  if (!a || !step) return null;
  const where = { stepId: step.id, path: source.cursor };
  const owner = a.ownerId ?? "";
  const projectId = approvalProjectOf(source.pending?.preview ?? {}, a);
  switch (step.kind) {
    case "sendEmail": {
      const allegati = preview.allegati;
      return {
        kind: "email",
        ...where,
        from: a.mailbox ?? state.mailboxes.find((b) => b.personId === a.ownerId)?.email ?? "",
        to: str(preview.to),
        subject: str(preview.subject),
        body: str(preview.body),
        attachments: Array.isArray(allegati) ? allegati.map(String) : [],
        sameConversationAs: null,
      };
    }
    case "createTask": {
      const eff = effectOf(source, step);
      const plan = eff ? planTask(eff, a, owner, runNow(source)) : null;
      if (!plan?.ok) return null;
      const { assignee } = plan.plan;
      return {
        kind: "task",
        ...where,
        project: projectFor(me, projectId),
        title: str(preview.titolo),
        description: str(preview.descrizione),
        assigneeId: assignee.assigneeId,
        departmentId: plan.plan.departmentId,
        assignedBy: assignee.by,
        role: assignee.role,
        warning: assignee.why ?? null,
        dueDate: plan.plan.dueDate,
        dueInDays: step.dueInDays,
        milestone: null,
      };
    }
    case "createMilestone": {
      const eff = effectOf(source, step);
      const plan = eff ? planMilestone(eff, a, owner, runNow(source)) : null;
      if (!plan?.ok) return null;
      return {
        kind: "milestone",
        ...where,
        project: projectFor(me, projectId),
        name: str(preview.nome),
        dueDate: plan.plan.dueDate,
        dueInDays: step.dueInDays,
      };
    }
    case "createRequest":
      return {
        kind: "request",
        ...where,
        project: projectFor(me, projectId),
        title: str(preview.titolo),
        description: str(preview.descrizione),
      };
    default:
      return null;
  }
}
