import { departmentHomeViewSchema, departmentPreviewSchema, departmentRoleViewSchema, departmentViewSchema } from "@stubwise/shared";
import type {
  DepartmentHomeView,
  DepartmentPermission,
  DepartmentPreview,
  DepartmentRoleView,
  DepartmentView,
  HomeBlock,
  Reader,
} from "@stubwise/shared";
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
    /**
     * `memberIds` sostituisce l'insieme intero delle persone del reparto;
     * `projectPermissions` (area 9, F8) l'insieme intero dei permessi di
     * progetto che dà. Chiede la riconferma (403 `reauth_required`) quando fa
     * arrivare permessi a qualcuno; i rifiuti: 403 `escalation` (`missing`),
     * 409 `last_manager` (`projectId`, `projectCode`), 400 `invalid_permission`,
     * 400 `not_a_person`. Un server di prima ignora `projectPermissions`.
     */
    update(
      id: string,
      patch: { name?: string; colorToken?: DepartmentView["colorToken"]; memberIds?: string[]; projectPermissions?: string[] },
    ): Promise<Reader<DepartmentView>> {
      return request("PATCH", `/api/departments/${seg(id)}`, patch, departmentViewSchema);
    },
    /**
     * Area 9, F8: l'anteprima di una BOZZA (persone e permessi di progetto non
     * ancora salvati), calcolata dal server con la regola della scrittura:
     * `reach`, `notGivable`, `missingToAdd`, `missing`. Per la forma salvata, la
     * bozza = il salvato. Un server di prima risponde 404.
     */
    preview(id: string, draft: { memberIds: string[]; projectPermissions: string[] }): Promise<Reader<DepartmentPreview>> {
      return request("POST", `/api/departments/${seg(id)}/preview`, draft, departmentPreviewSchema);
    },
    /** 204 senza corpo. Con task e senza `moveTasksTo` il server risponde 400 `department_has_tasks`. */
    remove(id: string, moveTasksTo?: string): Promise<void> {
      return request("DELETE", `/api/departments/${seg(id)}${toQuery({ moveTasksTo })}`);
    },
    /** La Home predefinita del reparto (fetta 3); `updatedAt` null se non ne ha una sua. */
    home(id: string): Promise<Reader<DepartmentHomeView>> {
      return request("GET", `/api/departments/${seg(id)}/home`, undefined, departmentHomeViewSchema);
    },
    /** Full admin o `department.home.manage` nel reparto; solo filtri pubblici. */
    setHome(id: string, blocks: HomeBlock[]): Promise<Reader<DepartmentHomeView>> {
      return request("PUT", `/api/departments/${seg(id)}/home`, { blocks }, departmentHomeViewSchema);
    },
    /** I ruoli di reparto di tutti: chi gestisce la Home di quale reparto. */
    roles(): Promise<Reader<DepartmentRoleView>[]> {
      return request("GET", "/api/departments/roles", undefined, z.array(departmentRoleViewSchema));
    },
    /** SOSTITUISCE i ruoli del reparto (`departments.manage`, senza riconferma). */
    setRoles(
      id: string,
      roles: { userId: string; permissions: DepartmentPermission[] }[],
    ): Promise<Reader<DepartmentRoleView>[]> {
      return request("PUT", `/api/departments/${seg(id)}/roles`, { roles }, z.array(departmentRoleViewSchema));
    },
  };
}
