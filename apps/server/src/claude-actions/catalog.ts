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
import { fromBody, fromTicket, ticketVisible } from "../auth/project-resolvers.js";
import type { SessionUser } from "../auth/session.js";
import { deleteTask } from "../services/task-delete.js";
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

export type ActionObject = { kind: "task" | "request" | "milestone" | "filter" | "comment"; id: string };

export interface CatalogRunResult {
  inverse: { fn: ClaudeActionFn; args: Record<string, unknown> } | null;
  objects: ActionObject[];
  /** I codici degli oggetti toccati (AUD-12), per la riga «fatto» e il modello. */
  codes: string[];
}

export type CatalogRefusal = {
  code: "forbidden" | "not_found" | "invalid" | "conflict" | "busy";
  message: string;
};

export type CatalogRun = (
  tx: Db,
  user: SessionUser,
  args: Record<string, unknown>,
  permissions: ReadonlySet<ProjectPermission>,
) => Promise<{ ok: true; result: CatalogRunResult } | { ok: false; refusal: CatalogRefusal }>;

export interface CatalogEntry {
  fn: ClaudeActionFn;
  /** La rotta di riferimento: `METODO /percorso` come la registra Fastify. */
  route: string;
  /** Lo stesso `config.access` della rotta (tipo progetto: il permesso si valuta come lì). */
  access: Extract<RouteAccess, { kind: "project" }>;
  /** Parametri e corpo della richiesta sintetica su cui si valuta `access`. */
  request: (args: Record<string, unknown>) => { params?: Record<string, unknown>; body?: unknown };
  run: CatalogRun;
}

const onTicket = (permission: ProjectPermission | "member" = "member"): Extract<RouteAccess, { kind: "project" }> => ({
  kind: "project",
  permission,
  project: fromTicket("ticketId"),
  resource: ticketVisible("ticketId"),
});

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
    async run(tx, user, args) {
      const result = await createTask(tx, user, args as unknown as NewTaskBody);
      if (!result.ok) return taskRefusal(result.error);
      // «Annulla» = eliminazione (F3.0), solo se nessuno ci ha scritto dopo.
      return {
        ok: true,
        result: {
          inverse: { fn: "deleteTask", args: { id: result.task.id } },
          objects: [{ kind: "task", id: result.task.id }],
          codes: [result.task.code],
        },
      };
    },
  },
  {
    fn: "updateTask",
    route: "PATCH /api/tasks/:ticketId",
    access: onTicket("tickets.edit"),
    request: (args) => ({ params: { ticketId: args["id"] } }),
    async run(tx, user, args) {
      const id = args["id"] as string;
      const patch = (args["patch"] ?? {}) as TaskPatch;
      const before = await taskBefore(tx, user, id);
      if (!before) return refused("not_found", "not_found");
      const was = Object.fromEntries(
        Object.keys(patch).map((k) => [k, (before as unknown as Record<string, unknown>)[k] ?? null]),
      );
      const result = await updateTask(tx, user, id, patch);
      if (!result.ok) return taskRefusal(result.error);
      return {
        ok: true,
        result: {
          inverse: { fn: "updateTask", args: { id, patch: was } },
          objects: [{ kind: "task", id }],
          codes: [result.task.code],
        },
      };
    },
  },
  {
    fn: "planTask",
    route: "POST /api/tasks/:ticketId/plan",
    access: onTicket(),
    request: (args) => ({ params: { ticketId: args["id"] } }),
    async run(tx, user, args) {
      const id = args["id"] as string;
      const plan = args["plan"] as { assigneeId: string | null; week: string | null };
      const before = await taskBefore(tx, user, id);
      if (!before) return refused("not_found", "not_found");
      const was = { assigneeId: before.assigneeId ?? null, week: before.plannedWeek ?? null };
      const result = await planTask(tx, user, id, plan);
      if (!result.ok) return taskRefusal(result.error);
      return {
        ok: true,
        result: {
          inverse: { fn: "planTask", args: { id, plan: was } },
          objects: [{ kind: "task", id }],
          codes: [result.task.code],
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
      return { ok: true, result: { inverse: null, objects: [{ kind: "task", id }], codes: [] } };
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
