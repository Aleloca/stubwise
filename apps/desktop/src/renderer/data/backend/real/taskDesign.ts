import { ApiError } from "@stubwise/api-client";
import type { TaskDesignPlan } from "../../taskDesign";
import { appClient } from "./client";

// Design e piano di una task nella build app (ritiro del web vecchio,
// inventario r.88; shape `design-plan-remove.md`, DP-Q2b). Si leggono dal
// dettaglio del ticket (`GET /api/tickets/:id`): sono grandi e restano fuori
// dagli elenchi. Con un design attivo il corpo del ticket È il design e
// l'originale sta in `originContent`; togliere il design lo rimette.

export interface TaskDesignApi {
  detail(taskId: string): Promise<{ body: string; originContent: string | null; implementationPlan: string | null }>;
  remove(taskId: string, field: "design" | "plan"): Promise<unknown>;
}

export function createRealTaskDesign(api: TaskDesignApi) {
  const getTaskDesignPlan = async (taskId: string): Promise<TaskDesignPlan> => {
    const d = await api.detail(taskId);
    const active = d.originContent !== null;
    return {
      design: active ? d.body : null,
      plan: d.implementationPlan?.trim() ? d.implementationPlan : null,
      original: active ? d.originContent : null,
    };
  };
  const remove = async (taskId: string, field: "design" | "plan"): Promise<void> => {
    try {
      await api.remove(taskId, field);
    } catch (error) {
      // Già tolto da un altro (M1: SOLO `no_active_design`; il DELETE del piano
      // non dà 404 se il piano non c'è): non è un errore, la pagina rilegge.
      if (error instanceof ApiError && error.code === "no_active_design") return;
      throw error;
    }
  };
  return {
    getTaskDesignPlan,
    removeTaskDesign: (taskId: string) => remove(taskId, "design"),
    removeTaskPlan: (taskId: string) => remove(taskId, "plan"),
  };
}

const live = createRealTaskDesign({
  detail: async (taskId) => {
    const t = (await appClient().tickets.get(taskId)) as { body: string; originContent: string | null; implementationPlan: string | null };
    return { body: t.body, originContent: t.originContent, implementationPlan: t.implementationPlan };
  },
  remove: (taskId, field) => appClient().request("DELETE", `/api/tickets/${encodeURIComponent(taskId)}/${field}`),
});

export const { getTaskDesignPlan, removeTaskDesign, removeTaskPlan } = live;
