import {
  projectDetailSchema,
  projectListItemSchema,
  projectPulseSummarySchema,
} from "@stubwise/shared";
import type { ProjectDetail, ProjectListItem, ProjectPulseSummary, Reader } from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { seg } from "../query.js";

const projectListSchema = z.array(projectListItemSchema);
const pulseSchema = z.array(projectPulseSummarySchema);

/**
 * Progetti visibili all'utente corrente.
 *
 * `pulse` (fase 4, mobile) è il "polso" per progetto — chi aspetta una
 * decisione, chi ha lavoro in corso, da quanto un progetto è fermo — nato dagli
 * stessi segnali del pulse proattivo (fase 2), letti qui sincronamente. Ordine
 * già deciso dal server (`GET /api/projects/pulse`): prima chi ha
 * `waitingForYou`, poi chi ha `running`, infine per `idleDays` decrescente.
 */
export function createProjectsEndpoints(request: ApiRequest) {
  return {
    list(): Promise<Reader<ProjectListItem>[]> {
      return request("GET", "/api/projects", undefined, projectListSchema);
    },

    get(projectId: string): Promise<Reader<ProjectDetail>> {
      return request("GET", `/api/projects/${seg(projectId)}`, undefined, projectDetailSchema);
    },

    pulse(): Promise<Reader<ProjectPulseSummary>[]> {
      return request("GET", "/api/projects/pulse", undefined, pulseSchema);
    },
  };
}
