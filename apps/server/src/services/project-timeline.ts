import {
  prReviews,
  projectFollows,
  projects,
  repositories,
  type Db,
} from "@stubwise/db";
import { buildProjectTimeline, type TimelineWindow } from "@stubwise/notifications";
import type { PrReviewSummary } from "@stubwise/shared";
import { and, desc, eq } from "drizzle-orm";

/**
 * TIMELINE DI PROGETTO (Fase 5) — il lato HTTP.
 *
 * La FUSIONE delle sorgenti non abita più qui: sta in
 * `@stubwise/notifications/project-timeline`, perché ha due consumatori — questa
 * rotta e il brief settimanale del worker — e `apps/worker` non può importare da
 * `apps/server` (sono app sorelle, senza dipendenza nel workspace). Vedi il
 * commento in testa a quel modulo per il perché di quel package e non di un
 * altro.
 *
 * Qui resta ciò che è HTTP e solo HTTP:
 *  - {@link resolveTimelineWindow}: la querystring `from`/`to` normalizzata, col
 *    tetto di {@link TIMELINE_MAX_DAYS} giorni;
 *  - {@link canViewProject}: l'ACL del chiamante (il brief gira senza viewer);
 *  - {@link listProjectReviews}: la lettura di `pr_reviews` che serve solo
 *    all'API (la timeline si arricchisce da sé del verdetto).
 *
 * `buildProjectTimeline` è RI-ESPORTATA da qui perché le rotte continuino ad
 * avere un import solo per la timeline: è un alias, non una seconda copia.
 */
export { buildProjectTimeline, type TimelineWindow };

/** Ampiezza massima della finestra richiedibile, in giorni (limite INCLUSO). */
export const TIMELINE_MAX_DAYS = 180;
/** Ampiezza della finestra quando il chiamante non ne indica una. */
export const TIMELINE_DEFAULT_DAYS = 28;

const DAY_MS = 24 * 60 * 60 * 1000;

export type TimelineWindowResult =
  | { ok: true; window: TimelineWindow }
  | { ok: false; reason: "window_too_large" | "invalid_range" };

/**
 * Normalizza `from`/`to` della querystring in una finestra.
 *
 * `to` assente = adesso; `from` assente = {@link TIMELINE_DEFAULT_DAYS} giorni
 * prima di **quel** `to`, non prima di adesso: chi chiede una finestra storica
 * passando solo `to` si aspetta le quattro settimane che precedono quella data,
 * non un intervallo che finisce nel passato e comincia ieri.
 *
 * `now` è iniettabile perché i test non possono asserire su un default che
 * scorre mentre girano.
 */
export function resolveTimelineWindow(
  params: { from?: string; to?: string },
  now: Date = new Date(),
): TimelineWindowResult {
  const to = params.to ? new Date(params.to) : now;
  const from = params.from ? new Date(params.from) : new Date(to.getTime() - TIMELINE_DEFAULT_DAYS * DAY_MS);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { ok: false, reason: "invalid_range" };
  }
  if (from.getTime() > to.getTime()) return { ok: false, reason: "invalid_range" };
  if (to.getTime() - from.getTime() > TIMELINE_MAX_DAYS * DAY_MS) {
    return { ok: false, reason: "window_too_large" };
  }
  return { ok: true, window: { from, to } };
}

/** Chi guarda: il ruolo decide se serve seguire il progetto. */
export interface TimelineViewer {
  userId: string;
  role: string;
}

/**
 * Il viewer può leggere la narrativa di questo progetto?
 *
 * Stesso criterio di `GET /api/projects/pulse`: un `admin` vede tutto (non ha
 * bisogno di seguire un progetto per doverne sapere lo stato), un `member` solo
 * ciò che segue. Un progetto INESISTENTE dà `false` come uno non seguito, di
 * proposito: la rotta risponde 404 in entrambi i casi e non si può distinguere
 * "non esiste" da "non è tuo" contando i codici di stato.
 */
export async function canViewProject(
  db: Db,
  projectId: string,
  viewer: TimelineViewer,
): Promise<boolean> {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) return false;
  if (viewer.role === "admin") return true;
  const [follow] = await db
    .select({ projectId: projectFollows.projectId })
    .from(projectFollows)
    .where(and(eq(projectFollows.projectId, projectId), eq(projectFollows.userId, viewer.userId)));
  return follow !== undefined;
}


/**
 * Le review AI di PR di un progetto: la prima lettura di `pr_reviews` da
 * un'API (Fase 5). `error` NON esce di qui — vedi `prReviewSummarySchema`.
 */
export async function listProjectReviews(
  db: Db,
  projectId: string,
  limit: number,
): Promise<PrReviewSummary[]> {
  const rows = await db
    .select({
      id: prReviews.id,
      repositoryId: prReviews.repositoryId,
      repositoryName: repositories.name,
      ticketId: prReviews.ticketId,
      prNumber: prReviews.prNumber,
      prUrl: prReviews.prUrl,
      prTitle: prReviews.prTitle,
      status: prReviews.status,
      verdict: prReviews.verdict,
      prSummary: prReviews.prSummary,
      createdAt: prReviews.createdAt,
      finishedAt: prReviews.finishedAt,
    })
    .from(prReviews)
    .innerJoin(repositories, eq(repositories.id, prReviews.repositoryId))
    .where(eq(repositories.projectId, projectId))
    .orderBy(desc(prReviews.createdAt))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    repositoryId: row.repositoryId,
    repositoryName: row.repositoryName ?? null,
    ticketId: row.ticketId,
    prNumber: row.prNumber,
    prUrl: row.prUrl,
    prTitle: row.prTitle,
    status: row.status,
    verdict: row.verdict,
    prSummary: row.prSummary,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }));
}

