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
import {
  BASE_PLUGIN,
  RECOMMENDED_PRESETS,
  disabledKeys,
  type ProjectPluginsView,
} from "./pluginDraft";

export {
  BASE_PLUGIN,
  RECOMMENDED_PRESETS,
  applyPluginPreset,
  pluginBothChanged,
  pluginChangedKeys,
  pluginChoosable,
  pluginDisabledInput,
  pluginEnabledInput,
  pluginHookKey,
  pluginKey,
  pluginOffKeys,
  pluginPresetApplied,
  pluginSkillKey,
  reconcilePluginDraft,
  type ProjectPluginsView,
} from "./pluginDraft";

// Progetto → Settings → Plugins (area 9c, Task 4): quali skill e quali
// gruppi di hook dei plugin del registro d'istanza entrano nei run del
// progetto. Si scrive con `project.settings.manage`.
// - Un plugin del registro entra nei run solo se è ACCESO sul progetto
//   (area 9, F5, decisione del maintainer: opt-in, come il server): uno
//   registrato dopo non entra da solo. Dentro un plugin acceso, per
//   sottrazione: skill e gruppi di hook partono accesi, si salva ciò che è
//   spento, per `name` del manifest.
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


const disabledOf = (choices: ProjectPluginChoices, plugin: string) =>
  choices.disabled.find((d) => d.plugin === plugin);

/** Il plugin base come riga della vista: sempre pronto, sempre acceso. */
const baseRow = (): ProjectPluginsView["plugins"][number] => ({
  name: BASE_PLUGIN_SEED.name,
  slug: BASE_PLUGIN_SEED.name,
  status: "ready",
  base: true,
  on: true,
  inRuns: true,
  skills: BASE_PLUGIN_SEED.skills.map((s) => ({ ...s, enabled: true })),
  hooks: [],
  preset: null,
});

