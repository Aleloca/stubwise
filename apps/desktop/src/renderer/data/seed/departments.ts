import type { Department } from "../types";

/** Reparti: dati configurabili, nessun componente ne conosce i nomi. */
export const DEPARTMENTS: Department[] = [
  { id: "dep-marketing", name: "Marketing", colorToken: "--dept-1" },
  { id: "dep-sales", name: "Sales", colorToken: "--dept-2" },
  { id: "dep-support", name: "Support", colorToken: "--dept-3" },
  { id: "dep-development", name: "Development", colorToken: "--dept-4" },
  { id: "dep-administration", name: "Administration", colorToken: "--dept-5" },
];
