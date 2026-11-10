import {
  aiJobs,
  attachments,
  backlogItemTickets,
  deletedTickets,
  prCorrections,
  projects,
  ticketLinks,
  ticketRepositories,
  tickets,
  type Db,
} from "@stubwise/db";
import { publishNotification } from "@stubwise/notifications";
import type { ProjectPermission } from "@stubwise/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { loadTaskViews, visibleTasksCondition, type TaskViewer } from "./task-view.js";

/**
 * «Elimina task» (chat con Claude, fetta 3.0; decisione del maintainer del 10
 * nov 2026; regole del prototipo in `apps/desktop/.impeccable/shape/task-delete.md`
 * e `apps/desktop/src/renderer/data/taskDelete.ts`). Un'eliminazione VERA.
 *
 * - **Chi** (lo decide il server): chi ha `tickets.moderate` nel progetto, o
 *   l'autore (`requested_by_user_id`) con `tickets.edit`. L'utente di sistema
 *   Claude non ha `tickets.moderate`: non elimina una task d'altri.
 * - **Ordine dei controlli**: `not_found` (invisibile = inesistente) →
 *   `forbidden` → `busy` → la scrittura.
 * - **Busy**: un job non concluso della task (in coda, fermo, in attesa di
 *   piano o di risposta, in esecuzione), una PR aperta, una correzione aperta.
 * - **Niente** annullamento né riconferma: a mano basta il dialogo.
 * - **Cosa se ne va e cosa resta**: lo decidono le FK (0130, commento di
 *   `deletedTickets` in schema.ts). Qui: la LAPIDE (codice, titolo, richiesta
 *   d'origine, chi, quando), l'avviso ai follower PRIMA (la notifica resta,
 *   col ticket nullo), i file degli allegati DOPO il commit (best-effort).
 * - Il numero non si riusa: `projects.next_ticket_number` non scende.
 */

export type TaskBusyReason =
  | { kind: "claude_session"; code: string | null }
  | { kind: "open_pr"; repo: string | null; number: number | null }
  | { kind: "open_correction" };

export interface TaskDeletionPreview {
  taskId: string;
  code: string;
  title: string;
  canDelete: boolean;
  whoAction: "editTasks" | "deleteTasks" | null;
  busy: TaskBusyReason[];
  children: { code: string; title: string }[];
}

export type TaskDeleteResult =
  | { ok: true; storageKeys: string[] }
  | { ok: false; error: "not_found" | "forbidden" }
  | { ok: false; error: "busy"; reasons: TaskBusyReason[] };

/** Gli stati di un job che NON è concluso: ci gira (o ci girerà) qualcosa. */
const LIVE_JOB = ["queued", "triaging", "fixing", "held", "awaiting_plan_approval", "awaiting_input"] as const;
const OPEN_CORRECTION = ["pending", "queued"] as const;

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

interface Deleter extends TaskViewer {
  /** I permessi nel progetto della task, calcolati dal server (`routePermissions`). */
  permissions: ReadonlySet<ProjectPermission>;
}

async function visibleTicket(db: DbOrTx, viewer: TaskViewer, ticketId: string) {
  const visible = await visibleTasksCondition(db as Db, viewer);
  const [row] = await db
    .select({
      id: tickets.id,
      projectId: tickets.projectId,
      number: tickets.number,
      title: tickets.title,
      requestedByUserId: tickets.requestedByUserId,
      code: projects.code,
    })
    .from(tickets)
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .where(and(eq(tickets.id, ticketId), visible));
  return row ?? null;
}

function canDelete(viewer: Deleter, task: { requestedByUserId: string | null }): boolean {
  if (viewer.permissions.has("tickets.moderate")) return true;
  return task.requestedByUserId === viewer.id && viewer.permissions.has("tickets.edit");
}

async function busyOf(db: DbOrTx, ticketId: string, code: string): Promise<TaskBusyReason[]> {
  const [jobs, prs, corrections] = await Promise.all([
    db
      .select({ id: aiJobs.id })
      .from(aiJobs)
      .where(and(eq(aiJobs.ticketId, ticketId), inArray(aiJobs.status, [...LIVE_JOB]))),
    db
      .select({ number: ticketRepositories.prNumber, url: ticketRepositories.prUrl })
      .from(ticketRepositories)
      .where(and(eq(ticketRepositories.ticketId, ticketId), eq(ticketRepositories.prState, "open"))),
    db
      .select({ id: prCorrections.id })
      .from(prCorrections)
      .where(and(eq(prCorrections.ticketId, ticketId), inArray(prCorrections.status, [...OPEN_CORRECTION]))),
  ]);
  const repoOf = (url: string | null) => url?.match(/\/([^/]+)\/pull\/\d+/)?.[1] ?? null;
  return [
    // Il codice della task: chi la guarda la vede (è la sessione di lavoro di questa task).
    ...(jobs.length > 0 ? [{ kind: "claude_session" as const, code }] : []),
    ...prs.map((p) => ({ kind: "open_pr" as const, repo: repoOf(p.url), number: p.number })),
    ...(corrections.length > 0 ? [{ kind: "open_correction" as const }] : []),
  ];
}

