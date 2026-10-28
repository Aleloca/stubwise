import { now, state, visibleProjectIds } from "../store";
import type { AutomationRun, ClientProjectLink, DataField } from "../types";
import { forbidden, invalid, notFound, writer } from "../writer";
import { publishedVersion, startRun } from "./runner";
import { dueSchedules } from "./sources";
import { canManageAutomation, canManageIntegrations, canSeeRun } from "./visibility";

// Le scritture delle sorgenti (eventi mandati a mano, ricorrenze, collegare
// e scollegare) e della tabella cliente → progetto. Regole comuni in
// `writes.ts`.

/**
 * I dati di un evento mandato a mano («Edit and send» di un webhook):
 * un oggetto, coi campi dichiarati del tipo giusto. `invalid: event_types`
 * se un numero non è un numero (shape sources: «Received with errors» e non
 * parte nulla).
 */
const PAYLOAD_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAYLOAD_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Un valore è del tipo del campo? Numeri, sì/no, date, email, elenchi (coi loro campi). */
function fitsType(f: DataField, v: unknown): boolean {
  switch (f.type) {
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "boolean":
      return typeof v === "boolean";
    case "date":
      return typeof v === "string" && PAYLOAD_DATE.test(v) && !Number.isNaN(Date.parse(v));
    case "email":
      return typeof v === "string" && PAYLOAD_EMAIL.test(v);
    case "list":
      return (
        Array.isArray(v) &&
        (!f.of ||
          v.every((item) => !!item && typeof item === "object" && fieldsFit(f.of!, item as object)))
      );
    default:
      return true;
  }
}

/** I campi presenti in un oggetto hanno il loro tipo (gli assenti non si controllano). */
function fieldsFit(fields: DataField[], obj: object): boolean {
  return fields.every((f) => {
    const v = f.key
      .split(".")
      .reduce<unknown>(
        (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
        obj,
      );
    return v === undefined || v === null || fitsType(f, v);
  });
}

function checkPayload(source: { fields: DataField[] }, payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw invalid("event");
  if (!fieldsFit(source.fields, payload)) throw invalid("event_types");
  return payload as Record<string, unknown>;
}

/**
 * «Simula un evento» di una sorgente (solo prototipo): l'evento d'esempio
 * n. `sampleIndex` arriva e fa partire ogni automazione attiva con
 * quell'inizio. Lo fa chi gestisce le integrazioni o un'automazione con
 * quell'inizio; la sorgente deve essere collegata. Restituisce le
 * esecuzioni nate che chi agisce vede.
 */
export async function simulateSourceEvent(
  sourceId: string,
  sample: number | { payload: unknown },
): Promise<string[]> {
  const me = await writer("automations.simulateSourceEvent");
  const source = state.automationSources.find((s) => s.id === sourceId);
  const listeners = state.automations.filter((a) => {
    const t = publishedVersion(a)?.flow.trigger;
    return t?.kind === "source" && t.sourceId === sourceId;
  });
  if (!source) throw notFound();
  if (!canManageIntegrations(me) && !listeners.some((a) => canManageAutomation(me, a)))
    throw forbidden();
  if (source.status !== "connected") throw invalid("source_not_connected");
  const event =
    typeof sample === "number" ? source.sampleEvents[sample] : checkPayload(source, sample.payload);
  if (!event) throw invalid("sample");
  const started = listeners
    .filter((a) => a.status === "active")
    .map((a) => startRun(a, event, { origin: "source" }))
    .filter((r): r is AutomationRun => r !== null);
  return started.filter((r) => canSeeRun(me, r)).map((r) => r.id);
}

/** Le date e le ricorrenze che cadono adesso: partono le automazioni non ancora partite oggi. */
export async function runDueSchedules(): Promise<string[]> {
  const me = await writer("automations.runDueSchedules");
  const at = now();
  return dueSchedules(at)
    .map((a) => startRun(a, { avvio: { data: at.slice(0, 10) } }, { origin: "schedule" }))
    .filter((r): r is AutomationRun => r !== null)
    .filter((r) => canSeeRun(me, r))
    .map((r) => r.id);
}

// --- sorgenti e tabella cliente → progetto -------------------------------------------

function managedSource(me: string, id: string) {
  if (!canManageIntegrations(me)) throw forbidden();
  const source = state.automationSources.find((s) => s.id === id);
  if (!source) throw notFound();
  return source;
}

/** Collega (o ricollega) una sorgente: `integrations.manage`. */
export async function connectSource(id: string): Promise<void> {
  const me = await writer("automations.connectSource");
  const source = managedSource(me, id);
  // Ricollegare (anche da un altro): ne diventa «chi l'ha collegata» (shape sources [A 5]).
  if (source.connectedAt) {
    source.reconnectedById = me;
    source.reconnectedAt = now();
  } else source.connectedAt = now();
  source.status = "connected";
  source.connectedById = me;
  source.expiredAt = null;
}

/** Scollega una sorgente: le automazioni che ne partono lo dicono negli errori di configurazione. */
export async function disconnectSource(id: string): Promise<void> {
  const me = await writer("automations.disconnectSource");
  managedSource(me, id).status = "disconnected";
}

/** Aggiunge o cambia una riga cliente → progetto (verso un progetto che chi agisce vede). */
export async function setClientLink(link: ClientProjectLink): Promise<void> {
  const me = await writer("automations.setClientLink");
  if (!canManageIntegrations(me)) throw forbidden();
  const clientKey = link.clientKey.trim().toLowerCase();
  if (!clientKey || !link.clientName.trim()) throw invalid("client");
  if (!state.projectsById.has(link.projectId) || !visibleProjectIds(me).has(link.projectId))
    throw notFound();
  putClientLink(me, { clientKey, clientName: link.clientName.trim(), projectId: link.projectId });
}

/** Scrive una riga cliente → progetto: una nuova porta chi e quando, una cambiata li conserva. */
export function putClientLink(me: string, row: ClientProjectLink): void {
  const i = state.clientProjectLinks.findIndex((l) => l.clientKey === row.clientKey);
  if (i >= 0) {
    const old = state.clientProjectLinks[i]!;
    state.clientProjectLinks[i] = { ...row, addedById: old.addedById, addedAt: old.addedAt };
  } else state.clientProjectLinks.push({ ...row, addedById: me, addedAt: now() });
}

export async function removeClientLink(clientKey: string): Promise<void> {
  const me = await writer("automations.removeClientLink");
  if (!canManageIntegrations(me)) throw forbidden();
  const before = state.clientProjectLinks.length;
  state.clientProjectLinks = state.clientProjectLinks.filter((l) => l.clientKey !== clientKey);
  if (state.clientProjectLinks.length === before) throw notFound();
}
