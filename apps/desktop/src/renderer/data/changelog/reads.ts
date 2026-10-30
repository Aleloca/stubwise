import { accessState, isMember } from "../access/index";
import { canSeeAdminSection } from "../adminSections";
import type { AdminSection } from "../routes";
import { visiblePeopleFor } from "../access/whoCan";
import { CLAUDE_ID, PEOPLE } from "../seed/people";
import { gate, now, state, visibleProjectIds } from "../store";
import { can, viewerFor, type Permission } from "../viewer";
import { forbidden, notFound } from "../writer";
import { changeTypeOf } from "./record";
import { SETTING_KINDS, decodeSetting } from "./settingValues";
import { MANAGE_PROJECT, readableChangeGroups } from "./visibility";
import type {
  ChangeDiff,
  ChangeEntry,
  ChangeEntryView,
  ChangeFilter,
  ChangeFilterChoices,
  ChangeObjectLink,
} from "./types";

// Le letture del registro (area 9a). Chi legge cosa, in UN posto
// (`readable`), sempre attraverso `can()`:
// - una voce d'istanza: `changelog.view`, oppure il `readPermission` del suo
//   tipo (chi gestisce l'oggetto);
// - una voce di progetto (R-M1): il progetto dev'essere visibile (R-G5: una
//   voce di un progetto che non si vede non esiste) E chi guarda ha
//   `changelog.view`, oppure gestisce il progetto
//   (`project.settings.manage` o `project.members.manage`), oppure ha lì il
//   `readPermission` del tipo.
// Il full admin legge tutto (`can()` gli dice sempre sì, e vede ogni
// progetto); Claude niente (`changelog.view` e i `.manage` gli sono negati).
//
// La vista di una voce porta già tutto ciò che la UI mostra (`view`): il
// link all'oggetto se esiste ancora e chi guarda può aprirlo, «(deleted)»,
// e il prima/dopo pronto da leggere. Le persone che chi guarda non vede non
// ci sono nemmeno lì, né per nome né in un conteggio (R-G5).

const DAY_MS = 86_400_000;

/** Chi guarda può gestire (impostazioni o membri) il progetto. */
const managesProject = (me: string, projectId: string): boolean =>
  MANAGE_PROJECT.some((p) => can(viewerFor(me), p, projectId));

/** Se `me` legge la voce. */
function readable(me: string, entry: ChangeEntry, visible: Set<string>): boolean {
  const type = changeTypeOf(entry.kind);
  if (!type) return false;
  const viewer = viewerFor(me);
  if (entry.projectId === null)
    return can(viewer, "changelog.view") || can(viewer, type.readPermission as Permission);
  if (!visible.has(entry.projectId)) return false;
  return (
    can(viewer, "changelog.view") ||
    managesProject(me, entry.projectId) ||
    can(viewer, type.readPermission as Permission, entry.projectId)
  );
}

function matchesFilter(entry: ChangeEntry, filter: ChangeFilter): boolean {
  if (filter.personId !== undefined && entry.actorId !== filter.personId) return false;
  if (filter.projectId !== undefined && entry.projectId !== filter.projectId) return false;
  if (filter.kind !== undefined && entry.kind !== filter.kind) return false;
  if (filter.group !== undefined && changeTypeOf(entry.kind)?.group !== filter.group) return false;
  if (
    filter.withinDays !== undefined &&
    Date.parse(entry.at) < Date.parse(now()) - filter.withinDays * DAY_MS
  )
    return false;
  if (filter.from !== undefined && Date.parse(entry.at) < Date.parse(filter.from)) return false;
  if (filter.to !== undefined && Date.parse(entry.at) > Date.parse(filter.to)) return false;
  return true;
}

const nameOf = (personId: string): string =>
  PEOPLE.find((p) => p.id === personId)?.name ?? personId;

const listOf = (value: string | undefined): string[] =>
  value ? value.split(",").filter(Boolean) : [];

