import { departmentViewSchema } from "@stubwise/shared";
import type { DepartmentView, Reader } from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

/** Reparti (integrazione area 2): letti da tutti, gestiti con `departments.manage`. */
export function createDepartmentsEndpoints(request: ApiRequest) {
  return {
    list(): Promise<Reader<DepartmentView>[]> {
      return request("GET", "/api/departments", undefined, z.array(departmentViewSchema));
    },
    create(body: { name: string; colorToken: DepartmentView["colorToken"] }): Promise<Reader<DepartmentView>> {
      return request("POST", "/api/departments", body, departmentViewSchema);
    },
    /** `memberIds` sostituisce l'insieme intero delle persone del reparto. */
    update(
      id: string,
      patch: { name?: string; colorToken?: DepartmentView["colorToken"]; memberIds?: string[] },
    ): Promise<Reader<DepartmentView>> {
      return request("PATCH", `/api/departments/${seg(id)}`, patch, departmentViewSchema);
    },
    /** 204 senza corpo. Con task e senza `moveTasksTo` il server risponde 400 `department_has_tasks`. */
    remove(id: string, moveTasksTo?: string): Promise<void> {
      return request("DELETE", `/api/departments/${seg(id)}${toQuery({ moveTasksTo })}`);
    },
  };
}
