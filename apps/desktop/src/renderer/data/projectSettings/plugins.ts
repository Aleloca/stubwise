import { recordChange } from "../changelog/index";
import { changedFields } from "../changelog/settingValues";
import type { RegisteredPlugin } from "../instance/state";
import { BASE_PLUGIN_SEED } from "../seed/commands";
import { gate, state } from "../store";
import { writer } from "../writer";
import { MANAGE_SETTINGS, canI, managedProject, projectObject, refuse } from "./common";
import { openProject, settingsOf } from "./reads";
import type { ProjectPluginChoices } from "./state";
import type { ProjectResult } from "./types";

// Progetto → Settings → Plugins (area 9c, Task 4): quali skill e quali
// gruppi di hook dei plugin del registro d'istanza entrano nei run del
// progetto. Per sottrazione, come sul web: di base tutto acceso, si
// salva ciò che è spento, per `name` del manifest. Si scrive con
// `project.settings.manage`.
// - Il plugin base `stubwise` (le skill di Stubwise in «/») sta fuori dal
//   registro e non si spegne, come `stubwise-base` del worker (scelta del
//   controller): fra gli spenti è `invalid: "base_plugin"`.
// - Un plugin del registro non `ready` compare con `inRuns: false`: il suo
//   stato ne è la ragione, e le sue skill non entrano in nessun run. Le
//   scelte salvate per lui restano e valgono quando sarà pronto ([PG 4]):
//   la vista le mostra anche senza inventario, e un salvataggio che non lo
//   nomina le tiene (nominarlo con le liste vuote lo riaccende).
// - Una persona per volta (RF 5): il salvataggio porta la `version` letta;
//   se nel frattempo un altro ha salvato è `conflict`, e niente si scrive.
//   Quale bozza tenere lo sceglie la persona nella UI (maintainer, [PG 5]).
// - Una voce sola per salvataggio, con le liste di ciò che è spento prima e
//   dopo, in chiavi stabili: `<plugin>:<skill>` e `<plugin>#<Evento>#<i>`.

/** Il nome del manifest del plugin base. */
export const BASE_PLUGIN = "stubwise";

/**
 * I preset consigliati, chiavati sul `name` del manifest (non sullo slug):
 * per superpowers le quattro skill che rifanno il lavoro della pipeline
 * (worktree, branch, agenti paralleli), come sul web.
 */
export const RECOMMENDED_PRESETS: Readonly<Record<string, readonly string[]>> = {
  superpowers: [
    "using-git-worktrees",
    "finishing-a-development-branch",
    "dispatching-parallel-agents",
    "subagent-driven-development",
  ],
};

export interface ProjectPluginsView {
  version: number;
  canEdit: boolean;
  plugins: {
    name: string;
    slug: string;
    status: "ready" | "materializing" | "failed";
    base: boolean;
    inRuns: boolean;
    skills: { name: string; description: string; enabled: boolean }[];
    hooks: { key: string; event: string; command: string; enabled: boolean }[];
    preset: string[] | null;
  }[];
}

const disabledOf = (choices: ProjectPluginChoices, plugin: string) =>
  choices.disabled.find((d) => d.plugin === plugin);

/** Il plugin base come riga della vista: sempre pronto, sempre acceso. */
const baseRow = (): ProjectPluginsView["plugins"][number] => ({
  name: BASE_PLUGIN_SEED.name,
  slug: BASE_PLUGIN_SEED.name,
  status: "ready",
  base: true,
  inRuns: true,
  skills: BASE_PLUGIN_SEED.skills.map((s) => ({ ...s, enabled: true })),
  hooks: [],
  preset: null,
});

function registryRow(
  p: RegisteredPlugin,
  choices: ProjectPluginChoices,
): ProjectPluginsView["plugins"][number] {
  const off = disabledOf(choices, p.name);
  const skills = p.inventory?.skills ?? [];
  const hooks = p.inventory?.hooks ?? [];
  return {
    name: p.name,
    slug: p.slug,
    status: p.status,
    base: false,
    inRuns: p.status === "ready",
    skills: [
      ...skills.map((s) => ({
        name: s.name,
        description: s.description,
        enabled: !off?.skills.includes(s.name),
      })),
      // Le scelte salvate che l'inventario (assente, o di un altro sha) non conosce: si vedono.
      ...(off?.skills ?? [])
        .filter((name) => !skills.some((s) => s.name === name))
        .map((name) => ({ name, description: "", enabled: false })),
    ],
    hooks: [
      ...hooks.map((h) => ({
        key: h.key,
        event: h.event,
        command: h.command,
        enabled: !off?.hookGroups.includes(h.key),
      })),
      ...(off?.hookGroups ?? [])
        .filter((key) => !hooks.some((h) => h.key === key))
        .map((key) => ({ key, event: key.split("#")[0]!, command: "", enabled: false })),
    ],
    preset: RECOMMENDED_PRESETS[p.name] ? [...RECOMMENDED_PRESETS[p.name]!] : null,
  };
}

/** I plugin del progetto come li legge chi guarda; `null` su un progetto invisibile o archiviato. */
export async function getProjectPlugins(projectId: string): Promise<ProjectPluginsView | null> {
  const me = await gate("projectSettings.getProjectPlugins");
  const project = openProject(me, projectId);
  if (!project) return null;
  const choices = settingsOf(project).plugins;
  return {
    version: choices.version,
    canEdit: canI(me, MANAGE_SETTINGS, project.id),
    plugins: [baseRow(), ...state.instance.plugins.map((p) => registryRow(p, choices))],
  };
}

