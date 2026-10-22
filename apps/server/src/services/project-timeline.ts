import { prReviews, repositories, type Db } from "@stubwise/db";
import { buildProjectTimeline, type TimelineWindow } from "@stubwise/notifications";
import type { PrReviewSummary } from "@stubwise/shared";
import { desc, eq } from "drizzle-orm";

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
 * Qui resta ciò che è HTTP e solo HTTP (l'ACL del chiamante no: la dichiarano
 * le rotte in `config.access`, e un progetto che non si vede è 404):
 *  - {@link resolveTimelineWindow}: la querystring `from`/`to` normalizzata, col
 *    tetto di {@link TIMELINE_MAX_DAYS} giorni;
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

