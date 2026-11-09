import { milestoneSchema, milestoneWithCountsSchema } from "@stubwise/shared";
import type { Milestone, MilestoneDraft, MilestonePatch, MilestoneWithCounts, Reader } from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { seg } from "../query.js";

/**
 * I traguardi (milestone) di un progetto, sulle rotte esistenti
 * `/api/milestones` (integrazione area 2, fetta 4). L'elenco di un progetto è
 * `projects.milestones(projectId)`. Il permesso delle scritture è
 * `tickets.edit` nel progetto, lo stesso del prototipo. Il «chiuso» del
 * prototipo è `status: "closed"` (e `closedAt` lo scrive il server).
 */
export function createMilestonesEndpoints(request: ApiRequest) {
  return {
    get(id: string): Promise<Reader<MilestoneWithCounts>> {
      return request("GET", `/api/milestones/${seg(id)}`, undefined, milestoneWithCountsSchema);
    },
    create(body: MilestoneDraft): Promise<Reader<Milestone>> {
      return request("POST", "/api/milestones", body, milestoneSchema);
    },
    /** Una patch: gli assenti restano invariati; `status` chiude e riapre. */
    update(id: string, patch: MilestonePatch): Promise<Reader<MilestoneWithCounts>> {
      return request("PATCH", `/api/milestones/${seg(id)}`, patch, milestoneWithCountsSchema);
    },
    /** 204; le task del traguardo restano, senza traguardo. */
    remove(id: string): Promise<void> {
      return request("DELETE", `/api/milestones/${seg(id)}`);
    },
  };
}
