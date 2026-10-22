/**
 * Catalogo dei permessi e ruoli preset (appartenenza ai progetti, ruoli e
 * permessi granulari — design `docs/plans/2026-10-22-permessi-progetto-design.md`).
 *
 * Il catalogo sta NEL CODICE, non nel DB: aggiungere un permesso è una modifica
 * di codice, e un permesso nuovo non è dato a nessun ruolo esistente salvo che
 * la sua migrazione lo dica. Le chiavi sono stabili e in inglese; le etichette
 * i18n stanno in `apps/web/src/i18n/locales/{it,en}.json`, sotto
 * `permissions.label.<chiave>` (il test di questo modulo verifica che ogni
 * chiave ne abbia una in entrambe le lingue).
 *
 * Modulo PURO e privo di dipendenze: lo usano server, web e app.
 */

export type RoleScope = "instance" | "project";

/** Permessi d'istanza: ciò che un utente può fare sull'intera installazione. */
export const INSTANCE_PERMISSIONS = [
  "instance.full_admin",
  "projects.create",
  "users.invite",
  "users.manage",
  "roles.manage",
  "settings.manage",
  "ai_providers.manage",
  "git_accounts.manage",
  "plugins.manage",
  "integrations.manage",
  "monitor.view",
  "monitor.manage",
  "usage.view",
  "users.view_all",
  // Letture d'istanza aperte oggi a ogni utente autenticato, aggiunte con
  // l'audit del ruling R1 (vedi il commento sopra `PRESET_ROLES`).
  "git_accounts.view",
  "mail_admission.view",
] as const;

/**
 * Permessi di progetto. Essere membri di un progetto implica vederlo: non
 * esiste una chiave `project.view`.
 */
export const PROJECT_PERMISSIONS = [
  "project.settings.manage",
  "project.members.manage",
  "tickets.view_all",
  "tickets.create",
  "tickets.edit",
  "tickets.comment",
  "runs.start",
  "plans.approve",
  "release.merge",
  "corrections.request",
  "backlog.view_all",
  /** Aprire una richiesta di backlog. */
  "backlog.create",
  "backlog.edit",
  "docs.view",
  "docs.edit",
  "repos.view",
  "repos.manage",
  "agent_sessions.intervene",
  "decisions.record",
  "environments.manage",
  "widget.manage",
  "project.usage.view",
  /** Avviare o riprendere una generazione Docs. */
  "docs.generate",
  /** Adottare una PR aperta da altri. */
  "prs.adopt",
] as const;

export type InstancePermission = (typeof INSTANCE_PERMISSIONS)[number];
export type ProjectPermission = (typeof PROJECT_PERMISSIONS)[number];

export interface PresetRole {
  key: string;
  name: string;
  scope: RoleScope;
  permissions: readonly string[];
}

/**
 * Tutti i permessi di progetto che un `member` ha oggi, cioè tutti tranne
 * quelli che oggi sono dietro `requireAdmin` (o che non esistevano):
 *
 * - `plans.approve`: tickets.ts `approve-plan`, `reject-plan`,
 *   `pre-approve-plan` (POST/DELETE) — `requireAdmin`.
 * - `release.merge`: release.ts `GET /release-queue` e `POST
 *   /tickets/:id/repositories/:repositoryId/release` — `requireAdmin`.
 * - `project.settings.manage`: projects.ts `PATCH /:projectId`, `DELETE
 *   /:projectId`, `PUT /:projectId/email-routes`, `POST
 *   /:projectId/briefs/generate`; project-plugins.ts `GET`/`PUT
 *   /:projectId/plugins` — `requireAdmin`.
 * - `project.members.manage`: oggi non esiste nessuna appartenenza da gestire.
 * - `repos.manage`: repositories.ts `POST /`, `GET /:slug/webhook`, `POST
 *   /:slug/configure-webhook`, `PATCH /:slug`; project-env-files.ts tutte le
 *   rotte `/:id/env-files…` (lettura inclusa) — `requireAdmin`.
 * - `environments.manage`: project-environments.ts `POST`/`PUT`/`DELETE
 *   /:projectId/environments…` — `requireAdmin` (le letture restano aperte).
 * - `docs.generate`: docs.ts `POST /repositories/:repositoryId/docs/generate`
 *   e `/docs/resume` — `requireAdmin`.
 * - `prs.adopt`: corrections.ts `POST`/`DELETE
 *   /tickets/:id/repositories/:repositoryId/adoption` — `requireAdmin`.
 * - `project.usage.view`: usage-costs.ts `GET /api/ai-usage/costs` e
 *   `/breakdown` (righe 390 e 410) e usage-snapshots.ts — `requireAdmin`; un
 *   member non ha oggi nessun accesso ai consumi. Quelli per-ticket restano
 *   governati dalla visibilità del ticket, non da questa chiave.
 * - `widget.manage`: widget-admin.ts `POST`/`PUT`/`DELETE
 *   /:projectId/widgets…` — `requireAdmin`.
 *
 * Restano quindi nel preset `tickets.*`, `runs.start`, `corrections.request`
 * (corrections.ts: `requireAuth`, come `run-ai`), `backlog.*`, `docs.view`, `docs.edit`,
 * `repos.view`, `agent_sessions.intervene`, `decisions.record`.
 */
