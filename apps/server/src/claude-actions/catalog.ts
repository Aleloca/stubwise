import { tickets, type Db } from "@stubwise/db";
import {
  CLAUDE_ACTION_ARGS,
  CLAUDE_DECLARED_CLASS,
  type ClaudeActionFn,
  type NewTaskBody,
  type ProjectPermission,
  type TaskPatch,
} from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { RouteAccess } from "../auth/access.js";
import { backlogItemAccess, fromBody, fromMilestone, fromTicket, ticketVisible } from "../auth/project-resolvers.js";
import type { SessionUser } from "../auth/session.js";
import { backlogItems, taskFilters } from "@stubwise/db";
import type { MilestoneDraft, NewFilterBody, NewRequestBody } from "@stubwise/shared";
import { enqueueBacklogIntake } from "../services/backlog-intake.js";
import { postUserComment } from "../services/comment-post.js";
import { deleteComment } from "../services/comments.js";
import { startRun } from "../services/jobs.js";
import { createMilestone, deleteMilestone } from "../services/milestones.js";
import { archiveRequest, reopenRequest } from "../services/project-request-writes.js";
import { deleteTask } from "../services/task-delete.js";
import { createTaskFilter, deleteTaskFilter } from "../services/task-filters.js";
import { deleteStoredObjects } from "./effects.js";
import { loadTaskViews } from "../services/task-view.js";
import { createTask, planTask, updateTask } from "../services/task-writes.js";

/**
 * Il catalogo delle azioni di Claude sul SERVER (chat, fetta 3): per ogni `fn`
 * dell'elenco chiuso di `@stubwise/shared` (`CLAUDE_ACTION_FNS`), la rotta di
 * riferimento, il suo `RouteAccess` (lo STESSO della rotta: lo verifica il
 * test del registro) e `run`, che chiama IL SERVIZIO della rotta — nessuna
 * scrittura sua, quindi permessi, rifiuti, notifiche e registro sono quelli
 * di sempre. `run` legge «com'era» prima di scrivere e dà l'inverso per
 * «Annulla» (`null` = non si annulla) e gli oggetti toccati.
 *
 * MAI qui (test sul sorgente, `claude-actions-never.test.ts`): approvare o
 * rifiutare piani, rispondere alle domande dell'agente, mergiare o
 * rilasciare, il registro decisioni, segreti, invii fuori, PAT e inviti.
 */

/**
 * Un oggetto toccato. `stamp`: il suo `updated_at` subito dopo la scrittura
 * (richieste, filtri): «Annulla» lo confronta per sapere se qualcuno ha
 * scritto dopo. Le task usano la loro storia (`ticket_events`, commenti).
 */
export type ActionObject = {
  kind: "task" | "request" | "milestone" | "filter" | "comment";
  id: string;
  code?: string;
  stamp?: string;
};

export interface CatalogRunResult {
  inverse: { fn: ClaudeActionFn; args: Record<string, unknown> } | null;
  objects: ActionObject[];
  /** I codici degli oggetti toccati (AUD-12), per la riga «fatto» e il modello. */
  codes: string[];
  /**
   * La scrittura ha fatto partire il lavoro di Claude (Claude assegnato: il
   * servizio lo avvia con `startClaudeRuns`, come le rotte). Alza la classe a
   * B, come `startRun`, e l'azione non si annulla: togliere Claude non ferma il
   * lavoro partito («Annulla il lavoro» resta il gesto vero).
   */
  startsWork?: boolean;
}

/** Il lavoro di Claude è partito da questa scrittura (`claudeRun` della vista). */
const startedWork = (task: { claudeRun?: string | null }) => task.claudeRun === "started";

export type CatalogRefusal = {
  code: "forbidden" | "not_found" | "invalid" | "conflict" | "busy";
  message: string;
};

