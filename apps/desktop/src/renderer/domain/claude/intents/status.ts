import type { Project, ProjectPulse } from "../../../data/types";
import { labelled, sayDate, type Answer } from "../answers";
import type { IntentContext, T } from "../context";
import { findProject } from "../parse";

const MAX_PROJECTS = 8;

/**
 * «A che punto sono i progetti»: il polso dei progetti fissati (o di tutti
 * quelli visibili, se non ne ha fissati); di uno solo, se il messaggio o il
 * contesto lo nomina, con la prima riga del brief settimanale.
 */
export async function status(text: string, ctx: IntentContext): Promise<Answer> {
  const { read, t } = ctx;
  const projects = await read.listProjects();
  const { project, named } = findProject(text, projects, ctx.contextProjectId);
  if (named && !project) {
    return { actions: [], text: t("claude.answers.status.projectNotFound", { code: named }) };
  }
  const pulses = await read.listProjectPulses();
  const byId = new Map(projects.map((p) => [p.id, p]));

  if (project) {
    const pulse = pulses.find((p) => p.projectId === project.id);
    const brief = await read.getLatestBrief(project.id);
    const lines = [line(t, project, pulse)];
    if (brief) lines.push("", t("claude.answers.status.brief", { headline: brief.headline }));
    return {
      actions: [
        {
          tool: "get_project_pulse",
          ...labelled(t, "claude.answers.actions.readProject", { code: project.code }),
        },
      ],
      text: lines.join("\n"),
      refs: [{ kind: "project", id: project.id }],
    };
  }

  const pinned = await read.listPinnedProjectIds();
  const chosen = (pinned.length > 0 ? pinned : projects.map((p) => p.id))
    .map((id) => byId.get(id))
    .filter((p): p is Project => p !== undefined);
  if (chosen.length === 0) return { actions: [], text: t("claude.answers.status.none") };
  // Prima chi aspetta te, poi chi ha task ferme: l'ordine dice cosa guardare.
  const rank = (p: Project) => {
    const pulse = pulses.find((x) => x.projectId === p.id);
    return pulse?.waitingOnMe ? 0 : pulse && pulse.stalled > 0 ? 1 : 2;
  };
  const ordered = chosen
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
    .map((x) => x.p);
  const shown = ordered.slice(0, MAX_PROJECTS);
  const body = [
    t(pinned.length > 0 ? "claude.answers.status.introPinned" : "claude.answers.status.intro"),
    "",
    ...shown.map(
      (p) =>
        `- ${line(
          t,
          p,
          pulses.find((x) => x.projectId === p.id),
        )}`,
    ),
  ];
  if (ordered.length > shown.length) {
    body.push(`- ${t("claude.answers.more", { count: ordered.length - shown.length })}`);
  }
  return {
    actions: [
      {
        tool: "list_projects",
        ...labelled(t, "claude.answers.actions.readPulses", { count: chosen.length }),
      },
    ],
    text: body.join("\n"),
    refs: shown.map((p) => ({ kind: "project" as const, id: p.id })),
  };
}

/** «**AUD** Audin 2.0 — 3 to do, 4 in progress · 2 stalled · waiting on you». */
function line(t: T, project: Project, pulse: ProjectPulse | undefined): string {
  const head = `**${project.code}** ${project.name}`;
  if (!pulse) return head;
  const parts = [
    t("claude.answers.status.open", { todo: pulse.open.todo, active: pulse.open.active }),
  ];
  if (pulse.stalled > 0) parts.push(t("claude.answers.status.stalled", { count: pulse.stalled }));
  if (pulse.waitingOnMe) parts.push(t("claude.answers.status.waiting"));
  if (pulse.claudeWorking) parts.push(t("claude.answers.status.claude"));
  const next = pulse.nextMilestone;
  if (next) {
    parts.push(
      next.dueDate
        ? t("claude.answers.status.next", { name: next.name, date: sayDate(t, next.dueDate) })
        : t("claude.answers.status.nextUndated", { name: next.name }),
    );
  }
  return `${head} — ${parts.join(" · ")}`;
}
