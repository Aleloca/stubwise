import { alertSubscriptions, notifications, projects, users, type Db } from "@stubwise/db";
import { notificationVisibleToRecipient } from "@stubwise/notifications";
import {
  alertTypeOf,
  defaultApplies,
  isLiveAlertType,
  liveRowTypes,
  rowPartners,
  rowTypeOf,
  type AlertSubscriptionRow,
  type AlertType,
  type ProjectSubscriptions,
  type SetAlertSubscriptionInput,
} from "@stubwise/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import { projectPermissionsFor, visibleProjectIds } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";

/**
 * LE ISCRIZIONI AGLI AVVISI di chi chiede (area 8, F2, S5). Lo stato di
 * ADESSO (`alert_subscriptions`, upsert); senza riga, il default del catalogo
 * dai permessi di adesso — la stessa regola dei destinatari
 * (`catalogRecipients`), così le Preferenze dicono quello che arriva. Il
 * Telefono senza riga vuole anche l'interruttore `push` di oggi (46). Un
 * progetto che non si vede è 404, come uno che non esiste.
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;

export class AlertSubscriptionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Il tipo che dà il VALORE a una riga: il primo partner vivo (per la riga dei server, `monitor.alert`). */
function valueTypeOf(rowType: string): AlertType | undefined {
  return rowPartners(rowType).find((t) => isLiveAlertType(t.type)) ?? alertTypeOf(rowType);
}

interface Scope {
  holds: (perm: string) => boolean;
  fullAdmin: boolean;
  push: boolean;
}

function rowOf(rowType: string, scope: Scope, saved: ReadonlyMap<string, { app: boolean; phone: boolean }>): AlertSubscriptionRow | null {
  const main = alertTypeOf(rowType);
  const type = valueTypeOf(rowType);
  if (!main || !type) return null;
  const base = { type: rowType, group: main.group, labelKey: main.labelKey, mandatory: [...type.mandatory] };
  if (type.mandatoryOnly) return { ...base, app: false, phone: false, state: "mandatory", suspendedReason: null };
  const perm = type.subscribe.perm;
  const sub = saved.get(type.type);
  const defaultOn = defaultApplies(type.appDefaultOn ?? type.defaultOn, scope.holds) || (type.defaultForFullAdmins === true && scope.fullAdmin);
  const app = sub ? sub.app : defaultOn;
  const phone = sub ? sub.phone : app && type.defaultPhone && scope.push;
  if (perm !== "member" && !scope.holds(perm)) return { ...base, app, phone, state: "suspended", suspendedReason: perm };
  return { ...base, app, phone, state: app ? "on" : "off", suspendedReason: null };
}

async function scopeOf(db: Db, viewer: Viewer, projectId: string): Promise<Scope> {
  const perms = await projectPermissionsFor(db, viewer, projectId);
  if (!perms) throw new AlertSubscriptionError(404, "not_found", "Not found");
  const [me] = await db.select({ push: users.notifyPush }).from(users).where(eq(users.id, viewer.id));
  return {
    holds: (perm) => perms.has(perm as never),
    fullAdmin: viewer.instancePermissions.has("instance.full_admin"),
    push: me?.push === true,
  };
}

async function savedOf(db: Db, userId: string, projectId: string): Promise<Map<string, { app: boolean; phone: boolean }>> {
  const rows = await db
    .select({ type: alertSubscriptions.alertType, app: alertSubscriptions.app, phone: alertSubscriptions.phone })
    .from(alertSubscriptions)
    .where(and(eq(alertSubscriptions.userId, userId), eq(alertSubscriptions.projectId, projectId)));
  return new Map(rows.map((r) => [r.type, { app: r.app, phone: r.phone }]));
}

async function rowsOf(db: Db, viewer: Viewer, projectId: string): Promise<AlertSubscriptionRow[]> {
  const scope = await scopeOf(db, viewer, projectId);
  const saved = await savedOf(db, viewer.id, projectId);
  return liveRowTypes().flatMap((t) => {
    const row = rowOf(t, scope, saved);
    return row ? [row] : [];
  });
}

export async function listAlertSubscriptions(db: Db, viewer: Viewer): Promise<ProjectSubscriptions[]> {
  const ids = await visibleProjectIds(db, viewer);
  if (ids !== "all" && ids.length === 0) return [];
  const list = await db
    .select({ id: projects.id, code: projects.code, name: projects.name })
    .from(projects)
    .where(ids === "all" ? undefined : inArray(projects.id, [...ids]))
    .orderBy(asc(projects.name));
  const out: ProjectSubscriptions[] = [];
  for (const p of list) out.push({ projectId: p.id, projectCode: p.code, projectName: p.name, rows: await rowsOf(db, viewer, p.id) });
  return out;
}

