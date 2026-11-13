import { automationRunLog, automationRuns, automations, automationVersions, type Db } from "@stubwise/db";
import {
  approvalProjectOf,
  hideProject,
  stepAt,
  type Automation,
  type AutomationDecision,
  type AutomationFlow,
  type MyAutomationRun,
} from "@stubwise/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { canManage, seen, sees, type Viewer } from "./model.js";
import { decidersOf, runCode, runRowOf } from "./runs.js";

/**
 * LE LETTURE PERSONALI delle Automations (area 7, fetta 1; la specifica è
 * `listMyRuns` e `listDecisions` del prototipo, `data/automations/entry.ts`):
 * «Da decidere» (le esecuzioni ferme che aspettano chi guarda, ADESSO) e il
 * blocco della Home (aspetta me, fallite di automazioni che gestisco, mie e
 * non finite). Le esecuzioni candidate sono già filtrate nella WHERE sui
 * progetti che chi guarda vede: chi decide vede sempre il progetto (R-J8).
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

/** «Da decidere»: un passo da approvare o il progetto da scegliere, che aspetta chi guarda adesso. */
export async function listMyApprovals(db: Db, viewer: Viewer): Promise<AutomationDecision[]> {
  const { visible, rows } = await candidates(db, viewer, WAITING);
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
      // L'anteprima condivisa del passo arriva con le letture della prova.
      effect: null,
    });
  }
  return out.sort((x, y) => x.since.localeCompare(y.since) || x.code.localeCompare(y.code));
}

/** Il blocco Home: aspetta me, fallite di automazioni che gestisco, mie non finite; in quest'ordine. */
export async function listMyRuns(db: Db, viewer: Viewer): Promise<MyAutomationRun[]> {
  const { visible, rows } = await candidates(db, viewer, [...OPEN, "failed"]);
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
  return out.sort((x, y) => rank[x.concern] - rank[y.concern] || y.startedAt.localeCompare(x.startedAt) || x.code.localeCompare(y.code));
}
