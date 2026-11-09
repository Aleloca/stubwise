import type { Milestone } from "../types";
import { AUTOMATION_MILESTONES } from "./automations/created";
import { daysFromToday } from "./dates";
import { PROJECTS } from "./projects";

// [codice progetto, nome, descrizione, giorni da oggi della scadenza (null = senza data), chiuso]
type Row = [string, string, string, number | null, boolean];

const REFERENCE: Row[] = [
  ["AUD", "Private beta", "The first customers use Audin 2.0 every day.", -9, true],
  ["AUD", "Public launch", "Pricing page, onboarding and billing are live.", 18, false],
  ["AUD", "Mobile app", "The companion app is on both stores.", null, false],
  ["STW", "Desktop prototype", "Tasks, planning and requests in the desktop app, with fake data.", 6, false],
  ["STW", "Planning", "Weekly planning across projects.", 27, false],
  ["STW", "Self-hosted 1.0", "Install guide and upgrade path for customers.", -20, true],
  ["MKX", "Spring campaign", "Brief, creatives and media plan approved.", 11, false],
  ["MKX", "Showroom event", "Invitations, landing page and follow-up.", 34, false],
];

const REFERENCE_CODES = new Set(REFERENCE.map(([code]) => code));

/**
 * Traguardi: 2–3 nei progetti di riferimento, uno in circa metà degli altri,
 * più quelli creati dalle automazioni del seme.
 */
export const MILESTONES: Milestone[] = [
  ...REFERENCE.map(([code, name, description, due, closed], i) => {
    const n = REFERENCE.slice(0, i).filter(([c]) => c === code).length + 1;
    return {
      id: `ms-${code.toLowerCase()}-${n}`,
      projectId: `prj-${code.toLowerCase()}`,
      name,
      description,
      dueDate: due === null ? null : daysFromToday(due),
      closed,
    };
  }),
  ...PROJECTS.filter((p, i) => !REFERENCE_CODES.has(p.code) && i % 2 === 0).map((p, i) => ({
    id: `ms-${p.code.toLowerCase()}-1`,
    projectId: p.id,
    name: i % 3 === 0 ? "Go live" : i % 3 === 1 ? "First delivery" : "Content ready",
    description: "",
    // Fra 1 e 6 settimane; uno ogni tanto già scaduto.
    dueDate: daysFromToday(i % 5 === 4 ? -3 : 7 + (i % 6) * 6),
    closed: false,
  })),
  // Creati dalle esecuzioni delle automazioni del seme (area 7).
  ...AUTOMATION_MILESTONES,
];
