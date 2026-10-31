import type { SlashCommand } from "../types";
import { PROJECTS } from "./projects";

/**
 * I comandi «/» di Stubwise: le azioni che una persona fa a mano, dette a
 * Claude. Ci sono sempre, anche senza un contesto di progetto.
 */
export const STUBWISE_COMMANDS: SlashCommand[] = (
  [
    ["status", "Where the projects stand: pulse of your pinned projects"],
    ["today", "What you have to do today: decisions, late tasks, your week"],
    ["explain", "Explain a task or a request, by its code"],
    ["plan", "Plan your next week from the open tasks"],
    ["new-task", "Create a task, with a proposal to confirm"],
    ["new-request", "Open a request in a project"],
    ["run", "Start Claude's work on a task or a request"],
    ["docs", "How something works in a project, from its Docs"],
  ] as const
).map<SlashCommand>(([id, description]) => ({
  id: `cmd-${id}`,
  label: `/${id}`,
  description,
  source: "stubwise",
}));

export interface PluginSkill {
  name: string;
  description: string;
}

/**
 * Il plugin base (area 9c, ruling del controller del 31 ott 2026): le skill
 * di Stubwise in «/». Vale per tutti i progetti, sta fuori dal registro
 * d'istanza, non sta fra le scelte e non si spegne, come `stubwise-base` del
 * worker. `name` è il nome del manifest, che fa da namespace delle skill.
 */
export const BASE_PLUGIN_SEED: { name: string; skills: readonly PluginSkill[] } = {
  name: "stubwise",
  skills: [
    { name: "stubwise", description: "Link designs and plans to requests and tasks" },
    { name: "init", description: "Connect a repository to its Stubwise project" },
    { name: "start", description: "Start a plan: task, design and plan, in progress" },
  ],
};

export interface ProjectPluginEnablement {
  /** Il plugin del registro d'istanza (`state.instance.plugins`). */
  pluginId: string;
  /** Le skill spente nel progetto (abilitazioni per sottrazione: di base tutto acceso). */
  disabledSkills: string[];
}

const SOFTWARE = PROJECTS.filter((p) => p.template === "software");
/** Un progetto software senza plugin: «/» mostra i comandi di Stubwise e il plugin base. */
const WITHOUT_PLUGINS = new Set(["prj-znc"]);

/**
 * Il seme delle scelte dei plugin (area 9c, ruling del controller
 * (pre-flight), P3): superpowers del registro su tutti i progetti software
 * (tranne ZNC); in AUD una skill è spenta. Lo legge solo
 * `projectSettings/seed.ts`, che ne fa le scelte per sottrazione: i progetti
 * che qui non ci sono nascono con superpowers tutto spento. Le skill vere le
 * dà il registro, e chi entra in «/» lo decide `skillsForRun`
 * (`projectSettings/plugins.ts`): un modulo del seme non legge lo stato vivo
 * (P4).
 */
export const PROJECT_PLUGINS: Record<string, ProjectPluginEnablement[]> = Object.fromEntries(
  SOFTWARE.filter((p) => !WITHOUT_PLUGINS.has(p.id)).map((p) => [
    p.id,
    [
      {
        pluginId: "plg-superpowers",
        disabledSkills: p.code === "AUD" ? ["test-driven-development"] : [],
      },
    ],
  ]),
);

/** Il comando di «/» di una skill di un plugin: `/<plugin>:<skill>`. */
export const pluginSkillCommand = (s: {
  plugin: string;
  skill: string;
  description: string;
}): SlashCommand => ({
  id: `${s.plugin}:${s.skill}`,
  label: `/${s.plugin}:${s.skill}`,
  description: s.description,
  source: { plugin: s.plugin, skill: s.skill },
});
