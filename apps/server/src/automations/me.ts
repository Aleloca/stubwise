import { automationRunInputs, automationRunLog, automationRuns, automations, automationVersions, type Db } from "@stubwise/db";
import {
  approvalProjectOf,
  hideProject,
  stepAt,
  type Automation,
  type AutomationDecision,
  type AutomationFlow,
  type MyAutomationRun,
} from "@stubwise/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { canManage, seen, sees, type Viewer } from "./model.js";
import { decidersOf, pendingEffectOf, runCode, runRowOf } from "./runs.js";

/**
 * LE LETTURE PERSONALI delle Automations (area 7, fetta 1; la specifica è
 * `listMyRuns` e `listDecisions` del prototipo, `data/automations/entry.ts`):
 * «Da decidere» (le esecuzioni ferme che aspettano chi guarda, ADESSO) e il
 * blocco della Home (aspetta me, fallite di automazioni che gestisco, mie e
 * non finite). Le esecuzioni candidate sono già filtrate nella WHERE sui
 * progetti che chi guarda vede: quello dell'automazione, o per le ferme quello
 * dell'APPROVAZIONE, che chi decide vede sempre (R-J8).
 */

const WAITING = ["waiting_approval", "waiting_project"] as const;
const OPEN = ["running", "waiting_approval", "waiting_project", "suspended"] as const;

async function candidates(db: Db, viewer: Viewer, statuses: readonly string[]) {
  const visible = await seen(db, viewer);
  if (visible !== "all" && visible.size === 0) return { visible, rows: [] };
  const rows = await db
    .select({ run: automationRuns, automation: automations })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(and(visible === "all" ? undefined : inArray(automations.projectId, [...visible]), inArray(automationRuns.status, statuses as never)))
    .orderBy(desc(automationRuns.startedAt))
    .limit(500);
  return { visible, rows };
}

/** Il tetto degli elenchi personali, applicato DOPO il filtro dei decisori. */
const MAX_ITEMS = 200;

/**
 * Le esecuzioni ferme su una decisione, filtrate sul progetto
 * dell'APPROVAZIONE (review F1, I5): chi decide deve vedere quello (R-J8),
 * che può essere un progetto fisso diverso da quello dell'automazione. È la
 * stessa regola di `approvalProjectOf`: `pending.preview.progetto` se c'è,
 * altrimenti il progetto dell'automazione. Senza le esecuzioni con una
 * decisione già in coda: il passo è deciso, l'esecutore la applica al giro.
 */
async function waitingCandidates(db: Db, viewer: Viewer) {
  const visible = await seen(db, viewer);
  if (visible !== "all" && visible.size === 0) return { visible, rows: [] };
  const approvalProject = sql`coalesce(${automationRuns.pending}->'preview'->>'progetto', ${automations.projectId}::text)`;
  const rows = await db
    .select({ run: automationRuns, automation: automations })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(
      and(
        inArray(automationRuns.status, [...WAITING]),
        visible === "all" ? undefined : sql`${approvalProject} in (${sql.join([...visible].map((id) => sql`${id}`), sql`, `)})`,
        sql`not exists (select 1 from ${automationRunInputs} i where i.run_id = ${automationRuns.id} and i.consumed_at is null)`,
      ),
    )
    .orderBy(desc(automationRuns.startedAt));
  return { visible, rows };
}

/** «Da decidere»: un passo da approvare o il progetto da scegliere, che aspetta chi guarda adesso. */
export async function listMyApprovals(db: Db, viewer: Viewer): Promise<AutomationDecision[]> {
  const { visible, rows } = await waitingCandidates(db, viewer);
  const out: AutomationDecision[] = [];
  for (const { run, automation: a } of rows) {
    const deciders = await decidersOf(db, run, a);
    if (!deciders.includes(viewer.id)) continue;
    const cursor = (run.cursor as { path?: string | null } | null)?.path ?? "";
    const pending = (run.pending ?? { preview: {}, round: 0 }) as { preview: Record<string, unknown>; round?: number };
    const [v] = await db.select({ flow: automationVersions.flow }).from(automationVersions).where(and(eq(automationVersions.automationId, a.id), eq(automationVersions.n, run.version)));
    const step = v && cursor ? stepAt((v.flow as AutomationFlow).steps, cursor) : null;
    const [last] = await db.select({ at: automationRunLog.at }).from(automationRunLog).where(eq(automationRunLog.runId, run.id)).orderBy(desc(automationRunLog.seq)).limit(1);
    const preview = structuredClone(pending.preview ?? {});
    if (visible !== "all") hideProject(preview, visible);
    const cliente = (run.event as { cliente?: { nome?: unknown } } | null)?.cliente?.nome;
    out.push({
      kind: run.status === "waiting_project" ? "project" : "approval",
      runId: run.id,
      code: runCode(a, run.n),
      title: run.title,
      automationId: a.id,
      automationName: a.name,
      projectId: approvalProjectOf(pending.preview ?? {}, a as unknown as Automation),
      stepKind: step?.kind ?? "createTask",
      preview,
      since: (last?.at ?? run.startedAt).toISOString(),
      cursor,
      round: pending.round ?? 0,
      automationCode: a.code,
      n: run.n,
      automationVisible: sees(visible, a.projectId),
      clientName: typeof cliente === "string" ? cliente : "",
      effect: v ? await pendingEffectOf(db, visible, run, a, await runRowOf(db, viewer, run, a, visible), v.flow as AutomationFlow) : null,
    });
  }
  return out.sort((x, y) => x.since.localeCompare(y.since) || x.code.localeCompare(y.code)).slice(0, MAX_ITEMS);
}

/** Il blocco Home: aspetta me, fallite di automazioni che gestisco, mie non finite; in quest'ordine. */
export async function listMyRuns(db: Db, viewer: Viewer): Promise<MyAutomationRun[]> {
  const own = await candidates(db, viewer, [...OPEN, "failed"]);
  const waiting = await waitingCandidates(db, viewer);
  const visible = own.visible;
  // Le ferme che aspettano chi guarda in un progetto fisso: le trova solo la seconda lettura.
  const seenIds = new Set(own.rows.map((r) => r.run.id));
  const rows = [...own.rows, ...waiting.rows.filter((r) => !seenIds.has(r.run.id))];
  const rank = { waiting_me: 0, failed: 1, owner: 2 } as const;
  const manageable = new Map<string, boolean>();
  const out: MyAutomationRun[] = [];
  for (const { run, automation: a } of rows) {
    if (!manageable.has(a.projectId)) manageable.set(a.projectId, await canManage(db, viewer, a.projectId));
    const deciders = await decidersOf(db, run, a);
    const concern = deciders.includes(viewer.id)
      ? ("waiting_me" as const)
      : run.status === "failed" && manageable.get(a.projectId)
        ? ("failed" as const)
        : run.status !== "failed" && a.ownerId === viewer.id
          ? ("owner" as const)
          : null;
    if (concern) out.push({ ...(await runRowOf(db, viewer, run, a, visible)), concern });
  }
  return out.sort((x, y) => rank[x.concern] - rank[y.concern] || y.startedAt.localeCompare(x.startedAt) || x.code.localeCompare(y.code)).slice(0, MAX_ITEMS);
}