/**
 * Gli oggetti d'istanza del 9b: la voce dell'Amministrazione in cui stanno e,
 * per quelli che si eliminano, se esistono ancora. Gli altri (le impostazioni
 * dell'AI, l'archiviazione, il webhook) esistono sempre.
 */
const INSTANCE_OBJECTS: Record<
  string,
  { section: AdminSection; exists?: (id: string) => boolean }
> = {
  provider: { section: "ai", exists: (id) => state.instance.providers.some((p) => p.id === id) },
  ai_settings: { section: "ai" },
  git_account: {
    section: "git-accounts",
    exists: (id) => state.instance.gitAccounts.some((g) => g.id === id),
  },
  plugin: { section: "plugins", exists: (id) => state.instance.plugins.some((p) => p.id === id) },
  google_app: {
    section: "google",
    exists: (id) => state.googleWorkspaces.some((w) => w.id === id),
  },
  storage: { section: "storage" },
  webhook: { section: "webhooks" },
};

/** Il server di una voce `server.*`, se esiste ancora (l'id dell'oggetto è il codice, `SRV-2`). */
const serverExists = (code: string): boolean => state.servers.some((s) => s.code === code);

/** Dove porta l'oggetto, per chi guarda; `null` se non c'è più o non lo può aprire. */
function objectLinkOf(
  me: string,
  entry: ChangeEntry,
  people: Set<string>,
): ChangeObjectLink | null {
  const viewer = viewerFor(me);
  const { type, id } = entry.object;
  switch (type) {
    case "person": {
      if (!people.has(id)) return null;
      // Un membro ancora nel progetto si apre nel suo pannello di Members.
      if (entry.projectId && isMember(id, entry.projectId)) {
        const code = state.projectsById.get(entry.projectId)?.code;
        if (code) return { to: "member", projectCode: code, personId: id };
      }
      return { to: "person", personId: id };
    }
    case "role":
      return can(viewer, "roles.manage") && accessState().roles.some((r) => r.id === id)
        ? { to: "role", roleId: id }
        : null;
    case "department":
      return can(viewer, "departments.manage") && state.departments.some((d) => d.id === id)
        ? { to: "department", departmentId: id }
        : null;
    case "invite":
      return can(viewer, "users.invite") && state.invites.some((i) => i.id === id)
        ? { to: "invite", inviteId: id }
        : null;
    case "server":
      // I server d'istanza li apre chi gestisce il monitor (voce Servers).
      return canSeeAdminSection(viewer, "servers") && serverExists(id)
        ? { to: "server", code: id }
        : null;
    default: {
      const target = INSTANCE_OBJECTS[type];
      if (!target || !canSeeAdminSection(viewer, target.section)) return null;
      if (!target.exists) return { to: "admin", section: target.section };
      return target.exists(id) ? { to: "admin", section: target.section, id } : null;
    }
  }
}

/** Un oggetto che non c'è più (ruolo, reparto; dal 9b provider, account, plugin, app, server): il nome resta, con «(deleted)». */
function objectDeletedOf(entry: ChangeEntry): boolean {
  const { type, id } = entry.object;
  if (type === "role") return !accessState().roles.some((r) => r.id === id);
  if (type === "department") return !state.departments.some((d) => d.id === id);
  if (type === "server") return !serverExists(id);
  const exists = INSTANCE_OBJECTS[type]?.exists;
  return exists ? !exists(id) : false;
}

/**
 * I tipi del 9b con un prima/dopo in parole («On → Off», «$600 → $800»,
 * l'URL del webhook). Quelli che toccano un segreto (`*_replaced`, la chiave
 * dell'agente) e quelli che nascono o spariscono non ne hanno: c'è la frase.
 */
const INSTANCE_VALUE_KINDS: ReadonlySet<string> = new Set([
  "provider.updated",
  "provider.reordered",
  "model.changed",
  "automation.changed",
  "budget.changed",
  "content_language.changed",
  "git_account.updated",
  "git_account.default_reviewer_changed",
  "plugin.ref_updated",
  "google_app.updated",
  "storage.changed",
  "webhook.changed",
  "server.updated",
  "server.thresholds_changed",
  "server.check_changed",
  "queue.resumed",
]);

