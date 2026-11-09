import {
  decisionRequestViewSchema,
  stalledTaskViewSchema,
  taskActivityEntryViewSchema,
  taskListResponseSchema,
  taskViewSchema,
  taskWorkViewSchema,
} from "@stubwise/shared";
import type {
  DecisionRequestView,
  NewTaskBody,
  Reader,
  StatusFamily,
  TaskActivityEntryView,
  TaskPatch,
  TaskSize,
  TaskViewData,
  TaskWorkView,
  TicketPriority,
  UiTaskType,
} from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

/**
 * I filtri dell'elenco delle task: `FilterCriteria` del prototipo
 * (`apps/desktop/src/renderer/data/model.ts`). Sul filo gli array diventano
 * stringhe separate da virgola e il periodo si appiattisce in `periodField` +
 * (`periodPreset` | `periodFrom`/`periodTo`): è `taskListQuerySchema`.
 */
export interface TaskListFilters {
  projectIds?: string[];
  departmentIds?: string[];
  assigneeIds?: (string | "none")[];
  families?: StatusFamily[];
  statusIds?: string[];
  sizes?: (TaskSize | "none")[];
  milestoneIds?: string[];
  types?: UiTaskType[];
  priorities?: TicketPriority[];
  stalled?: boolean;
  text?: string;
  period?: { field: "created" | "closed" | "plannedWeek" | "due" } & (
    | { kind: "relative"; preset: "last7" | "last30" | "thisWeek" | "nextWeek" | "thisMonth" | "lastMonth" }
    | { kind: "absolute"; from: string; to: string }
  );
}

export type TaskBulkPatch = Pick<TaskPatch, "statusId" | "assigneeId" | "milestoneId" | "size" | "departmentId">;

/** `?families=todo,active&…`: la forma che `taskListQuerySchema` si aspetta. */
export function taskListQuery(f: TaskListFilters = {}): string {
  const csv = (values?: readonly string[]) => (values && values.length > 0 ? values.join(",") : undefined);
  return toQuery({
    projectIds: csv(f.projectIds),
    departmentIds: csv(f.departmentIds),
    assigneeIds: csv(f.assigneeIds),
    families: csv(f.families),
    statusIds: csv(f.statusIds),
    sizes: csv(f.sizes),
    milestoneIds: csv(f.milestoneIds),
    types: csv(f.types),
    priorities: csv(f.priorities),
    stalled: f.stalled === undefined ? undefined : String(f.stalled),
    text: f.text,
    periodField: f.period?.field,
    periodPreset: f.period?.kind === "relative" ? f.period.preset : undefined,
    periodFrom: f.period?.kind === "absolute" ? f.period.from : undefined,
    periodTo: f.period?.kind === "absolute" ? f.period.to : undefined,
  });
}

/**
 * `/api/tasks` (integrazione area 2): le task nella forma del prototipo. Le
 * regole derivate (ferme, stato di Claude, tipi mostrati, taglie) le calcola
 * il server; qui si leggono.
 */
export function createTasksEndpoints(request: ApiRequest) {
  return {
    list(filters?: TaskListFilters): Promise<Reader<{ items: TaskViewData[]; truncated: boolean }>> {
      return request("GET", `/api/tasks${taskListQuery(filters)}`, undefined, taskListResponseSchema);
    },
    byCode(code: string): Promise<Reader<TaskViewData>> {
      return request("GET", `/api/tasks/by-code/${seg(code)}`, undefined, taskViewSchema);
    },
    stalled(filters?: TaskListFilters) {
      return request("GET", `/api/tasks/stalled${taskListQuery(filters)}`, undefined, z.array(stalledTaskViewSchema));
    },
    activity(ticketId: string): Promise<Reader<TaskActivityEntryView>[]> {
      return request("GET", `/api/tasks/${seg(ticketId)}/activity`, undefined, z.array(taskActivityEntryViewSchema));
    },
    work(ticketId: string): Promise<Reader<TaskWorkView>> {
      return request("GET", `/api/tasks/${seg(ticketId)}/work`, undefined, taskWorkViewSchema);
    },
    create(body: NewTaskBody): Promise<Reader<TaskViewData>> {
      return request("POST", "/api/tasks", body, taskViewSchema);
    },
    update(ticketId: string, patch: TaskPatch): Promise<Reader<TaskViewData>> {
      return request("PATCH", `/api/tasks/${seg(ticketId)}`, patch, taskViewSchema);
    },
    bulkUpdate(ids: string[], patch: TaskBulkPatch): Promise<Reader<TaskViewData>[]> {
      return request("PATCH", "/api/tasks/bulk", { ids, patch }, z.array(taskViewSchema));
    },
    setManualStall(ticketId: string, body: { reason: string; note?: string }): Promise<Reader<TaskViewData>> {
      return request("PUT", `/api/tasks/${seg(ticketId)}/manual-stall`, body, taskViewSchema);
    },
    clearManualStall(ticketId: string): Promise<Reader<TaskViewData>> {
      return request("DELETE", `/api/tasks/${seg(ticketId)}/manual-stall`, undefined, taskViewSchema);
    },
    /** 204 senza corpo: nessuno schema da validare. */
    follow(ticketId: string): Promise<void> {
      return request("PUT", `/api/tasks/${seg(ticketId)}/follow`);
    },
    unfollow(ticketId: string): Promise<void> {
      return request("DELETE", `/api/tasks/${seg(ticketId)}/follow`);
    },
    askDecision(
      ticketId: string,
      body: { askedOfId: string; question: string; options?: string[] },
    ): Promise<Reader<DecisionRequestView>> {
      return request("POST", `/api/tasks/${seg(ticketId)}/decisions`, body, decisionRequestViewSchema);
    },
  };
}
