import { ApiError } from "@stubwise/api-client";
import {
  briefHeadline,
  briefSummaryText,
  pulseOf,
  type ChronologyEvent,
  type ProjectBriefWeekly,
  type ProjectDecision,
  type ProjectPulsesResponse,
  type WeeklyBriefView,
} from "@stubwise/shared";
import type * as Fake from "../../api";
import type {
  DecisionLogEntry,
  DecisionSource,
  PortfolioEvent,
  ProjectPulse,
  TimelineEvent,
  TimelinePage,
} from "../../types";
import { appClient, session } from "./client";
import { claudeWaitingCounts, claudeWorkingProjectIds } from "./claudePulse";
import { listRequestsToConvert } from "./requests";
import { listMilestonesOf, listProjectStatuses, toMilestone } from "./statuses";
import { listDecisionRequests } from "./taskDetail";
import { listStalled, listTasks, tasksTruncated } from "./tasks";

// L'Overview e il portafoglio della build app (integrazione area 2, fetta 4):
// registro decisioni, brief settimanale (testo generato), cronologia e attività
// a pagine di 28 giorni («Load older», decisione del maintainer), e il polso
// calcolato con `pulseOf` di `@stubwise/shared` sui dati già letti (le ferme
// delle task, «aspetta te» comprese le richieste da trasformare, il prossimo
// traguardo). `/api/projects/pulse` resta del web vecchio e del mobile.

// --- registro decisioni -------------------------------------------------------

/** Il progetto di ogni voce letta: «superata da» si scrive sotto il progetto. */
const projectOfDecision = new Map<string, string>();

const SOURCES: readonly DecisionSource[] = ["ask_user", "plan_review", "pulse", "manual", "email"];

function toEntry(d: ProjectDecision): DecisionLogEntry {
  projectOfDecision.set(d.id, d.projectId);
  return {
    id: d.id,
    projectId: d.projectId,
    // Una sorgente nuova del server si legge come voce a mano.
    source: (SOURCES as readonly string[]).includes(d.source) ? (d.source as DecisionSource) : "manual",
    taskId: d.ticketId,
    title: d.title,
    context: d.context,
    decision: d.decision,
    decidedById: d.decidedBy?.id ?? null,
    decidedAt: d.decidedAt,
    supersededById: d.supersededById,
    // «via Claude Code» (D4 della parità MCP): solo se vero.
    ...(d.viaClaudeCode ? { viaClaudeCode: true } : {}),
  };
}

/** Quante voci del registro si leggono: oltre, il registro dice che sono le più recenti. */
const DECISION_LOG_LIMIT = 200;
const truncatedLogs = new Set<string>();

export const listDecisionLog: typeof Fake.listDecisionLog = async (projectId) => {
  const rows = await appClient().projects.decisions(projectId, { limit: DECISION_LOG_LIMIT });
  if (rows.length >= DECISION_LOG_LIMIT) truncatedLogs.add(projectId);
  else truncatedLogs.delete(projectId);
  return rows.map((d) => toEntry(d as ProjectDecision));
};

/** L'ultima lettura del registro del progetto è arrivata al tetto: ce ne sono forse di più vecchie. */
export const decisionLogTruncated: typeof Fake.decisionLogTruncated = (projectId) => truncatedLogs.has(projectId);

/** «Supera» si scrive con la voce nuova, nella stessa transazione (400 `invalid_supersede`). */
export const recordDecision: typeof Fake.recordDecision = async (projectId, draft) =>
  toEntry(
    (await appClient().projects.createDecision(projectId, {
      title: draft.title,
      decision: draft.decision,
      ...(draft.context ? { context: draft.context } : {}),
      ...(draft.taskId ? { ticketId: draft.taskId } : {}),
      ...(draft.supersedesId ? { supersedesId: draft.supersedesId } : {}),
    })) as ProjectDecision,
  );

/** Un ciclo di «superata da» lo rifiuta il server (400 `decision_cycle`). */
export const setDecisionSuperseded: typeof Fake.setDecisionSuperseded = async (id, supersededById) => {
  const projectId = projectOfDecision.get(id);
  if (!projectId) throw new Error("not_found");
  return toEntry((await appClient().projects.patchDecision(projectId, id, { supersededById })) as ProjectDecision);
};

// --- brief ------------------------------------------------------------------------

