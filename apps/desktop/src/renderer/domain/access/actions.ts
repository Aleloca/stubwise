// Il catalogo di «Chi può farlo?» (area 9a, shape admin-audit.md) e i gruppi
// dei permessi, gli stessi della tabella dei ruoli: gli 11 gruppi del web
// (`apps/web/src/lib/permission-groups.ts`) più «prototype» per i permessi
// che vivono solo nel prototipo. Solo presentazione: chi può davvero lo dice
// `can()`. Un test fallisce se un permesso non sta in nessun gruppo.

export type AccessScope = "project" | "instance";

export interface PermissionGroup {
  /** L'etichetta è `whoCan.groups.<key>`. */
  key: string;
  permissions: readonly string[];
}

export const INSTANCE_GROUPS: readonly PermissionGroup[] = [
  {
    key: "administration",
    permissions: ["instance.full_admin", "roles.manage", "settings.manage"],
  },
  { key: "people", permissions: ["users.view_all", "users.invite", "users.manage"] },
  { key: "projects", permissions: ["projects.create"] },
  {
    key: "integrations",
    permissions: [
      "ai_providers.manage",
      "git_accounts.view",
      "git_accounts.manage",
      "plugins.manage",
      "integrations.manage",
      "mail_admission.view",
    ],
  },
  { key: "monitoring", permissions: ["monitor.view", "monitor.manage", "usage.view"] },
  {
    key: "prototype",
    permissions: [
      "claude.public.view",
      "people.activity.view",
      "chat.general.create",
      "chat.general.manage",
      "automations.manage",
      "servers.ssh.manage",
      "departments.manage",
      "instance.status.view",
      "changelog.view",
    ],
  },
];

export const PROJECT_GROUPS: readonly PermissionGroup[] = [
  {
    key: "project",
    permissions: ["project.settings.manage", "project.members.manage", "project.usage.view"],
  },
  {
    key: "tickets",
    permissions: [
      "tickets.view_all",
      "tickets.create",
      "tickets.edit",
      "tickets.comment",
      "tickets.moderate",
    ],
  },
  {
    key: "runs",
    permissions: [
      "runs.start",
      "plans.approve",
      "corrections.request",
      "release.merge",
      "prs.adopt",
      "agent_sessions.intervene",
    ],
  },
  {
    key: "backlog",
    permissions: ["backlog.view_all", "backlog.create", "backlog.edit", "decisions.record"],
  },
  { key: "docs", permissions: ["docs.view", "docs.edit", "docs.generate"] },
  {
    key: "code",
    permissions: ["repos.view", "repos.manage", "environments.manage", "widget.manage"],
  },
  {
    key: "prototype",
    permissions: [
      "planning.others",
      "chat.channels.create",
      "chat.channels.manage",
      "drive.upload",
      "drive.manage",
      "drive.history",
      "automations.manage",
      "support.reply",
      "servers.operate",
    ],
  },
];

export const groupsFor = (scope: AccessScope): readonly PermissionGroup[] =>
  scope === "instance" ? INSTANCE_GROUPS : PROJECT_GROUPS;

/** Il gruppo di un permesso a quel livello; `null` se non c'è (un test lo impedisce). */
export function groupOf(scope: AccessScope, permission: string): string | null {
  return groupsFor(scope).find((g) => g.permissions.includes(permission))?.key ?? null;
}

/**
 * Raggruppa dei permessi come la tabella dei ruoli: i gruppi nel loro
 * ordine, i permessi nell'ordine del gruppo, senza gruppi vuoti.
 */
export function groupPermissions<T extends { permission: string }>(
  scope: AccessScope,
  entries: readonly T[],
): { groupKey: string; permissions: T[] }[] {
  const byPerm = new Map(entries.map((e) => [e.permission, e]));
  return groupsFor(scope)
    .map((g) => ({
      groupKey: g.key,
      permissions: g.permissions.flatMap((p) => {
        const e = byPerm.get(p);
        return e ? [e] : [];
      }),
    }))
    .filter((g) => g.permissions.length > 0);
}

export interface AccessAction {
  id: string;
  permission: string;
  scope: AccessScope;
  /** Un'etichetta all'infinito («approve a plan»), per comporsi in «Who can … in ACQ?». */
  labelKey: string;
}

const project = (id: string, permission: string): AccessAction => ({
  id,
  permission,
  scope: "project",
  labelKey: `whoCan.actions.${id}`,
});
const instance = (id: string, permission: string): AccessAction => ({
  id,
  permission,
  scope: "instance",
  labelKey: `whoCan.actions.${id}`,
});

/**
 * Le azioni in parole. Le automazioni sono due azioni distinte, perché
 * `automations.manage` vale a due livelli (area 7): quelle del progetto e
 * quelle generali.
 */
export const ACTIONS: readonly AccessAction[] = [
  // progetto
  project("manageMembers", "project.members.manage"),
  project("manageProjectSettings", "project.settings.manage"),
  project("seeProjectUsage", "project.usage.view"),
  // task
  project("createTasks", "tickets.create"),
  project("editTasks", "tickets.edit"),
  project("moderateComments", "tickets.moderate"),
  // run e rilasci
  project("startRun", "runs.start"),
  project("approvePlan", "plans.approve"),
  project("requestCorrection", "corrections.request"),
  project("release", "release.merge"),
  project("adoptPr", "prs.adopt"),
  project("interveneSession", "agent_sessions.intervene"),
  // backlog
  project("addRequests", "backlog.create"),
  project("editBacklog", "backlog.edit"),
  project("recordDecision", "decisions.record"),
  // docs e codice
  project("editDocs", "docs.edit"),
  project("generateDocs", "docs.generate"),
  project("manageRepos", "repos.manage"),
  project("manageEnvironments", "environments.manage"),
  project("manageWidget", "widget.manage"),
  // del prototipo
  project("planOthers", "planning.others"),
  project("manageChannels", "chat.channels.manage"),
  project("manageDrive", "drive.manage"),
  project("manageProjectAutomations", "automations.manage"),
  project("replyCustomers", "support.reply"),
  project("fixServer", "servers.operate"),
  // istanza
  instance("manageRoles", "roles.manage"),
  instance("manageSettings", "settings.manage"),
  instance("invitePeople", "users.invite"),
  instance("managePeople", "users.manage"),
  instance("createProjects", "projects.create"),
  instance("manageMonitor", "monitor.manage"),
  instance("manageIntegrations", "integrations.manage"),
  instance("seeUsage", "usage.view"),
  instance("manageGeneralAutomations", "automations.manage"),
  instance("manageSshAccess", "servers.ssh.manage"),
  instance("manageDepartments", "departments.manage"),
  instance("readChangeLog", "changelog.view"),
];

export const actionById = (id: string): AccessAction | undefined =>
  ACTIONS.find((a) => a.id === id);