export type CatalogRun = (
  tx: Db,
  user: SessionUser,
  args: Record<string, unknown>,
  permissions: ReadonlySet<ProjectPermission>,
  /** Le opzioni dei servizi che avviano il lavoro di Claude: il link pubblico delle notifiche. */
  start: { publicUrl?: string },
) => Promise<{ ok: true; result: CatalogRunResult } | { ok: false; refusal: CatalogRefusal }>;

export interface CatalogEntry {
  fn: ClaudeActionFn;
  /** La rotta di riferimento: `METODO /percorso` come la registra Fastify. */
  route: string;
  /** Lo stesso `config.access` della rotta: di progetto (il permesso si valuta come lì) o `user` (cose personali). */
  access: Extract<RouteAccess, { kind: "project" } | { kind: "user" }>;
  /** Parametri e corpo della richiesta sintetica su cui si valuta `access` (può leggere il DB). */
  request: (
    args: Record<string, unknown>,
    db: Db,
  ) => { params?: Record<string, unknown>; body?: unknown } | Promise<{ params?: Record<string, unknown>; body?: unknown }>;
  run: CatalogRun;
}

const onTicket = (
  permission: ProjectPermission | "member" = "member",
  param = "ticketId",
): Extract<RouteAccess, { kind: "project" }> => ({
  kind: "project",
  permission,
  project: fromTicket(param),
  resource: ticketVisible(param),
});

/** `updated_at` di una richiesta o di un filtro, dopo la scrittura (per `changed_after`). */
async function stampOf(tx: Db, kind: "request" | "filter", id: string): Promise<string | undefined> {
  const table = kind === "request" ? backlogItems : taskFilters;
  const [row] = await tx.select({ at: table.updatedAt }).from(table).where(eq(table.id, id));
  return row?.at.toISOString();
}

const requestObject = async (tx: Db, id: string): Promise<ActionObject> => {
  const stamp = await stampOf(tx, "request", id);
  return { kind: "request", id, ...(stamp ? { stamp } : {}) };
};

const refused = (code: CatalogRefusal["code"], message: string) => ({ ok: false as const, refusal: { code, message } });

/** Gli errori dei servizi delle task nei codici del catalogo. */
function taskRefusal(error: string): { ok: false; refusal: CatalogRefusal } {
  switch (error) {
    case "forbidden":
    case "claude_assign_forbidden":
      return refused("forbidden", error);
    case "not_found":
      return refused("not_found", error);
    case "request_not_convertible":
      return refused("conflict", error);
    default:
      return refused("invalid", error);
  }
}

async function taskBefore(tx: Db, user: SessionUser, id: string) {
  const [loaded] = await loadTaskViews(tx, user, [eq(tickets.id, id)], 1);
  return loaded?.view ?? null;
}

