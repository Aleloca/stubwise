import type { InstancePermission, ProjectPermission, RoleScope } from "@stubwise/shared";

/**
 * Raggruppamento per area delle chiavi di permesso, per le caselle della
 * pagina Ruoli. È solo presentazione: il catalogo vero sta in
 * `@stubwise/shared` (`INSTANCE_PERMISSIONS`/`PROJECT_PERMISSIONS`), e un test
 * (`permission-groups.test.ts`) fallisce se una chiave del catalogo non è in
 * nessun gruppo — altrimenti un permesso nuovo non comparirebbe nella UI e
 * nessuno potrebbe darlo a un ruolo.
 *
 * L'etichetta di un gruppo è `settings:roles.groups.<id>`, quella di una
 * chiave `permissions:label.<chiave>`.
 */
export interface PermissionGroup<P extends string> {
  id: string;
  permissions: readonly P[];
}

export const INSTANCE_PERMISSION_GROUPS: readonly PermissionGroup<InstancePermission>[] = [
  { id: "administration", permissions: ["instance.full_admin", "roles.manage", "settings.manage"] },
  { id: "people", permissions: ["users.view_all", "users.invite", "users.manage"] },
  { id: "projects", permissions: ["projects.create"] },
  {
    id: "integrations",
    permissions: [
      "ai_providers.manage",
      "git_accounts.view",
      "git_accounts.manage",
      "plugins.manage",
      "integrations.manage",
      "mail_admission.view",
    ],
  },
  { id: "monitoring", permissions: ["monitor.view", "monitor.manage", "usage.view"] },
];

export const PROJECT_PERMISSION_GROUPS: readonly PermissionGroup<ProjectPermission>[] = [
  {
    id: "project",
    permissions: ["project.settings.manage", "project.members.manage", "project.usage.view"],
  },
  {
    id: "tickets",
    permissions: [
      "tickets.view_all",
      "tickets.create",
      "tickets.edit",
      "tickets.comment",
      "tickets.moderate",
    ],
  },
  {
    id: "runs",
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
    id: "backlog",
    permissions: ["backlog.view_all", "backlog.create", "backlog.edit", "decisions.record"],
  },
  { id: "docs", permissions: ["docs.view", "docs.edit", "docs.generate"] },
  {
    id: "code",
    permissions: ["repos.view", "repos.manage", "environments.manage", "widget.manage"],
  },
  { id: "credentials", permissions: ["credentials.create", "credentials.edit", "credentials.share"] },
];

export function permissionGroupsFor(scope: RoleScope): readonly PermissionGroup<string>[] {
  return scope === "instance" ? INSTANCE_PERMISSION_GROUPS : PROJECT_PERMISSION_GROUPS;
}
