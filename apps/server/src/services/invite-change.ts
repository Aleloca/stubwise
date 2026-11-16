import { projects, roles, type Db } from "@stubwise/db";
import { inArray } from "drizzle-orm";
import { inviteIdOf } from "./admin-people.js";

/**
 * Area 9, F2: l'oggetto e i `params` di una voce d'invito. L'id è quello
 * OPACO (`inviteIdOf`), l'etichetta l'email invitata; i progetti e i ruoli per
 * NOME, fissati ora. Il token non entra mai.
 */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const inviteObject = (token: string, email: string) => ({ type: "invite", id: inviteIdOf(token), label: email });

export async function inviteParams(
  tx: Tx,
  instanceRoleId: string,
  grants: readonly { projectId: string; roleId: string }[],
): Promise<Record<string, string | string[]>> {
  const roleIds = [instanceRoleId, ...grants.map((g) => g.roleId)];
  const roleNames = new Map((await tx.select({ id: roles.id, name: roles.name }).from(roles).where(inArray(roles.id, roleIds))).map((r) => [r.id, r.name]));
  const codes = grants.length
    ? new Map((await tx.select({ id: projects.id, code: projects.code }).from(projects).where(inArray(projects.id, grants.map((g) => g.projectId)))).map((p) => [p.id, p.code]))
    : new Map<string, string>();
  return {
    instanceRole: roleNames.get(instanceRoleId) ?? "",
    projects: grants.map((g) => `${codes.get(g.projectId) ?? "?"} · ${roleNames.get(g.roleId) ?? "?"}`),
  };
}

