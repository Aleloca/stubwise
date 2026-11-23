import { changeLog, chatChannelMembers, chatChannels, chatMessages, projectMembers, users, type Db } from "@stubwise/db";
import { userIdsWithPermission } from "@stubwise/notifications";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import { channelReadableSql } from "../chat/access.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * CHI SI CONOSCE (registro, A11 r.1414; docs/invariants/permissions.md, «chi
 * non vede una persona o un progetto non ne riceve nemmeno l'id»): FRA I
 * CANDIDATI (le persone che una risposta nomina), quelle di cui chi guarda
 * riceve id e nome; "all" per un full admin. È più largo di chi si vede per scegliere
 * (`visiblePersonIds`, gli assegnabili e «Who can?»): due domande diverse.
 *
 * - un full admin conosce tutti;
 * - sé stesso, i full admin, Claude (l'utente di sistema);
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
export async function peopleKnownTo(
  db: Db,
  viewer: Pick<SessionUser, "id" | "instancePermissions">,
  candidates: Iterable<string>,
): Promise<"all" | ReadonlySet<string>> {
  if (viewer.instancePermissions.has("instance.full_admin")) return "all";
  // Revisione del lotto 2, I4: solo le persone che la risposta nomina, con
  // EXISTS filtrati per id (mai una scansione dei messaggi o dei membri di tutti).
  const ids = [...new Set(candidates)].filter((id) => id !== viewer.id && UUID.test(id));
  const known = new Set<string>([viewer.id]);
  if (ids.length === 0) return known;
  for (const id of await userIdsWithPermission(db, null, null)) if (ids.includes(id)) known.add(id);
  const readable = await channelReadableSql(db, viewer);
  // I progetti che chi guarda legge, ARCHIVIATI compresi (decisione di 46, 23
  // nov 2026: un archiviato si legge ancora, e chi c'era resta conosciuto).
  const mine = sql`(select me.project_id from ${projectMembers} me where me.user_id = ${viewer.id})`;
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        inArray(users.id, ids),
        or(
          // Claude (l'utente di sistema) lo conoscono tutti: si assegna, si chiama nella Chat.
          eq(users.isAgent, true),
          sql`exists (select 1 from ${projectMembers} pm where pm.user_id = ${users.id} and pm.project_id in ${mine})`,
          // Gli ex membri: ogni uscita lascia una voce nel registro, sul membro.
          sql`exists (select 1 from ${changeLog} cl where cl.type = 'member.removed' and cl.subject_id = ${users.id}::text and cl.project_id in ${mine})`,
          // I membri e gli autori dei canali che chi guarda legge (la regola di `channelReadableSql`).
          sql`exists (select 1 from ${chatChannelMembers} join ${chatChannels} on ${chatChannels.id} = ${chatChannelMembers.channelId} where ${chatChannelMembers.userId} = ${users.id} and ${readable})`,
          sql`exists (select 1 from ${chatMessages} join ${chatChannels} on ${chatChannels.id} = ${chatMessages.channelId} where ${chatMessages.authorId} = ${users.id} and ${readable})`,
        ),
      ),
    );
  for (const r of rows) known.add(r.id);
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
  private known: "all" | Set<string>;
  /** Le persone già verificate (conosciute o no): `knows` di una mai verificata dice no. */
  private readonly checked = new Set<string>();

  constructor(
    known: "all" | ReadonlySet<string>,
    private readonly selfId: string,
  ) {
    this.known = known === "all" ? "all" : new Set(known);
  }

  /** Le persone di `candidates` ancora da verificare. */
  unchecked(candidates: Iterable<string>): string[] {
    const known = this.known;
    if (known === "all") return [];
    return [...new Set(candidates)].filter((id) => id !== this.selfId && !this.checked.has(id) && !known.has(id));
  }

  /** Aggiunge l'esito di una verifica (`peopleKnownTo` sui candidati). */
  learn(candidates: Iterable<string>, known: "all" | ReadonlySet<string>): void {
    if (known === "all") this.known = "all";
    if (this.known === "all") return;
    for (const id of candidates) this.checked.add(id);
    for (const id of known as ReadonlySet<string>) this.known.add(id);
  }

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
const hiddenByViewer = new WeakMap<object, { hidden: HiddenIds; pending: Promise<void> }>();
export async function hiddenFor(db: Db, viewer: Pick<SessionUser, "id" | "instancePermissions">, candidates: Iterable<string | null | undefined>): Promise<HiddenIds> {
  let entry = hiddenByViewer.get(viewer);
  if (!entry) {
    entry = { hidden: new HiddenIds(viewer.instancePermissions.has("instance.full_admin") ? "all" : new Set(), viewer.id), pending: Promise.resolve() };
    hiddenByViewer.set(viewer, entry);
  }
  const ids = [...candidates].filter((id): id is string => typeof id === "string");
  // In fila: due viste della stessa risposta non verificano due volte la stessa persona.
  const e = entry;
  const run = e.pending.then(async () => {
    const todo = e.hidden.unchecked(ids);
    if (todo.length > 0) e.hidden.learn(todo, await peopleKnownTo(db, viewer, todo));
  });
  // Un errore lo riceve chi ha chiesto, non le richieste dopo.
  e.pending = run.catch(() => undefined);
  await run;
  return e.hidden;
}


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
    const nameless: string[] = [];
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (keys.has(k) && typeof x === "string" && UUID.test(x)) {
        out[k] = hidden.person(x);
        if (out[k] !== x && k.endsWith("Id")) nameless.push(`${k.slice(0, -2)}Name`);
      } else if (keys.has(k) && Array.isArray(x)) out[k] = x.map((e) => (typeof e === "string" && UUID.test(e) ? hidden.person(e) : walk(e)));
      else out[k] = walk(x);
    }
    // Il nome accanto a un id mascherato (`byId` → `byName`) non esce nemmeno lui.
    for (const k of nameless) if (k in out) out[k] = null;
    return out;
  };
  return walk(payload) as T;
}

