import { inviteProjects, invites, projects, roles, users, type Db } from "@stubwise/db";
import type { InviteLink } from "@stubwise/shared";
import { alias } from "drizzle-orm/pg-core";
import { asc, eq } from "drizzle-orm";

/**
 * Area 9, F1 (decisione del maintainer): la lettura pubblica di un invito,
 * prima di registrarsi. Non cambia niente. I dettagli (email, chi invita, i
 * progetti col ruolo, il ruolo d'istanza se non è User, la scadenza) SOLO su un
 * invito valido; uno scaduto dà solo lo stato. Un invito usato o revocato è
 * cancellato: per il server è indistinguibile da un token sbagliato, quindi
 * `invalid`, senza nomi né date.
 */
const inviters = alias(users, "inviter");

export async function readInvite(db: Db, token: string): Promise<InviteLink> {
  const empty = { email: null, invitedByName: null, projects: [], instanceRoleName: null, expiresAt: null };
  const [row] = await db
    .select({
      email: invites.email,
      expiresAt: invites.expiresAt,
      inviterName: inviters.displayName,
      inviterEmail: inviters.email,
      roleName: roles.name,
      rolePreset: roles.presetKey,
    })
    .from(invites)
    .leftJoin(inviters, eq(inviters.id, invites.invitedByUserId))
    .leftJoin(roles, eq(roles.id, invites.instanceRoleId))
    .where(eq(invites.token, token));
  if (!row) return { status: "invalid", ...empty };
  if (row.expiresAt.getTime() <= Date.now()) return { status: "expired", ...empty };
  const granted = await db
    .select({ code: projects.code, name: projects.name, roleName: roles.name })
    .from(inviteProjects)
    .innerJoin(projects, eq(projects.id, inviteProjects.projectId))
    .innerJoin(roles, eq(roles.id, inviteProjects.roleId))
    .where(eq(inviteProjects.inviteToken, token))
    .orderBy(asc(projects.name));
  return {
    status: "valid",
    email: row.email,
    invitedByName: row.inviterName ?? row.inviterEmail?.split("@")[0] ?? null,
    projects: granted,
    instanceRoleName: row.roleName && row.rolePreset !== "user" ? row.roleName : null,
    expiresAt: row.expiresAt.toISOString(),
  };
}
