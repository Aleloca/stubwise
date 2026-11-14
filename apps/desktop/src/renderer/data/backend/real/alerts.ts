import { ApiError } from "@stubwise/api-client";
import type {
  AlertSubscriptionRow as ServerRow,
  ProjectSubscriptions as ServerProjectSubscriptions,
  Reader,
  SetAlertSubscriptionInput,
} from "@stubwise/shared";
import type * as Fake from "../../api";
import type { ProjectSubscriptions, SubscriptionRow, Undoable } from "../../alerts";
import { rowTypeOf, type AlertGroup } from "../../../domain/alerts/catalog";
import type { MandatoryReason } from "../../model";
import type { Permission } from "../../viewing";
import { asPrototypeError } from "./automationRefs";
import { appClient } from "./client";

// Le iscrizioni agli avvisi della build app (area 8, F2, R2) sopra le rotte
// vere (`/api/me/alert-subscriptions`, S5), con le firme del prototipo
// (`data/alerts/reads.ts`, `writes.ts`). Righe e stati li calcola il server
// (il client legge, non deduce), compreso il Telefono di partenza senza una
// riga scritta (`defaultPhone` e l'interruttore `push` di oggi). Copia e
// «Mute» rispondono con le righe di PRIMA: l'«Annulla» le riscrive con `set`.

/** Una riga come la legge il client: un enum aperto (`__unknown__` da un server più nuovo). */
type AlertSubscriptionRow = Reader<ServerRow>;

/** Le rotte (sul client vero: `client.alerts` e `client.me.follows`, S8). */
export interface AlertsApi {
  list(): Promise<Reader<{ items: ServerProjectSubscriptions[] }>>;
  /** I progetti seguiti: i «fissati» del prototipo, nell'ordine del server. */
  follows(): Promise<{ projectIds: string[] }>;
  set(
    projectId: string,
    type: string,
    patch: SetAlertSubscriptionInput,
  ): Promise<AlertSubscriptionRow>;
  copy(projectId: string, fromProjectId: string): Promise<{ before: AlertSubscriptionRow[] }>;
  mute(projectId: string): Promise<{ before: AlertSubscriptionRow[] }>;
}

/**
 * Una riga per le Preferenze, o `null` se il suo stato è sconosciuto (un
 * server più nuovo): non si mostra ciò che l'app non sa dire né se si possa
 * scrivere.
 */
function rowOf(r: AlertSubscriptionRow): SubscriptionRow | null {
  if (r.state === "__unknown__") return null;
  return {
    type: r.type,
    group: r.group as AlertGroup,
    labelKey: r.labelKey,
    app: r.app,
    phone: r.phone,
    state: r.state,
    mandatory: r.mandatory as MandatoryReason[],
    ...(r.suspendedReason ? { suspendedReason: r.suspendedReason as Permission } : {}),
  };
}

/** Gli errori nelle parole del prototipo; un tipo sconosciuto è `invalid: type`, come lì. */
function words(error: unknown): unknown {
  if (error instanceof ApiError && error.code === "alert_type_not_found")
    return new Error("invalid: type");
  return asPrototypeError(error);
}

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw words(error);
  }
}

export function createRealAlerts(api: AlertsApi) {
  /** Rimette le righe di prima: solo quelle che si possono scrivere (le altre il server le rifiuta). */
  const undoOf = (projectId: string, before: AlertSubscriptionRow[]): Undoable => ({
    async undo() {
      const writable = before.filter((r) => r.state === "on" || r.state === "off");
      await call(() =>
        Promise.all(
          writable.map((r) => api.set(projectId, r.type, { app: r.app, phone: r.phone })),
        ),
      );
    },
  });

  return {
    async subscriptionRows(): Promise<ProjectSubscriptions[]> {
      const [{ items }, { projectIds }] = await call(() =>
        Promise.all([api.list(), api.follows()]),
      );
      const pinned = projectIds.filter((id) => items.some((p) => p.projectId === id));
      const byId = new Map(items.map((p) => [p.projectId, p]));
      const others = items
        .filter((p) => !pinned.includes(p.projectId))
        .sort((a, b) => a.projectName.localeCompare(b.projectName));
      return [...pinned.map((id) => byId.get(id)!), ...others].map((p) => ({
        projectId: p.projectId,
        code: p.projectCode,
        name: p.projectName,
        pinned: pinned.includes(p.projectId),
        rows: p.rows.flatMap((r) => rowOf(r) ?? []),
      }));
    },

    /** Una patch della riga: un kind di prima scrive la riga in cui confluisce (e i suoi partner). */
    async setSubscription(
      projectId: string,
      type: string,
      change: { app?: boolean; phone?: boolean },
    ): Promise<void> {
      await call(() => api.set(projectId, rowTypeOf(type), change));
    },

    async copySubscriptions(fromProjectId: string, toProjectId: string): Promise<Undoable> {
      const { before } = await call(() => api.copy(toProjectId, fromProjectId));
      return undoOf(toProjectId, before);
    },

    async muteProject(projectId: string): Promise<Undoable> {
      const { before } = await call(() => api.mute(projectId));
      return undoOf(projectId, before);
    },
  } satisfies Partial<typeof Fake.alerts>;
}

/** Sul client vero (il client si legge a ogni chiamata). */
export const liveAlerts: Partial<typeof Fake.alerts> = createRealAlerts({
  list: () => appClient().alerts.list(),
  follows: () => appClient().me.follows(),
  set: (projectId, type, patch) => appClient().alerts.set(projectId, type, patch),
  copy: (projectId, fromProjectId) => appClient().alerts.copy(projectId, fromProjectId),
  mute: (projectId) => appClient().alerts.mute(projectId),
});
