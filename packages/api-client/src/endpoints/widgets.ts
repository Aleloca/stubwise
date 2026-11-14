import {
  widgetListSchema,
  widgetResultSchema,
  type Reader,
  type WidgetAdmin,
  type WidgetUpsertInput,
} from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { seg } from "../query.js";

/**
 * I widget di Support di un progetto (area 8, F3), sopra
 * `/api/projects/:projectId/widgets`. L'elenco lo legge chi vede il progetto;
 * `canManage` (calcolato dal server) dice se chi guarda li gestisce.
 * ⚠️ `update` è una SOSTITUZIONE: il corpo va mandato intero, compreso
 * `repositoryFilters` (un corpo senza azzera i filtri salvati).
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
    /** Le sue conversazioni restano in Support. */
    delete(projectId: string, widgetId: string): Promise<void> {
      return request("DELETE", `${base(projectId)}/${seg(widgetId)}`);
    },
  };
}
