import { accessState, isMember } from "../access/index";
import { canSeeAdminSection, projectSettingsAccess } from "../adminSections";
// Area 9c: solo i tipi di voce, mai `projectSettings/index.ts` (P6).
import { SECTION_OF_KIND } from "../projectSettings/changeTypes";
import type { AdminSection } from "../routes";
import { visiblePeopleFor } from "../access/whoCan";
import { CLAUDE_ID, PEOPLE } from "../seed/people";
import {
  archivedProjectIdsFor,
  gate,
  knownDeletedProject,
  now,
  state,
  visibleProjectIds,
} from "../store";
import { can, viewerFor, type Permission } from "../viewer";
import { forbidden, notFound } from "../writer";
import { changeTypeOf } from "./record";
import { SETTING_KINDS, decodeSetting, type SettingValue } from "./settingValues";
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
// Area 9c (Task 5): le voci di un archiviato si leggono con la stessa regola
// sui progetti visibili PIÙ gli archiviati di chi guarda
// (`archivedProjectIdsFor`: ex membri e full admin). Un progetto eliminato
// non c'è più per nessuno: le sue voci di progetto restano e non si leggono.
// `project.deleted` e `repository.deleted` (d'istanza) dicono il progetto
// eliminato solo a chi ne era membro o è full admin (R-G5): agli altri la
// chiave «un progetto che non vedi», senza nome, codice né id.
//
// La vista di una voce porta già tutto ciò che la UI mostra (`view`): il
// link all'oggetto se esiste ancora e chi guarda può aprirlo, «(deleted)»,
// e il prima/dopo pronto da leggere. Le persone che chi guarda non vede non
// ci sono nemmeno lì, né per nome né in un conteggio (R-G5).

const DAY_MS = 86_400_000;

/** I progetti di cui `me` può leggere le voci: i visibili e i suoi archiviati (R-M1, Task 5). */
const readableProjectIds = (me: string): Set<string> =>
  new Set([...visibleProjectIds(me), ...archivedProjectIdsFor(me)]);

/**
 * Le due voci d'istanza che nominano un progetto eliminato, risolte a
 * lettura (R-G5). `project.deleted`: «RNC · Vetrina online Tenuta Ronchi» a
 * chi ne era membro o è full admin; agli altri un'etichetta vuota e la
 * chiave `changelog.values.hiddenProject`, e nemmeno l'id. `repository.deleted`:
 * `formerProjectId` non esce mai; `formerProject` (il codice) solo a chi
 * conosce il progetto. Le altre voci passano com'erano.
 */
function resolveDeleted(
  me: string,
  entry: ChangeEntry,
): { entry: ChangeEntry; labelKey: string | null } {
  if (entry.kind === "project.deleted") {
    const known = knownDeletedProject(me, entry.object.id);
    return known
      ? {
          entry: { ...entry, object: { ...entry.object, label: `${known.code} · ${known.name}` } },
          labelKey: null,
        }
      : {
          entry: { ...entry, object: { type: entry.object.type, id: "", label: "" } },
          labelKey: "changelog.values.hiddenProject",
        };
  }
  if (entry.kind === "repository.deleted") {
    const { formerProjectId, ...params } = entry.params;
    const known = knownDeletedProject(me, formerProjectId);
    return {
      entry: { ...entry, params: known ? { ...params, formerProject: known.code } : params },
      labelKey: null,
    };
  }
  return { entry, labelKey: null };
}

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
  if (filter.via !== undefined && entry.via !== filter.via) return false;
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

/**
 * Una voce di progetto del 9c porta alla sezione di Settings in cui sta
 * l'oggetto, se chi guarda la vede (`projectSettingsAccess`); `undefined` per
 * le voci che non sono del 9c.
 */
function projectSettingsLinkOf(
  me: string,
  entry: ChangeEntry,
): ChangeObjectLink | null | undefined {
  const section = SECTION_OF_KIND[entry.kind];
  if (!section || entry.projectId === null) return undefined;
  const project = state.projectsById.get(entry.projectId);
  if (!project) return null;
  const { code } = project;
  // Un archiviato non ha Settings da aprire: una voce sul progetto porta alla
  // sua pagina (`/archived/RNC`, Task 11), per chi la vede da archiviato.
  if (project.archived)
    return entry.object.type === "project" && archivedProjectIdsFor(me).has(project.id)
      ? { to: "archived", code }
      : null;
  if (!projectSettingsAccess(viewerFor(me), entry.projectId)[section].visible) return null;
  // Un repository ancora nel progetto apre la sua pagina in Repositories.
  const repo =
    section === "repositories" &&
    entry.object.type === "repository" &&
    state.repositories.some((r) => r.id === entry.object.id && r.projectId === project.id)
      ? entry.object.id
      : undefined;
  return repo
    ? { to: "projectSettings", code, section, repo }
    : { to: "projectSettings", code, section };
}

/**
 * `project.deleted` (Task 12): con un repository rimasto senza progetto, la
 * voce porta ad Amministrazione → Repositories, per chi vede quella voce.
 */
function deletedProjectLinkOf(me: string, entry: ChangeEntry): ChangeObjectLink | null {
  if (Number(entry.params.detachedRepositories ?? 0) === 0) return null;
  return canSeeAdminSection(viewerFor(me), "repositories")
    ? { to: "admin", section: "repositories" }
    : null;
}