/** Il nome di un reparto, senza il colore che la voce gli tiene accanto («Support --dept-3»). */
const departmentName = (value: string | null): string | null =>
  value === null ? null : value.replace(/\s+--[\w-]+$/, "");

/**
 * Il prima e dopo di una voce, per tipo. Le voci che toccano un segreto
 * (link di reset, secondo fattore) non ne hanno mai: c'è solo la frase.
 */
function diffOf(entry: ChangeEntry, people: Set<string>): ChangeDiff | null {
  const p = entry.params;
  if (SETTING_KINDS[entry.kind]) {
    // I valori stabili del 9b (Ruling T3): in forma di dato, le parole sono della pagina.
    const before = decodeSetting(entry.kind, entry.before);
    const after = decodeSetting(entry.kind, entry.after);
    if (before || after) return { kind: "setting", before, after };
  }
  switch (entry.kind) {
    case "person.instance_role_changed":
    case "member.role_changed":
    case "person.git_identity_linked":
    case "person.git_identity_unlinked":
    case "person.bitbucket_username_set":
      return { kind: "values", before: entry.before, after: entry.after };
    case "department.updated": {
      const before = departmentName(entry.before);
      const after = departmentName(entry.after);
      return before === after ? null : { kind: "values", before, after };
    }
    case "role.updated":
    case "department.permissions_changed": {
      const added = listOf(p.added);
      const removed = listOf(p.removed);
      if (added.length === 0 && removed.length === 0)
        return entry.before !== entry.after
          ? { kind: "values", before: entry.before, after: entry.after }
          : null;
      const full = p.before !== undefined && p.after !== undefined;
      return {
        kind: "permissions",
        added,
        removed,
        role: null,
        before: full ? listOf(p.before) : null,
        after: full ? listOf(p.after) : null,
      };
    }
    case "member.permission_granted":
    case "member.permission_revoked": {
      const granted = entry.kind === "member.permission_granted";
      const permission = p.permission ?? (granted ? entry.after : entry.before) ?? "";
      return {
        kind: "permissions",
        added: granted ? [permission] : [],
        removed: granted ? [] : [permission],
        role: p.role ?? null,
        before: null,
        after: null,
      };
    }
    case "department.members_changed":
    case "department.home_managers_changed": {
      const added = listOf(p.added);
      const removed = listOf(p.removed);
      const seen = (id: string) => people.has(id);
      return {
        kind: "people",
        added: added.filter(seen).map(nameOf),
        removed: removed.filter(seen).map(nameOf),
      };
    }
    default:
      if (!INSTANCE_VALUE_KINDS.has(entry.kind)) return null;
      return entry.before === null && entry.after === null
        ? null
        : { kind: "values", before: entry.before, after: entry.after };
  }
}

function view(me: string, stored: ChangeEntry, people: Set<string>): ChangeEntryView {
  const entry = resolveProject(me, stored);
  const type = changeTypeOf(entry.kind)!;
  return {
    ...entry,
    object: { ...entry.object },
    params: { ...entry.params },
    templateKey: type.templateKey,
    scope: type.scope,
    group: type.group,
    actorName: nameOf(entry.actorId),
    projectCode: entry.projectId ? (state.projectsById.get(entry.projectId)?.code ?? null) : null,
    objectDeleted: objectDeletedOf(entry),
    objectLink: objectLinkOf(me, entry, people),
    objectLabelKey: entry.kind === "model.changed" ? `usage.operations.${entry.object.id}` : null,
    diff: diffOf(entry, people),
  };
}

/** Il segnaposto di un progetto che chi legge non vede (la pagina lo dice a parole). */
const HIDDEN_PROJECT = "@hidden";

