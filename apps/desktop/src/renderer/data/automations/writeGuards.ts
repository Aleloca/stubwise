import { PEOPLE } from "../seed/people";
import type { Automation, AutomationRun } from "../types";
import { forbidden, notFound } from "../writer";
import {
  automationById,
  canManageAutomation,
  canSeeAutomation,
  canSeeRun,
  runById,
} from "./visibility";

// I controlli comuni delle scritture delle Automations: chi non vede è
// `not_found` (R-G5), chi vede ma non gestisce `forbidden`.

export const personName = (id: string) => PEOPLE.find((p) => p.id === id)?.name ?? id;

function visibleAutomation(me: string, id: string): Automation {
  const a = automationById(id);
  if (!a || !canSeeAutomation(me, a)) throw notFound();
  return a;
}

export function managedAutomation(me: string, id: string): Automation {
  const a = visibleAutomation(me, id);
  if (!canManageAutomation(me, a)) throw forbidden();
  return a;
}

export function visibleRun(me: string, id: string): AutomationRun {
  const run = runById(id);
  if (!run || !canSeeRun(me, run)) throw notFound();
  return run;
}

export function managedRun(me: string, id: string): { run: AutomationRun; automation: Automation } {
  const run = visibleRun(me, id);
  const automation = automationById(run.automationId)!;
  if (!canManageAutomation(me, automation)) throw forbidden();
  return { run, automation };
}
