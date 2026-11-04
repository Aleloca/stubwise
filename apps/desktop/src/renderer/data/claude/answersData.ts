import { visiblePeopleFor } from "../access/whoCan";
import { usageView, OTHER_PROJECTS_KEY } from "../instance/usage";
import type { SeenStallReason, SpendView, StalledProject, StallReason } from "../model";
import { now, stalledTasks, state, visibleProjectIds } from "../store";
import { can, viewerFor } from "../viewer";

// Le letture delle risposte di Claude sui dati (area 10b, Task 6): i progetti
// fermi (S2) e la spesa del mese (S3), calcolati sulle letture di chi chiede.
// Nessun numero esce da qui che chi chiede non potrebbe ritrovare a mano:
// le ferme sono quelle del blocco «Stalled» (`stalledTasks`, cioè `stallOf`
// con le bloccanti visibili), la spesa quella di Usage (`usageView`).

/**
 * I progetti aperti e visibili con task ferme, dal più fermo (la task ferma
 * da più tempo, poi il codice). `projectId`: solo quel progetto (S2
 * dall'Overview, [SG 3], P16); un progetto che chi chiede non vede dà
 * l'elenco vuoto, come uno senza ferme.
 */
export function stalledProjectsFor(me: string, projectId?: string | null): StalledProject[] {
  const visible = visibleProjectIds(me);
  if (projectId && !visible.has(projectId)) return [];
  const people = visiblePeopleFor(me);
  const groups = new Map<string, ReturnType<typeof stalledTasks>>();
  // `stalledTasks` le dà già dalla più vecchia: la prima di ogni gruppo è la sua più vecchia.
  for (const row of stalledTasks(me)) {
    if (projectId && row.task.projectId !== projectId) continue;
    const list = groups.get(row.task.projectId) ?? [];
    list.push(row);
    groups.set(row.task.projectId, list);
  }
  return [...groups].map(([id, rows]) => {
    const project = state.projectsById.get(id)!;
    const { task, stall } = rows[0]!;
    return {
      projectId: id,
      code: project.code,
      stalled: rows.length,
      oldest: {
        taskCode: task.code,
        days: stall.days,
        reason: seenReason(stall.reason, people, visible),
        plannedWeek: task.plannedWeek,
      },
      thresholdDays: project.stallThresholds.activeDays,
    };
  });
}

/** Il motivo senza la persona o la task che chi chiede non vede (R-G5). */
function seenReason(
  reason: StallReason,
  people: Set<string>,
  visible: Set<string>,
): SeenStallReason {
  if (reason.kind === "decision") {
    return people.has(reason.personId) ? { ...reason } : { kind: "decision" };
  }
  if (reason.kind === "blocked_by") {
    const blocker = state.tasksById.get(reason.taskId);
    return blocker && visible.has(blocker.projectId) ? { ...reason } : { kind: "blocked_by" };
  }
  return { ...reason };
}

/** Quanti progetti chi spende di più nella vista d'istanza. */
const TOP = 3;

/**
 * La spesa dal 1° del mese a `now()`: con `usage.view` quella d'istanza
 * (`usageView`, la stessa di Usage, coi progetti invisibili in «Other
 * projects»); senza, la somma dei progetti dove ha `project.usage.view`
 * (quella di Progetto → Settings → Usage); senza nessuno dei due, `none`.
 */
export function spendThisMonthFor(me: string): SpendView {
  const asOf = now();
  const range = { month: true } as const;
  if (can(viewerFor(me), "usage.view")) {
    const view = usageView(me, { range, groupBy: "project" }, null);
    const top = view.rows
      // «No project» (le conversazioni senza progetto) conta nel totale, non è un progetto.
      .filter((r) => r.key !== null)
      // Usage mette «Other projects» in fondo; qui conta quanto spende, come gli altri.
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, TOP)
      .map((r) =>
        r.key === OTHER_PROJECTS_KEY
          ? { projectId: null, code: null, usd: r.costUsd }
          : { projectId: r.key, code: r.code ?? null, usd: r.costUsd },
      );
    const budget = state.instance.budget.monthlyUsd;
    return {
      scope: "instance",
      totalUsd: view.totals.costUsd,
      budgetUsd: budget,
      top,
      asOf,
    };
  }
  const viewer = viewerFor(me);
  const projects = state.projects
    .filter((p) => visibleProjectIds(me).has(p.id) && can(viewer, "project.usage.view", p.id))
    .map((p) => ({
      projectId: p.id,
      code: p.code,
      usd: usageView(me, { range, groupBy: "day" }, p.id).totals.costUsd,
    }));
  if (projects.length === 0) return { scope: "none" };
  const totalUsd = Math.round(projects.reduce((sum, p) => sum + p.usd, 0) * 1e6) / 1e6;
  return {
    scope: "projects",
    totalUsd,
    projects: projects.sort((a, b) => b.usd - a.usd || a.code.localeCompare(b.code)),
    asOf,
  };
}
