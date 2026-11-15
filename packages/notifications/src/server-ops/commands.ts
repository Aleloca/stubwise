import { serverCommands, serverMetrics, serverOperationApprovals, type Db } from "@stubwise/db";
import { canonicalCommandPayload, serverActionKind, serverActionSchema, type ServerAction } from "@stubwise/shared";
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { signCommand } from "./signing.js";

/**
 * I comandi verso l'agente di monitoraggio (area 8, F4b, S3). UN posto che
 * firma: si firma solo ciò che le regole permettono
 * (docs/invariants/server-operations.md):
 * - un'azione dell'insieme chiuso (`serverActionSchema`, parametri stretti);
 * - un `change` solo per un passo di un'approvazione NON revocata, dello
 *   stesso server, con azione e parametri IDENTICI (e il CHECK nel DB);
 * - un container che l'agente ha riportato nell'ultimo campione;
 * - scadenza breve, firma sulla serializzazione canonica.
 */

export class ServerCommandError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Quanto vale un comando prima di scadere. */
export const COMMAND_TTL_MS = 10 * 60 * 1000;
/** Il tetto dell'uscita salvata (non fidata). */
export const COMMAND_OUTPUT_MAX = 16 * 1024;

export interface IssueServerCommandInput {
  serverId: string;
  action: ServerAction;
  approval?: { id: string; stepIndex: number };
  sessionId?: string | null;
  analysisId?: string | null;
  requestedByUserId?: string | null;
}

/** I container che l'agente ha riportato nell'ultimo campione. */
export async function seenContainers(db: Db, serverId: string): Promise<string[]> {
  const [latest] = await db
    .select({ services: serverMetrics.services })
    .from(serverMetrics)
    .where(eq(serverMetrics.serverId, serverId))
    .orderBy(desc(serverMetrics.ts))
    .limit(1);
  return (latest?.services ?? []).map((s) => s.name);
}

export async function issueServerCommand(db: Db, encryptionKey: Buffer, input: IssueServerCommandInput): Promise<{ id: string; kind: "change" | "read" }> {
  const parsed = serverActionSchema.safeParse(input.action);
  if (!parsed.success) throw new ServerCommandError(400, "bad_action", "Not an action of the closed set");
  const action = parsed.data;
  const kind = serverActionKind(action.action)!;

  if (kind === "change" && !input.approval) throw new ServerCommandError(409, "not_approved", "A change needs an approved plan step");

  const container = (action.params as { container?: string }).container;
  if (container !== undefined && !(await seenContainers(db, input.serverId)).includes(container)) {
    throw new ServerCommandError(409, "unknown_container", "The agent has not reported this container");
  }

  return db.transaction(async (tx) => {
  if (kind === "change") {
    // Review F4b, I1: l'approvazione si legge IN LOCK nella stessa
    // transazione che firma. Lo Stop la aggiorna (revoca) in una sua
    // transazione: le due si serializzano, e o la firma vede la revoca, o lo
    // Stop trova il comando già scritto e lo annulla.
    const [approval] = await tx.select().from(serverOperationApprovals).where(eq(serverOperationApprovals.id, input.approval!.id)).for("update");
    if (!approval || approval.serverId !== input.serverId) throw new ServerCommandError(409, "not_approved", "Not an approved step of this server");
    if (approval.revokedAt) throw new ServerCommandError(409, "approval_revoked", "The approval was revoked");
    const step = approval.steps[input.approval!.stepIndex];
    const same =
      step !== undefined &&
      step.action === action.action &&
      canonicalCommandPayload({ ...EMPTY, params: step.params }) === canonicalCommandPayload({ ...EMPTY, params: action.params });
    if (!same) throw new ServerCommandError(409, "not_approved", "Not the approved step");
  }
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + COMMAND_TTL_MS);
    const [row] = await tx
      .insert(serverCommands)
      .values({
        serverId: input.serverId,
        action: action.action,
        params: action.params,
        kind,
        approvalId: input.approval?.id ?? null,
        stepIndex: input.approval?.stepIndex ?? null,
        sessionId: input.sessionId ?? null,
        analysisId: input.analysisId ?? null,
        requestedByUserId: input.requestedByUserId ?? null,
        issuedAt,
        expiresAt,
      })
      .returning({ id: serverCommands.id });
    const signature = await signCommand(tx as unknown as Db, encryptionKey, {
      v: 1,
      serverId: input.serverId,
      commandId: row!.id,
      action: action.action,
      params: action.params,
      approvalId: input.approval?.id ?? null,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    await tx.update(serverCommands).set({ signature }).where(eq(serverCommands.id, row!.id));
    return { id: row!.id, kind };
  });
}

const EMPTY = { v: 1 as const, serverId: "", commandId: "", action: "", approvalId: null, issuedAt: "", expiresAt: "" };

/** Lo Stop e la revoca: i comandi NON consegnati passano a `cancelled`. Restituisce quanti. */
export async function cancelServerCommands(db: Db, scope: { serverId?: string; sessionId?: string; approvalId?: string }): Promise<number> {
  const conds = [eq(serverCommands.status, "pending")];
  if (scope.serverId) conds.push(eq(serverCommands.serverId, scope.serverId));
  if (scope.sessionId) conds.push(eq(serverCommands.sessionId, scope.sessionId));
  if (scope.approvalId) conds.push(eq(serverCommands.approvalId, scope.approvalId));
  const now = new Date();
  // Uno già scaduto resta `expired` (non è stato fermato: non sarebbe partito comunque).
  await db
    .update(serverCommands)
    .set({ status: "expired", finishedAt: now })
    .where(and(...conds, lte(serverCommands.expiresAt, now)));
  const rows = await db
    .update(serverCommands)
    .set({ status: "cancelled", finishedAt: now })
    .where(and(...conds))
    .returning({ id: serverCommands.id });
  return rows.length;
}

/** Per i test e il registro: i comandi di alcuni id. */
export async function commandsByIds(db: Db, ids: string[]) {
  return ids.length === 0 ? [] : db.select().from(serverCommands).where(inArray(serverCommands.id, ids));
}
