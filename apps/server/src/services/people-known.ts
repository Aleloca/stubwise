import { changeLog, chatChannelMembers, chatChannels, chatMessages, projectMembers, type Db } from "@stubwise/db";
import { userIdsWithPermission } from "@stubwise/notifications";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { isAllProjects, visibleProjectIds } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { channelReadableSql } from "../chat/access.js";

/**
 * CHI SI CONOSCE (registro, A11 r.1414; docs/invariants/permissions.md, «chi
 * non vede una persona o un progetto non ne riceve nemmeno l'id»): le persone
 * di cui chi guarda riceve id e nome. È più largo di chi si vede per scegliere
 * (`visiblePersonIds`, gli assegnabili e «Who can?»): due domande diverse.
 *
 * - un full admin conosce tutti;
 * - sé stesso, i full admin;
 * - chi è, o è STATO, membro di un progetto che chi guarda vede (le attive e
 *   le disattivate; gli ex membri dal registro, `member.removed`);
 * - i MEMBRI e gli AUTORI dei canali della Chat che chi guarda legge, anche
 *   senza un progetto in comune (decisione del maintainer del 23 nov 2026:
 *   «chi scrive in un canale che vedo è conosciuto»).
 *
 * La directory di Amministrazione → People resta fuori (chi ha il permesso
 * vede tutti per costruzione). Il prototipo: `peopleKnownTo`
 * (`domain/access/whoCan.ts`) e `knownPeopleFor` (`data/access/whoCan.ts`).
 */
export async function peopleKnownTo(db: Db, viewer: Pick<SessionUser, "id" | "instancePermissions">): Promise<"all" | ReadonlySet<string>> {
  if (viewer.instancePermissions.has("instance.full_admin")) return "all";
  const visible = await visibleProjectIds(db, viewer);
  if (isAllProjects(visible)) return "all";
  const known = new Set<string>([viewer.id, ...(await userIdsWithPermission(db, null, null))]);
  if (visible.length > 0) {
    for (const r of await db.selectDistinct({ id: projectMembers.userId }).from(projectMembers).where(inArray(projectMembers.projectId, visible))) known.add(r.id);
    // Gli ex membri: ogni uscita lascia una voce nel registro, sul membro.
    for (const r of await db
      .selectDistinct({ id: changeLog.subjectId })
      .from(changeLog)
      .where(and(eq(changeLog.type, "member.removed"), inArray(changeLog.projectId, visible)))) {
      known.add(r.id);
    }
  }
  const readable = await channelReadableSql(db, viewer);
  for (const r of await db
    .selectDistinct({ id: chatChannelMembers.userId })
    .from(chatChannelMembers)
    .innerJoin(chatChannels, eq(chatChannels.id, chatChannelMembers.channelId))
    .where(readable)) {
    known.add(r.id);
  }
  for (const r of await db
    .selectDistinct({ id: chatMessages.authorId })
    .from(chatMessages)
    .innerJoin(chatChannels, eq(chatChannels.id, chatMessages.channelId))
    .where(and(readable, isNotNull(chatMessages.authorId)))) {
    if (r.id) known.add(r.id);
  }
  return known;
}

/**
 * I segnaposto di UNA risposta: al posto dell'id di una persona che chi guarda
 * non conosce `hidden-<n>`, di un progetto che non vede `hidden-project-<n>`,
 * numerati nell'ordine di comparsa e stabili dentro la risposta (la stessa
 * persona è sempre lo stesso `hidden-2`), mai fra due risposte. Il proprio id
 * resta vero. Un segnaposto non è un id: una scrittura che lo riceve è un 400
 * (gli schemi delle scritture vogliono un uuid).
 */
export class HiddenIds {
  private readonly people = new Map<string, string>();
  private readonly projects = new Map<string, string>();

  constructor(
    private readonly known: "all" | ReadonlySet<string>,
    private readonly selfId: string,
  ) {}

  /** La persona è conosciuta da chi guarda (id e nome escono così come sono). */
  knows(personId: string): boolean {
    return personId === this.selfId || this.known === "all" || this.known.has(personId);
  }

  person(personId: string): string;
  person(personId: string | null): string | null;
  person(personId: string | null): string | null {
    if (personId === null || this.knows(personId)) return personId;
    let out = this.people.get(personId);
    if (!out) {
      out = `hidden-${this.people.size + 1}`;
      this.people.set(personId, out);
    }
    return out;
  }

  /** Un progetto che chi guarda non vede, dove la vista non può togliere il campo. */
  project(projectId: string, visible: boolean): string {
    if (visible) return projectId;
    let out = this.projects.get(projectId);
    if (!out) {
      out = `hidden-project-${this.projects.size + 1}`;
      this.projects.set(projectId, out);
    }
    return out;
  }
}
