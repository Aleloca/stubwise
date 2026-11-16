import {
  widgetIdentitySecretResultSchema,
  widgetListSchema,
  widgetResultSchema,
  type Reader,
  type WidgetAdmin,
  type WidgetIdentitySecretResult,
  type WidgetUpsertInput,
} from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { seg } from "../query.js";

/**
 * I widget di Support di un progetto (area 8, F3), sopra
 * `/api/projects/:projectId/widgets`. L'elenco lo legge chi vede il progetto;
 * `canManage` (calcolato dal server) dice se chi guarda li gestisce.
 * ⚠️ `update` è una SOSTITUZIONE: il corpo va mandato intero, compreso
 * `repositoryFilters` (un corpo senza azzera i filtri salvati). L'unica
 * eccezione è `origins` (i siti ammessi, S16): assente = l'elenco resta com'è.
 */
export function createWidgetEndpoints(request: ApiRequest) {
  const base = (projectId: string) => `/api/projects/${seg(projectId)}/widgets`;
  return {
    list(projectId: string): Promise<Reader<{ widgets: WidgetAdmin[]; canManage: boolean }>> {
      return request("GET", base(projectId), undefined, widgetListSchema);
    },
    create(projectId: string, body: WidgetUpsertInput): Promise<Reader<{ widget: WidgetAdmin }>> {
      return request("POST", base(projectId), body, widgetResultSchema);
    },
    update(projectId: string, widgetId: string, body: WidgetUpsertInput): Promise<Reader<{ widget: WidgetAdmin }>> {
      return request("PUT", `${base(projectId)}/${seg(widgetId)}`, body, widgetResultSchema);
    },
    /**
     * Area 8, «L'API per i siti»: genera o RIGENERA il segreto d'identità,
     * mostrato QUESTA volta sola (il vecchio smette subito). Vuole
     * `widget.manage` e la riconferma recente: senza, 403 `reauth_required`.
     */
    regenerateIdentitySecret(projectId: string, widgetId: string): Promise<Reader<WidgetIdentitySecretResult>> {
      return request("POST", `${base(projectId)}/${seg(widgetId)}/identity-secret`, undefined, widgetIdentitySecretResultSchema);
    },
    /** Le sue conversazioni restano in Support. */
    delete(projectId: string, widgetId: string): Promise<void> {
      return request("DELETE", `${base(projectId)}/${seg(widgetId)}`);
    },
  };
}