/** Dove porta l'oggetto, per chi guarda; `null` se non c'è più o non lo può aprire. */
function objectLinkOf(
  me: string,
  entry: ChangeEntry,
  people: Set<string>,
): ChangeObjectLink | null {
  const settingsLink = projectSettingsLinkOf(me, entry);
  if (settingsLink !== undefined) return settingsLink;
  if (entry.kind === "project.deleted") return deletedProjectLinkOf(me, entry);
  const viewer = viewerFor(me);
  const { type, id } = entry.object;
  switch (type) {
    case "person": {
      if (!people.has(id)) return null;
      // Un membro ancora nel progetto si apre nel suo pannello di Members
      // (non in un archiviato: non ha Settings da aprire, Task 5).
      if (entry.projectId && isMember(id, entry.projectId)) {
        const project = state.projectsById.get(entry.projectId);
        if (project && !project.archived)
          return { to: "member", projectCode: project.code, personId: id };
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
 * L'account AI di un progetto (9c) si salva come id: il nome è quello di
 * adesso; se l'account è stato eliminato, `deleted` e il nome di allora
 * (`params.accountBefore`/`accountAfter`, Task 12), `null` se la voce non lo sa.
 */
function withAccountName(
  value: SettingValue | null,
  nameThen: string | undefined,
): SettingValue | null {
  if (value?.type !== "ai_account" || value.providerId === null) return value;
  const provider = state.instance.providers.find((p) => p.id === value.providerId);
  return provider
    ? { ...value, name: provider.name }
    : { ...value, name: nameThen ?? null, deleted: true };
}

/**
 * Il prima e dopo di una voce, per tipo. Le voci che toccano un segreto
 * (link di reset, secondo fattore) non ne hanno mai: c'è solo la frase.
 */
function diffOf(entry: ChangeEntry, people: Set<string>): ChangeDiff | null {
  const p = entry.params;
  if (SETTING_KINDS[entry.kind]) {
    // I valori stabili del 9b (Ruling T3): in forma di dato, le parole sono della pagina.
    const before = withAccountName(decodeSetting(entry.kind, entry.before), p.accountBefore);
    const after = withAccountName(decodeSetting(entry.kind, entry.after), p.accountAfter);
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

/**
 * La voce annullata da `entry`, se chi guarda legge anche quella; `null`
 * altrimenti (R-G5: l'id di una voce che non legge non esce).
 */
function undoOfFor(me: string, entry: ChangeEntry, visible: Set<string>): string | null {
  if (entry.undoOf === undefined) return null;
  const undone = state.changelog.find((e) => e.id === entry.undoOf);
  return undone && readable(me, undone, visible) ? undone.id : null;
}

function view(
  me: string,
  stored: ChangeEntry,
  people: Set<string>,
  visible: Set<string>,
  nested = false,
): ChangeEntryView {
  const { entry, labelKey } = resolveDeleted(me, resolveProject(me, stored));
  const type = changeTypeOf(entry.kind)!;
  // I campi della voce uno per uno, mai con uno spread: `claudeActionId`
  // resta nel livello dati e `undoOf` si calcola per chi guarda (ruling del
  // controller (pre-flight), P16).
  const undoOf = undoOfFor(me, stored, visible);
  // La voce annullata per la riga «Undid:» ([CT 4]); dentro di lei non si scende oltre.
  const undone = undoOf && !nested ? state.changelog.find((e) => e.id === undoOf) : undefined;
  return {
    id: entry.id,
    kind: entry.kind,
    at: entry.at,
    actorId: entry.actorId,
    projectId: entry.projectId,
    before: entry.before,
    after: entry.after,
    ...(entry.via ? { via: entry.via } : {}),
    undoOf,
    ...(undone ? { undoneEntry: view(me, undone, people, visible, true) } : {}),
    object: { ...entry.object },
    params: { ...entry.params },
    templateKey: type.templateKey,
    scope: type.scope,
    group: type.group,
    actorName: nameOf(entry.actorId),
    projectCode: entry.projectId ? (state.projectsById.get(entry.projectId)?.code ?? null) : null,
    objectDeleted: objectDeletedOf(entry),
    objectLink: objectLinkOf(me, entry, people),
    objectLabelKey:
      entry.kind === "model.changed" ? `usage.operations.${entry.object.id}` : labelKey,
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
  const visible = readableProjectIds(me);
  const people = me === CLAUDE_ID ? new Set<string>() : visiblePeopleFor(me);
  return newestFirst(
    state.changelog.filter((e) => readable(me, e, visible) && matchesFilter(e, filter)),
  ).map((e) => view(me, e, people, visible));
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
  const readableIds = readableProjectIds(me);
  return {
    everything: can(viewer, "changelog.view"),
    people: [...people]
      .map((personId) => ({ personId, name: nameOf(personId) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    projects: [
      ...state.projects
        .filter((p) => visible.has(p.id))
        .map((p) => ({ projectId: p.id, code: p.code, name: p.name })),
      // P21: gli archiviati di chi ne era membro (o del full admin), se ne legge le voci.
      ...state.projects
        .filter(
          (p) =>
            archivedProjectIdsFor(me).has(p.id) && readableChangeGroups(viewer, p.id).length > 0,
        )
        .map((p) => ({ projectId: p.id, code: p.code, name: p.name, archived: true })),
    ].sort((a, b) => a.code.localeCompare(b.code)),
    groups: readableChangeGroups(viewer, projectId),
    // Area 10a: «By Claude» solo se chi guarda ne legge almeno una (lì, con `projectId`).
    claude: state.changelog.some(
      (e) =>
        e.via === "claude" &&
        (projectId === undefined || e.projectId === projectId) &&
        readable(me, e, readableIds),
    ),
  };
}
