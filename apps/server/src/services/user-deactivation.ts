import {
  desktopHandoffs,
  deviceTokens,
  emailChanges,
  invites,
  passwordResetTokens,
  personalAccessTokens,
  projectAccess,
  projectAccessSql,
  roles,
  sessions,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { recordSecurityEvent } from "../auth/second-factor/security-events.js";
import { personObject, recordChange } from "./change-log.js";
import { inviteObject } from "./invite-change.js";
import { assertFullAdminRemains, keepingManagersIn, RoleRuleError } from "./roles.js";

/**
 * Area 9, F1 (D-6; docs/invariants/permissions.md, «Una persona disattivata
 * non entra da nessuna porta, e non si disattiva l'ultimo full admin»).
 *
 * Disattivare, in UNA transazione:
 * - la persona è segnata `deactivated_at` (le letture dell'identità, il login e
 *   lo scambio del desktop la trattano come assente);
 * - i device si SPENGONO (`user_deactivated`, come alla revoca di un PAT), poi
 *   si cancellano sessioni, PAT, passaggi del desktop e link di reset aperti;
 * - gli inviti pendenti che ha mandato si revocano;
 * - le task aperte assegnate a lei si riassegnano PER TASK, come dice
 *   `reassign` (una task assente o `null` resta sua). Una riga non valida fa
 *   fallire tutto (`422 invalid_reassignment`, con l'id della task): niente a
 *   metà;
 * - una riga in `security_events`.
 * Mai sé stessi, mai l'ultimo full admin ATTIVO, mai Claude, mai l'ultimo
 * gestore ATTIVO dei membri di un progetto (`409 last_manager` col `projectId`).
 */

type Actor = { id: string; email: string };

export async function deactivateUser(db: Db, actor: Actor, userId: string, reassign: Record<string, string | null> = {}): Promise<void> {
  if (userId === actor.id) throw new RoleRuleError(400, "cannot_deactivate_self", "You cannot deactivate your own account");
  await db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: users.id, email: users.email, isAgent: users.isAgent, deactivatedAt: users.deactivatedAt })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!target || target.isAgent) throw new RoleRuleError(404, "user_not_found", "User not found");
    if (target.deactivatedAt) return;

    // Le righe della riassegnazione, tutte valide prima di toccare qualunque cosa.
    const rows = Object.entries(reassign).filter((r): r is [string, string] => r[1] !== null);
    const taskIds = Object.keys(reassign);
    const own = taskIds.length
      ? await tx
          .select({ id: tickets.id, projectId: tickets.projectId })
          .from(tickets)
          .where(and(inArray(tickets.id, taskIds), eq(tickets.assigneeId, userId), isNull(tickets.closedAt)))
      : [];
    const projectOf = new Map(own.map((t) => [t.id, t.projectId]));
    for (const taskId of taskIds) {
      if (!projectOf.has(taskId)) throw invalidReassignment(taskId);
    }
    for (const [taskId, toUserId] of rows) {
      if (!(await canReceive(tx, toUserId, projectOf.get(taskId)!)) || toUserId === userId) throw invalidReassignment(taskId);
    }

    // Nessun progetto resta senza un gestore ATTIVO (review di F1, m4).
    // Anche i progetti visti per workspace (D18: anche lì può essere il gestore).
    const memberOf = await tx.selectDistinct({ projectId: projectAccess.projectId }).from(projectAccess).where(eq(projectAccess.userId, userId));
    await keepingManagersIn(
      tx,
      memberOf.map((m) => m.projectId),
      async () => {
        await tx.update(users).set({ deactivatedAt: new Date(), deactivatedByUserId: actor.id }).where(eq(users.id, userId));
      },
    );
    await assertFullAdminRemains(tx);

    await tx
      .update(deviceTokens)
      .set({ disabledAt: new Date(), disabledReason: "user_deactivated" })
      .where(and(eq(deviceTokens.userId, userId), isNull(deviceTokens.disabledAt)));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await tx.delete(personalAccessTokens).where(eq(personalAccessTokens.userId, userId));
    await tx.delete(desktopHandoffs).where(eq(desktopHandoffs.userId, userId));
    await tx.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userId));
    // Un cambio dell'email in attesa non sopravvive (review di F1): sennò il
    // link tornerebbe buono a una riattivazione entro le 24 ore.
    await tx
      .update(emailChanges)
      .set({ cancelledAt: new Date() })
      .where(and(eq(emailChanges.userId, userId), isNull(emailChanges.confirmedAt), isNull(emailChanges.cancelledAt)));
    // Review di F2 (m5): ogni invito revocato lascia la sua voce.
    const revoked = await tx.delete(invites).where(eq(invites.invitedByUserId, userId)).returning({ token: invites.token, email: invites.email });
    for (const invite of revoked) {
      await recordChange(tx, { type: "invite.revoked", actor, projectId: null, data: { object: inviteObject(invite.token, invite.email), params: { via: "deactivation" } } });
    }
    for (const [taskId, toUserId] of rows) {
      await tx.update(tickets).set({ assigneeId: toUserId }).where(eq(tickets.id, taskId));
    }
    await recordSecurityEvent(tx, { kind: "deactivated", user: target, actor });
    // Area 9, F2: quante task sono andate a chi, mai i titoli.
    await recordChange(tx, { type: "person.deactivated", actor, projectId: null, data: { object: personObject(target), params: { reassigned: String(rows.length) } } });
  });
}

export async function reactivateUser(db: Db, actor: Actor, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: users.id, email: users.email, isAgent: users.isAgent, deactivatedAt: users.deactivatedAt })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!target || target.isAgent) throw new RoleRuleError(404, "user_not_found", "User not found");
    if (!target.deactivatedAt) return;
    await tx.update(users).set({ deactivatedAt: null, deactivatedByUserId: null }).where(eq(users.id, userId));
    await recordSecurityEvent(tx, { kind: "reactivated", user: target, actor });
    await recordChange(tx, { type: "person.reactivated", actor, projectId: null, data: { object: personObject(target) } });
  });
}

function invalidReassignment(taskId: string): RoleRuleError {
  return new RoleRuleError(422, "invalid_reassignment", "A task cannot be reassigned that way", { taskId });
}

/** Una persona attiva (non Claude) che vede il progetto: membro, o full admin. */
async function canReceive(tx: Parameters<Parameters<Db["transaction"]>[0]>[0], userId: string, projectId: string): Promise<boolean> {
  const [row] = await tx
    // Membro esplicito o di workspace (0238).
    .select({ permissions: roles.permissions, member: projectAccessSql(sql`${projectId}::uuid`, users.id) })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.instanceRoleId))
    .where(and(eq(users.id, userId), eq(users.isAgent, false), isNull(users.deactivatedAt)));
  if (!row) return false;
  return row.member === true || row.permissions.includes("instance.full_admin");
}
