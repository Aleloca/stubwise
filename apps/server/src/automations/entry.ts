import { automationRunLog, automationRuns, automations, milestones, projects, tickets, type Db } from "@stubwise/db";
import type { AutomationOrigin, ProjectAutomationsView } from "@stubwise/shared";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { automationRows, canManage, managesGeneral, notFound, seen, sees, seesAutomation, type Viewer } from "./model.js";
import { runCode } from "./runs.js";

/**
 * I PUNTI D'INGRESSO delle Automations nelle altre superfici (area 7, fetta 1;
 * la specifica è `data/automations/entry.ts` del prototipo): la sezione del
 * progetto e la riga d'origine di una task o di un traguardo. Ciò che chi
 * guarda non vede risponde come ciò che non esiste (R-G5).
 */

const OPEN = ["running", "waiting_approval", "waiting_project", "suspended"] as const;

/**
 * La sezione «Automations» di un progetto; 404 se non lo si vede. Le
 * esecuzioni NON finite di una generale che ha agito qui (`project_ids`)
 * arrivano a ogni membro, ma a chi non vede la generale solo con codice e
 * stato: niente nome, niente link, e niente titolo — il titolo può contenere
 * dati dell'evento (anche di un'email, R-J13), e chi non vede la generale
 * non ne legge i dati (il prototipo mostra il titolo filtrato da `viewRun`,
 * qui si toglie del tutto). L'elenco delle generali che hanno agito, solo a
 * chi le vede.
 */
export async function projectAutomations(db: Db, viewer: Viewer, projectId: string): Promise<ProjectAutomationsView> {
  const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
  const visible = await seen(db, viewer);
  if (!project || !sees(visible, projectId)) throw notFound();
  const own = await db.select().from(automations).where(eq(automations.projectId, projectId)).orderBy(asc(sql`lower(${automations.name})`), asc(automations.code));
  const runs = own.length
    ? await db
        .select({ run: automationRuns, automation: automations })
        .from(automationRuns)
        .innerJoin(automations, eq(automations.id, automationRuns.automationId))
        .where(and(inArray(automationRuns.automationId, own.map((a) => a.id)), inArray(automationRuns.status, [...OPEN])))
        .orderBy(desc(automationRuns.startedAt), desc(automationRuns.n))
    : [];
  // Le esecuzioni delle generali che hanno agito qui (tutte, per l'elenco «hanno agito qui»).
  const acted = await db
    .select({ run: automationRuns, automation: automations })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(and(isNull(automations.projectId), sql`${projectId}::uuid = any(${automationRuns.projectIds})`))
    .orderBy(desc(automationRuns.startedAt), desc(automationRuns.n))
    .limit(500);
  const seesGeneral = managesGeneral(viewer);
  const canCreate = await canManage(db, viewer, projectId);
  const ownRuns = runs.map(({ run, automation: a }) => ({
    id: run.id,
    n: run.n,
    code: runCode(a, run.n),
    title: run.title,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    automationCode: a.code,
    automationName: a.name,
    linkable: true,
  }));
  const generalRuns = acted
    .filter(({ run }) => (OPEN as readonly string[]).includes(run.status))
    .map(({ run, automation: a }) => ({
      id: run.id,
      n: run.n,
      code: runCode(a, run.n),
      title: seesGeneral ? run.title : "",
      status: run.status,
      startedAt: run.startedAt.toISOString(),
      automationCode: a.code,
      automationName: seesGeneral ? a.name : "",
      linkable: seesGeneral,
    }));
  const general: ProjectAutomationsView["general"] = [];
  if (seesGeneral) {
    const byId = new Map<string, ProjectAutomationsView["general"][number]>();
    for (const { run, automation: a } of acted) {
      const g = byId.get(a.id);
      if (g) g.runCount++;
      else byId.set(a.id, { id: a.id, code: a.code, name: a.name, lastActedAt: run.startedAt.toISOString(), runCount: 1 });
    }
    general.push(...byId.values());
  }
  const allRuns = [...ownRuns, ...generalRuns].sort((x, y) => y.startedAt.localeCompare(x.startedAt) || y.n - x.n);
  return {
    show: own.length > 0 || allRuns.length > 0 || canCreate || general.length > 0,
    canCreate,
    automations: await automationRows(db, viewer, own),
    runs: allRuns,
    general,
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
  if (!row || !seesAutomation(visible, viewer, row.automation)) return { visible: false };
  const log = await db.select({ path: automationRunLog.path, effects: automationRunLog.effects }).from(automationRunLog).where(eq(automationRunLog.runId, runId)).orderBy(asc(automationRunLog.seq));
  const entry = log.find((e) => ((e.effects ?? []) as { code: string }[]).some((x) => x.code === created))?.path ?? null;
  return { visible: true, code: row.automation.code, name: row.automation.name, n: row.run.n, entry };
}
