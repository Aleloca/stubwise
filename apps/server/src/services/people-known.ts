import { changeLog, chatChannelMembers, chatChannels, chatMessages, projectMembers, type Db } from "@stubwise/db";
import { userIdsWithPermission } from "@stubwise/notifications";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
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
 * - chi è, o è STATO, membro di un progetto che chi guarda vede, archiviati
 *   compresi (le attive e le disattivate; gli ex membri dal registro,
 *   `member.removed`);
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
  // I progetti che chi guarda legge, ARCHIVIATI compresi (decisione di 46, 23
  // nov 2026: un archiviato si legge ancora, e chi c'era resta conosciuto).
  const visible = (await db.select({ id: projectMembers.projectId }).from(projectMembers).where(eq(projectMembers.userId, viewer.id))).map((r) => r.id);
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

/**
 * I segnaposto di UNA risposta per chi guarda: uno per oggetto `viewer` (la
 * sessione della richiesta), così una risposta che mette insieme più viste
 * numera le persone nascoste una volta sola.
 */
const hiddenByViewer = new WeakMap<object, Promise<HiddenIds>>();
export function hiddenFor(db: Db, viewer: Pick<SessionUser, "id" | "instancePermissions">): Promise<HiddenIds> {
  let out = hiddenByViewer.get(viewer);
  if (!out) {
    out = peopleKnownTo(db, viewer).then((known) => new HiddenIds(known, viewer.id));
    hiddenByViewer.set(viewer, out);
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sostituisce, in una risposta intera, gli id delle persone che chi guarda non
 * conosce nelle chiavi date (a ogni profondità: un valore, o un elenco di
 * valori). Per le superfici con molte viste dagli stessi nomi di campo (la doc
 * di prodotto): UNA regola sul nome della chiave invece di una per vista. Le
 * chiavi devono essere SOLO di persone.
 */
/** Gli id di persona che la risposta porta nelle chiavi date: senza, nessuna query. */
export function personIdsIn(payload: unknown, keys: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v === null || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (keys.has(k) && typeof x === "string" && UUID.test(x)) out.add(x);
      else if (keys.has(k) && Array.isArray(x)) {
        for (const e of x) {
          if (typeof e === "string" && UUID.test(e)) out.add(e);
          else walk(e);
        }
      }
      else walk(x);
    }
  };
  walk(payload);
  return out;
}

export function maskPeople<T>(payload: T, hidden: HiddenIds, keys: ReadonlySet<string>): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v === null || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (keys.has(k) && typeof x === "string" && UUID.test(x)) out[k] = hidden.person(x);
      else if (keys.has(k) && Array.isArray(x)) out[k] = x.map((e) => (typeof e === "string" && UUID.test(e) ? hidden.person(e) : walk(e)));
      else out[k] = walk(x);
    }
    return out;
  };
  return walk(payload) as T;
}
