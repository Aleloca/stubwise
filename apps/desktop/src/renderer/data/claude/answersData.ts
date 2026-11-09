import { accessState } from "../access/index";
import { visiblePeopleFor } from "../access/whoCan";
import { projectRoleChoices } from "../admin/members";
import { PEOPLE } from "../seed/people";
import { usageView, OTHER_PROJECTS_KEY } from "../instance/usage";
import type {
  ArchiveCandidates,
  Person,
  SeenStallReason,
  SpendView,
  StalledProject,
  StallReason,
} from "../model";
import { lastActivityOf } from "../projectActivity";
import { busyReasonsOf } from "../projectSettings/archive";
import { MANAGE_SETTINGS } from "../projectSettings/common";
import { now, stalledTasks, state, visibleProjectIds } from "../store";
import { can, viewerFor } from "../viewer";

// Le letture delle risposte di Claude sui dati (area 10b, Task 6): i progetti
// fermi (S2) e la spesa del mese (S3), calcolati sulle letture di chi chiede.
// Dal Task 7 anche le letture delle azioni in blocco (S4: i progetti senza
// attività) e dei membri (S5: persone, ruoli, chi può dare cosa).
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

/**
 * I progetti aperti e visibili senza attività da `days` su `now()`
 * (`lastActivityOf`; nessun segnale = senza attività, come il seme), divisi
 * per ciò che chi chiede può fare (S4): archiviabili, `busy` (li gestisce ma
 * `busyReasonsOf` dice di no, con le ragioni come le legge lui) e non
 * gestibili (senza `project.settings.manage`: il numero e i codici, che
 * vede). Dal più fermo; un progetto invisibile non c'è in nessuna parte.
 */
export function archiveCandidatesFor(me: string, days: number): ArchiveCandidates {
  const limit = new Date(Date.parse(now()) - days * 86_400_000).toISOString();
  const viewer = viewerFor(me);
  const visible = visibleProjectIds(me);
  const out: ArchiveCandidates = {
    candidates: [],
    busy: [],
    notManageable: 0,
    notManageableCodes: [],
  };
  const quiet = state.projects
    .filter((p) => !p.archived && visible.has(p.id))
    .map((p) => ({ project: p, last: lastActivityOf(p.id) ?? "" }))
    .filter((x) => x.last < limit)
    .sort((a, b) => a.last.localeCompare(b.last) || a.project.code.localeCompare(b.project.code));
  for (const { project, last } of quiet) {
    if (!can(viewer, MANAGE_SETTINGS, project.id)) {
      out.notManageable++;
      out.notManageableCodes.push(project.code);
      continue;
    }
    const reasons = busyReasonsOf(project.id, me);
    if (reasons.length > 0) {
      out.busy.push({ code: project.code, reasons });
      continue;
    }
    out.candidates.push({
      projectId: project.id,
      code: project.code,
      name: project.name,
      lastActivity: last,
    });
  }
  return out;
}

// --- S5: i membri ----------------------------------------------------------------

/** Un nome per confrontarlo: minuscolo, senza accenti né spazi in più. */
const plainName = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Le persone che chi chiede vede (`visiblePeopleFor`: attive, Claude
 * escluso), il cui nome (o nome e cognome) è `name`, senza maiuscole né
 * accenti. Dall'ordine del nome.
 */
export function findPeopleFor(me: string, name: string): Person[] {
  const wanted = plainName(name);
  if (!wanted) return [];
  const seen = visiblePeopleFor(me);
  return PEOPLE.filter((p) => {
    if (p.isClaude || !seen.has(p.id)) return false;
    const full = plainName(p.name);
    return full === wanted || full.split(" ")[0] === wanted;
  })
    .map((p) => ({ ...p, departmentIds: [...p.departmentIds] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** I ruoli di progetto, nell'ordine dei preset (quello del dialogo di Members). */
export function projectRolesOf(): { id: string; name: string }[] {
  return accessState()
    .roles.filter((r) => r.scope === "project")
    .map((r) => ({ id: r.id, name: r.name }));
}

/**
 * Chi chiede può dare `roleId` in `projectId`? `forbidden` se lì non
 * gestisce i membri (o non vede il progetto: la stessa risposta), qualunque
 * sia il ruolo; `escalation` se il ruolo ha permessi che lì non ha (la
 * regola di Members, `projectRoleChoices`); `ok` altrimenti.
 */
export function canGrantRoleFor(
  me: string,
  projectId: string,
  roleId: string,
): "ok" | "escalation" | "forbidden" {
  if (!visibleProjectIds(me).has(projectId)) return "forbidden";
  if (!can(viewerFor(me), "project.members.manage", projectId)) return "forbidden";
  const choice = projectRoleChoices(me, projectId).find((r) => r.roleId === roleId);
  if (!choice) return "forbidden";
  return choice.missing.length > 0 ? "escalation" : "ok";
}

/** Il ruolo di `personId` in `projectId`, se chi chiede vede entrambi; `null` se non è membro. */
export function memberRoleIdFor(me: string, projectId: string, personId: string): string | null {
  if (!visibleProjectIds(me).has(projectId) || !visiblePeopleFor(me).has(personId)) return null;
  return (
    accessState().memberships.find((m) => m.projectId === projectId && m.personId === personId)
      ?.roleId ?? null
  );
}

/** Chi chiede può invitare persone (`users.invite`)? La riga D di S5 non promette un dialogo che non si aprirebbe. */
export const canInvitePeopleFor = (me: string): boolean => can(viewerFor(me), "users.invite");
