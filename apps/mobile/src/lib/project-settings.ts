import { ApiError } from "@stubwise/api-client";
import type { UpdateProjectInput } from "@stubwise/shared";

/**
 * Le impostazioni di un progetto che l'app mostra e — per un maintainer —
 * modifica (23 set 2026, hub di progetto, tappa 3). Gli stessi campi del form
 * del web, meno il provider AI: scegliere un provider richiede l'elenco dei
 * provider d'istanza, che è configurazione da computer.
 */
export interface ProjectSettingsValues {
  name: string;
  description: string | null;
  docAutoUpdate: boolean;
  dailyReportEnabled: boolean;
  backlogEnabled: boolean;
  pulseEnabled: boolean;
  pulseEveryDays: number;
  weeklyBriefEnabled: boolean;
}

/** Ciò che l'utente ha TOCCATO, campo per campo. Un campo assente non è stato toccato. */
export type ProjectSettingsEdits = Partial<ProjectSettingsValues>;

export const PULSE_DAYS_MIN = 1;
export const PULSE_DAYS_MAX = 30;

/**
 * Il valore da MOSTRARE: quello toccato, o altrimenti quello del server.
 *
 * ⚠️ Il form tiene solo le modifiche, non una copia intera del progetto: i
 * campi non toccati si leggono sempre dal server, quindi se un collega ne
 * cambia uno mentre questa schermata è aperta, al primo refetch lo si vede —
 * e non lo si riscrive col valore vecchio al salvataggio.
 */
export function effectiveSettings(project: ProjectSettingsValues, edits: ProjectSettingsEdits): ProjectSettingsValues {
  return { ...project, ...edits };
}

/**
 * La PATCH da mandare: SOLO i campi toccati il cui valore differisce da quello
 * del server. Mai l'oggetto intero — due persone che salvano dalla stessa
 * schermata non devono sovrascriversi i campi che nessuna delle due ha
 * toccato.
 *
 * La descrizione vuota (o di soli spazi) diventa `null`, come sul web: lo
 * schema del corpo rifiuta la stringa vuota.
 */
export function settingsPatch(project: ProjectSettingsValues, edits: ProjectSettingsEdits): UpdateProjectInput {
  const patch: UpdateProjectInput = {};
  if (edits.name !== undefined) {
    const name = edits.name.trim();
    if (name !== project.name) patch.name = name;
  }
  if (edits.description !== undefined) {
    const trimmed = edits.description?.trim() ?? "";
    const description = trimmed === "" ? null : trimmed;
    if (description !== project.description) patch.description = description;
  }
  const toggles = ["docAutoUpdate", "dailyReportEnabled", "backlogEnabled", "pulseEnabled", "weeklyBriefEnabled"] as const;
  for (const key of toggles) {
    const value = edits[key];
    if (value !== undefined && value !== project[key]) patch[key] = value;
  }
  if (edits.pulseEveryDays !== undefined && edits.pulseEveryDays !== project.pulseEveryDays) {
    patch.pulseEveryDays = edits.pulseEveryDays;
  }
  return patch;
}

/** Il nome è obbligatorio (lo schema del corpo lo vuole di almeno un carattere). */
export function settingsInvalid(values: ProjectSettingsValues): boolean {
  return values.name.trim() === "";
}

/**
 * LA RIGA DEL PULSE in sola lettura, come la dice il web
 * (`projects:detail.pulseWaitingBacklog`).
 *
 * ⚠️ Acceso ma senza backlog, il pulse è MUTO: non ha voci da proporre. Il web
 * lo dice nel valore invece di mostrare una cadenza che non succederà, e
 * l'app dice la stessa cosa — due superfici che spiegano diversamente lo
 * stesso stato sono un modo di sbagliare che qui si evita a costo zero.
 */
export function pulseValue(values: Pick<ProjectSettingsValues, "pulseEnabled" | "backlogEnabled" | "pulseEveryDays">):
  | { key: "mobile.projects.settings.pulseOff" }
  | { key: "mobile.projects.settings.pulseWaitingBacklog" }
  | { key: "mobile.projects.settings.pulseEvery"; count: number } {
  if (!values.pulseEnabled) return { key: "mobile.projects.settings.pulseOff" };
  if (!values.backlogEnabled) return { key: "mobile.projects.settings.pulseWaitingBacklog" };
  return { key: "mobile.projects.settings.pulseEvery", count: values.pulseEveryDays };
}

/**
 * Il messaggio di un salvataggio fallito. Un 403 si MOSTRA per quello che è
 * — solo un maintainer modifica — e non si ingoia: capita a chi aveva la
 * schermata aperta quando gli è stato tolto il ruolo.
 */
export function settingsErrorKey(error: unknown): "mobile.projects.settings.errors.forbidden" | "mobile.projects.settings.errors.generic" {
  if (error instanceof ApiError && error.status === 403) return "mobile.projects.settings.errors.forbidden";
  return "mobile.projects.settings.errors.generic";
}
