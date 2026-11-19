import { changeLogFiltersSchema, changeLogPageSchema } from "@stubwise/shared";
import type { ChangeLogFilters, ChangeLogPage, Reader } from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

/**
 * Area 9, F2: il registro delle modifiche. Il server filtra nella WHERE chi
 * legge cosa e toglie le persone invisibili; la frase, il link e il
 * prima/dopo li compone il client da `type` e `data`. 50 voci per pagina:
 * `nextCursor` (o null) per la pagina dopo.
 */
export interface ChangeLogQuery {
  /** Chi ha agito. */
  person?: string;
  type?: string;
  group?: string;
  /** ISO, estremi compresi. */
  from?: string;
  to?: string;
  withinDays?: number;
  cursor?: string;
  /** Area 9, F7: le sole voci scritte da Claude («By Claude»). Un server di prima lo ignora. */
  via?: "claude";
}

export function createChangeLogEndpoints(request: ApiRequest) {
  return {
    /** Il registro in Amministrazione; `project: "instance"` per le sole voci d'istanza. */
    list(query: ChangeLogQuery & { project?: string } = {}): Promise<Reader<ChangeLogPage>> {
      return request("GET", `/api/change-log${toQuery({ ...query })}`, undefined, changeLogPageSchema);
    },
    /** Il registro di un progetto (Settings → Change log): 404 se invisibile, 403 senza gestione. */
    listProject(projectId: string, query: ChangeLogQuery = {}): Promise<Reader<ChangeLogPage>> {
      return request("GET", `/api/projects/${seg(projectId)}/change-log${toQuery({ ...query })}`, undefined, changeLogPageSchema);
    },
    /** Le scelte dei filtri per chi guarda. */
    filters(projectId?: string): Promise<Reader<ChangeLogFilters>> {
      return request("GET", `/api/change-log/filters${toQuery({ project: projectId })}`, undefined, changeLogFiltersSchema);
    },
  };
}
