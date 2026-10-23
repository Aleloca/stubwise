import type {
  InstancePermission,
  ProjectPermission,
  TicketStatus as SharedTicketStatus,
} from "@stubwise/shared";

export interface Department {
  id: string;
  name: string;
  colorToken: `--dept-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
}

export interface Person {
  id: string;
  name: string;
  initials: string;
  departmentIds: string[];
  isClaude: boolean;
  /** Chiave di un `PRESET_ROLES` di `@stubwise/shared` (ruolo tipico della persona). */
  presetRole: string;
}

export type ProjectModule = "docs" | "releases" | "support" | "servers";
export type ProjectTemplate = "software" | "marketing" | "client" | "empty";

export interface Project {
  id: string;
  /** 2–4 maiuscole, univoco. */
  code: string;
  name: string;
  kind: "internal" | "client";
  clientName?: string;
  template: ProjectTemplate;
  modules: ProjectModule[];
  memberIds: string[];
  signals: { waitingOnViewer: boolean; claudeWorking: boolean };
}

/** Gli stessi valori di `ticketStatusSchema`. */
export type TaskStatus = SharedTicketStatus;

export interface Task {
  id: string;
  /** `${project.code}-${n}` */
  code: string;
  projectId: string;
  title: string;
  departmentId: string;
  assigneeId: string | null;
  status: TaskStatus;
  /** ISO (YYYY-MM-DD). */
  dueDate: string | null;
  /** Settimana ISO, es. "2026-W43". */
  plannedWeek: string | null;
}

export interface AppNotification {
  id: string;
  /** Valori di `notificationKindSchema`. */
  kind: string;
  projectId: string | null;
  /**
   * Codice dell'oggetto della notifica, che apre la riga: una task
   * (`MKX-2`), un progetto (`LMR`) o un evento (`MAIL-1`, `SEC-1`…; vedi
   * `EVENT_PREFIXES` nel seed).
   */
  objectCode: string;
  /** Reparto della task, se l'oggetto è una task; altrimenti `null`. */
  departmentId: string | null;
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
  archived: boolean;
  snoozedUntil: string | null;
  /** Route hash. */
  link: string;
}

export interface Viewer {
  personId: string;
  instancePermissions: InstancePermission[];
  projectPermissions: Record<string, ProjectPermission[]>;
}

export interface SearchResult {
  kind: "project" | "task" | "person";
  id: string;
  code?: string;
  label: string;
  route: string;
  /** Solo per le task: il reparto, per la striscia. */
  departmentId?: string;
}
