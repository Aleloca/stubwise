import { projectMemberPermissions, projectMembers, projects, users, type Db } from "@stubwise/db";
import { aiBudgetState } from "@stubwise/notifications";
import type { UpdateProjectInput } from "@stubwise/shared";
import { and, eq, sql } from "drizzle-orm";
import { fromJob, fromParam } from "../auth/project-resolvers.js";
import { recordChange } from "../services/change-log.js";
import { retryCheck, retryFactsOf } from "../services/instance-status.js";
import { startRun } from "../services/jobs.js";
import { ArchiveError, archiveProject, reopenProject } from "../services/project-archive.js";
import { patchProject } from "../services/project-patch.js";
import { pauseProjectQueue, resumeProjectQueue } from "../services/project-queue.js";
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

const MANAGE = {
  kind: "project" as const,
  permission: "project.settings.manage" as const,
  project: fromParam("projectId"),
};
const projectRequest = (args: Record<string, unknown>) => ({ params: { projectId: args["projectId"] } });

/**
 * Il progetto come oggetto dell'azione, coi tipi di voce che contano per il suo
 * «Annulla»: un salvataggio a mano DOPO, di quelle stesse impostazioni, lo
 * rifiuta (M-7 = a); una modifica di un'altra sezione no.
 */
const projectAction = async (tx: Db, projectId: string, changeTypes: readonly string[]): Promise<ActionObject> => ({
  kind: "project",
  id: projectId,
  projectId,
  changeTypes,
  stamp: await txNow(tx),
});

/** Le impostazioni di adesso, per l'inverso (`was`, come il prototipo). */
async function projectNow(tx: Db, projectId: string) {
  const [row] = await tx.select().from(projects).where(eq(projects.id, projectId));
  return row ?? null;
}

const patchRefusal = (error: "not_found" | "pulse_needs_backlog" | "code_taken" | "ai_provider_not_found") =>
  refused(error === "not_found" ? "not_found" : error === "code_taken" ? "conflict" : "invalid", error);

/** I rifiuti dei servizi d'archivio e della coda (`busy` col suo motivo, `already_archived`…). */
function archiveRefusal(error: unknown): { ok: false; refusal: CatalogRefusal } {
  if (error instanceof ArchiveError) return refused("conflict", error.code);
  return roleRefusal(error);
}

/** Le colonne degli interruttori, nei nomi del prototipo (`PROJECT_SWITCHES`). */
type Switches = { docsNightly: boolean; dailyReport: boolean; backlogDiscovery: boolean; pulse: boolean; weeklyBrief: boolean };

