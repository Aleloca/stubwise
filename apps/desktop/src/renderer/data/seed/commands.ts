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

/** Un plugin del registro d'istanza: `name` è il nome del manifest, che fa da namespace delle skill. */
export interface RegisteredPlugin {
  id: string;
  name: string;
  skills: PluginSkill[];
}

export const PLUGINS: RegisteredPlugin[] = [
  {
    id: "plg-superpowers",
    name: "superpowers",
    skills: [
      { name: "brainstorming", description: "Explore the idea and the design before writing code" },
      { name: "writing-plans", description: "Turn a design into a step-by-step plan" },
      {
        name: "test-driven-development",
        description: "Write the failing test first, then the code",
      },
      { name: "systematic-debugging", description: "Find the root cause before proposing a fix" },
      {
        name: "requesting-code-review",
        description: "Check the work against the plan before merging",
      },
    ],
  },
  {
    id: "plg-stubwise",
    name: "stubwise",
    skills: [
      { name: "stubwise", description: "Link designs and plans to requests and tasks" },
      { name: "init", description: "Connect a repository to its Stubwise project" },
      { name: "start", description: "Start a plan: task, design and plan, in progress" },
    ],
  },
];

/**
 * Il plugin base (area 9c, ruling del controller del 31 ott 2026): vale per
 * tutti i progetti, non sta fra le scelte e non si spegne. Le sue skill
 * stanno in coda a «/» in ogni contesto di progetto.
 */
export const BASE_PLUGIN_ID = "plg-stubwise";

export interface ProjectPluginEnablement {
  pluginId: string;
  /** Le skill spente nel progetto (abilitazioni per sottrazione: di base tutto acceso). */
  disabledSkills: string[];
}

const SOFTWARE = PROJECTS.filter((p) => p.template === "software");
/** Un progetto software senza plugin: «/» mostra solo i comandi di Stubwise. */
const WITHOUT_PLUGINS = new Set(["prj-znc"]);

/**
 * I plugin scelti per progetto: superpowers su tutti i progetti software
 * (tranne uno); in AUD una skill è spenta. Il plugin base `stubwise` non sta
 * qui: vale per tutti (`BASE_PLUGIN_ID`).
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

const skillCommands = ({ pluginId, disabledSkills }: ProjectPluginEnablement): SlashCommand[] => {
  const plugin = PLUGINS.find((p) => p.id === pluginId);
  if (!plugin) return [];
  return plugin.skills
    .filter((s) => !disabledSkills.includes(s.name))
    .map<SlashCommand>((s) => ({
      id: `${plugin.name}:${s.name}`,
      label: `/${plugin.name}:${s.name}`,
      description: s.description,
      source: { plugin: plugin.name, skill: s.name },
    }));
};

/**
 * I comandi di «/» per un contesto di progetto: quelli di Stubwise, poi le
 * skill dei plugin scelti nel progetto, senza quelle spente, e in coda
 * quelle del plugin base, in ogni progetto. Senza contesto, solo i comandi
 * di Stubwise.
 */
export function commandsFor(projectId: string | null): SlashCommand[] {
  if (projectId === null) return STUBWISE_COMMANDS;
  const chosen = (PROJECT_PLUGINS[projectId] ?? []).flatMap(skillCommands);
  const base = skillCommands({ pluginId: BASE_PLUGIN_ID, disabledSkills: [] });
  return [...STUBWISE_COMMANDS, ...chosen, ...base];
}