const ENTRIES: CatalogEntry[] = [
  {
    fn: "createTask",
    route: "POST /api/tasks",
    access: { kind: "project", permission: "tickets.create", project: fromBody("projectId") },
    request: (args) => ({ body: args }),
    async run(tx, user, args, _permissions, start) {
      const result = await createTask(tx, user, args as unknown as NewTaskBody, start);
      if (!result.ok) return taskRefusal(result.error);
      // «Annulla» = eliminazione (F3.0), solo se nessuno ci ha scritto dopo
      // (e se Claude non ci sta già lavorando: allora la task è occupata).
      const startsWork = startedWork(result.task);
      return {
        ok: true,
        result: {
          inverse: startsWork ? null : { fn: "deleteTask", args: { id: result.task.id } },
          objects: [{ kind: "task", id: result.task.id }],
          codes: [result.task.code],
          ...(startsWork ? { startsWork } : {}),
        },
      };
    },
  },
  {
    fn: "updateTask",
    route: "PATCH /api/tasks/:ticketId",
    access: onTicket("tickets.edit"),
    request: (args) => ({ params: { ticketId: args["id"] } }),
    async run(tx, user, args, _permissions, start) {
      const id = args["id"] as string;
      const patch = (args["patch"] ?? {}) as TaskPatch;
      const before = await taskBefore(tx, user, id);
      if (!before) return refused("not_found", "not_found");
      const was = Object.fromEntries(
        Object.keys(patch).map((k) => [k, (before as unknown as Record<string, unknown>)[k] ?? null]),
      );
      const result = await updateTask(tx, user, id, patch, start);
      if (!result.ok) return taskRefusal(result.error);
      const startsWork = startedWork(result.task);
      return {
        ok: true,
        result: {
          inverse: startsWork ? null : { fn: "updateTask", args: { id, patch: was } },
          objects: [{ kind: "task", id }],
          codes: [result.task.code],
          ...(startsWork ? { startsWork } : {}),
        },
      };
    },
  },
  {
    fn: "planTask",
    route: "POST /api/tasks/:ticketId/plan",
    access: onTicket(),
    request: (args) => ({ params: { ticketId: args["id"] } }),
    async run(tx, user, args, _permissions, start) {
      const id = args["id"] as string;
      const plan = args["plan"] as { assigneeId: string | null; week: string | null };
      const before = await taskBefore(tx, user, id);
      if (!before) return refused("not_found", "not_found");
      const was = { assigneeId: before.assigneeId ?? null, week: before.plannedWeek ?? null };
      const result = await planTask(tx, user, id, plan, start);
      if (!result.ok) return taskRefusal(result.error);
      const startsWork = startedWork(result.task);
      return {
        ok: true,
        result: {
          inverse: startsWork ? null : { fn: "planTask", args: { id, plan: was } },
          objects: [{ kind: "task", id }],
          codes: [result.task.code],
          ...(startsWork ? { startsWork } : {}),
        },
      };
    },
  },
  {
    // Solo INVERSO di `createTask` (Claude non lo propone): le regole sono quelle di «Elimina task».
    fn: "deleteTask",
    route: "DELETE /api/tasks/:ticketId",
    access: onTicket("member"),
    request: (args) => ({ params: { ticketId: args["id"] } }),
    async run(tx, user, args, permissions) {
      const id = args["id"] as string;
      const result = await deleteTask(tx, { ...user, permissions }, id);
      if (!result.ok) return refused(result.error === "busy" ? "busy" : result.error, result.error);
      // I file degli allegati: DOPO il commit, e mai in una prova a secco (`effects.ts`).
      deleteStoredObjects(result.storageKeys);
      return { ok: true, result: { inverse: null, objects: [{ kind: "task", id }], codes: [] } };
    },
  },
  {
    fn: "addComment",
    route: "POST /api/tickets/:ticketId/comments",
    access: onTicket("tickets.comment"),
    request: (args) => ({ params: { ticketId: args["taskId"] } }),
    async run(tx, user, args) {
      const taskId = args["taskId"] as string;
      const posted = await postUserComment(tx, {
        ticketId: taskId,
        authorId: user.id,
        body: args["body"] as string,
        replyToCommentId: (args["replyToId"] as string | undefined) ?? null,
      });
      if (!posted.ok) return refused(posted.error === "ticket_not_found" ? "not_found" : "invalid", posted.error);
      return {
        ok: true,
        result: {
          inverse: { fn: "deleteComment", args: { id: posted.comment.id, taskId } },
          objects: [{ kind: "task", id: taskId }],
          codes: [],
        },
      };
    },
  },
  {
    fn: "deleteComment",
    route: "DELETE /api/tickets/:ticketId/comments/:commentId",
    access: onTicket("member"),
    request: (args) => ({ params: { ticketId: args["taskId"], commentId: args["id"] } }),
    async run(tx, user, args, permissions) {
      const result = await deleteComment(tx, {
        ticketId: args["taskId"] as string,
        commentId: args["id"] as string,
        actor: { id: user.id, permissions },
      });
      if (!result.ok) return refused(result.error === "forbidden" ? "forbidden" : "not_found", result.error);
      // I file degli allegati del commento: DOPO il commit, mai a secco.
      deleteStoredObjects(result.storageKeys);
      return { ok: true, result: { inverse: null, objects: [{ kind: "task", id: args["taskId"] as string }], codes: [] } };
    },
  },
  {
    fn: "createRequest",
    route: "POST /api/requests",
    access: { kind: "project", permission: "backlog.create", project: fromBody("projectId") },
    request: (args) => ({ body: args }),
    async run(tx, user, args) {
      const body = args as unknown as NewRequestBody;
      // Passa dall'intake (può fonderla in una che c'è già): non si annulla.
      const result = await enqueueBacklogIntake(tx, {
        projectId: body.projectId,
        title: body.title,
        body: body.description,
        requestedByUserId: user.id,
      });
      if (!result.ok) return refused("not_found", result.error);
      return { ok: true, result: { inverse: null, objects: [], codes: [] } };
    },
  },
  {
    // Trasformare una richiesta in task: la rotta è la creazione della task con `requestId`.
    fn: "convertRequest",
    route: "POST /api/tasks",
    access: { kind: "project", permission: "tickets.create", project: fromBody("projectId") },
    async request(args, db) {
      const [item] = await db
        .select({ projectId: backlogItems.projectId })
        .from(backlogItems)
        .where(eq(backlogItems.id, args["id"] as string));
      return { body: { projectId: item?.projectId ?? null } };
    },
    async run(tx, user, args, _permissions, start) {
      const [item] = await tx
        .select({ projectId: backlogItems.projectId })
        .from(backlogItems)
        .where(eq(backlogItems.id, args["id"] as string));
      if (!item) return refused("not_found", "not_found");
      const input = args["input"] as Omit<NewTaskBody, "projectId" | "requestId">;
      const result = await createTask(tx, user, { ...input, projectId: item.projectId, requestId: args["id"] as string }, start);
      if (!result.ok) return taskRefusal(result.error);
      return {
        ok: true,
        result: {
          inverse: null,
          objects: [{ kind: "task", id: result.task.id }, await requestObject(tx, args["id"] as string)],
          codes: [result.task.code],
        },
      };
    },
  },
  {
    fn: "archiveRequest",
    route: "POST /api/requests/:id/archive",
    access: backlogItemAccess("id", "backlog.edit") as Extract<RouteAccess, { kind: "project" }>,
    request: (args) => ({ params: { id: args["id"] } }),
    async run(tx, _user, args) {
      const id = args["id"] as string;
      if (!(await archiveRequest(tx, id))) return refused("conflict", "invalid_status");
      return { ok: true, result: { inverse: { fn: "reopenRequest", args: { id } }, objects: [await requestObject(tx, id)], codes: [] } };
    },
  },
  {
    fn: "reopenRequest",
    route: "POST /api/requests/:id/reopen",
    access: backlogItemAccess("id", "backlog.edit") as Extract<RouteAccess, { kind: "project" }>,
    request: (args) => ({ params: { id: args["id"] } }),
    async run(tx, _user, args) {
      const id = args["id"] as string;
      if (!(await reopenRequest(tx, id))) return refused("conflict", "invalid_status");
      return { ok: true, result: { inverse: { fn: "archiveRequest", args: { id } }, objects: [await requestObject(tx, id)], codes: [] } };
    },
  },
  {
    // Avviare il lavoro di Claude: lo stesso `startRun` di `run-ai`, col gate
    // del piano invariato (senza `plans.approve` nasce in attesa
    // d'approvazione). Non approva mai niente; non si annulla da qui.
    fn: "startRun",
    route: "POST /api/tickets/:id/run-ai",
    access: onTicket("runs.start", "id"),
    request: (args) => ({ params: { id: args["taskId"] } }),
    async run(tx, user, args, permissions, start) {
      const taskId = args["taskId"] as string;
      const result = await startRun(tx, {
        ticketId: taskId,
        actor: { id: user.id, permissions },
        ...(start.publicUrl !== undefined ? { publicUrl: start.publicUrl } : {}),
      });
      if (!result.ok) {
        return refused(
          result.error === "ticket_not_found" ? "not_found" : result.error === "forbidden" || result.error === "needs_maintainer" ? "forbidden" : "busy",
          result.error,
        );
      }
      return { ok: true, result: { inverse: null, objects: [{ kind: "task", id: taskId }], codes: [] } };
    },
  },
  {
    fn: "createMilestone",
    route: "POST /api/milestones",
    access: { kind: "project", permission: "tickets.edit", project: fromBody("projectId") },
    request: (args) => ({ body: args }),
    async run(tx, _user, args) {
      const result = await createMilestone(tx, args as unknown as MilestoneDraft & { projectId: string });
      if (!result.ok) return refused(result.error === "project_not_found" ? "not_found" : "conflict", result.error);
      return {
        ok: true,
        result: {
          inverse: { fn: "deleteMilestone", args: { id: result.milestone.id } },
          objects: [{ kind: "milestone", id: result.milestone.id }],
          codes: [],
        },
      };
    },
  },
  {
    fn: "deleteMilestone",
    route: "DELETE /api/milestones/:id",
    access: { kind: "project", permission: "tickets.edit", project: fromMilestone("id") },
    request: (args) => ({ params: { id: args["id"] } }),
    async run(tx, _user, args) {
      const id = args["id"] as string;
      if (!(await deleteMilestone(tx, id))) return refused("not_found", "milestone_not_found");
      return { ok: true, result: { inverse: null, objects: [{ kind: "milestone", id }], codes: [] } };
    },
  },
  {
    fn: "saveFilter",
    route: "POST /api/filters",
    access: { kind: "user" },
    request: (args) => ({ body: args }),
    async run(tx, user, args) {
      // Solo PERSONALE: un filtro di Claude non diventa mai pubblico (lo vedrebbero altri).
      const row = await createTaskFilter(tx, user, { ...(args as unknown as NewFilterBody), visibility: "private" });
      if (!row) return refused("invalid", "too_many_filters");
      const stamp = await stampOf(tx, "filter", row.id);
      return {
        ok: true,
        result: {
          inverse: { fn: "deleteFilter", args: { id: row.id } },
          objects: [{ kind: "filter", id: row.id, ...(stamp ? { stamp } : {}) }],
          codes: [],
        },
      };
    },
  },
  {
    fn: "deleteFilter",
    route: "DELETE /api/filters/:id",
    access: { kind: "user" },
    request: (args) => ({ params: { id: args["id"] } }),
    async run(tx, user, args) {
      const result = await deleteTaskFilter(tx, user, args["id"] as string);
      if (result !== "ok") return refused(result, result);
      return { ok: true, result: { inverse: null, objects: [{ kind: "filter", id: args["id"] as string }], codes: [] } };
    },
  },
];

/** Le voci per `fn`. Una `fn` dell'elenco condiviso senza voce qui non si esegue (ancora). */
export const SERVER_CATALOG: ReadonlyMap<ClaudeActionFn, CatalogEntry> = new Map(ENTRIES.map((e) => [e.fn, e]));

export function declaredClassOf(fn: ClaudeActionFn): "A" | "B" {
  return CLAUDE_DECLARED_CLASS[fn];
}

/** Gli argomenti validati con lo schema della rotta; `null` se non sono validi. */
export function parseArgs(fn: ClaudeActionFn, args: unknown): Record<string, unknown> | null {
  const parsed = CLAUDE_ACTION_ARGS[fn].safeParse(args);
  return parsed.success ? (parsed.data as Record<string, unknown>) : null;
}

/** La richiesta sintetica su cui il `RouteAccess` della voce si valuta come nella rotta. */
export function syntheticRequest(
  db: Db,
  user: SessionUser,
  parts: { params?: Record<string, unknown>; body?: unknown },
): FastifyRequest {
  return {
    params: parts.params ?? {},
    body: parts.body ?? {},
    query: {},
    user,
    server: { db },
  } as unknown as FastifyRequest;
}