function registryRow(
  p: RegisteredPlugin,
  choices: ProjectPluginChoices,
  /** Chi può salvare (`canEdit`): solo lui vede i comandi degli hook. */
  canEdit: boolean,
): ProjectPluginsView["plugins"][number] {
  const off = disabledOf(choices, p.slug);
  const on = choices.enabled.includes(p.slug);
  const skills = p.inventory?.skills ?? [];
  const hooks = p.inventory?.hooks ?? [];
  return {
    name: p.name,
    slug: p.slug,
    status: p.status,
    base: false,
    on,
    inRuns: p.status === "ready" && on,
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
        // Decisione di 46 con 72 (24 nov 2026): il comando a chi può salvare;
        // chi legge soltanto vede il gruppo (le descrizioni delle skill a tutti).
        command: canEdit ? h.command : "",
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
  const canEdit = canI(me, MANAGE_SETTINGS, project.id);
  return {
    version: String(choices.version),
    canEdit,
    plugins: [baseRow(), ...state.instance.plugins.map((p) => registryRow(p, choices, canEdit))],
  };
}

/** La chiave stabile di una skill: `<plugin>:<skill>`. */
function normalized(
  disabled: unknown,
  saved: ProjectPluginChoices["disabled"],
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
    const plugin = state.instance.plugins.find((p) => p.slug === d.plugin);
    if (!plugin) return { reason: "plugin" };
    // Un plugin senza inventario (mai materializzato) non dice le sue skill: si accetta ciò che arriva.
    const skills = plugin.inventory?.skills.map((s) => s.name);
    const hooks = plugin.inventory?.hooks.map((h) => h.key);
    // Ruling (T10): su un plugin `ready`, una scelta già salvata che il suo
    // inventario non ha più (uno sha nuovo l'ha tolta) si scarta, invece di
    // rifiutare il salvataggio per un dato che nessuno può togliere. Un nome
    // che non era fra le scelte salvate resta un `invalid`.
    const was = plugin.status === "ready" ? saved.find((x) => x.plugin === d.plugin) : undefined;
    const keepSkill = (s: string) => !skills || skills.includes(s);
    const keepHook = (h: string) => !hooks || hooks.includes(h);
    if (d.skills.some((s) => !keepSkill(s) && !was?.skills.includes(s))) return { reason: "skill" };
    if (d.hookGroups.some((h) => !keepHook(h) && !was?.hookGroups.includes(h)))
      return { reason: "hook" };
    const row = out.get(d.plugin) ?? { skills: new Set(), hookGroups: new Set() };
    d.skills.filter(keepSkill).forEach((s) => row.skills.add(s));
    d.hookGroups.filter(keepHook).forEach((h) => row.hookGroups.add(h));
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

/** Il rifiuto dei plugin accesi dati: il plugin base, o un nome fuori dal registro. */
function enabledReason(enabled: unknown): string | null {
  if (enabled === undefined) return null;
  if (!Array.isArray(enabled) || enabled.some((n) => typeof n !== "string")) return "enabled";
  for (const name of enabled as string[]) {
    if (name === BASE_PLUGIN) return "base_plugin";
    if (!state.instance.plugins.some((p) => p.slug === name)) return "plugin";
  }
  return null;
}

/**
 * Salva le scelte: quali plugin sono accesi (`enabled`, assente = com'era)
 * e, dentro, ciò che è spento. `conflict` se `version` non è quella
 * di adesso; se va bene, e qualcosa cambia, la versione sale di uno e si
 * scrive una voce sola.
 */
export async function saveProjectPlugins(
  projectId: string,
  input: { version: string; enabled?: string[]; disabled: ProjectPluginChoices["disabled"] },
): Promise<ProjectResult<{ version: string }>> {
  const me = await writer("projectSettings.saveProjectPlugins");
  const managed = managedProject(me, projectId);
  if ("refusal" in managed) return managed.refusal;
  const { project } = managed;
  const choices = settingsOf(project).plugins;
  const clean = normalized(input.disabled, choices.disabled);
  if ("reason" in clean) return refuse.invalid(clean.reason);
  const badEnabled = enabledReason(input.enabled);
  if (badEnabled) return refuse.invalid(badEnabled);
  if (input.version !== String(choices.version)) return refuse.conflict();

  // [PG 4]: le scelte di un plugin non `ready` che l'input non nomina restano.
  const ready = (name: string) =>
    state.instance.plugins.some((p) => p.slug === name && p.status === "ready");
  const disabled = [
    ...clean.disabled,
    ...choices.disabled.filter((d) => !clean.named.has(d.plugin) && !ready(d.plugin)),
  ].sort((a, b) => a.plugin.localeCompare(b.plugin));
  // F5: un pronto è acceso se l'input lo nomina; un non pronto resta com'era
  // finché l'input non lo nomina (la pagina non lo sceglie, [PG 4]).
  const wanted = input.enabled;
  const enabled = wanted
    ? state.instance.plugins
        .filter(
          (p) =>
            wanted.includes(p.slug) || (p.status !== "ready" && choices.enabled.includes(p.slug)),
        )
        .map((p) => p.slug)
    : choices.enabled;
  const fields = (on: string[], off: ProjectPluginChoices["disabled"]) => ({
    enabledPlugins: [...on].sort(),
    ...disabledKeys(off),
  });
  const diff = changedFields(fields(choices.enabled, choices.disabled), fields(enabled, disabled));
  if (!diff) return { ok: true, version: String(choices.version) };
  choices.enabled = enabled;
  choices.disabled = disabled;
  choices.version += 1;
  recordChange({
    kind: "project.plugins_changed",
    actorId: me,
    projectId: project.id,
    object: projectObject(project),
    ...diff,
  });
  return { ok: true, version: String(choices.version) };
}

/**
 * Le skill che entrano nei run (e in «/») di un progetto: quelle dei plugin
 * `ready` del registro accesi sul progetto, meno le spente, poi il plugin base. Non guarda chi
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
    .filter((p) => p.status === "ready" && choices.enabled.includes(p.slug))
    .flatMap((p) => {
      const off = disabledOf(choices, p.slug);
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
