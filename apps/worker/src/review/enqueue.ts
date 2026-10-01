import { instanceSettings, prReviewJobs, type Db } from "@stubwise/db";
import { eq, sql } from "drizzle-orm";

export interface EnqueuePrReviewNowInput {
  repositoryId: string;
  prNumber: number;
  prUrl: string;
  prTitle: string;
  prBody: string;
  sourceBranch: string;
  targetBranch: string;
  /** Sha pushato (completo): è la head che la review deve leggere. */
  headSha: string;
}

/**
 * Accoda SUBITO la review di una PR di Stubwise (dopo l'apertura dal fix, o
 * dopo il push di una correzione). Non ci si affida al webhook del provider:
 * che Bitbucket mandi `pullrequest:updated` a ogni commit non è documentato.
 *
 * Idempotente col webhook: upsert sullo STESSO vincolo `(repository_id,
 * pr_number)` che usa il webhook — un solo pending per PR. Se il webhook è
 * arrivato prima, la riga è sua: qui si sovrascrivono la head (la nostra è
 * completa e certamente quella pushata) e la finestra, anticipata a ora. Se
 * arriva dopo, sposta di nuovo la finestra in avanti: comunque una review sola.
 * Un webhook che arriva DOPO il claim del poller lo ferma la guardia
 * anti-doppione di `runPrReview` (stessa head già revisionata).
 *
 * `not_before = now()` del database, non del processo: il claim del poller
 * confronta con `now()` di Postgres, e un orologio del worker avanti di pochi
 * millisecondi farebbe saltare il giro.
 *
 * Gate: review spenta d'istanza → false, niente riga (come il webhook).
 * Best-effort: mai lancia, false su errore con una riga di log.
 */
export async function enqueuePrReviewNow(db: Db, input: EnqueuePrReviewNowInput): Promise<boolean> {
  try {
    const [settings] = await db
      .select({ enabled: instanceSettings.prReviewEnabled })
      .from(instanceSettings)
      .where(eq(instanceSettings.id, 1));
    if (settings?.enabled !== true) return false;
    await db
      .insert(prReviewJobs)
      .values({ ...input, notBefore: sql`now()` })
      .onConflictDoUpdate({
        target: [prReviewJobs.repositoryId, prReviewJobs.prNumber],
        set: {
          prUrl: input.prUrl,
          prTitle: input.prTitle,
          prBody: input.prBody,
          sourceBranch: input.sourceBranch,
          targetBranch: input.targetBranch,
          headSha: input.headSha,
          notBefore: sql`now()`,
          // $onUpdate di Drizzle non scatta su onConflictDoUpdate (come nel webhook).
          updatedAt: new Date(),
        },
      });
    return true;
  } catch (err) {
    console.error(
      `[stubwise-worker] pr-review: accodamento della review della PR #${input.prNumber} fallito (${err instanceof Error ? err.message : String(err)})`,
    );
    return false;
  }
}
