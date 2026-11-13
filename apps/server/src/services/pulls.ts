import { prCorrections, prReviews, projects, type Db } from "@stubwise/db";
import type { OpenPull } from "@stubwise/shared";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { projectPermissionsFor } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { listReleaseQueue } from "./release.js";
import { ReleaseError } from "./releases.js";

/**
 * L'ELENCO DELLE PR APERTE DI UN PROGETTO (area 8, F1, S5b): a CHIUNQUE veda
 * il progetto (404 altrimenti) — a differenza della coda, che resta di chi ha
 * `release.merge` e dice `canMerge`. Riusa la lettura della coda (la stessa
 * deduplica fra PR di Stubwise ed esterne, i controlli letti dal provider) e
 * aggiunge ciò che l'elenco del prototipo mostra: la base, «Solo analisi»,
 * un riassunto LEGGERO delle correzioni (non `derivePrCycle`, che fa sette
 * letture per PR) e i permessi per chi guarda, calcolati una volta per
 * progetto. `mergeable` non si legge nella F1 (una chiamata in più al
 * provider per PR): non è nella forma.
 */
export async function listOpenPulls(db: Db, encryptionKey: Buffer, viewer: Pick<SessionUser, "id" | "instancePermissions">, projectId: string): Promise<OpenPull[]> {
  const perms = await projectPermissionsFor(db, viewer, projectId);
  if (!perms) throw new ReleaseError(404, "not_found", "Not found");
  const items = await listReleaseQueue(db, encryptionKey, [projectId]);
  if (items.length === 0) return [];
  const [project] = await db.select({ cap: projects.prCorrectionMaxRounds }).from(projects).where(eq(projects.id, projectId));
  const repoIds = [...new Set(items.map((i) => i.repositoryId))];
  const reviews = await db
    .selectDistinctOn([prReviews.repositoryId, prReviews.prNumber], {
      repositoryId: prReviews.repositoryId,
      prNumber: prReviews.prNumber,
      targetBranch: prReviews.targetBranch,
      analysisOnly: prReviews.analysisOnly,
      analysisOnlyBy: prReviews.analysisOnlyBy,
      analysisOnlyAt: prReviews.analysisOnlyAt,
    })
    .from(prReviews)
    .where(inArray(prReviews.repositoryId, repoIds))
    .orderBy(prReviews.repositoryId, prReviews.prNumber, desc(prReviews.createdAt));
  const corrections = await db
    .select({ repositoryId: prCorrections.repositoryId, prNumber: prCorrections.prNumber, status: prCorrections.status, createdAt: prCorrections.createdAt })
    .from(prCorrections)
    .where(and(inArray(prCorrections.repositoryId, repoIds), ne(prCorrections.status, "cancelled")))
    .orderBy(desc(prCorrections.createdAt));
  const key = (r: string, n: number | null) => `${r}:${n}`;
  const reviewOf = new Map(reviews.map((r) => [key(r.repositoryId, r.prNumber), r]));
  const editReleaseNotes = perms.has("release.merge") || perms.has("tickets.edit");
  return items.map((i) => {
    const review = reviewOf.get(key(i.repositoryId, i.prNumber));
    const mine = corrections.filter((c) => c.repositoryId === i.repositoryId && c.prNumber === i.prNumber);
    const colleague = i.origin === "external";
    return {
      origin: i.origin,
      ticketId: i.ticketId,
      ticketNumber: i.ticketNumber,
      ticketTitle: i.ticketTitle,
      repositoryId: i.repositoryId,
      repositoryName: i.repositoryName,
      branch: i.branch,
      baseBranch: review?.targetBranch ?? null,
      prUrl: i.prUrl,
      prNumber: i.prNumber,
      headSha: i.headSha ?? null,
      createdAt: i.createdAt,
      checks: i.checks,
      deployedOn: i.deployedOn,
      analysis: { verdict: i.reviewVerdict, summary: i.reviewSummary, stale: i.reviewStale },
      corrections: { count: mine.length, lastStatus: mine[0]?.status ?? null },
      cap: project?.cap ?? 0,
      analysisOnly: review?.analysisOnly ? { byId: review.analysisOnlyBy, at: (review.analysisOnlyAt ?? new Date(0)).toISOString() } : null,
      permissions: {
        analysisOnly: colleague && perms.has("prs.adopt"),
        requestCorrection: colleague ? perms.has("prs.adopt") : perms.has("corrections.request"),
        editReleaseNotes,
      },
    };
  });
}
