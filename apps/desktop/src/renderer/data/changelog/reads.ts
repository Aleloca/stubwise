import { PEOPLE } from "../seed/people";
import { gate, state, visibleProjectIds } from "../store";
import { can, viewerFor, type Permission } from "../viewer";
import { forbidden, notFound } from "../writer";
import { changeTypeOf } from "./record";
import type { ChangeEntry, ChangeEntryView, ChangeFilter } from "./types";

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

const MANAGE_PROJECT = ["project.settings.manage", "project.members.manage"] as const;

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
  if (filter.from !== undefined && Date.parse(entry.at) < Date.parse(filter.from)) return false;
  if (filter.to !== undefined && Date.parse(entry.at) > Date.parse(filter.to)) return false;
  return true;
}

const nameOf = (personId: string): string =>
  PEOPLE.find((p) => p.id === personId)?.name ?? personId;

function view(entry: ChangeEntry): ChangeEntryView {
  const type = changeTypeOf(entry.kind)!;
  return {
    ...entry,
    object: { ...entry.object },
    params: { ...entry.params },
    templateKey: type.templateKey,
    scope: type.scope,
    actorName: nameOf(entry.actorId),
    projectCode: entry.projectId ? (state.projectsById.get(entry.projectId)?.code ?? null) : null,
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
  return newestFirst(
    state.changelog.filter((e) => readable(me, e, visible) && matchesFilter(e, filter)),
  ).map(view);
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
