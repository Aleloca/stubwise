import type { AiModelChoice, AiOperation } from "@stubwise/shared";
import { alertTypeOf } from "../../domain/alerts/catalog";
import { accessState } from "../access/index";
import { addMemberAs, removeMemberAs, setMemberRoleAs } from "../admin/members";
import { currentChannels } from "../alerts/reads";
import { setSubscriptionAs } from "../alerts/writes";
import {
  addCommentAs,
  archiveRequestAs,
  convertRequestAs,
  createMilestoneAs,
  createRequestAs,
  createTaskAs,
  deleteCommentAs,
  deleteMilestoneAs,
  launchRun,
  planTaskAs,
  prepareRunAs,
  reopenRequestAs,
  updateTaskAs,
} from "../api-mutations";
import type { NewRequestInput } from "../api-mutations";
import { REAUTH_REQUIRED } from "../auth/reauth";
import { saveAutomationAs, type AutomationSettings } from "../instance/automation";
import { saveBudgetAs, type ContentLanguage } from "../instance/budget";
import { setDefaultReviewerAs, updateGitAccountAs } from "../instance/git";
import { updateGoogleAppAs } from "../instance/google";
import { setModelAs } from "../instance/models";
import {
  registerPluginAs,
  removePluginAs,
  rerunSmokeAs,
  updatePluginRefAs,
} from "../instance/plugins";
import { moveProviderAs, setProviderEnabledAs } from "../instance/providers";
import { pauseQueueAs, resumeQueueAs } from "../instance/queue";
import { retryJobAs } from "../instance/retry";
import { saveStorageAs, setAttachmentsAs } from "../instance/storage";
import { saveWebhookAs, type WebhookFormat } from "../instance/webhook";
import type { MilestoneInput, NewTaskInput, Task, TaskPatch } from "../model";
import { setProjectAiAs } from "../projectSettings/ai";
import { archiveProjectAs, reopenProjectAs } from "../projectSettings/archive";
import { saveProjectAutomationsAs } from "../projectSettings/automations";
import { updateProjectGeneralAs } from "../projectSettings/general";
import { settingsOf } from "../projectSettings/reads";
import type { ProjectSwitch } from "../projectSettings/state";
import { capOf } from "../releases/visibility";
import { state, type ApiFnName } from "../store";
import { deleteTaskAs } from "../taskDelete";
import type { CatalogInverse, ClaudeActionFn, ObjectRef } from "./types";

// Il catalogo delle azioni di Claude (area 10a, Task 4): l'elenco CHIUSO di
// ciò che il riquadro può fare. Ogni voce chiama la forma sincrona («As»)
// di una scrittura che la pagina usa già: il catalogo non ha scritture sue,
// quindi permessi, rifiuti e registro sono quelli di sempre. La voce dichiara
// la classe di partenza (A o B), se si annulla, l'azione del «Who?» e la
// funzione dell'API; la classe C la dà `REAUTH_REQUIRED`, mai la voce. Il
// valore di prima, per l'inverso, si legge dentro `run` prima di scrivere.
//
// Ciò che è un gesto delle persone (approvare, mergiare, rispondere,
// accendere un'automazione, registrare una decisione, i segreti…) qui non
// c'è e non si nomina: `neverInCatalog.test.ts`.

export interface CatalogRun {
  codes: string[];
  projectIds: string[];
  inverse: CatalogInverse;
  objects: ObjectRef[];
  /** Il lavoro che parte solo a gruppo riuscito (la sessione di `retryJob`). */
  after?: (gen: number) => Promise<void>;
}

export interface CatalogEntry {
  fn: ClaudeActionFn;
  apiFn: ApiFnName;
  /** La classe dichiarata: A o B. La C viene da `REAUTH_REQUIRED`, mai da qui. */
  baseClass: "A" | "B";
  /** Se la voce ha un inverso (il valore vero lo dà `run`). */
  undoable: boolean;
  /** L'azione di `ACTIONS` per il «Who?» di un rifiuto; `null` solo per `setSubscription` (P19). */
  whoAction: string | null;
  /** Sincrona; lancia come `applyActions` (`forbidden`, `not_found`, `invalid: …`, `busy`, `reauth_required`). */
  run(me: string, args: Record<string, unknown>): CatalogRun;
}

