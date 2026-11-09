import type { ProjectPluginChoices } from "./state";

// La bozza della sezione Plugins (area 9c, Task 4): chiavi, preset, scelte e
// conflitti, funzioni pure. `plugins.ts` (la lettura e il salvataggio sullo
// stato) le ri-esporta; stanno qui perché le superfici le importano anche
// nella build app (integrazione area 2, fetta 1).

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

export const pluginSkillKey = (plugin: string, skill: string) => `${plugin}:${skill}`;
/** La chiave stabile di un gruppo di hook: `<plugin>#<Evento>#<i>`. */
export const pluginHookKey = (plugin: string, hookGroup: string) => `${plugin}#${hookGroup}`;

/** Le chiavi stabili di ciò che è spento, ordinate: le liste della voce. */
/** Le chiavi spente salvate (`<plugin>:<skill>`, `<plugin>#<gruppo>`): la usa anche il salvataggio. */
export function disabledKeys(choices: ProjectPluginChoices["disabled"]): {
  disabledSkills: string[];
  disabledHooks: string[];
} {
  return {
    disabledSkills: choices.flatMap((d) => d.skills.map((s) => pluginSkillKey(d.plugin, s))).sort(),
    disabledHooks: choices
      .flatMap((d) => d.hookGroups.map((h) => pluginHookKey(d.plugin, h)))
      .sort(),
  };
}

// --- La bozza della pagina (Task 10) -----------------------------------------
//
// La pagina tiene la bozza come insieme di chiavi stabili spente, e queste
// funzioni pure le dicono le regole: quali plugin si scelgono (i `ready` del
// registro: il plugin base non si spegne, i non pronti non si nominano e le
// loro scelte restano, [PG 4]), cosa fa il preset e come si riconcilia una
// bozza dopo un `conflict` ([PG 5]). Così la pagina non le ricalcola.

type PluginRow = ProjectPluginsView["plugins"][number];

/** Se le righe di un plugin si scelgono in questa sezione: i `ready` del registro. */
export const pluginChoosable = (p: PluginRow): boolean => !p.base && p.status === "ready";

/** Le chiavi spente di un plugin della vista. */
function offKeysOfPlugin(p: PluginRow): string[] {
  return [
    ...p.skills.filter((s) => !s.enabled).map((s) => pluginSkillKey(p.name, s.name)),
    ...p.hooks.filter((h) => !h.enabled).map((h) => pluginHookKey(p.name, h.key)),
  ];
}

/** Le chiavi spente della vista, dei soli plugin che si scelgono: il punto di partenza della bozza. */
export function pluginOffKeys(view: ProjectPluginsView): Set<string> {
  return new Set(view.plugins.filter(pluginChoosable).flatMap(offKeysOfPlugin));
}

/**
 * L'input di `saveProjectPlugins` da una bozza: nomina ogni plugin che si
 * sceglie (anche tutto acceso: è così che si riaccende), e mai i non pronti,
 * le cui scelte il livello dati tiene com'erano ([PG 4]).
 */
export function pluginDisabledInput(
  view: ProjectPluginsView,
  keys: ReadonlySet<string>,
): ProjectPluginChoices["disabled"] {
  return view.plugins.filter(pluginChoosable).map((p) => ({
    plugin: p.name,
    skills: p.skills.filter((s) => keys.has(pluginSkillKey(p.name, s.name))).map((s) => s.name),
    hookGroups: p.hooks.filter((h) => keys.has(pluginHookKey(p.name, h.key))).map((h) => h.key),
  }));
}

/** Le chiavi del preset di un plugin che il suo inventario ha davvero. */
const presetKeys = (p: PluginRow): string[] =>
  (p.preset ?? [])
    .filter((name) => p.skills.some((s) => s.name === name))
    .map((name) => pluginSkillKey(p.name, name));

/**
 * Il preset consigliato sulla bozza ([PG 3]): spegne le sue skill e non
 * tocca nient'altro. `turnedOff` quante erano accese.
 */
export function applyPluginPreset(
  p: PluginRow,
  keys: ReadonlySet<string>,
): { keys: Set<string>; turnedOff: number } {
  const next = new Set(keys);
  let turnedOff = 0;
  for (const key of presetKeys(p))
    if (!next.has(key)) {
      next.add(key);
      turnedOff++;
    }
  return { keys: next, turnedOff };
}

/** Vero se le skill del preset sono già tutte spente nella bozza: il bottone è spento per regola. */
export function pluginPresetApplied(p: PluginRow, keys: ReadonlySet<string>): boolean {
  const preset = presetKeys(p);
  return preset.length > 0 && preset.every((key) => keys.has(key));
}

/** Le chiavi che cambiano fra due insiemi. */
function changedKeys(a: ReadonlySet<string>, b: ReadonlySet<string>): Set<string> {
  return new Set([...a, ...b].filter((key) => a.has(key) !== b.has(key)));
}

/**
 * «Keep my changes on theirs» ([PG 5]): la base diventa la versione nuova
 * (`theirs`), e sopra si rimettono solo le righe che ho cambiato io rispetto
 * alla versione da cui ero partita (`start`), chiavate sui nomi stabili, mai
 * sulle posizioni. `bothChanged`: le righe che abbiamo cambiato entrambi.
 */
export function reconcilePluginDraft(
  start: ReadonlySet<string>,
  mine: ReadonlySet<string>,
  theirs: ReadonlySet<string>,
): { keys: Set<string>; bothChanged: string[] } {
  const myChanges = changedKeys(start, mine);
  const theirChanges = changedKeys(start, theirs);
  const keys = new Set(theirs);
  for (const key of myChanges) {
    if (mine.has(key)) keys.add(key);
    else keys.delete(key);
  }
  return { keys, bothChanged: [...myChanges].filter((key) => theirChanges.has(key)).sort() };
}

/** Le righe cambiate da entrambi, dopo un `conflict` e prima della scelta. */
export function pluginBothChanged(
  start: ReadonlySet<string>,
  mine: ReadonlySet<string>,
  theirs: ReadonlySet<string>,
): string[] {
  return reconcilePluginDraft(start, mine, theirs).bothChanged;
}

/** Le righe cambiate nella bozza rispetto alla base. */
export function pluginChangedKeys(
  base: ReadonlySet<string>,
  draft: ReadonlySet<string>,
): Set<string> {
  return changedKeys(base, draft);
}

/** Le scelte date, validate e ripulite (righe vuote via, liste ordinate e senza doppioni). */
