import { ApiError } from "@stubwise/api-client";
import type { UpdateProjectInput } from "@stubwise/shared";
import { projectSettingsAccess } from "../../adminSections";
import type { ProjectSettingsView } from "../../projectSettings/reads";
import {
  CORRECTION_CAP_MAX,
  CORRECTION_CAP_MIN,
  PROJECT_SWITCHES,
  PULSE_DAYS_MAX,
  PULSE_DAYS_MIN,
  pulseNeedsBacklogFor,
  type ProjectSwitch,
} from "../../projectSettings/state";
import type { ProjectResult } from "../../projectSettings/types";
import { appClient } from "./client";
import { getViewer } from "./session";

// Registro, area 9 r.1121: Progetto → Settings → Automations e gli
// interruttori del progetto (le frasi «spento» di brief, Docs notturni,
// pulse e report) sulla lettura del progetto (`GET /api/projects/:id`) e
// sulla sua PATCH (`updateProjectSchema`, con `project.settings.manage`).
// La PATCH porta SOLO i campi cambiati: chi salva dalla stessa schermata
// aperta da prima non sovrascrive i campi che non ha toccato.

/** L'interruttore del prototipo → il campo del progetto sul server. */
const FIELD: Record<ProjectSwitch, keyof UpdateProjectInput> = {
  docsNightly: "docAutoUpdate",
  dailyReport: "dailyReportEnabled",
  backlogDiscovery: "backlogEnabled",
  pulse: "pulseEnabled",
  weeklyBrief: "weeklyBriefEnabled",
};

type ServerProject = Record<string, unknown>;

const switchesOf = (p: ServerProject): Record<ProjectSwitch, boolean> =>
  Object.fromEntries(PROJECT_SWITCHES.map((sw) => [sw, p[FIELD[sw]] === true])) as Record<
    ProjectSwitch,
    boolean
  >;

/** Il progetto, o `null` se chi guarda non lo vede (404, come ogni lettura del progetto). */
async function projectOf(projectId: string): Promise<ServerProject | null> {
  try {
    return (await appClient().projects.get(projectId)) as unknown as ServerProject;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

const inRange = (n: number, min: number, max: number): boolean =>
  Number.isInteger(n) && n >= min && n <= max;

/** I valori salvabili della sezione, come li ha letti chi guarda. */
interface AutomationsBase {
  switches: Record<ProjectSwitch, boolean>;
  pulseEveryDays: number;
  correctionCap: number;
}

/**
 * Revisione I-4: la lettura da cui è partita la schermata, per progetto e per
 * client (una sessione nuova ha un client nuovo). Il salvataggio manda solo
 * ciò che chi guarda ha cambiato rispetto a QUESTA: una rilettura al
 * salvataggio sovrascriverebbe il cambio di un altro fatto nel frattempo.
 */
const bases = new WeakMap<object, Map<string, AutomationsBase>>();
function basesOf(): Map<string, AutomationsBase> {
  const client = appClient();
  let map = bases.get(client);
  if (!map) bases.set(client, (map = new Map()));
  return map;
}

export const liveProjectAutomations = {
  /**
   * Le impostazioni come le legge la pagina. Nella build app servono le sole
   * parti di Automations (e il nome, il codice, il modulo Docs): la scheda AI
   * resta «in arrivo», quindi le sue scelte sono vuote.
   */
  async getProjectSettings(projectId: string): Promise<ProjectSettingsView | null> {
    const [p, viewer] = await Promise.all([projectOf(projectId), getViewer()]);
    if (!p) return null;
    const switches = switchesOf(p);
    const pulseEveryDays = typeof p.pulseEveryDays === "number" ? p.pulseEveryDays : 7;
    const correctionCap = typeof p.prCorrectionMaxRounds === "number" ? p.prCorrectionMaxRounds : 3;
    basesOf().set(projectId, { switches, pulseEveryDays, correctionCap });
    return {
      projectId,
      code: String(p.code ?? ""),
      name: String(p.name ?? ""),
      description: typeof p.description === "string" ? p.description : "",
      docsModule: Array.isArray(p.modules) && p.modules.includes("docs"),
      ai: {
        providerId: typeof p.aiProviderId === "string" ? p.aiProviderId : null,
        exclusive: p.aiProviderExclusive === true,
        choices: [],
        chosenUnavailable: false,
        automaticChain: [],
      },
      switches,
      pulseEveryDays,
      correctionCap,
      pulseNeedsBacklog: pulseNeedsBacklogFor(switches),
      // I permessi li calcola il server (`/api/auth/me`): il client li legge.
      access: projectSettingsAccess(viewer, projectId),
    };
  },

  async getProjectSwitches(projectId: string): Promise<Record<ProjectSwitch, boolean> | null> {
    const p = await projectOf(projectId);
    return p ? switchesOf(p) : null;
  },

  /**
   * Salva interruttori, giorni del pulse e tetto delle correzioni. Le regole
   * del prototipo (`projectSettings/automations.ts`) prima della PATCH: il
   * server controlla i range ma non che il pulse abbia la discovery.
   */
  async saveProjectAutomations(
    projectId: string,
    input: {
      switches: Record<ProjectSwitch, boolean>;
      pulseEveryDays: number;
      correctionCap: number;
    },
  ): Promise<ProjectResult> {
    const sw = input.switches as Partial<Record<string, unknown>> | undefined;
    if (
      !sw ||
      Object.keys(sw).length !== PROJECT_SWITCHES.length ||
      !PROJECT_SWITCHES.every((k) => typeof sw[k] === "boolean")
    )
      return { ok: false, error: "invalid", reason: "switches" };
    if (!inRange(input.pulseEveryDays, PULSE_DAYS_MIN, PULSE_DAYS_MAX))
      return { ok: false, error: "invalid", reason: "pulse_days" };
    if (!inRange(input.correctionCap, CORRECTION_CAP_MIN, CORRECTION_CAP_MAX))
      return { ok: false, error: "invalid", reason: "correction_cap" };
    if (input.switches.pulse && pulseNeedsBacklogFor(input.switches))
      return { ok: false, error: "invalid", reason: "pulse_needs_backlog" };
    // Il confronto è con la lettura di partenza; senza (nessuna lettura in questa sessione), con una rilettura.
    let base = basesOf().get(projectId);
    if (!base) {
      const p = await projectOf(projectId);
      if (!p) return { ok: false, error: "not_found" };
      base = {
        switches: switchesOf(p),
        pulseEveryDays: Number(p.pulseEveryDays),
        correctionCap: Number(p.prCorrectionMaxRounds),
      };
    }
    const body: Record<string, unknown> = {};
    for (const k of PROJECT_SWITCHES)
      if (base.switches[k] !== input.switches[k]) body[FIELD[k]] = input.switches[k];
    if (base.pulseEveryDays !== input.pulseEveryDays) body.pulseEveryDays = input.pulseEveryDays;
    if (base.correctionCap !== input.correctionCap) body.prCorrectionMaxRounds = input.correctionCap;
    if (Object.keys(body).length === 0) return { ok: true };
    try {
      await appClient().projects.patch(projectId, body as UpdateProjectInput);
      // Il salvato è la nuova partenza: un secondo salvataggio manda solo il resto.
      basesOf().set(projectId, {
        switches: { ...input.switches },
        pulseEveryDays: input.pulseEveryDays,
        correctionCap: input.correctionCap,
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404)
        return { ok: false, error: "not_found" };
      if (error instanceof ApiError && error.status === 403)
        return { ok: false, error: "forbidden" };
      throw error;
    }
  },
};