export const getLatestBrief: typeof Fake.getLatestBrief = async (projectId) => {
  const brief = (await appClient().projects.latestBrief(projectId)) as WeeklyBriefView | null;
  if (!brief) return null;
  return {
    id: brief.id,
    projectId: brief.projectId,
    periodStart: brief.periodStart.slice(0, 10),
    periodEnd: brief.periodEnd.slice(0, 10),
    headline: brief.headline,
    summary: brief.summary,
    createdAt: brief.createdAt,
  };
};

/**
 * UN brief per id (`GET /api/briefs/:id`), anche non l'ultimo, nella forma
 * della vista: l'incipit e il testo con le stesse funzioni del server
 * (`briefHeadline`, `briefSummaryText` di `@stubwise/shared`). `null` per il
 * 404 (ignoto, o di un progetto invisibile: il server non li distingue) e per
 * un brief non ancora pronto o senza testo, che l'Overview non mostra.
 */
export const getBrief: typeof Fake.getBrief = async (briefId) => {
  let brief: ProjectBriefWeekly;
  try {
    brief = (await appClient().projects.brief(briefId)) as ProjectBriefWeekly;
  } catch (error) {
    // 404 (ignoto o invisibile) e 403 (senza `tickets.view_all`): «non disponibile» (M2).
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return null;
    throw error;
  }
  const sections = (brief.sections ?? null) as Record<string, string> | null;
  if (brief.status !== "done" || (brief.summary === null && sections === null)) return null;
  return {
    id: brief.id,
    projectId: brief.projectId,
    periodStart: brief.periodStart.slice(0, 10),
    periodEnd: brief.periodEnd.slice(0, 10),
    headline: briefHeadline(sections, brief.summary) ?? "",
    summary: briefSummaryText(sections, brief.summary),
    createdAt: brief.createdAt,
  };
};

// --- cronologia ---------------------------------------------------------------------

/** Un evento del server come `TimelineEvent`; `null` se il kind è ignoto o mancano i campi del suo kind. */
function toEvent(e: ChronologyEvent): TimelineEvent | null {
  const at = e.at;
  switch (e.kind) {
    case "task_opened":
    case "task_closed":
      return e.taskId ? { kind: e.kind, at, taskId: e.taskId } : null;
    case "milestone":
      return e.milestoneId ? { kind: "milestone", at, milestoneId: e.milestoneId } : null;
    case "decision":
      return e.decisionId && typeof e.title === "string"
        ? { kind: "decision", at, decisionId: e.decisionId, title: e.title }
        : null;
    case "brief":
      return e.briefId && e.headline !== undefined
        ? { kind: "brief", at, briefId: e.briefId, headline: e.headline }
        : null;
    case "daily_report":
      return e.reportId ? { kind: "daily_report", at, reportId: e.reportId, summary: e.summary ?? null } : null;
    // Lotto 4, pulizia 4 (72, 27c0ad517; regola di 46): una task eliminata, col
    // codice e il titolo di allora. Senza (chi guarda non ha `tickets.view_all`
    // e non l'ha eliminata): l'evento c'è, nascosto, «A task was deleted».
    case "task_deleted": {
      // Revisione del lotto 5, Minor 6: senza `byId` (chi ha eliminato è stato
      // a sua volta eliminato, ON DELETE SET NULL) l'evento resta, con «Someone».
      if (!e.taskId) return null;
      // 72 (1ef4f49bb): null a chi non può vederli; un server di prima li ometteva.
      const shown = typeof e.taskCode === "string" && typeof e.title === "string";
      return {
        kind: "task_deleted",
        at,
        taskId: e.taskId,
        code: shown ? e.taskCode! : "",
        title: shown ? e.title! : "",
        byId: e.byId ?? "",
        byName: e.byId ? (e.byName ?? null) : null,
        ...(e.viaClaude ? { viaClaude: true } : {}),
        ...(shown ? {} : { concealed: true as const }),
      };
    }
    case "pr_opened":
    case "pr_merged":
    case "pr_closed":
      return e.prId && e.taskId
        ? { kind: e.kind, at, prId: e.prId, taskId: e.taskId, ...(e.number !== undefined ? { number: e.number } : {}) }
        : null;
    default:
      return null;
  }
}

export const listTimelinePage: typeof Fake.listTimelinePage = async (projectId, before) => {
  const page = await appClient().projects.chronology(projectId, before);
  return {
    events: page.events.flatMap((e) => toEvent(e as ChronologyEvent) ?? []),
    nextBefore: page.nextBefore,
  };
};

