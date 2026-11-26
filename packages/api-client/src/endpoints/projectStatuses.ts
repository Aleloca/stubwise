import { projectStatusViewSchema } from "@stubwise/shared";
import type { ProjectStatusView, Reader, StatusFamily } from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { seg } from "../query.js";

export interface ProjectStatusesBody {
  /** L'elenco INTERO, nell'ordine; uno stato senza `id` è nuovo, uno assente si elimina. */
  statuses: { id?: string; name: string; family: StatusFamily }[];
  /** Stato eliminato → stato (che resta) dove vanno le sue task. */
  reassign?: Record<string, string>;
}

/** Stati e soglie «ferma» del progetto (integrazione area 2). */
export function createProjectStatusesEndpoints(request: ApiRequest) {
  return {
    list(projectId: string): Promise<Reader<ProjectStatusView>[]> {
      return request("GET", `/api/projects/${seg(projectId)}/statuses`, undefined, z.array(projectStatusViewSchema));
    },
    set(projectId: string, body: ProjectStatusesBody): Promise<Reader<ProjectStatusView>[]> {
      return request(
        "PUT",
        `/api/projects/${seg(projectId)}/statuses`,
        { reassign: {}, ...body },
        z.array(projectStatusViewSchema),
      );
    },
    setStallThresholds(projectId: string, body: { activeDays: number; todoDays: number }) {
      return request(
        "PUT",
        `/api/projects/${seg(projectId)}/stall-thresholds`,
        body,
        z.object({ activeDays: z.number().int(), todoDays: z.number().int() }),
      );
    },
  };
}