/**
 * Registra sul plugin di rotte il mascheramento delle risposte (registro, A11
 * r.1414): `keys` portano l'id di una persona (un valore o un elenco),
 * `objectKeys` un oggetto persona `{ id, name }` (l'id diventa il segnaposto e
 * il nome null). Senza persone diverse da chi guarda, nessuna query.
 */
/** Una rotta che passa dalla maschera, con le sue chiavi: la legge il test degli schemi (`people-mask-schemas.test.ts`). */
export interface PersonMaskedRoute {
  method: string;
  url: string;
  keys: ReadonlySet<string>;
  objectKeys: ReadonlySet<string>;
  response: Record<string, unknown>;
}
const maskedRoutes = new Map<string, PersonMaskedRoute>();
export function personMaskedRoutes(): PersonMaskedRoute[] {
  return [...maskedRoutes.values()];
}

type RouteSeen = { method: string | string[]; url: string; schema?: { response?: Record<string, unknown> } };

/**
 * La stessa maschera di {@link registerPersonMask}, per una risposta scritta a
 * mano (uno stream SSE, dove `preSerialization` non scatta). Ogni chiamata ha
 * la sua numerazione, a meno che il chiamante non ripassi lo stesso `viewer`.
 */
export async function maskPeopleFor<T>(db: Db, viewer: Pick<SessionUser, "id" | "instancePermissions">, payload: T, keys: ReadonlySet<string>): Promise<T> {
  const ids = personIdsIn(payload, keys);
  ids.delete(viewer.id);
  if (ids.size === 0) return payload;
  return maskPeople(payload, await hiddenFor(db, viewer, ids), keys);
}

export function registerPersonMask(
  instance: {
    addHook(name: "preSerialization", fn: (request: { user?: SessionUser | null }, reply: unknown, payload: unknown) => Promise<unknown>): unknown;
    addHook(name: "onRoute", fn: (route: RouteSeen) => void): unknown;
    db: Db;
  },
  keys: ReadonlySet<string>,
  objectKeys: ReadonlySet<string> = new Set(),
): void {
  // Le rotte di questo plugin (registrate DOPO): un segnaposto in un campo
  // rimasto `uuid` fa lanciare il serializer (500 sull'intera risposta).
  instance.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) {
      maskedRoutes.set(`${method} ${route.url}`, { method, url: route.url, keys, objectKeys, response: route.schema?.response ?? {} });
    }
  });
  instance.addHook("preSerialization", async (request, _reply, payload) => {
    const user = request.user;
    if (!user || payload === null || typeof payload !== "object") return payload;
    const ids = personIdsIn(payload, keys);
    for (const id of personObjectIdsIn(payload, objectKeys)) ids.add(id);
    ids.delete(user.id);
    if (ids.size === 0) return payload;
    const hidden = await hiddenFor(instance.db, user, ids);
    return maskPersonObjects(maskPeople(payload, hidden, keys), hidden, objectKeys);
  });
}

function personObjectIdsIn(payload: unknown, keys: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  if (keys.size === 0) return out;
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v === null || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const id = x && typeof x === "object" ? (x as { id?: unknown }).id : undefined;
      if (keys.has(k) && typeof id === "string" && UUID.test(id)) out.add(id);
      walk(x);
    }
  };
  walk(payload);
  return out;
}

export function maskPersonObjects<T>(payload: T, hidden: HiddenIds, keys: ReadonlySet<string>): T {
  if (keys.size === 0) return payload;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v === null || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const id = x && typeof x === "object" ? (x as { id?: unknown }).id : undefined;
      if (keys.has(k) && typeof id === "string" && UUID.test(id) && !hidden.knows(id)) out[k] = { ...(x as object), id: hidden.person(id), name: null };
      else out[k] = walk(x);
    }
    return out;
  };
  return walk(payload) as T;
}