export const listPortfolioActivityPage: typeof Fake.listPortfolioActivityPage = async (before) => {
  const page = await appClient().activity.portfolio(before);
  const events: PortfolioEvent[] = page.events.flatMap((raw) => {
    const e = raw as ChronologyEvent;
    const event = toEvent(e);
    return event && e.projectId ? [{ ...event, projectId: e.projectId }] : [];
  });
  return { events, nextBefore: page.nextBefore } satisfies TimelinePage<PortfolioEvent>;
};

// --- polso ------------------------------------------------------------------------

/**
 * Il polso dei progetti chiesti, con le stesse letture per tutti: le sole task
 * aperte (le famiglie `todo` e `active`). Oltre il tetto delle 2000 righe i
 * numeri non sono esatti: il polso lo dice (`truncated`) e la riga mette un
 * «+». Le ferme si contano dalla loro lettura, non dall'intersezione con la
 * lista, che troncata ne perderebbe.
 */
async function pulsesOf(projectIds: string[]): Promise<ProjectPulse[]> {
  const me = session.personId ?? "";
  const criteria = {
    ...(projectIds.length === 1 ? { projectIds } : {}),
    families: ["todo", "active"] as ("todo" | "active")[],
  };
  const [tasks, stalled, milestones, decisions, requests, statuses, claudeWorking, claudeWaiting] = await Promise.all([
    listTasks(criteria),
    listStalled(criteria),
    listMilestonesOf(projectIds),
    listDecisionRequests({ askedOfId: me, open: true }),
    listRequestsToConvert(),
    Promise.all(projectIds.map((id) => listProjectStatuses(id))),
    claudeWorkingProjectIds(),
    claudeWaitingCounts(),
  ]);
  const truncated = tasksTruncated(criteria);
  const familyOf = new Map(statuses.flat().map((s) => [s.id, s.family] as const));
  const projectOfTask = new Map(tasks.map((t) => [t.id, t.projectId] as const));
  return projectIds.map((projectId) => {
    const pulse = pulseOf({
      projectId,
      tasks: tasks
        .filter((t) => t.projectId === projectId && t.closedAt === null)
        .flatMap((t) => {
          const family = familyOf.get(t.statusId);
          return family ? [{ family, stalled: false }] : [];
        }),
      milestones: milestones.filter((m) => m.projectId === projectId),
      decisionsForMe: decisions.filter((d) => (d.projectId ?? projectOfTask.get(d.taskId)) === projectId).length,
      requestsToConvert: requests.filter((r) => r.projectId === projectId && r.status === "new").length,
      // Area 3, 3e.2: le sessioni di lavoro dal vivo e le voci di Claude per me.
      claudeWaitingForMe: claudeWaiting.get(projectId) ?? 0,
      claudeWorking: claudeWorking.has(projectId),
    });
    return {
      ...pulse,
      stalled: stalled.filter((r) => r.task.projectId === projectId && r.task.closedAt === null).length,
      ...(truncated ? { truncated: true } : {}),
    };
  });
}

/**
 * Lotto 7, voce 4 (72, 05010a858): il polso lo calcola il server, con la
 * stessa formula (`pulseOf`) sugli stessi dati, in UNA lettura per tutti i
 * progetti (`GET /api/projects/pulses`); i numeri sono esatti fino a 10.000
 * task aperte (`truncated` solo oltre). Un progetto invisibile non compare.
 * Un server di prima (404) ripiega sulle letture di sempre (`pulsesOf`).
 */
async function serverPulses(projectIds: string[] | null): Promise<ProjectPulse[] | null> {
  const query = projectIds ? `?projectIds=${projectIds.map(encodeURIComponent).join(",")}` : "";
  let res: ProjectPulsesResponse;
  try {
    res = await appClient().request<ProjectPulsesResponse>("GET", `/api/projects/pulses${query}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
  return res.items.map((p) => ({
    projectId: p.projectId,
    open: { todo: p.open.todo, active: p.open.active },
    stalled: p.stalled,
    waitingOnMe: p.waitingOnMe,
    claudeWorking: p.claudeWorking,
    nextMilestone: p.nextMilestone ? toMilestone(p.nextMilestone) : null,
    ...(p.truncated ? { truncated: true } : {}),
  }));
}

export const projectPulse: typeof Fake.projectPulse = async (projectId) =>
  ((await serverPulses([projectId])) ?? (await pulsesOf([projectId])))[0] ?? null;

export const listProjectPulses: typeof Fake.listProjectPulses = async () => {
  const fromServer = await serverPulses(null);
  if (fromServer) return fromServer;
  const projects = await appClient().projects.list();
  return pulsesOf(projects.map((p) => p.id));
};
