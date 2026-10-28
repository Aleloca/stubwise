import {
  type EffectRequest,
  type EngineInput,
  type EngineState,
} from "../../domain/automations/engine";
import { lower } from "../mail/compose";
import { copy, state } from "../store";
import type {
  Automation,
  RunLogEntry,
  SimulationEffectPreview,
  SimulationEmailPreview,
  SimulationMilestonePreview,
  SimulationProject,
  SimulationTaskPreview,
  SimulationView,
} from "../types";
import { fakeClaude } from "./claudeFake";
import {
  bouncedFailure,
  planEmail,
  planMilestone,
  planNotify,
  planRequest,
  planStart,
  planTask,
  resolveProject,
  RUN_LIMIT_REASON,
  type ActionEffect,
  type EffectOutcome,
} from "./plans";
import { canStartRun } from "./runner";

// L'esecutore finto della prova (vedi `simulate.ts`): cosa farebbe ogni
// effetto, coi piani dell'esecutore vero. Non scrive mai nello store.

export interface Sim {
  id: string;
  personId: string;
  automationId: string;
  version: number;
  /** La revisione provata (R-J19): se la prova finisce bene e la versione è ancora questa, è provata. */
  rev: number | null;
  draft: boolean;
  ownerId: string;
  event: Record<string, unknown>;
  engine: EngineState;
  /** Gli elementi di ogni «Per ogni» visto (il motore li toglie a giri finiti). */
  loopItems: Record<string, unknown[]>;
  /** L'effetto chiesto dal motore, che «Passo successivo» farebbe. */
  pending: EffectRequest | null;
  log: RunLogEntry[];
  /** I riferimenti interni dati al motore per i traguardi (`milestoneRef`): mai mostrati. */
  milestoneRefs: Map<string, SimulationMilestonePreview>;
  preview: SimulationView["preview"];
}

export const TERMINAL = new Set(["done", "failed", "cancelled"]);

/** Un progetto per un'anteprima (pieno: la vista lo nasconde a chi non lo vede). */
export function projectRef(id: string): SimulationProject {
  const p = state.projectsById.get(id);
  return { id, code: p?.code ?? "", name: p?.name ?? "" };
}

type Previewed =
  | { ok: true; preview: SimulationEffectPreview; reason?: string }
  | { ok: false; outcome: EffectOutcome };

