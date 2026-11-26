import { decisionRequestViewSchema } from "@stubwise/shared";
import type { DecisionRequestView, Reader } from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

export interface DecisionFilters {
  taskId?: string;
  /** `"me"` = chi chiama. */
  askedOfId?: string | "me";
  open?: boolean;
}

/** Richieste di decisione sulle task (integrazione area 2): elenco, risposta, ritiro. */
export function createDecisionsEndpoints(request: ApiRequest) {
  return {
    list(filters: DecisionFilters = {}): Promise<Reader<DecisionRequestView>[]> {
      const query = toQuery({
        taskId: filters.taskId,
        askedOfId: filters.askedOfId,
        open: filters.open === undefined ? undefined : String(filters.open),
      });
      return request("GET", `/api/decisions${query}`, undefined, z.array(decisionRequestViewSchema));
    },
    answer(id: string, body: { optionIndex: number } | { text: string }): Promise<Reader<DecisionRequestView>> {
      return request("POST", `/api/decisions/${seg(id)}/answer`, body, decisionRequestViewSchema);
    },
    withdraw(id: string): Promise<Reader<DecisionRequestView>> {
      return request("POST", `/api/decisions/${seg(id)}/withdraw`, {}, decisionRequestViewSchema);
    },
  };
}
