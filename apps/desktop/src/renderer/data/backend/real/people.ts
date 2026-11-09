import type { DepartmentView, PersonView } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { Department, Person } from "../../types";
import { appClient } from "./client";

// Persone e reparti della build app (integrazione area 2, fetta 1), da
// `GET /api/people` e `GET /api/departments`: le persone che condividono un
// progetto con chi guarda (tutte per un full admin), il nome già risolto dal
// server (`display_name` o la parte locale dell'email). Claude non è una
// persona del server in questa fetta: non si assegna.

export function toPerson(view: PersonView): Person {
  return {
    id: view.id,
    name: view.name,
    initials: view.initials,
    departmentIds: view.departmentIds,
    isClaude: false,
    presetRole: "",
    deactivated: view.deactivated,
  };
}

export function toDepartment(view: DepartmentView): Department {
  return { id: view.id, name: view.name, colorToken: view.colorToken as Department["colorToken"] };
}

export const listPeople: typeof Fake.listPeople = async () => {
  const rows = await appClient().people.list();
  return rows.map((row) => toPerson(row as PersonView));
};

export const listDepartments: typeof Fake.listDepartments = async () => {
  const rows = await appClient().departments.list();
  return rows.map((row) => toDepartment(row as DepartmentView));
};