type Args = Record<string, unknown>;

/**
 * Il risultato di una scrittura che rifiuta in forma di dato (9a–9c, 10a),
 * come errore col suo codice: `applyActions` lo trasforma in un fallimento
 * del gruppo e rimette lo stato. `busy` porta le sue ragioni.
 */
function done<R extends { ok: boolean }>(result: R): Extract<R, { ok: true }> {
  if (result.ok) return result as Extract<R, { ok: true }>;
  const refusal = result as unknown as { error: string; reason?: string; reasons?: unknown[] };
  switch (refusal.error) {
    case "busy":
      throw Object.assign(new Error("busy"), { reasons: refusal.reasons ?? [] });
    case "invalid":
      throw new Error(`invalid: ${refusal.reason ?? "input"}`);
    case "in_use":
      throw new Error("invalid: in_use");
    // Dare ciò che non si ha è un permesso che manca.
    case "escalation":
      throw new Error("forbidden");
    default:
      throw new Error(refusal.error);
  }
}

const invalid = (what: string) => new Error(`invalid: ${what}`);

/** Solo i campi presenti negli argomenti: gli assenti restano come sono. */
function present<K extends string>(args: Args, keys: readonly K[]): Partial<Record<K, unknown>> {
  return Object.fromEntries(
    keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]),
  ) as Partial<Record<K, unknown>>;
}

const onTask = (task: Task, inverse: CatalogInverse, codes = [task.code]): CatalogRun => ({
  codes,
  projectIds: [task.projectId],
  inverse,
  objects: [{ kind: "task", id: task.id }],
});

/** Un'impostazione d'istanza toccata (`instanceSetting`), senza codici né progetti. */
const onSetting = (
  key: string,
  inverse: CatalogInverse,
  projectIds: string[] = [],
): CatalogRun => ({
  codes: [],
  projectIds,
  inverse,
  objects: [{ kind: "instanceSetting", key }],
});

const onProject = (projectId: string, inverse: CatalogInverse, settings = false): CatalogRun => ({
  codes: [],
  projectIds: [projectId],
  inverse,
  objects: [settings ? { kind: "projectSettings", projectId } : { kind: "project", id: projectId }],
});

const onMember = (projectId: string, personId: string, inverse: CatalogInverse): CatalogRun => ({
  codes: [],
  projectIds: [projectId],
  inverse,
  objects: [{ kind: "member", projectId, personId }],
});

const roleOf = (projectId: string, personId: string): string | null =>
  accessState().memberships.find((m) => m.projectId === projectId && m.personId === personId)
    ?.roleId ?? null;

type Declaration = Omit<CatalogEntry, "fn">;

