import type { InstancePermission, ProjectPermission } from "@stubwise/shared";
import type { DepartmentPermission, Milestone } from "./model";

// I tipi del modello dell'area 2 stanno in `model.ts`; qui restano quelli
// dell'ossatura e del livello dati (chi guarda, ricerca, letture derivate).
export * from "./model";

/** Permessi di progetto che vivono solo nel prototipo (non nel registro condiviso). */
export type LocalProjectPermission = "planning.others";

/**
 * Permessi d'istanza che vivono solo nel prototipo (area 3): vedere le
 * conversazioni pubbliche con Claude e l'attività delle persone. Entrano nel
 * registro di `@stubwise/shared` quando si costruisce il backend.
 */
export type LocalInstancePermission = "claude.public.view" | "people.activity.view";

export interface Viewer {
  personId: string;
  instancePermissions: (InstancePermission | LocalInstancePermission)[];
  projectPermissions: Record<string, (ProjectPermission | LocalProjectPermission)[]>;
  /** Permessi di reparto, per id del reparto. */
  departmentPermissions: Record<string, DepartmentPermission[]>;
}

export interface SearchResult {
  kind: "project" | "task" | "request" | "person";
  id: string;
  code?: string;
  label: string;
  route: string;
  /** Solo per le task: il reparto, per la striscia. */
  departmentId?: string;
}

/** Il polso di un progetto, per chi guarda. */
export interface ProjectPulse {
  projectId: string;
  /** Task aperte per famiglia. */
  open: { todo: number; active: number };
  stalled: number;
  waitingOnMe: boolean;
  claudeWorking: boolean;
  /** Il traguardo aperto con la data più vicina (anche se passata). */
  nextMilestone: Milestone | null;
}

/**
 * Un evento della cronologia di progetto (la Roadmap del web). Le voci che
 * non sono task né traguardi portano con sé ciò che serve a dirle, come
 * `projectTimelineEntrySchema`: il titolo della decisione, la prima riga del
 * brief, la sintesi del report.
 */
export type TimelineEvent =
  | { kind: "task_opened" | "task_closed"; at: string; taskId: string }
  | { kind: "milestone"; at: string; milestoneId: string }
  | { kind: "decision"; at: string; decisionId: string; title: string }
  | { kind: "brief"; at: string; briefId: string; headline: string }
  | { kind: "daily_report"; at: string; reportId: string; summary: string | null }
  | {
      kind: "pr_opened" | "pr_merged" | "pr_closed";
      at: string;
      prId: string;
      taskId: string;
      number: number;
    };

export type TimelineKind = TimelineEvent["kind"];

/** Una voce dell'attività del portafoglio: un evento di cronologia col suo progetto. */
export type PortfolioEvent = TimelineEvent & { projectId: string };
