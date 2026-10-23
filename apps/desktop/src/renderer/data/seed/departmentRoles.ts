import type { DepartmentRole } from "../types";

/** Ruoli di reparto (la loro gestione è dell'area 9). */
export const DEPARTMENT_ROLES: DepartmentRole[] = [
  { personId: "p-giulia", departmentId: "dep-marketing", permissions: ["department.home.manage"] },
  { personId: "p-laura", departmentId: "dep-development", permissions: ["department.home.manage"] },
  { personId: "p-matteo", departmentId: "dep-sales", permissions: ["department.home.manage"] },
  { personId: "p-giorgio", departmentId: "dep-administration", permissions: [] },
];