/** Scrive l'iscrizione di una riga, per TUTTI i suoi partner (`sameRowAs`), coi valori uniti alla patch. */
async function write(db: Db, userId: string, projectId: string, rowType: string, values: { app: boolean; phone: boolean }): Promise<void> {
  const now = new Date();
  for (const t of rowPartners(rowType)) {
    await db
      .insert(alertSubscriptions)
      .values({ userId, projectId, alertType: t.type, app: values.app, phone: values.phone, updatedAt: now })
      .onConflictDoUpdate({
        target: [alertSubscriptions.userId, alertSubscriptions.projectId, alertSubscriptions.alertType],
        set: { app: values.app, phone: values.phone, updatedAt: now },
      });
  }
}

const writable = (row: AlertSubscriptionRow) => row.state === "on" || row.state === "off";

export async function setAlertSubscription(
  db: Db,
  viewer: Viewer,
  input: { projectId: string; type: string; patch: SetAlertSubscriptionInput },
): Promise<AlertSubscriptionRow> {
  const rows = await rowsOf(db, viewer, input.projectId);
  const row = rows.find((r) => r.type === input.type);
  if (!row) throw new AlertSubscriptionError(404, "alert_type_not_found", "No such alert type");
  if (!writable(row)) throw new AlertSubscriptionError(403, row.state === "mandatory" ? "alert_mandatory_only" : "alert_suspended", "This alert can't be changed");
  await write(db, viewer.id, input.projectId, row.type, { app: input.patch.app ?? row.app, phone: input.patch.phone ?? row.phone });
  return (await rowsOf(db, viewer, input.projectId)).find((r) => r.type === input.type)!;
}

/** «Copia da»: le righe scrivibili di `projectId` prendono i valori di `fromProjectId`. Risponde con le righe di PRIMA. */
export async function copyAlertSubscriptions(db: Db, viewer: Viewer, input: { projectId: string; fromProjectId: string }): Promise<AlertSubscriptionRow[]> {
  const before = await rowsOf(db, viewer, input.projectId);
  const source = await rowsOf(db, viewer, input.fromProjectId);
  for (const row of before) {
    const from = source.find((r) => r.type === row.type);
    if (!from || !writable(row)) continue;
    await write(db, viewer.id, input.projectId, row.type, { app: from.app, phone: from.phone });
  }
  return before;
}

/** «Mute»: tutto spento nel progetto (le righe scrivibili). Risponde con le righe di PRIMA. */
export async function muteProjectAlerts(db: Db, viewer: Viewer, projectId: string): Promise<AlertSubscriptionRow[]> {
  const before = await rowsOf(db, viewer, projectId);
  for (const row of before) if (writable(row)) await write(db, viewer.id, projectId, row.type, { app: false, phone: false });
  return before;
}

/**
 * «Non avvisarmi più di questo» (area 8, F2, S6): dalla card di chi chiede,
 * spegne il suo TIPO (e la sua riga) nel progetto della card. La card deve
 * essere sua e ancora visibile (404 altrimenti, come una che non esiste); un
 * kind fuori dal catalogo vivo o senza progetto è 422; una card arrivata da
 * OBBLIGATORIO (`alertMandatory`) è 403 — spegnere l'iscrizione non la
 * fermerebbe. Risponde con la riga di prima (l'«Annulla») e quella nuova.
 */
export async function muteFromNotification(
  db: Db,
  viewer: Viewer,
  notificationId: string,
): Promise<{ before: AlertSubscriptionRow; row: AlertSubscriptionRow; projectId: string }> {
  const [card] = await db
    .select({ kind: notifications.kind, projectId: notifications.projectId, event: notifications.event })
    .from(notifications)
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, viewer.id), notificationVisibleToRecipient()));
  if (!card) throw new AlertSubscriptionError(404, "not_found", "Not found");
  if (!isLiveAlertType(card.kind) || card.projectId === null) {
    throw new AlertSubscriptionError(422, "not_a_catalog_alert", "This notification can't be muted by type");
  }
  if (typeof (card.event as { alertMandatory?: unknown }).alertMandatory === "string") {
    throw new AlertSubscriptionError(403, "alert_mandatory", "This notification reaches you anyway");
  }
  const type = rowTypeOf(card.kind);
  const before = (await rowsOf(db, viewer, card.projectId)).find((r) => r.type === type);
  if (!before) throw new AlertSubscriptionError(422, "not_a_catalog_alert", "This notification can't be muted by type");
  const row = await setAlertSubscription(db, viewer, { projectId: card.projectId, type, patch: { app: false, phone: false } });
  return { before, row, projectId: card.projectId };
}
