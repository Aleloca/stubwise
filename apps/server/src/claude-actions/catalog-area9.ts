import { projectMemberPermissions, projectMembers, users, type Db } from "@stubwise/db";
import { and, eq, sql } from "drizzle-orm";
import { fromParam } from "../auth/project-resolvers.js";
import { createPlugin, requestUpdate } from "../services/plugins.js";
import { putProjectMember, removeProjectMember, RoleRuleError } from "../services/roles.js";
import type { ActionObject, CatalogEntry, CatalogRefusal } from "./catalog.js";

/**
 * Area 9, F7: le voci del catalogo dell'area 9 (il prototipo,
 * `data/claude/catalog.ts`, da `archiveProject` a `updateWebhook`). Come le
 * altre: la rotta di riferimento, il suo `config.access`, e `run` che chiama
 * IL SERVIZIO della rotta, così permessi, rifiuti, notifiche e registro sono
 * quelli di sempre. La classe la dice `CLAUDE_DECLARED_CLASS`, e il test
 * d'accordo la confronta con `config.reauth` della rotta.
 */

const refused = (code: CatalogRefusal["code"], message: string) => ({ ok: false as const, refusal: { code, message } });

/** Gli errori delle regole dei ruoli nei codici del catalogo. */
function roleRefusal(error: unknown): { ok: false; refusal: CatalogRefusal } {
  if (!(error instanceof RoleRuleError)) throw error;
  const code: CatalogRefusal["code"] =
    error.status === 403 ? "forbidden" : error.status === 404 ? "not_found" : error.status === 409 ? "conflict" : "invalid";
  return refused(code, error.code);
}

/**
 * L'istante della scrittura, nella sua transazione: le voci del registro della
 * scrittura hanno questo `at` (`now()` della transazione), e «Annulla» guarda
 * se sullo stesso soggetto ne è arrivata una DOPO (`changed_after`).
 */
async function txNow(tx: Db): Promise<string> {
  // Come testo di Postgres, ai microsecondi: un ISO di JS ha i millisecondi, e
  // le voci di QUESTA scrittura risulterebbero «dopo».
  const res = (await tx.execute(sql`select now()::text as at`)) as unknown as { rows?: { at: string }[] } & { at: string }[];
  return (res.rows ?? res)[0]!.at;
}

const memberObject = async (tx: Db, projectId: string, userId: string): Promise<ActionObject> => ({
  kind: "member",
  id: userId,
  projectId,
  stamp: await txNow(tx),
});

