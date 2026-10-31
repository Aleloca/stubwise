import { projectSettingsAccess, type SectionAccess } from "../adminSections";
import { chainProviderNames, isLimited } from "../instance/blocks";
import type { Project } from "../model";
import { capOf } from "../releases/visibility";
import type { ProjectSettingsSection } from "../routes";
import { gate, state, visibleProjectIds } from "../store";
import { viewerFor } from "../viewer";
import { defaultProjectSettings } from "./seed";
import { PROJECT_SWITCHES, type ProjectSettings, type ProjectSwitch } from "./state";

// Le letture delle impostazioni di progetto dell'area 9c (General, AI,
// Automations) e i due aiuti che le scritture e le altre aree condividono:
// il progetto su cui agire (`openProject`) e le sue impostazioni
// (`settingsOf`). R-G5: un progetto che chi guarda non vede, o archiviato,
// è come uno che non c'è (`null`). Le regole («il pulse ha bisogno della
// discovery», l'account scelto eliminato) le dice la lettura: la pagina non
// le ricalcola.

export interface ProjectSettingsView {
  projectId: string;
  code: string;
  name: string;
  description: string;
  ai: {
    /** `null` = «Automatic». Un account eliminato resta qui: lo dice `chosenUnavailable`. */
    providerId: string | null;
    exclusive: boolean;
    /** Gli account per la scelta: solo nome, tipo e stato, mai quota o segreto. */
    choices: {
      id: string;
      name: string;
      kind: "subscription" | "api_key";
      enabled: boolean;
      limited: boolean;
    }[];
    /**
     * L'account scelto è stato eliminato: si dice, e vale «Automatic». Uno
     * spento si legge da `choices[].enabled` (ruling del controller
     * (pre-flight), P15).
     */
    chosenUnavailable: boolean;
    /**
     * I nomi della catena di «Automatic», nell'ordine in cui la prova
     * (`pickProvider`): gli abbonamenti abilitati; la chiave API solo se
     * non ce n'è nessuno. La frase di «Automatic» li legge da qui (Task 7).
     */
    automaticChain: string[];
  };
  switches: Record<ProjectSwitch, boolean>;
  pulseEveryDays: number;
  correctionCap: number;
  /** Il pulse senza discovery backlog non propone niente: la frase la mette la UI. */
  pulseNeedsBacklog: boolean;
  access: Record<ProjectSettingsSection, SectionAccess>;
}

/** Il progetto aperto (non archiviato) che chi guarda vede; `null` altrimenti (R-G5). */
export function openProject(me: string, projectId: string): Project | null {
  return visibleProjectIds(me).has(projectId) ? (state.projectsById.get(projectId) ?? null) : null;
}

/**
 * Le impostazioni di un progetto esistente. Un progetto nato dall'app non
 * è nel seme: la prima lettura gli scrive quelle predefinite, sempre le
 * stesse per lo stesso progetto.
 */
export function settingsOf(project: Project): ProjectSettings {
  const known = state.projectSettings.get(project.id);
  if (known) return known;
  const settings = defaultProjectSettings(project);
  state.projectSettings.set(project.id, settings);
  return settings;
}

/** L'account scelto per il progetto c'era ed è stato eliminato. */
export const chosenUnavailable = (s: ProjectSettings): boolean =>
  s.aiProviderId !== null && !state.instance.providers.some((p) => p.id === s.aiProviderId);

/** Le impostazioni come le legge chi guarda; `null` su un progetto invisibile, archiviato o inesistente. */
export async function getProjectSettings(projectId: string): Promise<ProjectSettingsView | null> {
  const me = await gate("projectSettings.getProjectSettings");
  const project = openProject(me, projectId);
  if (!project) return null;
  const s = settingsOf(project);
  return {
    projectId: project.id,
    code: project.code,
    name: project.name,
    description: project.description ?? "",
    ai: {
      providerId: s.aiProviderId,
      exclusive: s.aiProviderExclusive,
      // Campo per campo, mai `...p`: né la quota né l'id del segreto escono.
      choices: state.instance.providers.map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        enabled: p.enabled,
        limited: isLimited(p),
      })),
      chosenUnavailable: chosenUnavailable(s),
      automaticChain: chainProviderNames(),
    },
    switches: { ...s.switches },
    pulseEveryDays: s.pulseEveryDays,
    correctionCap: capOf(project.id),
    pulseNeedsBacklog: !s.switches.backlogDiscovery,
    access: projectSettingsAccess(viewerFor(me), project.id),
  };
}

/**
 * Se un'automazione del progetto è accesa: la domanda delle altre aree
 * (Task 6). Falso su un progetto archiviato (le sue automazioni si fermano)
 * o inesistente. Non guarda chi chiede: è il lavoro di Claude a chiederlo.
 */
export function projectSwitchOn(projectId: string, sw: ProjectSwitch): boolean {
  const project = state.projectsById.get(projectId);
  if (!project || project.archived || !PROJECT_SWITCHES.includes(sw)) return false;
  return settingsOf(project).switches[sw];
}

/**
 * Gli interruttori del progetto come li legge chi guarda (Task 6): le frasi
 * «off» di brief, Docs notturni, pulse e report giornaliero li leggono da
 * qui (`useProjectSwitches`), mai da una regola propria. `null` su un
 * progetto invisibile, archiviato o inesistente (R-G5): la pagina non dice
 * né «off» né il contrario.
 */
export async function getProjectSwitches(
  projectId: string,
): Promise<Record<ProjectSwitch, boolean> | null> {
  const me = await gate("projectSettings.getProjectSwitches");
  const project = openProject(me, projectId);
  return project ? { ...settingsOf(project).switches } : null;
}
