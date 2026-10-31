import type { TestOutcome } from "../instance/state";

// Lo stato delle impostazioni di progetto dell'area 9c (Progetto →
// Settings): l'account AI, gli interruttori delle automazioni, l'intervallo
// del pulse, la chiave d'ingestione e le scelte dei plugin, uno per
// progetto, in `state.projectSettings` (`store.ts`). Il seme lo dà
// `seed.ts`. Modulo foglia per lo store: lo leggono `store.ts`,
// `adminSections.ts` e il registro, quindi qui non si importa né lo store
// né il caveau dei segreti (`architecture.secrets.test.ts`).
//
// Un segreto (la chiave d'ingestione) qui non c'è mai: solo il suo id nel
// caveau (`admin/secrets.ts`) e le ultime 4 cifre.

/** Gli interruttori delle automazioni di un progetto, nell'ordine della sezione Automations. */
export const PROJECT_SWITCHES = [
  "docsNightly",
  "dailyReport",
  "backlogDiscovery",
  "pulse",
  "weeklyBrief",
] as const;
export type ProjectSwitch = (typeof PROJECT_SWITCHES)[number];

/** Ogni quanti giorni il pulse guarda il progetto: come il CHECK del web. */
export const PULSE_DAYS_MIN = 1;
export const PULSE_DAYS_MAX = 30;
/** Il tetto delle correzioni automatiche per PR; 0 = ciclo automatico spento. */
export const CORRECTION_CAP_MIN = 0;
export const CORRECTION_CAP_MAX = 10;

export interface ProjectPluginChoices {
  /** Cresce a ogni salvataggio: il controllo del «una persona per volta». */
  version: number;
  /** Per sottrazione: ciò che è spento, per `name` del manifest. Assente = tutto acceso. */
  disabled: { plugin: string; skills: string[]; hookGroups: string[] /* "SessionStart#0" */ }[];
}

export interface ProjectSettings {
  projectId: string;
  /** `null` = «Automatic» (la catena dell'istanza). */
  aiProviderId: string | null;
  aiProviderExclusive: boolean;
  switches: Record<ProjectSwitch, boolean>;
  pulseEveryDays: number;
  /** La chiave d'ingestione: solo l'id nel caveau (null nel seme: mai mostrata) e le ultime 4. */
  ingestion: { secretId: string | null; last4: string; createdAt: string };
  plugins: ProjectPluginChoices;
}

/**
 * Un progetto eliminato (Task 5): resta solo questa riga, perché la voce
 * `project.deleted` e la provenienza di un repository senza progetto si
 * risolvano a lettura per i suoi ex membri e per il full admin (R-G5).
 */
export interface DeletedProject {
  id: string;
  code: string;
  name: string;
  memberIds: string[];
  deletedAt: string;
  deletedById: string;
}

/**
 * Le verifiche d'accesso dei repository (Task 4: una creazione chiede una
 * verifica `ok` della stessa terna, fatta da chi crea) e gli esiti simulati
 * del riquadro «Prototype only». Stanno nello stato, con `freshState`: una
 * variabile di modulo non si azzererebbe con `resetApi` (ruling del
 * controller (pre-flight), P29).
 */
export interface RepositoryChecksState {
  checks: {
    personId: string;
    projectId: string;
    gitAccountId: string;
    fullName: string;
    branch: string;
    outcome: TestOutcome;
    at: string;
  }[];
  /** L'esito della prossima verifica d'accesso; `null` = quello vero (`ok`). */
  nextRepositoryCheck: TestOutcome | null;
  /** L'esito della prossima configurazione automatica del webhook; `null` = `configured`. */
  nextWebhookSetup: "configured" | "failed" | null;
}

export function emptyRepositoryChecks(): RepositoryChecksState {
  return { checks: [], nextRepositoryCheck: null, nextWebhookSetup: null };
}
