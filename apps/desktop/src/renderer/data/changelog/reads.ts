import { accessState, isMember } from "../access/index";
import { visiblePeopleFor } from "../access/whoCan";
import { CLAUDE_ID, PEOPLE } from "../seed/people";
import { gate, now, state, visibleProjectIds } from "../store";
import { can, viewerFor, type Permission } from "../viewer";
import { forbidden, notFound } from "../writer";
import { changeTypeOf } from "./record";
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
// hanno nome nemmeno lì (R-G5).

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

/** Dove porta l'oggetto, per chi guarda; `null` se non c'è più o non lo può aprire. */
function objectLinkOf(me: string, entry: ChangeEntry, people: Set<string>): ChangeObjectLink | null {
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
    default:
      return null;
  }
}

/** Un ruolo o un reparto che non c'è più: il nome resta, con «(deleted)». */
function objectDeletedOf(entry: ChangeEntry): boolean {
  const { type, id } = entry.object;
  if (type === "role") return !accessState().roles.some((r) => r.id === id);
  if (type === "department") return !state.departments.some((d) => d.id === id);
  return false;
}

/** Il nome di un reparto, senza il colore che la voce gli tiene accanto («Support --dept-3»). */
const departmentName = (value: string | null): string | null =>
  value === null ? null : value.replace(/\s+--[\w-]+$/, "");

/**
 * Il prima e dopo di una voce, per tipo. Le voci che toccano un segreto
 * (link di reset, secondo fattore) non ne hanno mai: c'è solo la frase.
 */
function diffOf(entry: ChangeEntry, people: Set<string>): ChangeDiff | null {
  const p = entry.params;
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
        hidden: [...added, ...removed].filter((id) => !seen(id)).length,
      };
    }
    default:
      return null;
  }
}

function view(me: string, entry: ChangeEntry, people: Set<string>): ChangeEntryView {
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
    diff: diffOf(entry, people),
  };
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
export async function listChangeFilterChoices(
  projectId?: string,
): Promise<ChangeFilterChoices> {
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
