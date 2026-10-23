import { DEPARTMENTS } from "./seed/departments";
import { NOTIFICATIONS } from "./seed/notifications";
import { PEOPLE } from "./seed/people";
import { GIULIA_PINNED_CODES, PROJECTS } from "./seed/projects";
import { TASKS } from "./seed/tasks";
import type { AppNotification, Department, Person, Project, SearchResult, Task } from "./types";

export type { SearchResult } from "./types";

// --- controllo del simulatore ---------------------------------------------

let latencyOverride: number | null = null;
let callCounter = 0;
export type ApiFnName =
  | "listDepartments"
  | "listPeople"
  | "listProjects"
  | "getProjectByCode"
  | "listPinnedProjectIds"
  | "setPinned"
  | "listTasks"
  | "listNotifications"
  | "markNotification"
  | "search";
const failures = new Set<ApiFnName>();

/** Fissa la latenza simulata (ms); `0` per i test, `null` per tornare a 150–400 ms. */
export function setLatency(ms: number | null): void {
  latencyOverride = ms;
}

/** La prossima chiamata a `fnName` (e solo quella) viene rifiutata. */
export function failNext(fnName: ApiFnName): void {
  failures.add(fnName);
}

/** Ripristina lo stato (fissati, notifiche, errori iniettati). */
export function resetApi(): void {
  failures.clear();
  callCounter = 0;
  pinned = initialPinned();
  notifications = NOTIFICATIONS.map((n) => ({ ...n }));
}

async function gate(fnName: ApiFnName): Promise<void> {
  // Latenza deterministica (150–400 ms) che varia da una chiamata all'altra.
  const ms = latencyOverride ?? 150 + ((callCounter++ * 97) % 251);
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  if (failures.delete(fnName)) throw new Error(`Simulated failure: ${fnName}`);
}

// --- stato ------------------------------------------------------------------

function initialPinned(): string[] {
  return GIULIA_PINNED_CODES.map((c) => PROJECTS.find((p) => p.code === c)!.id);
}

let pinned = initialPinned();
let notifications: AppNotification[] = NOTIFICATIONS.map((n) => ({ ...n }));

// --- letture ----------------------------------------------------------------

export async function listDepartments(): Promise<Department[]> {
  await gate("listDepartments");
  return DEPARTMENTS.map((d) => ({ ...d }));
}

export async function listPeople(): Promise<Person[]> {
  await gate("listPeople");
  return PEOPLE.map((p) => ({ ...p }));
}

export async function listProjects(): Promise<Project[]> {
  await gate("listProjects");
  return PROJECTS.map((p) => ({ ...p }));
}

export async function getProjectByCode(code: string): Promise<Project | null> {
  await gate("getProjectByCode");
  const project = PROJECTS.find((p) => p.code === code.toUpperCase());
  return project ? { ...project } : null;
}

export async function listPinnedProjectIds(): Promise<string[]> {
  await gate("listPinnedProjectIds");
  return [...pinned];
}

export async function setPinned(projectId: string, isPinned: boolean): Promise<void> {
  await gate("setPinned");
  if (isPinned) {
    if (!pinned.includes(projectId)) pinned.push(projectId);
  } else {
    pinned = pinned.filter((id) => id !== projectId);
  }
}

export async function listTasks(filter?: {
  projectId?: string;
  assigneeId?: string;
}): Promise<Task[]> {
  await gate("listTasks");
  return TASKS.filter(
    (t) =>
      (!filter?.projectId || t.projectId === filter.projectId) &&
      (!filter?.assigneeId || t.assigneeId === filter.assigneeId),
  ).map((t) => ({ ...t }));
}

export async function listNotifications(): Promise<AppNotification[]> {
  await gate("listNotifications");
  return notifications.map((n) => ({ ...n }));
}

export async function markNotification(
  id: string,
  change: { read?: boolean; archived?: boolean; snoozedUntil?: string | null },
): Promise<void> {
  await gate("markNotification");
  notifications = notifications.map((n) => (n.id === id ? { ...n, ...change } : n));
}

export async function search(q: string): Promise<SearchResult[]> {
  await gate("search");
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const has = (...fields: (string | undefined)[]) =>
    fields.some((f) => f?.toLowerCase().includes(needle));
  const projectsById = new Map(PROJECTS.map((p) => [p.id, p]));
  const results: SearchResult[] = [];
  for (const p of PROJECTS) {
    if (has(p.code, p.name, p.clientName)) {
      results.push({
        kind: "project",
        id: p.id,
        code: p.code,
        label: p.name,
        route: `#/p/${p.code}`,
      });
    }
  }
  for (const t of TASKS) {
    if (has(t.code, t.title)) {
      const code = projectsById.get(t.projectId)!.code;
      results.push({
        kind: "task",
        id: t.id,
        code: t.code,
        label: t.title,
        route: `#/p/${code}/tasks`,
      });
    }
  }
  for (const p of PEOPLE) {
    if (!p.isClaude && has(p.name)) {
      results.push({ kind: "person", id: p.id, label: p.name, route: "#/chat" });
    }
  }
  return results;
}
