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
    ["plan-week", "Plan your next week from the open tasks"],
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

export interface ProjectPluginEnablement {
  pluginId: string;
  /** Le skill spente nel progetto (abilitazioni per sottrazione: di base tutto acceso). */
  disabledSkills: string[];
}

const SOFTWARE = PROJECTS.filter((p) => p.template === "software");
/** Un progetto software senza plugin: «/» mostra solo i comandi di Stubwise. */
const WITHOUT_PLUGINS = new Set(["prj-znc"]);

/**
 * I plugin abilitati per progetto: superpowers su tutti i progetti software
 * (tranne uno), stubwise su STW e AUD; in AUD due skill sono spente.
 */
export const PROJECT_PLUGINS: Record<string, ProjectPluginEnablement[]> = Object.fromEntries(
  SOFTWARE.filter((p) => !WITHOUT_PLUGINS.has(p.id)).map((p) => {
    const enabled: ProjectPluginEnablement[] = [
      {
        pluginId: "plg-superpowers",
        disabledSkills: p.code === "AUD" ? ["test-driven-development"] : [],
      },
    ];
    if (p.code === "STW" || p.code === "AUD") {
      enabled.push({ pluginId: "plg-stubwise", disabledSkills: p.code === "AUD" ? ["start"] : [] });
    }
    return [p.id, enabled];
  }),
);

/**
 * I comandi di «/» per un contesto di progetto: quelli di Stubwise, poi le
 * skill dei plugin abilitati nel progetto, senza quelle spente. Senza
 * contesto, solo i comandi di Stubwise.
 */
export function commandsFor(projectId: string | null): SlashCommand[] {
  if (projectId === null) return STUBWISE_COMMANDS;
  const skills = (PROJECT_PLUGINS[projectId] ?? []).flatMap(({ pluginId, disabledSkills }) => {
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
  });
  return [...STUBWISE_COMMANDS, ...skills];
}
