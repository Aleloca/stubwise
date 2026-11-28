import { workspaceMembers, workspaceProjects, type Db } from "@stubwise/db";
import { and, eq, sql } from "drizzle-orm";
import { RoleRuleError } from "../services/roles.js";
import { addProject, putMember, removeMember, removeProject } from "../services/workspaces.js";
import type { ActionObject, CatalogEntry, CatalogRefusal } from "./catalog.js";

/**
 * Workspace, lotto 3 (D14): le voci del catalogo di Claude per entrare in una
 * workspace e metterci un progetto, con «Annulla». Come le altre: la rotta di
 * riferimento, il suo `config.access`, e `run` che chiama IL SERVIZIO della
 * rotta (permessi, escalation, `last_manager`, registro e card sono quelli di
 * sempre). Le due add sono C (le rotte chiedono la riconferma, D11); le due
 * remove esistono solo come inversi (`CLAUDE_INVERSE_ONLY_FNS`) e non tolgono
 * mai gli override di una persona.
 */

const refused = (code: CatalogRefusal["code"], message: string) => ({ ok: false as const, refusal: { code, message } });

function ruleRefusal(error: unknown): { ok: false; refusal: CatalogRefusal } {
  if (!(error instanceof RoleRuleError)) throw error;
  const code: CatalogRefusal["code"] =
    error.status === 403 ? "forbidden" : error.status === 404 ? "not_found" : error.status === 409 ? "conflict" : "invalid";
  return refused(code, error.code);
}

/** L'istante a FINE scrittura, ai microsecondi (la regola di `catalog-area9.ts`). */
async function txNow(tx: Db): Promise<string> {
  const res = (await tx.execute(sql`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at`)) as unknown as { rows?: { at: string }[] } & { at: string }[];
  return (res.rows ?? res)[0]!.at;
}

/** La persona nella workspace: «Annulla» guarda le voci arrivate DOPO sulla persona, dei tipi della workspace. */
const memberObject = async (tx: Db, workspaceId: string, userId: string): Promise<ActionObject> => ({
  kind: "workspace",
  subjectKind: "person",
  id: userId,
  workspaceId,
  changeTypes: ["workspace.member_added", "workspace.member_role_changed", "workspace.member_removed"],
  stamp: await txNow(tx),
});

/** Il progetto nella workspace: le voci arrivate DOPO su quel progetto, dei tipi dello spostamento. */
const projectObject = async (tx: Db, workspaceId: string, projectId: string): Promise<ActionObject> => ({
  kind: "workspace",
  subjectKind: "workspace",
  id: "",
  workspaceId,
  projectId,
  changeTypes: ["workspace.project_added", "workspace.project_removed"],
  stamp: await txNow(tx),
});

async function memberNow(tx: Db, workspaceId: string, userId: string) {
  const [row] = await tx
    .select({ roleId: workspaceMembers.roleId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  return row ?? null;
}

async function workspaceOfProject(tx: Db, projectId: string): Promise<string | null> {
  const [row] = await tx.select({ id: workspaceProjects.workspaceId }).from(workspaceProjects).where(eq(workspaceProjects.projectId, projectId));
  return row?.id ?? null;
}

const MEMBERS_ACCESS = { kind: "user" as const };
const STRUCTURE_ACCESS = { kind: "instance" as const, permission: "workspaces.manage" as const };
const memberRequest = (args: Record<string, unknown>) => ({ params: { id: args["workspaceId"], userId: args["userId"] }, body: { roleId: args["roleId"] } });
const projectRequest = (args: Record<string, unknown>) => ({ params: { id: args["workspaceId"], projectId: args["projectId"] } });

export const WORKSPACE_ENTRIES: readonly CatalogEntry[] = [
  {
    // Solo chi non c'è (per cambiare ruolo c'è la pagina).
    fn: "addWorkspaceMember",
    route: "PUT /api/workspaces/:id/members/:userId",
    access: MEMBERS_ACCESS,
    request: memberRequest,
    async run(tx, user, args) {
      const { workspaceId, userId, roleId } = args as { workspaceId: string; userId: string; roleId?: string };
      if (await memberNow(tx, workspaceId, userId)) return refused("conflict", "already_member");
      try {
        await putMember(tx, user, workspaceId, userId, { roleId });
      } catch (error) {
        return ruleRefusal(error);
      }
      return { ok: true, result: { inverse: { fn: "removeWorkspaceMember", args: { workspaceId, userId } }, objects: [await memberObject(tx, workspaceId, userId)], codes: [] } };
    },
  },
  {
    // Solo come inverso: mai gli override (alsoProjects no). «Annulla» la rimette col ruolo di prima.
    fn: "removeWorkspaceMember",
    route: "DELETE /api/workspaces/:id/members/:userId",
    access: MEMBERS_ACCESS,
    request: memberRequest,
    async run(tx, user, args) {
      const { workspaceId, userId } = args as { workspaceId: string; userId: string };
      const before = await memberNow(tx, workspaceId, userId);
      if (!before) return refused("not_found", "member_not_found");
      try {
        await removeMember(tx, user, workspaceId, userId);
      } catch (error) {
        return ruleRefusal(error);
      }
      return {
        ok: true,
        result: { inverse: { fn: "addWorkspaceMember", args: { workspaceId, userId, roleId: before.roleId } }, objects: [await memberObject(tx, workspaceId, userId)], codes: [] },
      };
    },
  },
  {
    // Mettere (o spostare) un progetto; «Annulla» lo toglie, o lo rimette dov'era.
    fn: "addWorkspaceProject",
    route: "PUT /api/workspaces/:id/projects/:projectId",
    access: STRUCTURE_ACCESS,
    request: projectRequest,
    async run(tx, user, args) {
      const { workspaceId, projectId } = args as { workspaceId: string; projectId: string };
      const before = await workspaceOfProject(tx, projectId);
      if (before === workspaceId) return refused("conflict", "already_in_workspace");
      try {
        await addProject(tx, user, workspaceId, projectId);
      } catch (error) {
        return ruleRefusal(error);
      }
      return {
        ok: true,
        result: {
          inverse: before ? { fn: "addWorkspaceProject", args: { workspaceId: before, projectId } } : { fn: "removeWorkspaceProject", args: { workspaceId, projectId } },
          objects: [await projectObject(tx, workspaceId, projectId)],
          codes: [],
        },
      };
    },
  },
  {
    // Solo come inverso.
    fn: "removeWorkspaceProject",
    route: "DELETE /api/workspaces/:id/projects/:projectId",
    access: STRUCTURE_ACCESS,
    request: projectRequest,
    async run(tx, user, args) {
      const { workspaceId, projectId } = args as { workspaceId: string; projectId: string };
      if ((await workspaceOfProject(tx, projectId)) !== workspaceId) return refused("not_found", "project_not_in_workspace");
      try {
        await removeProject(tx, user, workspaceId, projectId);
      } catch (error) {
        return ruleRefusal(error);
      }
      return { ok: true, result: { inverse: { fn: "addWorkspaceProject", args: { workspaceId, projectId } }, objects: [await projectObject(tx, workspaceId, projectId)], codes: [] } };
    },
  },
];