export const AREA9_ENTRIES: CatalogEntry[] = [
  {
    // Archivia: passa su un archiviato come la rotta (`already_archived`), e
    // con lavoro di Claude o un rilascio in corso è un `busy`. Le esecuzioni
    // annullate non tornano con «Annulla» (si riapre soltanto).
    fn: "archiveProject",
    route: "POST /api/projects/:projectId/archive",
    access: MANAGE,
    archived: "write",
    request: projectRequest,
    async run(tx, user, args, permissions) {
      const projectId = args["projectId"] as string;
      try {
        await archiveProject(tx, user, projectId, permissions);
      } catch (error) {
        return archiveRefusal(error);
      }
      return { ok: true, result: { inverse: { fn: "reopenProject", args: { projectId } }, objects: [await projectAction(tx, projectId, ["project.archived", "project.reopened"])], codes: [] } };
    },
  },
  {
    fn: "reopenProject",
    route: "POST /api/projects/:projectId/reopen",
    access: MANAGE,
    archived: "write",
    request: projectRequest,
    async run(tx, user, args) {
      const projectId = args["projectId"] as string;
      try {
        await reopenProject(tx, user, projectId);
      } catch (error) {
        return archiveRefusal(error);
      }
      return { ok: true, result: { inverse: { fn: "archiveProject", args: { projectId } }, objects: [await projectAction(tx, projectId, ["project.archived", "project.reopened"])], codes: [] } };
    },
  },
  {
    fn: "updateProjectGeneral",
    route: "PATCH /api/projects/:projectId",
    access: MANAGE,
    request: projectRequest,
    async run(tx, user, args) {
      const { projectId, name, description } = args as { projectId: string; name?: string; description?: string | null };
      const was = await projectNow(tx, projectId);
      if (!was) return refused("not_found", "project_not_found");
      const patch: UpdateProjectInput = { ...(name !== undefined ? { name } : {}), ...(description !== undefined ? { description } : {}) };
      const out = await patchProject(tx, user, projectId, patch);
      if (!out.ok) return patchRefusal(out.error);
      return {
        ok: true,
        result: {
          inverse: { fn: "updateProjectGeneral", args: { projectId, ...(name !== undefined ? { name: was.name } : {}), ...(description !== undefined ? { description: was.description } : {}) } },
          objects: [await projectAction(tx, projectId, ["project.renamed", "project.description_changed"])],
          codes: [],
        },
      };
    },
  },
  {
    fn: "setProjectAi",
    route: "PATCH /api/projects/:projectId",
    access: MANAGE,
    request: projectRequest,
    async run(tx, user, args) {
      const { projectId, providerId, exclusive } = args as { projectId: string; providerId: string | null; exclusive: boolean };
      const was = await projectNow(tx, projectId);
      if (!was) return refused("not_found", "project_not_found");
      const out = await patchProject(tx, user, projectId, { aiProviderId: providerId, aiProviderExclusive: exclusive });
      if (!out.ok) return patchRefusal(out.error);
      return {
        ok: true,
        result: {
          inverse: { fn: "setProjectAi", args: { projectId, providerId: was.aiProviderId, exclusive: was.aiProviderExclusive } },
          objects: [await projectAction(tx, projectId, ["project.ai_account_changed"])],
          codes: [],
        },
      };
    },
  },
  {
    // Tutta la sezione Automations, come la salva la pagina: gli interruttori,
    // la cadenza del pulse e il tetto delle correzioni. Il pulse senza la
    // discovery è rifiutato (K-2), come la rotta.
    fn: "saveProjectAutomations",
    route: "PATCH /api/projects/:projectId",
    access: MANAGE,
    request: projectRequest,
    async run(tx, user, args) {
      const { projectId, switches, pulseEveryDays, correctionCap } = args as { projectId: string; switches: Switches; pulseEveryDays: number; correctionCap: number };
      const was = await projectNow(tx, projectId);
      if (!was) return refused("not_found", "project_not_found");
      const out = await patchProject(tx, user, projectId, {
        docAutoUpdate: switches.docsNightly,
        dailyReportEnabled: switches.dailyReport,
        backlogEnabled: switches.backlogDiscovery,
        pulseEnabled: switches.pulse,
        weeklyBriefEnabled: switches.weeklyBrief,
        pulseEveryDays,
        prCorrectionMaxRounds: correctionCap,
      });
      if (!out.ok) return patchRefusal(out.error);
      const wasSwitches: Switches = {
        docsNightly: was.docAutoUpdate,
        dailyReport: was.dailyReportEnabled,
        backlogDiscovery: was.backlogEnabled,
        pulse: was.pulseEnabled,
        weeklyBrief: was.weeklyBriefEnabled,
      };
      return {
        ok: true,
        result: {
          inverse: { fn: "saveProjectAutomations", args: { projectId, switches: wasSwitches, pulseEveryDays: was.pulseEveryDays, correctionCap: was.prCorrectionMaxRounds } },
          objects: [await projectAction(tx, projectId, ["project.docs_toggled", "project.switch_changed", "project.pulse_interval_changed", "project.correction_cap_changed"])],
          codes: [],
        },
      };
    },
  },
  {
    fn: "pauseQueue",
    route: "POST /api/projects/:projectId/queue/pause",
    access: MANAGE,
    request: projectRequest,
    async run(tx, user, args) {
      const projectId = args["projectId"] as string;
      try {
        await pauseProjectQueue(tx, user, projectId);
      } catch (error) {
        return roleRefusal(error);
      }
      return { ok: true, result: { inverse: { fn: "resumeQueue", args: { projectId } }, objects: [await projectAction(tx, projectId, ["queue.paused", "queue.resumed"])], codes: [] } };
    },
  },
  {
    fn: "resumeQueue",
    route: "POST /api/projects/:projectId/queue/resume",
    access: MANAGE,
    request: projectRequest,
    async run(tx, user, args) {
      const projectId = args["projectId"] as string;
      try {
        await resumeProjectQueue(tx, user, projectId);
      } catch (error) {
        return roleRefusal(error);
      }
      return { ok: true, result: { inverse: { fn: "pauseQueue", args: { projectId } }, objects: [await projectAction(tx, projectId, ["queue.paused", "queue.resumed"])], codes: [] } };
    },
  },
  {
    // «Retry» dello Stato dell'istanza, la STESSA `retryCheck` della rotta e
    // `startRun` col gate del piano. Fa ripartire lavoro: non si annulla (M-8 = a).
    fn: "retryJob",
    route: "POST /api/instance/jobs/:id/retry",
    access: { kind: "project", permission: "project.settings.manage", project: fromJob("id") },
    request: (args) => ({ params: { id: args["jobId"] } }),
    async run(tx, user, args, permissions, start) {
      const jobId = args["jobId"] as string;
      const facts = await retryFactsOf(tx, jobId);
      if (!facts) return refused("not_found", "job_not_found");
      const perms = permissions as ReadonlySet<string>;
      const check = retryCheck(facts, perms, (await aiBudgetState(tx)).exhausted, new Date());
      if (check.reason === "conflict") return refused("conflict", "conflict");
      if (check.reason === "not_retryable") return refused("invalid", "not_retryable");
      if (check.retryBlock) return refused("busy", "monthly_budget");
      if (check.retry !== "allowed") return refused("forbidden", "forbidden");
      const result = await startRun(tx, {
        ticketId: facts.ticketId,
        actor: { id: user.id, permissions },
        ...(start.publicUrl !== undefined ? { publicUrl: start.publicUrl } : {}),
        expectLatestJobId: jobId,
        afterInTx: async (inner) => {
          await recordChange(inner, { type: "job.retried", actor: user, projectId: facts.projectId, data: { object: { type: "task", id: facts.ticketId, label: facts.code } } });
        },
      });
      if (!result.ok) return refused(result.error === "forbidden" ? "forbidden" : "conflict", result.error);
      return { ok: true, result: { inverse: null, objects: [{ kind: "task", id: facts.ticketId, code: facts.code }], codes: [facts.code], startsWork: true } };
    },
  },
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
