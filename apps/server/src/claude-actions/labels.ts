import { projectMembers, roles, users, type Db } from "@stubwise/db";
import type { ClaudeActionFn } from "@stubwise/shared";
import { and, eq } from "drizzle-orm";
import { projectPermissionsFor } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { personName } from "../services/people.js";

export type ActionLabels = { person: string | null; role: string | null };

const NONE: ActionLabels = { person: null, role: null };
const MEMBER_FNS: ReadonlySet<ClaudeActionFn> = new Set(["addMember", "removeMember", "setMemberRole"]);

/**
 * Area 9, F7: i nomi che la scheda di un'azione sui membri mostra («Add
 * {{name}} to {{code}} as {{role}}»), DERIVATI A LETTURA coi permessi di chi
 * guarda: la scheda di una conversazione pubblica la legge anche chi non
 * gestisce i membri. Li vede chi vede il progetto, come l'elenco dei membri
 * (`GET /api/projects/:projectId/members`, `member`); altrimenti null, e la
 * frase ripiega su «a person». Il ruolo di `removeMember` è quello di
 * adesso (gli argomenti non lo portano).
 */
export async function actionLabels(db: Db, viewer: SessionUser, actions: readonly { fn: ClaudeActionFn; args: unknown }[]): Promise<ActionLabels[]> {
  const visible = new Map<string, boolean>();
  const out: ActionLabels[] = [];
  for (const a of actions) {
    if (!MEMBER_FNS.has(a.fn)) {
      out.push(NONE);
      continue;
    }
    const args = a.args as { projectId?: string; userId?: string; roleId?: string };
    if (!args.projectId || !args.userId) {
      out.push(NONE);
      continue;
    }
    if (!visible.has(args.projectId)) visible.set(args.projectId, (await projectPermissionsFor(db, viewer, args.projectId)) !== null);
    if (!visible.get(args.projectId)) {
      out.push(NONE);
      continue;
    }
    const [u] = await db.select({ email: users.email, displayName: users.displayName, isAgent: users.isAgent }).from(users).where(eq(users.id, args.userId));
    let roleName: string | null = null;
    if (args.roleId) {
      const [r] = await db.select({ name: roles.name }).from(roles).where(and(eq(roles.id, args.roleId), eq(roles.scope, "project")));
      roleName = r?.name ?? null;
    } else {
      const [m] = await db
        .select({ name: roles.name })
        .from(projectMembers)
        .innerJoin(roles, eq(roles.id, projectMembers.roleId))
        .where(and(eq(projectMembers.projectId, args.projectId), eq(projectMembers.userId, args.userId)));
      roleName = m?.name ?? null;
    }
    out.push({ person: u && !u.isAgent ? personName(u) : null, role: roleName });
  }
  return out;
}