/** Il dialogo: si può? perché no? cosa resta? `null` = invisibile o inesistente. */
export async function taskDeletionPreview(db: Db, viewer: Deleter, ticketId: string): Promise<TaskDeletionPreview | null> {
  const task = await visibleTicket(db, viewer, ticketId);
  if (!task) return null;
  const code = `${task.code}-${task.number}`;
  const allowed = canDelete(viewer, task);
  const author = task.requestedByUserId === viewer.id;
  // Le figlie che chi guarda VEDE (R-G5): la task è madre (`parent`) di loro.
  const childIds = (
    await db
      .select({ id: ticketLinks.targetTicketId })
      .from(ticketLinks)
      .where(and(eq(ticketLinks.sourceTicketId, ticketId), eq(ticketLinks.kind, "parent")))
  ).map((r) => r.id);
  const children =
    childIds.length > 0
      ? (await loadTaskViews(db, viewer, [inArray(tickets.id, childIds)])).map((t) => ({ code: t.view.code, title: t.view.title }))
      : [];
  return {
    taskId: task.id,
    code,
    title: task.title,
    canDelete: allowed,
    whoAction: allowed ? null : author ? "editTasks" : "deleteTasks",
    busy: await busyOf(db, ticketId, code),
    children,
  };
}

/**
 * Elimina la task a nome di `viewer`. Nella transazione, col lock del ticket
 * (lo stesso di `startRun` e `cancelRun`: un avvio e un'eliminazione non si
 * incrociano): i controlli si RIFANNO, poi lapide, avviso, eliminazione. I
 * file degli allegati li toglie il chiamante dopo il commit (`storageKeys`).
 */
export async function deleteTask(
  db: Db,
  viewer: Deleter,
  ticketId: string,
  opts: { viaClaudeActionId?: string } = {},
): Promise<TaskDeleteResult> {
  return db.transaction(async (tx): Promise<TaskDeleteResult> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ticketId}))`);
    const task = await visibleTicket(tx, viewer, ticketId);
    if (!task) return { ok: false, error: "not_found" };
    if (!canDelete(viewer, task)) return { ok: false, error: "forbidden" };
    const code = `${task.code}-${task.number}`;
    const reasons = await busyOf(tx, ticketId, code);
    if (reasons.length > 0) return { ok: false, error: "busy", reasons };

    const [origin] = await tx
      .select({ id: backlogItemTickets.itemId })
      .from(backlogItemTickets)
      .where(eq(backlogItemTickets.ticketId, ticketId))
      .limit(1);
    const keys = (
      await tx.select({ key: attachments.storageKey }).from(attachments).where(eq(attachments.ticketId, ticketId))
    ).map((r) => r.key);

    await tx.insert(deletedTickets).values({
      id: task.id,
      projectId: task.projectId,
      number: task.number,
      title: task.title,
      originBacklogItemId: origin?.id ?? null,
      deletedBy: viewer.id,
      ...(opts.viaClaudeActionId ? { viaClaudeActionId: opts.viaClaudeActionId } : {}),
    });
    // L'avviso ai follower PRIMA dell'eliminazione (l'audience li legge dal
    // ticket); la notifica resta, col ticket nullo (FK SET NULL, 0130).
    await publishNotification(
      tx,
      {
        kind: "ticket.activity",
        ticketId,
        ticketNumber: task.number,
        projectId: task.projectId,
        projectCode: task.code,
        change: "task_deleted",
        summary: task.title,
        actorUserId: viewer.id,
      },
      { projectId: task.projectId, ticketId, excludeUserIds: [viewer.id] },
    );
    await tx.delete(tickets).where(eq(tickets.id, ticketId));
    return { ok: true, storageKeys: keys };
  });
}

/** Le lapidi delle task create da una richiesta: «La task MKX-31 è stata eliminata». */
export async function deletedTaskCodesOf(db: Db, backlogItemIds: readonly string[]): Promise<Map<string, string[]>> {
  if (backlogItemIds.length === 0) return new Map();
  const rows = await db
    .select({ item: deletedTickets.originBacklogItemId, number: deletedTickets.number, code: projects.code })
    .from(deletedTickets)
    .innerJoin(projects, eq(projects.id, deletedTickets.projectId))
    .where(inArray(deletedTickets.originBacklogItemId, [...backlogItemIds]));
  const out = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.item) continue;
    out.set(r.item, [...(out.get(r.item) ?? []), `${r.code}-${r.number}`]);
  }
  return out;
}
