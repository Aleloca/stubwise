import {
  ALERT_GROUPS,
  ALERT_TYPES,
  rowPartners,
  type AlertGroup,
  type AlertType,
} from "../../domain/alerts/catalog";
import { allowedNow, latest, subscriptionAt, type Channels } from "../../domain/alerts/recipients";
import { chatKey, gate, now, state, visibleProjectIds } from "../store";
import type { AppNotification, MandatoryReason } from "../types";
import type { Permission } from "../viewer";
import { canReceive, isMember, permsIn, whyReceives } from "./visibility";

// Le letture degli avvisi: le iscrizioni di chi guarda (Preferenze →
// Notifiche e popover del progetto) e la forma con cui un avviso arriva a
// una persona (letto/archiviato/posticipato per persona).

export type SubscriptionState = "on" | "off" | "suspended" | "mandatory";

export interface SubscriptionRow {
  /** Il tipo della riga (per i kind di prima confluiti, quello nuovo). */
  type: string;
  group: AlertGroup;
  labelKey: string;
  /** Chi riceve questo tipo senza iscrizione (la riga lo dice in parole). */
  mandatory: MandatoryReason[];
  app: boolean;
  phone: boolean;
  state: SubscriptionState;
  /** Sospesa: il permesso che manca adesso (la UI lo dice in parole, mai il nome). */
  suspendedReason?: Permission;
}

export interface ProjectSubscriptions {
  projectId: string;
  code: string;
  name: string;
  pinned: boolean;
  rows: SubscriptionRow[];
}

const subOf = (personId: string, projectId: string, type: string) =>
  state.alertSubscriptions.find(
    (s) => s.personId === personId && s.projectId === projectId && s.type === type,
  );

/** Lo stato di adesso dell'iscrizione di una persona a un tipo, in un progetto. */
export function currentChannels(personId: string, projectId: string, def: AlertType): Channels {
  return subscriptionAt(
    subOf(personId, projectId, def.type),
    def,
    permsIn(personId, projectId),
    latest(now()),
    isMember(personId, projectId),
  );
}

/** Se la persona può iscriversi adesso a un tipo, nel progetto. */
export const canSubscribe = (personId: string, projectId: string, def: AlertType): boolean =>
  !def.mandatoryOnly &&
  allowedNow(def, permsIn(personId, projectId), canReceive(personId, projectId));

/**
 * La riga delle Preferenze di un tipo: i kind che vi confluiscono contano
 * insieme (accesa se uno di quelli che si possono vedere lo è). Sospesa solo
 * se sarebbe accesa (shape [A 8]): un tipo che non si può vedere e che non
 * era acceso non c'è (`null`).
 */
function rowOf(personId: string, projectId: string, main: AlertType): SubscriptionRow | null {
  const base = {
    type: main.type,
    group: main.group,
    labelKey: main.labelKey,
    mandatory: [...main.mandatory],
  };
  const perms = permsIn(personId, projectId);
  const sees = canReceive(personId, projectId);
  if (main.mandatoryOnly) {
    if (!allowedNow(main, perms, sees)) return null;
    return { ...base, app: true, phone: main.defaultPhone, state: "mandatory" };
  }
  const kinds = rowPartners(main.type);
  const allowed = kinds.filter((k) => canSubscribe(personId, projectId, k));
  const counted = allowed.length > 0 ? allowed : kinds;
  const channels = counted.map((k) => currentChannels(personId, projectId, k));
  const app = channels.some((c) => c.app);
  const phone = channels.some((c) => c.phone);
  if (allowed.length > 0) return { ...base, app, phone, state: app ? "on" : "off" };
  if (!app) return null;
  const missing = main.subscribe.perm;
  return {
    ...base,
    app,
    phone,
    state: "suspended",
    ...(missing !== "member" ? { suspendedReason: missing } : {}),
  };
}

/** Le righe di un progetto, per famiglia nell'ordine del catalogo. */
export function projectRows(personId: string, projectId: string): SubscriptionRow[] {
  const rows: SubscriptionRow[] = [];
  for (const group of ALERT_GROUPS) {
    for (const t of ALERT_TYPES) {
      if (t.group !== group || t.sameRowAs) continue;
      const row = rowOf(personId, projectId, t);
      if (row) rows.push(row);
    }
  }
  return rows;
}

/**
 * Le iscrizioni di una persona, per progetto che vede: i fissati prima,
 * nell'ordine del binario, poi gli altri per nome.
 */
export function rowsFor(personId: string): ProjectSubscriptions[] {
  const visible = visibleProjectIds(personId);
  const pinned = (state.pinned.get(personId) ?? []).filter((id) => visible.has(id));
  const others = state.projects
    .filter((p) => visible.has(p.id) && !pinned.includes(p.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const ordered = [...pinned.map((id) => state.projectsById.get(id)!), ...others];
  return ordered.map((p) => ({
    projectId: p.id,
    code: p.code,
    name: p.name,
    pinned: pinned.includes(p.id),
    rows: projectRows(personId, p.id),
  }));
}

/** Le iscrizioni di chi guarda (Preferenze → Notifiche, popover del progetto). */
export async function subscriptionRows(): Promise<ProjectSubscriptions[]> {
  const me = await gate("alerts.subscriptionRows");
  return rowsFor(me);
}

/**
 * Un avviso come arriva a `personId`, o `null` se non gli arriva: letto,
 * archiviato e posticipato sono suoi (`notificationMarks`, con i flag della
 * riga del seme come partenza); di `mandatory` resta solo il suo obbligo,
 * che la UI scrive sotto l'avviso.
 */
export function deliveredTo(personId: string, n: AppNotification): AppNotification | null {
  const why = whyReceives(personId, n);
  if (why === null) return null;
  const out: AppNotification = { ...n };
  const mark = state.notificationMarks.get(chatKey(personId, n.id));
  if (mark?.read !== undefined) out.read = mark.read;
  if (mark?.archived !== undefined) out.archived = mark.archived;
  if (mark?.snoozedUntil !== undefined) out.snoozedUntil = mark.snoozedUntil;
  delete out.mandatory;
  if (why !== "subscribed" && why !== "fixed") out.mandatory = [{ personId, reason: why }];
  return out;
}