/**
 * Il progetto principale di un server si salva come id (`server.updated`):
 * a lettura, PRIMA di tutto (anche del `before`/`after` grezzo che la vista
 * porta), diventa il codice se chi guarda lo vede, altrimenti
 * `HIDDEN_PROJECT` — mai il codice né l'id di un progetto invisibile (R-G5).
 */
function resolveProject(me: string, entry: ChangeEntry): ChangeEntry {
  if (entry.kind !== "server.updated") return entry;
  const visible = visibleProjectIds(me);
  const resolve = (raw: string | null): string | null => {
    if (raw === null) return null;
    try {
      const fields = JSON.parse(raw) as Record<string, unknown>;
      if (!("primaryProject" in fields)) return raw;
      const id = fields.primaryProject;
      const code =
        typeof id === "string" && visible.has(id) ? state.projectsById.get(id)?.code : undefined;
      return JSON.stringify({
        ...fields,
        primaryProject: id === null ? null : (code ?? HIDDEN_PROJECT),
      });
    } catch {
      return raw;
    }
  };
  return { ...entry, before: resolve(entry.before), after: resolve(entry.after) };
}

/** Le voci, più recenti prima (a parità d'ora, l'ultima scritta prima). */
function newestFirst(entries: ChangeEntry[]): ChangeEntry[] {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => Date.parse(b.e.at) - Date.parse(a.e.at) || b.i - a.i)
    .map(({ e }) => e);
}

/** Le voci che `me` legge, filtrate (funzione pura sullo stato, senza cancello). */
function changesReadableBy(me: string, filter: ChangeFilter = {}): ChangeEntryView[] {
  const visible = visibleProjectIds(me);
  const people = me === CLAUDE_ID ? new Set<string>() : visiblePeopleFor(me);
  return newestFirst(
    state.changelog.filter((e) => readable(me, e, visible) && matchesFilter(e, filter)),
  ).map((e) => view(me, e, people));
}

/** Il registro in Amministrazione: le voci leggibili da chi guarda, più recenti prima. */
export async function listChanges(filter: ChangeFilter = {}): Promise<ChangeEntryView[]> {
  const me = await gate("changelog.listChanges");
  return changesReadableBy(me, filter);
}

/**
 * Il registro di un progetto (Settings → Change log). Un progetto che chi
 * guarda non vede risponde `not_found`, come uno che non esiste (R-G5); uno
 * visibile senza `project.settings.manage` né `project.members.manage`,
 * `forbidden`.
 */
export async function listProjectChanges(
  projectId: string,
  filter: Omit<ChangeFilter, "projectId"> = {},
): Promise<ChangeEntryView[]> {
  const me = await gate("changelog.listProjectChanges");
  if (!visibleProjectIds(me).has(projectId)) throw notFound();
  if (!managesProject(me, projectId)) throw forbidden();
  return changesReadableBy(me, { ...filter, projectId });
}

/**
 * Le scelte dei filtri (R-G5): le persone che chi guarda vede, i progetti
 * che vede, i gruppi di voci che legge. Con `projectId` (il registro del
 * progetto) i gruppi sono quelli che legge lì.
 */
export async function listChangeFilterChoices(projectId?: string): Promise<ChangeFilterChoices> {
  const me = await gate("changelog.listChangeFilterChoices");
  const viewer = viewerFor(me);
  const visible = visibleProjectIds(me);
  if (projectId !== undefined && !visible.has(projectId)) throw notFound();
  const people = me === CLAUDE_ID ? new Set<string>() : visiblePeopleFor(me);
  return {
    everything: can(viewer, "changelog.view"),
    people: [...people]
      .map((personId) => ({ personId, name: nameOf(personId) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    projects: state.projects
      .filter((p) => visible.has(p.id))
      .map((p) => ({ projectId: p.id, code: p.code, name: p.name }))
      .sort((a, b) => a.code.localeCompare(b.code)),
    groups: readableChangeGroups(viewer, projectId),
  };
}
