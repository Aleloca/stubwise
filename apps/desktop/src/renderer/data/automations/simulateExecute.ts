import {
  createSimulator,
  type Previewed,
  type Sim,
  type SimWorld,
} from "../../domain/automations/simCore";
import { lower } from "../mail/compose";
import { now, state, visibleProjectIds } from "../store";
import type { Automation } from "../types";
import { fakeClaude } from "./claudeFake";
import {
  bouncedFailure,
  planEmail,
  planStart,
  resolveProject,
  runLimitFailure,
  storeWorld,
  type ActionEffect,
} from "./plans";
import { configErrorsOf } from "./reads";
import { canStartRun } from "./runner";
import { automationById, canSeeAutomation } from "./visibility";

// La prova nel prototipo (area 7, R3): il nucleo puro
// (`domain/automations/simCore.ts`) col mondo dello store. Qui restano solo
// gli agganci dei passi fuori dalla fetta 1, che la build app non offre:
// l'email (F2), Claude (F3), «avvia un'altra» e il progetto del cliente (F4).

export type { Sim } from "../../domain/automations/simCore";
export { TERMINAL } from "../../domain/automations/simCore";

/** «Manda email» nella prova: i controlli di una conversazione nuova, e la conversazione si dice nell'anteprima. */
function previewEmail(
  sim: Sim,
  a: Automation,
  eff: ActionEffect,
  where: { stepId: string; path: string },
): Previewed {
  const owner = sim.ownerId;
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

/** «Avvia un'altra automazione» nella prova: dice solo che partirebbe. */
function previewStart(
  sim: Sim,
  a: Automation,
  eff: ActionEffect,
  where: { stepId: string; path: string },
): Previewed {
  // Nella prova la catena è la sola automazione provata.
  const p = planStart(eff, sim.ownerId, [a.id]);
  if (!p.ok) return p;
  const target = p.plan;
  if (!canStartRun(target)) return { ok: false, outcome: runLimitFailure(target.name) };
  return {
    ok: true,
    preview: { kind: "start", ...where, automationId: target.id, code: target.code, name: target.name },
  };
}

/** Il mondo della prova nel prototipo: lo store. Ogni lettura al momento. */
export const storeSimWorld: SimWorld = {
  ...storeWorld,
  now: () => now(),
  project: (id) => state.projectsById.get(id),
  visibleProjectIds: (personId) => visibleProjectIds(personId),
  canSeeAutomation: (personId, automationId) => {
    const target = automationById(automationId);
    return !!target && canSeeAutomation(personId, target);
  },
  configErrors: (a, flow, ownerId) => configErrorsOf(a, flow, ownerId),
  outside: {
    claude: (step, vars, ownerId) => fakeClaude(step, vars, ownerId),
    resolveProject: (eff, ownerId) => resolveProject(eff, ownerId),
    previewEmail,
    previewStart,
  },
};

/** Il simulatore del prototipo. */
export const simulator = createSimulator(storeSimWorld);
