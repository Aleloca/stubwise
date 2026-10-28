import {
  ALERT_TYPES,
  alertTypeOf,
  rowPartners,
  rowTypeOf,
  type AlertType,
} from "../../domain/alerts/catalog";
import type { Channels } from "../../domain/alerts/recipients";
import { copy, now, state, storeGeneration, visibleProjectIds } from "../store";
import type { AlertSubscription } from "../types";
import { forbidden, invalid, notFound, writer } from "../writer";
import { canSubscribe, currentChannels, projectRows } from "./reads";
import { isComputed, notificationById, whyReceives } from "./visibility";

// Le scritture delle iscrizioni. Una scrittura aggiunge una voce alla storia
// dell'iscrizione, all'ora di adesso: spegnere vale solo per il futuro (gli
// avvisi già arrivati contano lo stato al loro momento). Si scrive solo ciò
// che si può vedere: una riga sospesa (permesso perso) o solo obbligatoria
// non si tocca, e gli obbligatori arrivano comunque. Un progetto invisibile
// risponde come uno che non esiste (R-G5).

export interface Undoable {
  /** Rimette le iscrizioni toccate come erano prima, riga per riga. */
  undo(): Promise<void>;
}

const subIndex = (personId: string, projectId: string, type: string) =>
  state.alertSubscriptions.findIndex(
    (s) => s.personId === personId && s.projectId === projectId && s.type === type,
  );

/** Scrive i canali di un tipo, se cambiano. Phone richiede App (shape [A 7]). */
function write(personId: string, projectId: string, def: AlertType, ch: Channels): boolean {
  const next = { app: ch.app, phone: ch.app && ch.phone };
  const cur = currentChannels(personId, projectId, def);
  if (cur.app === next.app && cur.phone === next.phone) return false;
  const i = subIndex(personId, projectId, def.type);
  const entry = { at: now(), ...next };
  if (i >= 0) state.alertSubscriptions[i]!.history.push(entry);
  else state.alertSubscriptions.push({ personId, projectId, type: def.type, history: [entry] });
  return true;
}

/**
 * Fotografa le iscrizioni che una scrittura sta per toccare, e restituisce
 * come rimetterle. Un ripristino nel frattempo (`resetApi`) annulla l'undo.
 */
function snapshot(personId: string, projectId: string, types: string[]): Undoable {
  const gen = storeGeneration();
  const before = new Map<string, AlertSubscription | undefined>(
    types.map((t) => {
      const i = subIndex(personId, projectId, t);
      return [t, i >= 0 ? copy(state.alertSubscriptions[i]!) : undefined];
    }),
  );
  return {
    async undo() {
      await writer("alerts.undo");
      if (gen !== storeGeneration()) return;
      for (const [type, sub] of before) {
        const i = subIndex(personId, projectId, type);
        if (i >= 0 && sub) state.alertSubscriptions[i] = copy(sub);
        else if (i >= 0) state.alertSubscriptions.splice(i, 1);
        else if (sub) state.alertSubscriptions.push(copy(sub));
      }
    },
  };
}

function visibleProject(me: string, projectId: string): void {
  if (!state.projectsById.has(projectId) || !visibleProjectIds(me).has(projectId)) throw notFound();
}

/** I tipi di una riga che chi agisce può scrivere; nessuno = riga sospesa o solo obbligatoria. */
function writableKinds(me: string, projectId: string, rowType: string): AlertType[] {
  return rowPartners(rowType).filter((k) => canSubscribe(me, projectId, k));
}

/**
 * Accende o spegne un tipo in un progetto, per App e Telefono (gli assenti
 * restano come sono). Una riga che raccoglie kind di prima (shape [A 10])
 * li scrive tutti.
 */
export async function setSubscription(
  projectId: string,
  type: string,
  change: { app?: boolean; phone?: boolean },
): Promise<void> {
  const me = await writer("alerts.setSubscription");
  visibleProject(me, projectId);
  if (!alertTypeOf(type)) throw invalid("type");
  const rowType = rowTypeOf(type);
  const kinds = writableKinds(me, projectId, rowType);
  if (kinds.length === 0) throw forbidden();
  const row = projectRows(me, projectId).find((r) => r.type === rowType);
  let app = change.app ?? row?.app ?? false;
  let phone = change.phone ?? row?.phone ?? false;
  if (change.phone === true) app = true;
  if (change.app === false) phone = false;
  for (const k of kinds) write(me, projectId, k, { app, phone });
}

/**
 * «Come questo progetto»: le righe di `toProjectId` che si possono scrivere
 * prendono lo stato di quelle di `fromProjectId`. Le righe sospese o
 * obbligatorie (da una parte o dall'altra) restano come sono.
 */
export async function copySubscriptions(
  fromProjectId: string,
  toProjectId: string,
): Promise<Undoable> {
  const me = await writer("alerts.copySubscriptions");
  visibleProject(me, fromProjectId);
  visibleProject(me, toProjectId);
  if (fromProjectId === toProjectId) throw invalid("same_project");
  const source = new Map(projectRows(me, fromProjectId).map((r) => [r.type, r]));
  const plan: [AlertType, Channels][] = [];
  for (const row of projectRows(me, toProjectId)) {
    const from = source.get(row.type);
    if (!from || from.state === "suspended" || from.state === "mandatory") continue;
    for (const k of writableKinds(me, toProjectId, row.type)) plan.push([k, from]);
  }
  const undo = snapshot(
    me,
    toProjectId,
    plan.map(([k]) => k.type),
  );
  for (const [k, ch] of plan) write(me, toProjectId, k, ch);
  return undo;
}

/**
 * «Spegni tutto in questo progetto»: ogni tipo che si può scrivere, App e
 * Telefono. Gli obbligatori arrivano comunque.
 */
export async function muteProject(projectId: string): Promise<Undoable> {
  const me = await writer("alerts.muteProject");
  visibleProject(me, projectId);
  const kinds = ALERT_TYPES.filter((k) => canSubscribe(me, projectId, k));
  const undo = snapshot(
    me,
    projectId,
    kinds.map((k) => k.type),
  );
  for (const k of kinds) write(me, projectId, k, { app: false, phone: false });
  return undo;
}

/**
 * «Non avvisarmi più di questo in <progetto>», dal pannello: spegne il tipo
 * dell'avviso (e della sua riga) per gli avvisi futuri; quello cliccato
 * resta. Non c'è per gli avvisi obbligatori (`forbidden`), né per i kind
 * fuori dal catalogo (`invalid: kind`).
 */
export async function muteFromNotification(notificationId: string): Promise<Undoable> {
  const me = await writer("alerts.muteFromNotification");
  const n = notificationById(notificationId);
  const why = n ? whyReceives(me, n) : null;
  if (!n || why === null) throw notFound();
  if (!isComputed(n)) throw invalid("kind");
  if (why !== "subscribed") throw forbidden();
  const kinds = writableKinds(me, n.projectId, rowTypeOf(n.kind));
  if (kinds.length === 0) throw forbidden();
  const undo = snapshot(
    me,
    n.projectId,
    kinds.map((k) => k.type),
  );
  for (const k of kinds) write(me, n.projectId, k, { app: false, phone: false });
  return undo;
}