/** Il membro com'è adesso: il ruolo e se ha permessi personali (che Claude non ridà). */
async function memberNow(tx: Db, projectId: string, userId: string) {
  const [row] = await tx
    .select({ roleId: projectMembers.roleId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  if (!row) return null;
  const [personal] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(projectMemberPermissions)
    .where(and(eq(projectMemberPermissions.projectId, projectId), eq(projectMemberPermissions.userId, userId)));
  return { roleId: row.roleId, personal: (personal?.n ?? 0) > 0 };
}

/** L'utente di sistema «Claude» non è un membro (come la rotta: 404). */
async function isAgent(tx: Db, userId: string): Promise<boolean> {
  const [u] = await tx.select({ isAgent: users.isAgent }).from(users).where(eq(users.id, userId));
  return u?.isAgent === true;
}

const MEMBERS = {
  kind: "project" as const,
  permission: "project.members.manage" as const,
  project: fromParam("projectId"),
};
const memberRequest = (args: Record<string, unknown>) => ({ params: { projectId: args["projectId"], userId: args["userId"] } });

export const AREA9_ENTRIES: CatalogEntry[] = [
  {
    // Aggiungere un membro: solo chi non lo è (per cambiare ruolo c'è `setMemberRole`).
    fn: "addMember",
    route: "PUT /api/projects/:projectId/members/:userId",
    access: MEMBERS,
    request: memberRequest,
    async run(tx, user, args, permissions) {
      const { projectId, userId, roleId } = args as { projectId: string; userId: string; roleId: string };
      if (await isAgent(tx, userId)) return refused("not_found", "user_not_found");
      if (await memberNow(tx, projectId, userId)) return refused("conflict", "already_member");
      try {
        await putProjectMember(tx, user, permissions, projectId, userId, roleId);
      } catch (error) {
        return roleRefusal(error);
      }
      return { ok: true, result: { inverse: { fn: "removeMember", args: { projectId, userId } }, objects: [await memberObject(tx, projectId, userId)], codes: [] } };
    },
  },
  {
    // Cambiare il ruolo di chi è già membro; i suoi permessi personali restano (la rotta senza `permissions`).
    fn: "setMemberRole",
    route: "PUT /api/projects/:projectId/members/:userId",
    access: MEMBERS,
    request: memberRequest,
    async run(tx, user, args, permissions) {
      const { projectId, userId, roleId } = args as { projectId: string; userId: string; roleId: string };
      const before = await memberNow(tx, projectId, userId);
      if (!before) return refused("not_found", "member_not_found");
      try {
        await putProjectMember(tx, user, permissions, projectId, userId, roleId);
      } catch (error) {
        return roleRefusal(error);
      }
      return {
        ok: true,
        result: { inverse: { fn: "setMemberRole", args: { projectId, userId, roleId: before.roleId } }, objects: [await memberObject(tx, projectId, userId)], codes: [] },
      };
    },
  },
  {
    // Togliere un membro. «Annulla» lo rimette col ruolo di prima, ma SOLO se
    // non aveva permessi personali: quelli Claude non li ridà (li dà una
    // persona, dalla pagina), quindi con permessi personali non si annulla.
    fn: "removeMember",
    route: "DELETE /api/projects/:projectId/members/:userId",
    access: MEMBERS,
    request: memberRequest,
    async run(tx, user, args, permissions) {
      const { projectId, userId } = args as { projectId: string; userId: string };
      const before = await memberNow(tx, projectId, userId);
      if (!before) return refused("not_found", "member_not_found");
      try {
        await removeProjectMember(tx, user, permissions, projectId, userId);
      } catch (error) {
        return roleRefusal(error);
      }
      return {
        ok: true,
        result: {
          inverse: before.personal ? null : { fn: "addMember", args: { projectId, userId, roleId: before.roleId } },
          objects: [await memberObject(tx, projectId, userId)],
          codes: [],
        },
      };
    },
  },
  {
    // Registrare un plugin ne ESEGUE il codice (lo smoke run parte da solo):
    // `trust: true` è negli argomenti (M-6 = a). Non si annulla.
    fn: "registerPlugin",
    route: "POST /api/plugins",
    access: { kind: "instance", permission: "plugins.manage" },
    request: (args) => ({ body: args }),
    async run(tx, user, args) {
      const { sourceUrl, ref, sourceSubdir } = args as { sourceUrl: string; ref: string; sourceSubdir?: string };
      const result = await createPlugin(tx, { sourceUrl, ref, ...(sourceSubdir !== undefined ? { sourceSubdir } : {}) }, user);
      if (!result.ok) return refused(result.error === "invalid_slug" ? "invalid" : "conflict", result.error === "invalid_slug" ? "invalid_plugin_slug" : "plugin_slug_taken");
      return { ok: true, result: { inverse: null, objects: [], codes: [] } };
    },
  },
  {
    fn: "updatePluginRef",
    route: "POST /api/plugins/:id/update",
    access: { kind: "instance", permission: "plugins.manage" },
    request: (args) => ({ params: { id: args["id"] }, body: { ref: args["ref"], trust: args["trust"] } }),
    async run(tx, user, args) {
      const result = await requestUpdate(tx, args["id"] as string, args["ref"] as string, user);
      if (!result.ok) return refused(result.error === "not_found" ? "not_found" : "conflict", result.error === "not_found" ? "plugin_not_found" : "plugin_job_pending");
      return { ok: true, result: { inverse: null, objects: [], codes: [] } };
    },
  },
];
