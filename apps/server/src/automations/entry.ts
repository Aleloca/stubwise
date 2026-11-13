import { automationRunLog, automationRuns, automations, milestones, projects, tickets, type Db } from "@stubwise/db";
import type { AutomationOrigin, ProjectAutomationsView } from "@stubwise/shared";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { automationRows, canManage, notFound, seen, sees, type Viewer } from "./model.js";
import { runCode } from "./runs.js";

/**
 * I PUNTI D'INGRESSO delle Automations nelle altre superfici (area 7, fetta 1;
 * la specifica è `data/automations/entry.ts` del prototipo): la sezione del
 * progetto e la riga d'origine di una task o di un traguardo. Ciò che chi
 * guarda non vede risponde come ciò che non esiste (R-G5).
 */

const OPEN = ["running", "waiting_approval", "waiting_project", "suspended"] as const;

/** La sezione «Automations» di un progetto; 404 se non lo si vede. Nella F1 non ci sono le generali. */
export async function projectAutomations(db: Db, viewer: Viewer, projectId: string): Promise<ProjectAutomationsView> {
  const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
  if (!project || !sees(await seen(db, viewer), projectId)) throw notFound();
  const own = await db.select().from(automations).where(eq(automations.projectId, projectId)).orderBy(asc(sql`lower(${automations.name})`), asc(automations.code));
  const runs = own.length
    ? await db
        .select({ run: automationRuns, automation: automations })
        .from(automationRuns)
        .innerJoin(automations, eq(automations.id, automationRuns.automationId))
        .where(and(inArray(automationRuns.automationId, own.map((a) => a.id)), inArray(automationRuns.status, [...OPEN])))
        .orderBy(desc(automationRuns.startedAt), desc(automationRuns.n))
    : [];
  const canCreate = await canManage(db, viewer, projectId);
  return {
    show: own.length > 0 || runs.length > 0 || canCreate,
    canCreate,
    automations: await automationRows(db, viewer, own),
    runs: runs.map(({ run, automation: a }) => ({
      id: run.id,
      n: run.n,
      code: runCode(a, run.n),
      title: run.title,
      status: run.status,
      startedAt: run.startedAt.toISOString(),
      automationCode: a.code,
      automationName: a.name,
      linkable: true,
    })),
    general: [],
  };
}

/**
 * «Created by automation X · run Y» su una task (per codice `<PRJ>-<n>`) o un
 * traguardo (per id), DERIVATO a lettura da `automation_run_id`: codice, nome
 * e la riga del registro che l'ha creata solo se chi guarda vede
 * l'automazione; altrimenti solo che l'ha creata un'automazione. 404 se la
 * task o il traguardo non si vedono, o non li ha creati un'automazione.
 */
export async function automationOrigin(db: Db, viewer: Viewer, ref: { task?: string; milestone?: string }): Promise<AutomationOrigin> {
  const visible = await seen(db, viewer);
  let projectId: string | null = null;
  let runId: string | null = null;
  let created: string | null = null;
  if (ref.task) {
    const m = /^([A-Z][A-Z0-9]{1,5})-(\d{1,9})$/.exec(ref.task.trim().toUpperCase());
    if (!m) throw notFound();
    const [t] = await db
      .select({ projectId: tickets.projectId, runId: tickets.automationRunId, number: tickets.number, code: projects.code })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(and(eq(projects.code, m[1]!), eq(tickets.number, Number(m[2]))));
    if (t) {
      projectId = t.projectId;
      runId = t.runId;
      created = `${t.code}-${t.number}`;
    }
  } else if (ref.milestone) {
    const [ms] = await db.select({ projectId: milestones.projectId, runId: milestones.automationRunId }).from(milestones).where(eq(milestones.id, ref.milestone));
    if (ms) {
      projectId = ms.projectId;
      runId = ms.runId;
      created = ref.milestone;
    }
  }
  if (!projectId || !sees(visible, projectId) || !runId) throw notFound();
  const [row] = await db
    .select({ run: automationRuns, automation: automations })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(eq(automationRuns.id, runId));
  if (!row || !sees(visible, row.automation.projectId)) return { visible: false };
  const log = await db.select({ path: automationRunLog.path, effects: automationRunLog.effects }).from(automationRunLog).where(eq(automationRunLog.runId, runId)).orderBy(asc(automationRunLog.seq));
  const entry = log.find((e) => ((e.effects ?? []) as { code: string }[]).some((x) => x.code === created))?.path ?? null;
  return { visible: true, code: row.automation.code, name: row.automation.name, n: row.run.n, entry };
}