const LEGACY_MEMBER_EXCLUDED: readonly ProjectPermission[] = [
  "plans.approve",
  "release.merge",
  "project.settings.manage",
  "project.members.manage",
  "repos.manage",
  "environments.manage",
  "widget.manage",
  "docs.generate",
  "prs.adopt",
  "project.usage.view",
];

/**
 * AUDIT del ruling R1 («nessuno perde nulla»): il preset `User` contiene
 * TUTTE le letture d'istanza oggi aperte a ogni utente autenticato
 * (`requireAuth`, non `requireAdmin`) e non per-utente:
 *
 * - `users.view_all`: users.ts `GET /api/users` (elenco del team).
 * - `monitor.view`: servers.ts `GET /api/servers`, `GET /api/servers/:id`;
 *   servers-checks.ts `GET` dei check (due rotte `requireAuth`).
 * - `git_accounts.view`: git-accounts.ts `GET /api/git-accounts` e `GET
 *   /api/git-accounts/:id`.
 * - `mail_admission.view`: settings.ts `GET /api/settings/mail-admission`
 *   (unica GET di settings aperta a tutti, vedi il suo docblock).
 *
 * Verificate e NON incluse perché oggi `requireAdmin`: usage-costs.ts,
 * usage-snapshots.ts (quindi `usage.view` NON è in `User`), plugins.ts,
 * ai-providers.ts, model-settings.ts, google-workspaces.ts, tutto il resto di
 * settings.ts. Per-utente, senza permesso: `/api/me/*`, `/api/pats`,
 * `/api/saved-views`, `/api/inbox`. Per-progetto (T5-T8): `/api/activity`,
 * `/api/milestones`, `/api/briefs`, `/api/search`.
 */
const USER_INSTANCE_PERMISSIONS: readonly InstancePermission[] = [
  "monitor.view",
  "users.view_all",
  "git_accounts.view",
  "mail_admission.view",
];

const VIEW_PROJECT_PERMISSIONS = PROJECT_PERMISSIONS.filter(
  (p) => p.endsWith(".view") || p.endsWith(".view_all"),
);

/** I sette ruoli già pronti. I nomi sono in inglese e non si traducono. */
export const PRESET_ROLES: readonly PresetRole[] = [
  { key: "admin", name: "Admin", scope: "instance", permissions: ["instance.full_admin"] },
  { key: "user", name: "User", scope: "instance", permissions: USER_INSTANCE_PERMISSIONS },
  {
    key: "project_lead",
    name: "Project Lead",
    scope: "project",
    permissions: PROJECT_PERMISSIONS,
  },
  {
    key: "developer",
    name: "Developer",
    scope: "project",
    permissions: PROJECT_PERMISSIONS.filter(
      (p) =>
        p !== "plans.approve" &&
        p !== "release.merge" &&
        p !== "project.members.manage" &&
        p !== "project.settings.manage",
    ),
  },
  {
    key: "contributor",
    name: "Contributor",
    scope: "project",
    permissions: ["docs.view", "tickets.create", "tickets.comment", "backlog.create"],
  },
  { key: "viewer", name: "Viewer", scope: "project", permissions: VIEW_PROJECT_PERMISSIONS },
  {
    key: "legacy_member",
    name: "Legacy Member",
    scope: "project",
    permissions: PROJECT_PERMISSIONS.filter((p) => !LEGACY_MEMBER_EXCLUDED.includes(p)),
  },
];

/** Permessi d'istanza effettivi di un ruolo; `instance.full_admin` li ha tutti. */
export function effectiveInstancePermissions(
  rolePerms: readonly string[],
): Set<InstancePermission> {
  const known = new Set<string>(INSTANCE_PERMISSIONS);
  if (rolePerms.includes("instance.full_admin")) return new Set(INSTANCE_PERMISSIONS);
  return new Set(rolePerms.filter((p): p is InstancePermission => known.has(p)));
}

/**
 * Permessi di progetto effettivi. `null` = non membro e non full admin: il
 * progetto è invisibile. Un full admin li ha tutti, membro o no.
 */
export function effectiveProjectPermissions(
  instancePerms: Set<InstancePermission>,
  memberRolePerms: readonly string[] | null,
): Set<ProjectPermission> | null {
  if (instancePerms.has("instance.full_admin")) return new Set(PROJECT_PERMISSIONS);
  if (memberRolePerms === null) return null;
  const known = new Set<string>(PROJECT_PERMISSIONS);
  return new Set(memberRolePerms.filter((p): p is ProjectPermission => known.has(p)));
}

/** `true` se ogni permesso concesso è fra quelli posseduti (anti-escalation). */
export function isSubsetOf(granted: Iterable<string>, held: Set<string>): boolean {
  for (const p of granted) if (!held.has(p)) return false;
  return true;
}
