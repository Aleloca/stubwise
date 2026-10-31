import { recordChange } from "../changelog/index";
import { encodeNumber, encodeSwitch } from "../changelog/settingValues";
import { capOf } from "../releases/visibility";
import { writer } from "../writer";
import { managedProject, projectObject, refuse } from "./common";
import { settingsOf } from "./reads";
import {
  CORRECTION_CAP_MAX,
  CORRECTION_CAP_MIN,
  PROJECT_SWITCHES,
  PULSE_DAYS_MAX,
  PULSE_DAYS_MIN,
  type ProjectSwitch,
} from "./state";
import type { ProjectResult } from "./types";

// Progetto → Settings → Automations (area 9c, Task 2): gli interruttori di
// ciò che Claude fa da solo, ogni quanti giorni passa il pulse e il tetto
// delle correzioni automatiche. Si salvano insieme (una barra), con
// `project.settings.manage`. Regole del web:
// - pulse 1–30 giorni interi (`pulse_days`), tetto 0–10 intero
//   (`correction_cap`; 0 = ciclo automatico spento);
// - il pulse acceso senza discovery del backlog non ha niente da proporre
//   (`pulse_needs_backlog`): si spengono insieme nello stesso salvataggio.
// Una voce per ogni valore cambiato, con valori stabili (`on`/`off`, numeri
// in stringa) e l'interruttore in `params.switch`. Il tetto scrive
// `Project.correctionCap`, che `capOf` legge già.

const inRange = (n: number, min: number, max: number): boolean =>
  Number.isInteger(n) && n >= min && n <= max;

/** Salva interruttori, giorni del pulse e tetto delle correzioni. */
export async function saveProjectAutomations(
  projectId: string,
  input: {
    switches: Record<ProjectSwitch, boolean>;
    pulseEveryDays: number;
    correctionCap: number;
  },
): Promise<ProjectResult> {
  const me = await writer("projectSettings.saveProjectAutomations");
  const managed = managedProject(me, projectId);
  if ("refusal" in managed) return managed.refusal;
  const { project } = managed;
  const switches = input.switches as Partial<Record<string, unknown>> | undefined;
  if (
    !switches ||
    Object.keys(switches).length !== PROJECT_SWITCHES.length ||
    !PROJECT_SWITCHES.every((sw) => typeof switches[sw] === "boolean")
  )
    return refuse.invalid("switches");
  if (!inRange(input.pulseEveryDays, PULSE_DAYS_MIN, PULSE_DAYS_MAX))
    return refuse.invalid("pulse_days");
  if (!inRange(input.correctionCap, CORRECTION_CAP_MIN, CORRECTION_CAP_MAX))
    return refuse.invalid("correction_cap");
  if (input.switches.pulse && !input.switches.backlogDiscovery)
    return refuse.invalid("pulse_needs_backlog");

  const settings = settingsOf(project);
  const object = projectObject(project);
  for (const sw of PROJECT_SWITCHES) {
    const before = settings.switches[sw];
    const after = input.switches[sw];
    if (before === after) continue;
    settings.switches[sw] = after;
    recordChange({
      kind: "project.switch_changed",
      actorId: me,
      projectId: project.id,
      object,
      before: encodeSwitch(before),
      after: encodeSwitch(after),
      params: { switch: sw },
    });
  }
  if (settings.pulseEveryDays !== input.pulseEveryDays) {
    const before = settings.pulseEveryDays;
    settings.pulseEveryDays = input.pulseEveryDays;
    recordChange({
      kind: "project.pulse_interval_changed",
      actorId: me,
      projectId: project.id,
      object,
      before: encodeNumber(before),
      after: encodeNumber(input.pulseEveryDays),
    });
  }
  const cap = capOf(project.id);
  if (cap !== input.correctionCap) {
    project.correctionCap = input.correctionCap;
    recordChange({
      kind: "project.correction_cap_changed",
      actorId: me,
      projectId: project.id,
      object,
      before: encodeNumber(cap),
      after: encodeNumber(input.correctionCap),
    });
  }
  return { ok: true };
}