const ENTRIES: Record<ClaudeActionFn, Declaration> = {
  // --- task, richieste, traguardi (le scritture delle pagine) -----------------
  createTask: {
    apiFn: "createTask",
    baseClass: "A",
    undoable: true,
    whoAction: "createTasks",
    run(me, args) {
      // La scrittura vera (P5): avviso `task.created`, `task.assigned` e il
      // segnale `task_created`, cioè ciò che `classOf` ha calcolato.
      const task = createTaskAs(me, args as unknown as NewTaskInput);
      // L'eccezione senza scheda del design: «Annulla» la elimina.
      return onTask(task, { fn: "deleteTask", args: { id: task.id } });
    },
  },
  updateTask: {
    apiFn: "updateTask",
    baseClass: "A",
    undoable: true,
    whoAction: "editTasks",
    run(me, args) {
      const id = args.id as string;
      const patch = (args.patch ?? {}) as TaskPatch;
      const before = state.tasksById.get(id) as unknown as Args | undefined;
      const was = Object.fromEntries(
        Object.keys(patch).map((k) => [k, structuredClone(before?.[k] ?? null)]),
      );
      const task = updateTaskAs(me, id, patch);
      return onTask(task, { fn: "updateTask", args: { id, patch: was } });
    },
  },
  planTask: {
    apiFn: "planTask",
    baseClass: "A",
    undoable: true,
    whoAction: "editTasks",
    run(me, args) {
      const id = args.id as string;
      const before = state.tasksById.get(id);
      const was = { assigneeId: before?.assigneeId ?? null, week: before?.plannedWeek ?? null };
      const task = planTaskAs(
        me,
        id,
        args.plan as { assigneeId: string | null; week: string | null },
      );
      return onTask(task, { fn: "planTask", args: { id, plan: was } });
    },
  },
  addComment: {
    apiFn: "addComment",
    baseClass: "B",
    undoable: true,
    whoAction: "commentTasks",
    run(me, args) {
      const replyToId = args.replyToId as string | undefined;
      const entry = addCommentAs(me, args.taskId as string, args.body as string, replyToId);
      const task = state.tasksById.get(entry.taskId)!;
      return onTask(task, { fn: "deleteComment", args: { id: entry.id } });
    },
  },
  deleteComment: {
    apiFn: "deleteComment",
    baseClass: "B",
    undoable: false,
    whoAction: "moderateComments",
    run(me, args) {
      const id = args.id as string;
      deleteCommentAs(me, id);
      const taskId = state.activity.find((a) => a.id === id)!.taskId;
      return onTask(state.tasksById.get(taskId)!, null, []);
    },
  },
  createRequest: {
    apiFn: "createRequest",
    baseClass: "B",
    undoable: false,
    whoAction: "addRequests",
    run(me, args) {
      const request = createRequestAs(me, args as unknown as NewRequestInput);
      return {
        codes: [request.code],
        projectIds: [request.projectId],
        inverse: null,
        objects: [{ kind: "request", id: request.id }],
      };
    },
  },
  convertRequest: {
    apiFn: "convertRequest",
    baseClass: "B",
    undoable: false,
    whoAction: "editBacklog",
    run(me, args) {
      const id = args.id as string;
      const input = args.input as Omit<NewTaskInput, "projectId" | "requestId">;
      const task = convertRequestAs(me, id, input);
      return {
        ...onTask(task, null),
        objects: [
          { kind: "task", id: task.id },
          { kind: "request", id },
        ],
      };
    },
  },
  archiveRequest: {
    apiFn: "archiveRequest",
    baseClass: "B",
    undoable: true,
    whoAction: "editBacklog",
    run(me, args) {
      const request = archiveRequestAs(me, args.id as string);
      return {
        codes: [request.code],
        projectIds: [request.projectId],
        inverse: { fn: "reopenRequest", args: { id: request.id } },
        objects: [{ kind: "request", id: request.id }],
      };
    },
  },
  reopenRequest: {
    apiFn: "reopenRequest",
    baseClass: "B",
    undoable: true,
    whoAction: "editBacklog",
    run(me, args) {
      const request = reopenRequestAs(me, args.id as string);
      return {
        codes: [request.code],
        projectIds: [request.projectId],
        inverse: { fn: "archiveRequest", args: { id: request.id } },
        objects: [{ kind: "request", id: request.id }],
      };
    },
  },
  startRun: {
    apiFn: "startRun",
    baseClass: "B",
    undoable: false,
    whoAction: "startRun",
    run(me, args) {
      // Solo i controlli: la sessione nasce a gruppo riuscito (`settleProposal`).
      return onTask(prepareRunAs(me, args.taskId as string), null);
    },
  },
  createMilestone: {
    apiFn: "createMilestone",
    baseClass: "B",
    undoable: true,
    whoAction: "editTasks",
    run(me, args) {
      const input: MilestoneInput = {
        name: args.name as string,
        ...(args.description !== undefined ? { description: args.description as string } : {}),
        dueDate: (args.dueDate as string | null | undefined) ?? null,
      };
      const milestone = createMilestoneAs(me, args.projectId as string, input);
      return {
        codes: [],
        projectIds: [milestone.projectId],
        inverse: { fn: "deleteMilestone", args: { id: milestone.id } },
        objects: [{ kind: "milestone", id: milestone.id }],
      };
    },
  },
  deleteMilestone: {
    apiFn: "deleteMilestone",
    baseClass: "B",
    undoable: false,
    whoAction: "editTasks",
    run(me, args) {
      const id = args.id as string;
      const projectId = state.milestones.find((m) => m.id === id)?.projectId;
      deleteMilestoneAs(me, id);
      return {
        codes: [],
        projectIds: projectId ? [projectId] : [],
        inverse: null,
        objects: [{ kind: "milestone", id }],
      };
    },
  },
  deleteTask: {
    apiFn: "deleteTask",
    baseClass: "B",
    undoable: false,
    whoAction: "deleteTasks",
    run(me, args) {
      const id = args.id as string;
      const task = state.tasksById.get(id);
      done(deleteTaskAs(me, id));
      return onTask(task!, null);
    },
  },

  // --- progetto: archivio, membri, impostazioni (9a, 9c) ----------------------
  archiveProject: {
    apiFn: "projectSettings.archiveProject",
    baseClass: "B",
    undoable: true,
    whoAction: "manageProjectSettings",
    run(me, args) {
      const projectId = args.projectId as string;
      done(archiveProjectAs(me, projectId));
      return onProject(projectId, { fn: "reopenProject", args: { projectId } });
    },
  },
  reopenProject: {
    apiFn: "projectSettings.reopenProject",
    baseClass: "B",
    undoable: true,
    whoAction: "manageProjectSettings",
    run(me, args) {
      const projectId = args.projectId as string;
      done(reopenProjectAs(me, projectId));
      return onProject(projectId, { fn: "archiveProject", args: { projectId } });
    },
  },
  addMember: {
    apiFn: "admin.addMember",
    baseClass: "B",
    undoable: true,
    whoAction: "manageMembers",
    run(me, args) {
      const projectId = args.projectId as string;
      const personId = args.personId as string;
      done(addMemberAs(me, projectId, personId, args.roleId as string));
      return onMember(projectId, personId, { fn: "removeMember", args: { projectId, personId } });
    },
  },
  removeMember: {
    apiFn: "admin.removeMember",
    baseClass: "B",
    undoable: true,
    whoAction: "manageMembers",
    run(me, args) {
      const projectId = args.projectId as string;
      const personId = args.personId as string;
      const roleId = roleOf(projectId, personId);
      done(removeMemberAs(me, projectId, personId));
      return onMember(projectId, personId, {
        fn: "addMember",
        args: { projectId, personId, roleId },
      });
    },
  },
  setMemberRole: {
    apiFn: "admin.setMemberRole",
    baseClass: "B",
    undoable: true,
    whoAction: "manageMembers",
    run(me, args) {
      const projectId = args.projectId as string;
      const personId = args.personId as string;
      const roleId = roleOf(projectId, personId);
      done(setMemberRoleAs(me, projectId, personId, args.roleId as string));
      return onMember(projectId, personId, {
        fn: "setMemberRole",
        args: { projectId, personId, roleId },
      });
    },
  },
  updateProjectGeneral: {
    apiFn: "projectSettings.updateProjectGeneral",
    baseClass: "B",
    undoable: true,
    whoAction: "manageProjectSettings",
    run(me, args) {
      const projectId = args.projectId as string;
      const project = state.projectsById.get(projectId);
      const was = { projectId, name: project?.name, description: project?.description ?? "" };
      done(
        updateProjectGeneralAs(
          me,
          projectId,
          present(args, ["name", "description"] as const) as {
            name?: string;
            description?: string;
          },
        ),
      );
      return onProject(projectId, { fn: "updateProjectGeneral", args: was }, true);
    },
  },
  setProjectAi: {
    apiFn: "projectSettings.setProjectAi",
    baseClass: "B",
    undoable: true,
    whoAction: "manageProjectSettings",
    run(me, args) {
      const projectId = args.projectId as string;
      const project = state.projectsById.get(projectId);
      const s = project ? settingsOf(project) : null;
      const was = {
        projectId,
        providerId: s?.aiProviderId ?? null,
        exclusive: s?.aiProviderExclusive ?? false,
      };
      done(
        setProjectAiAs(me, projectId, {
          providerId: (args.providerId as string | null | undefined) ?? null,
          exclusive: args.exclusive === true,
        }),
      );
      return onProject(projectId, { fn: "setProjectAi", args: was }, true);
    },
  },
  saveProjectAutomations: {
    apiFn: "projectSettings.saveProjectAutomations",
    baseClass: "B",
    undoable: true,
    whoAction: "manageProjectSettings",
    run(me, args) {
      const projectId = args.projectId as string;
      const project = state.projectsById.get(projectId);
      const s = project ? settingsOf(project) : null;
      const was = {
        projectId,
        switches: { ...s?.switches },
        pulseEveryDays: s?.pulseEveryDays,
        correctionCap: capOf(projectId),
      };
      done(
        saveProjectAutomationsAs(me, projectId, {
          switches: args.switches as Record<ProjectSwitch, boolean>,
          pulseEveryDays: args.pulseEveryDays as number,
          correctionCap: args.correctionCap as number,
        }),
      );
      return onProject(projectId, { fn: "saveProjectAutomations", args: was }, true);
    },
  },

  // --- istanza, senza segreti (9b; maintainer, 2 nov 2026) --------------------
  setModel: {
    apiFn: "instance.setModel",
    baseClass: "B",
    undoable: true,
    whoAction: "manageSettings",
    run(me, args) {
      const operation = args.operation as AiOperation;
      const was = state.instance.models[operation] ?? null;
      done(setModelAs(me, operation, (args.model as AiModelChoice | null | undefined) ?? null));
      return onSetting(`model:${operation}`, {
        fn: "setModel",
        args: { operation, model: was },
      });
    },
  },
  saveBudget: {
    apiFn: "instance.saveBudget",
    baseClass: "B",
    undoable: true,
    whoAction: "manageSettings",
    run(me, args) {
      // Budget E lingua dei contenuti: si salvano insieme, si rimettono insieme.
      const was = { ...state.instance.budget };
      done(
        saveBudgetAs(me, {
          monthlyUsd: args.monthlyUsd as number | null,
          contentLanguage: args.contentLanguage as ContentLanguage,
        }),
      );
      return onSetting("budget", { fn: "saveBudget", args: was });
    },
  },
  saveAutomation: {
    apiFn: "instance.saveAutomation",
    baseClass: "B",
    undoable: true,
    whoAction: "manageSettings",
    run(me, args) {
      const was = structuredClone(state.instance.automation);
      done(
        saveAutomationAs(me, {
          rules: args.rules as AutomationSettings["rules"],
          prReview: args.prReview as AutomationSettings["prReview"],
        }),
      );
      return onSetting("automation", { fn: "saveAutomation", args: was });
    },
  },
  setProviderEnabled: {
    apiFn: "instance.setProviderEnabled",
    baseClass: "B",
    undoable: true,
    whoAction: "manageAiProviders",
    run(me, args) {
      const id = args.id as string;
      const was = state.instance.providers.find((p) => p.id === id)?.enabled;
      done(setProviderEnabledAs(me, id, args.enabled === true));
      return onSetting("providers", { fn: "setProviderEnabled", args: { id, enabled: was } });
    },
  },
  moveProvider: {
    apiFn: "instance.moveProvider",
    baseClass: "B",
    undoable: true,
    whoAction: "manageAiProviders",
    run(me, args) {
      const id = args.id as string;
      const was = state.instance.providers.findIndex((p) => p.id === id);
      done(moveProviderAs(me, id, args.toIndex as number));
      return onSetting("providers", { fn: "moveProvider", args: { id, toIndex: was } });
    },
  },
  updateGitAccount: {
    apiFn: "instance.updateGitAccount",
    baseClass: "B",
    undoable: true,
    whoAction: "manageGitAccounts",
    run(me, args) {
      const id = args.id as string;
      const account = state.instance.gitAccounts.find((a) => a.id === id);
      const was = { id, name: account?.name, workspace: account?.workspace ?? null };
      done(
        updateGitAccountAs(
          me,
          id,
          present(args, ["name", "workspace"] as const) as {
            name?: string;
            workspace?: string | null;
          },
        ),
      );
      return onSetting(`gitAccount:${id}`, { fn: "updateGitAccount", args: was });
    },
  },
  setDefaultReviewer: {
    apiFn: "instance.setDefaultReviewer",
    baseClass: "B",
    undoable: true,
    whoAction: "manageGitAccounts",
    run(me, args) {
      const id = args.id as string;
      const on = args.on === true;
      const before = new Set(
        state.instance.gitAccounts.filter((a) => a.defaultReviewer).map((a) => a.id),
      );
      done(setDefaultReviewerAs(me, id, on));
      // Il revisore di prima nello stesso ambito (`replaced`), o nessuno.
      const replaced = [...before].find(
        (other) =>
          other !== id && !state.instance.gitAccounts.find((a) => a.id === other)?.defaultReviewer,
      );
      const inverse: CatalogInverse =
        before.has(id) === on
          ? { fn: "setDefaultReviewer", args: { id, on } }
          : replaced
            ? { fn: "setDefaultReviewer", args: { id: replaced, on: true } }
            : { fn: "setDefaultReviewer", args: { id, on: !on } };
      return onSetting("reviewer", inverse);
    },
  },
  updateGoogleApp: {
    apiFn: "instance.updateGoogleApp",
    baseClass: "B",
    undoable: true,
    whoAction: "manageIntegrations",
    run(me, args) {
      const id = args.id as string;
      const app = state.googleWorkspaces.find((g) => g.id === id);
      const was = {
        id,
        name: app?.name,
        domains: [...(app?.domains ?? [])],
        clientId: app?.clientId,
      };
      done(
        updateGoogleAppAs(
          me,
          id,
          present(args, ["name", "domains", "clientId"] as const) as {
            name?: string;
            domains?: string[];
            clientId?: string;
          },
        ),
      );
      return onSetting(`googleApp:${id}`, { fn: "updateGoogleApp", args: was });
    },
  },
  // Registrare o aggiornare un plugin ne esegue già il codice allo smoke run
  // (CLAUDE.md): non si annulla. Neanche rilanciare lo smoke, togliere un
  // plugin o rimettere in coda un lavoro: fanno partire lavoro, o tolgono
  // ciò che si rimetterebbe solo con la riconferma.
  registerPlugin: {
    apiFn: "instance.registerPlugin",
    baseClass: "B",
    undoable: false,
    whoAction: "managePlugins",
    run(me, args) {
      const { pluginId } = done(
        registerPluginAs(me, {
          url: args.url as string,
          ref: args.ref as string,
          subdir: (args.subdir as string | null | undefined) ?? null,
          trusted: args.trusted as true,
        }),
      );
      return onSetting(`plugin:${pluginId}`, null);
    },
  },
  updatePluginRef: {
    apiFn: "instance.updatePluginRef",
    baseClass: "B",
    undoable: false,
    whoAction: "managePlugins",
    run(me, args) {
      const id = args.id as string;
      done(updatePluginRefAs(me, id, { ref: args.ref as string, trusted: args.trusted as true }));
      return onSetting(`plugin:${id}`, null);
    },
  },
  rerunSmoke: {
    apiFn: "instance.rerunSmoke",
    baseClass: "B",
    undoable: false,
    whoAction: "managePlugins",
    run(me, args) {
      const id = args.id as string;
      done(rerunSmokeAs(me, id));
      return onSetting(`plugin:${id}`, null);
    },
  },
  removePlugin: {
    apiFn: "instance.removePlugin",
    baseClass: "B",
    undoable: false,
    whoAction: "managePlugins",
    run(me, args) {
      const id = args.id as string;
      done(removePluginAs(me, id));
      return onSetting(`plugin:${id}`, null);
    },
  },
  pauseQueue: {
    apiFn: "instance.pauseQueue",
    baseClass: "B",
    undoable: true,
    whoAction: "manageSettings",
    run(me, args) {
      const projectId = args.projectId as string;
      done(pauseQueueAs(me, projectId));
      return onSetting(`queue:${projectId}`, { fn: "resumeQueue", args: { projectId } }, [
        projectId,
      ]);
    },
  },
  resumeQueue: {
    apiFn: "instance.resumeQueue",
    baseClass: "B",
    undoable: true,
    whoAction: "manageSettings",
    run(me, args) {
      const projectId = args.projectId as string;
      done(resumeQueueAs(me, projectId));
      return onSetting(`queue:${projectId}`, { fn: "pauseQueue", args: { projectId } }, [
        projectId,
      ]);
    },
  },
  retryJob: {
    apiFn: "instance.retryJob",
    // La funzione chiede `settings.manage` E `runs.start` nel progetto: il
    // «Who?» nomina il primo, il rifiuto vale per entrambi.
    baseClass: "B",
    undoable: false,
    whoAction: "manageSettings",
    run(me, args) {
      // Il budget si controlla qui (`openRunAs`, rifiuto sincrono dentro il
      // gruppo, ruling (T4)); la sessione aperta parte solo a gruppo riuscito.
      const { conversationId } = done(retryJobAs(me, args.jobId as string));
      const c = state.conversations.find((x) => x.id === conversationId)!;
      return {
        codes: [],
        projectIds: c.projectId ? [c.projectId] : [],
        inverse: null,
        objects: [{ kind: "task", id: c.taskId! }],
        after: (gen) => launchRun(me, c, gen),
      };
    },
  },
  saveStorage: {
    apiFn: "instance.saveStorage",
    baseClass: "B",
    undoable: true,
    whoAction: "manageSettings",
    run(me, args) {
      // Nessun segreto entra da qui: la chiave si scrive solo nel dialogo vero.
      if ("secretAccessKey" in args) throw invalid("secret_access_key");
      const s = state.instance.storage;
      const was = {
        endpoint: s.endpoint,
        region: s.region,
        bucket: s.bucket,
        accessKeyId: s.accessKeyId,
      };
      done(
        saveStorageAs(me, {
          endpoint: args.endpoint as string,
          region: args.region as string,
          bucket: args.bucket as string,
          accessKeyId: args.accessKeyId as string,
        }),
      );
      return onSetting("storage", { fn: "saveStorage", args: was });
    },
  },
  setAttachments: {
    apiFn: "instance.setAttachments",
    baseClass: "B",
    undoable: true,
    whoAction: "manageSettings",
    run(me, args) {
      const was = state.instance.storage.attachmentsEnabled;
      done(setAttachmentsAs(me, args.on === true));
      return onSetting("attachments", { fn: "setAttachments", args: { on: was } });
    },
  },
  saveWebhook: {
    apiFn: "instance.saveWebhook",
    baseClass: "B",
    undoable: true,
    whoAction: "manageSettings",
    run(me, args) {
      const w = state.instance.webhook;
      const was = { enabled: w.enabled, format: w.format, url: w.url, events: { ...w.events } };
      done(
        saveWebhookAs(me, {
          enabled: args.enabled === true,
          format: args.format as WebhookFormat,
          url: (args.url as string | null | undefined) ?? null,
          events: (args.events ?? {}) as Record<string, boolean>,
        }),
      );
      return onSetting("webhook", { fn: "saveWebhook", args: was });
    },
  },

  // --- le tue preferenze ---------------------------------------------------
  setSubscription: {
    apiFn: "alerts.setSubscription",
    baseClass: "A",
    undoable: true,
    whoAction: null,
    run(me, args) {
      const projectId = args.projectId as string;
      const type = args.type as string;
      const def = alertTypeOf(type);
      const was = def ? currentChannels(me, projectId, def) : null;
      setSubscriptionAs(
        me,
        projectId,
        type,
        present(args, ["app", "phone"] as const) as { app?: boolean; phone?: boolean },
      );
      return {
        codes: [],
        projectIds: [projectId],
        inverse: { fn: "setSubscription", args: { projectId, type, ...was } },
        objects: [{ kind: "subscription", projectId, type }],
      };
    },
  },
};

export const CLAUDE_CATALOG: Readonly<Record<ClaudeActionFn, CatalogEntry>> = Object.freeze(
  Object.fromEntries(
    Object.entries(ENTRIES).map(([fn, entry]) => [fn, Object.freeze({ fn, ...entry })]),
  ) as Record<ClaudeActionFn, CatalogEntry>,
);

/** Una funzione del catalogo (non una della Posta, né un nome qualunque). */
export const isCatalogFn = (fn: string): fn is ClaudeActionFn => Object.hasOwn(CLAUDE_CATALOG, fn);

/** La classe dichiarata alzata dalla riconferma: C se `apiFn` è in `REAUTH_REQUIRED`. */
export function declaredClassOf(fn: ClaudeActionFn): "A" | "B" | "C" {
  const entry = CLAUDE_CATALOG[fn];
  return REAUTH_REQUIRED.has(entry.apiFn) ? "C" : entry.baseClass;
}