/** Cosa farebbe un'azione, coi piani dell'esecutore vero. Non scrive. */
export function previewOf(sim: Sim, a: Automation, eff: ActionEffect, at: string): Previewed {
  const owner = sim.ownerId;
  const where = { stepId: eff.stepId, path: eff.path };
  const dueInDays = (eff.args as { dueInDays?: number | null }).dueInDays ?? null;
  switch (eff.kind) {
    case "createTask": {
      const p = planTask(eff, a, owner, at);
      if (!p.ok) return p;
      const { plan } = p;
      const ms = plan.milestoneCode ? sim.milestoneRefs.get(plan.milestoneCode) : undefined;
      return {
        ok: true,
        reason: plan.assignee.reason,
        preview: {
          kind: "task",
          ...where,
          project: projectRef(plan.projectId),
          title: plan.title,
          description: plan.description,
          assigneeId: plan.assignee.assigneeId,
          departmentId: plan.departmentId,
          assignedBy: plan.assignee.by,
          role: plan.assignee.role,
          warning: plan.assignee.reason ?? null,
          dueDate: plan.dueDate,
          dueInDays,
          milestone:
            ms && ms.project.id === plan.projectId
              ? { name: ms.name, stepId: ms.stepId, path: ms.path }
              : null,
        },
      };
    }
    case "createMilestone": {
      const p = planMilestone(eff, a, owner, at);
      if (!p.ok) return p;
      return {
        ok: true,
        preview: {
          kind: "milestone",
          ...where,
          project: projectRef(p.plan.projectId),
          name: p.plan.name,
          dueDate: p.plan.dueDate,
          dueInDays,
        },
      };
    }
    case "createRequest": {
      const p = planRequest(eff, a, owner);
      if (!p.ok) return p;
      return {
        ok: true,
        preview: {
          kind: "request",
          ...where,
          project: projectRef(p.plan.projectId),
          title: p.plan.title,
          description: p.plan.description,
        },
      };
    }
    case "sendEmail": {
      // Nella prova non ci sono messaggi veri: i controlli si fanno come per
      // una conversazione nuova, e la conversazione si dice nell'anteprima.
      const p = planEmail(
        eff,
        owner,
        sim.preview.emails.length,
        () => ({ threadId: null, mode: "new", replyToMessageId: null }),
        (i: number) => `att-${sim.id}-${eff.stepId}-${i}`,
        // La casella scelta vale per il proprietario di adesso; chi prova una bozza usa la sua (R-J15).
        owner === a.ownerId ? (a.mailbox ?? null) : null,
      );
      if (!p.ok) return p;
      if (p.plan.bounced) return { ok: false, outcome: bouncedFailure(p.plan.to) };
      // Come `threadFor` dell'esecutore vero: le email allo stesso indirizzo
      // stanno in UNA conversazione, quella aperta dalla prima.
      const first = sim.preview.emails.find((e) => lower(e.to) === lower(p.plan.to));
      return {
        ok: true,
        preview: {
          kind: "email",
          ...where,
          from: p.plan.from,
          to: p.plan.to,
          subject: p.plan.subject,
          body: p.plan.body,
          attachments: p.plan.input.attachments.map((x) => x.name),
          sameConversationAs: first ? { stepId: first.stepId, path: first.path } : null,
        },
      };
    }
    case "notify": {
      const p = planNotify(eff, a, owner);
      if (!p.ok) return p;
      return {
        ok: true,
        preview: {
          kind: "notification",
          ...where,
          personId: p.plan.personId,
          text: p.plan.text,
          project: p.plan.projectId ? projectRef(p.plan.projectId) : null,
        },
      };
    }
    case "startAutomation": {
      // Nella prova la catena è la sola automazione provata.
      const p = planStart(eff, owner, [a.id]);
      if (!p.ok) return p;
      const target = p.plan;
      if (!canStartRun(target)) {
        return {
          ok: false,
          outcome: {
            input: {
              kind: "effect_result",
              ok: false,
              error: "run_limit",
              reason: RUN_LIMIT_REASON(target.name),
            },
          },
        };
      }
      return {
        ok: true,
        preview: {
          kind: "start",
          ...where,
          automationId: target.id,
          code: target.code,
          name: target.name,
        },
      };
    }
  }
}

/** Esegue un effetto per finta: un'anteprima al posto della scrittura, e l'input per il motore. */
export function execute(sim: Sim, a: Automation, eff: EffectRequest): EngineInput {
  if (eff.kind === "claude") {
    const r = fakeClaude(eff.step, eff.vars, sim.ownerId);
    sim.preview.claude.push({
      stepId: eff.stepId,
      path: eff.path,
      outcome: r.outcome ?? null,
      fields: copy(r.fields ?? {}),
      reason: r.reason,
      read: r.read,
    });
    return r;
  }
  if (eff.kind === "resolve_project") return resolveProject(eff, sim.ownerId).input;
  const r = previewOf(sim, a, eff, sim.engine.now);
  if (!r.ok) return r.outcome.input;
  // Il motore lega i traguardi alle task per «codice»: nella prova un riferimento interno.
  const ref = `${sim.id}:${eff.path}`;
  const { kind, ...item } = r.preview;
  if (kind === "task") sim.preview.tasks.push(item as SimulationTaskPreview);
  else if (kind === "milestone") {
    sim.preview.milestones.push(item as SimulationMilestonePreview);
    sim.milestoneRefs.set(ref, item as SimulationMilestonePreview);
  } else if (kind === "request")
    sim.preview.requests.push(item as SimulationView["preview"]["requests"][number]);
  else if (kind === "email") sim.preview.emails.push(item as SimulationEmailPreview);
  else if (kind === "notification")
    sim.preview.notifications.push(item as SimulationView["preview"]["notifications"][number]);
  else sim.preview.starts.push(item as SimulationView["preview"]["starts"][number]);
  return {
    kind: "effect_result",
    ok: true,
    codes: [ref],
    ...(r.reason ? { reason: r.reason } : {}),
  };
}
