import { users, type Db } from "@stubwise/db";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projectPermissionsFor } from "../auth/access.js";
import { publicUrlOrUndefined } from "../ingest/shared.js";
import { startRun } from "./jobs.js";
import type { TaskViewer } from "./task-view.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Claude come assegnatario (integrazione area 3, fetta 3e): la regola in UN
 * posto, per TUTTE le porte che assegnano una task — le rotte nuove
 * (`task-writes.ts`: crea, modifica, in blocco, pianifica) e quelle vecchie
 * (`POST /api/tickets`, `PATCH /api/tickets/:id`, usate dal web vecchio,
 * dall'app mobile e dall'MCP; review dell'area 3, punto 3). Assegnare Claude
 * AVVIA il lavoro, quindi chiede `runs.start` nel progetto; senza,
 * `claude_assign_forbidden` e niente si scrive.
 */

/** L'utente di sistema «Claude» (migrazione 0125), o null su un DB senza. Uno per istanza. */
export async function agentUserId(db: Db | Tx): Promise<string | null> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.isAgent, true)).limit(1);
  return row?.id ?? null;
}

/**
 * Assegnare Claude chiede `runs.start` nel progetto (decisione del
 * maintainer): chi non ce l'ha riceve `claude_assign_forbidden`. Toglierlo non
 * chiede niente.
 */
export async function claudeAssignGuard(
  db: Db | Tx,
  viewer: TaskViewer,
  projectId: string,
  assigneeId: string | null | undefined,
): Promise<"claude_assign_forbidden" | null> {
  if (!assigneeId || assigneeId !== (await agentUserId(db))) return null;
  const permissions = await projectPermissionsFor(db, viewer, projectId);
  return permissions?.has("runs.start") ? null : "claude_assign_forbidden";
}

/**
 * Dopo la scrittura: per ogni task APPENA assegnata a Claude parte il run,
 * con le stesse regole di run-ai (`startRun`: precondizioni, gate del piano per
 * chi non ha `plans.approve`), a nome di chi l'ha assegnata. Un lavoro già in
 * corso non ne fa partire un altro (`job_in_flight`, ignorato). Fuori dalla
 * transazione della scrittura, come la rotta run-ai: l'assegnazione resta
 * anche se l'avvio non parte.
 */
export async function startClaudeRuns(
  db: Db,
  viewer: TaskViewer,
  assigned: { ticketId: string; projectId: string }[],
  options: ClaudeStartOptions = {},
): Promise<Map<string, ClaudeRunOutcome>> {
  const outcomes = new Map<string, ClaudeRunOutcome>();
  for (const { ticketId, projectId } of assigned) {
    const permissions = (await projectPermissionsFor(db, viewer, projectId)) ?? new Set();
    try {
      const result = await startRun(db, {
        ticketId,
        actor: { id: viewer.id, permissions },
        // Il link della notifica `job.plan_review` quando il run nasce parcheggiato sul gate.
        ...(options.publicUrl !== undefined ? { publicUrl: options.publicUrl } : {}),
      });
      outcomes.set(ticketId, result.ok ? "started" : `refused:${result.error}`);
      if (!result.ok) options.log?.("Claude assegnato, il lavoro non parte", { ticketId, error: result.error });
    } catch (error) {
      // L'assegnazione è scritta; il lavoro si avvia anche a mano.
      outcomes.set(ticketId, "refused:error");
      options.log?.("Claude assegnato, avvio del lavoro fallito", { ticketId, err: error });
    }
  }
  return outcomes;
}

/** L'esito dell'avvio per una task appena assegnata a Claude (`TaskViewData.claudeRun`). */
export type ClaudeRunOutcome = "started" | `refused:${string}`;

/** Dalla rotta: il link pubblico per la notifica e dove loggare un avvio che non parte. */
export interface ClaudeStartOptions {
  publicUrl?: string;
  log?: (message: string, detail: Record<string, unknown>) => void;
}

/** Dalla rotta: il link pubblico dell'istanza e il log della richiesta. */
export function claudeStart(app: FastifyInstance, request: { log: FastifyBaseLogger }): ClaudeStartOptions {
  const publicUrl = publicUrlOrUndefined(app);
  return {
    ...(publicUrl !== undefined ? { publicUrl } : {}),
    log: (message, detail) => request.log.warn(detail, message),
  };
}