/** Le chiavi stabili di ciò che è spento, ordinate: le liste della voce. */
function disabledKeys(choices: ProjectPluginChoices["disabled"]): {
  disabledSkills: string[];
  disabledHooks: string[];
} {
  return {
    disabledSkills: choices.flatMap((d) => d.skills.map((s) => `${d.plugin}:${s}`)).sort(),
    disabledHooks: choices.flatMap((d) => d.hookGroups.map((h) => `${d.plugin}#${h}`)).sort(),
  };
}

/** Le scelte date, validate e ripulite (righe vuote via, liste ordinate e senza doppioni). */
function normalized(
  disabled: unknown,
): { disabled: ProjectPluginChoices["disabled"]; named: Set<string> } | { reason: string } {
  if (!Array.isArray(disabled)) return { reason: "disabled" };
  const out = new Map<string, { skills: Set<string>; hookGroups: Set<string> }>();
  for (const d of disabled as ProjectPluginChoices["disabled"]) {
    if (
      !d ||
      typeof d.plugin !== "string" ||
      !Array.isArray(d.skills) ||
      !Array.isArray(d.hookGroups)
    )
      return { reason: "disabled" };
    if (d.plugin === BASE_PLUGIN) return { reason: "base_plugin" };
    const plugin = state.instance.plugins.find((p) => p.name === d.plugin);
    if (!plugin) return { reason: "plugin" };
    // Un plugin senza inventario (mai materializzato) non dice le sue skill: si accetta ciò che arriva.
    const skills = plugin.inventory?.skills.map((s) => s.name);
    const hooks = plugin.inventory?.hooks.map((h) => h.key);
    if (skills && d.skills.some((s) => !skills.includes(s))) return { reason: "skill" };
    if (hooks && d.hookGroups.some((h) => !hooks.includes(h))) return { reason: "hook" };
    const row = out.get(d.plugin) ?? { skills: new Set(), hookGroups: new Set() };
    d.skills.forEach((s) => row.skills.add(s));
    d.hookGroups.forEach((h) => row.hookGroups.add(h));
    out.set(d.plugin, row);
  }
  return {
    named: new Set(out.keys()),
    disabled: [...out.entries()]
      .filter(([, r]) => r.skills.size > 0 || r.hookGroups.size > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([plugin, r]) => ({
        plugin,
        skills: [...r.skills].sort(),
        hookGroups: [...r.hookGroups].sort(),
      })),
  };
}

/**
 * Salva le scelte (ciò che è spento). `conflict` se `version` non è quella
 * di adesso; se va bene, e qualcosa cambia, la versione sale di uno e si
 * scrive una voce sola.
 */
export async function saveProjectPlugins(
  projectId: string,
  input: { version: number; disabled: ProjectPluginChoices["disabled"] },
): Promise<ProjectResult<{ version: number }>> {
  const me = await writer("projectSettings.saveProjectPlugins");
  const managed = managedProject(me, projectId);
  if ("refusal" in managed) return managed.refusal;
  const { project } = managed;
  const clean = normalized(input.disabled);
  if ("reason" in clean) return refuse.invalid(clean.reason);
  const choices = settingsOf(project).plugins;
  if (input.version !== choices.version) return refuse.conflict();

  // [PG 4]: le scelte di un plugin non `ready` che l'input non nomina restano.
  const ready = (name: string) =>
    state.instance.plugins.some((p) => p.name === name && p.status === "ready");
  const disabled = [
    ...clean.disabled,
    ...choices.disabled.filter((d) => !clean.named.has(d.plugin) && !ready(d.plugin)),
  ].sort((a, b) => a.plugin.localeCompare(b.plugin));
  const diff = changedFields(disabledKeys(choices.disabled), disabledKeys(disabled));
  if (!diff) return { ok: true, version: choices.version };
  choices.disabled = disabled;
  choices.version += 1;
  recordChange({
    kind: "project.plugins_changed",
    actorId: me,
    projectId: project.id,
    object: projectObject(project),
    ...diff,
  });
  return { ok: true, version: choices.version };
}

/**
 * Le skill che entrano nei run (e in «/») di un progetto: quelle dei plugin
 * `ready` del registro, meno le spente, poi il plugin base. Non guarda chi
 * chiede: è il lavoro di Claude a chiederlo. Un progetto inesistente non ne
 * ha.
 */
export function skillsForRun(
  projectId: string,
): { plugin: string; skill: string; description: string }[] {
  const project = state.projectsById.get(projectId);
  if (!project) return [];
  const choices = settingsOf(project).plugins;
  const chosen = state.instance.plugins
    .filter((p) => p.status === "ready")
    .flatMap((p) => {
      const off = disabledOf(choices, p.name);
      return (p.inventory?.skills ?? [])
        .filter((s) => !off?.skills.includes(s.name))
        .map((s) => ({ plugin: p.name, skill: s.name, description: s.description }));
    });
  const base = BASE_PLUGIN_SEED.skills.map((s) => ({
    plugin: BASE_PLUGIN_SEED.name,
    skill: s.name,
    description: s.description,
  }));
  return [...chosen, ...base];
}
