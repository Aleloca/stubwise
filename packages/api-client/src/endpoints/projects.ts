import { projectDetailSchema, projectListItemSchema } from "@stubwise/shared";
import type { ProjectDetail, ProjectListItem } from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { seg } from "../query.js";

const projectListSchema = z.array(projectListItemSchema);

/**
 * Progetti visibili all'utente corrente.
 *
 * NOTA: `GET /api/projects/pulse` (il "polso" per progetto che l'app mostra in
 * lista) NON è qui: la rotta arriva con la fase B del programma.
 */
export function createProjectsEndpoints(request: ApiRequest) {
  return {
    list(): Promise<ProjectListItem[]> {
      return request("GET", "/api/projects", undefined, projectListSchema);
    },

    get(projectId: string): Promise<ProjectDetail> {
      return request("GET", `/api/projects/${seg(projectId)}`, undefined, projectDetailSchema);
    },
  };
}
