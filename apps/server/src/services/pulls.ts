import { aiJobs, prCorrections, prReviews, projects, repositories, type Db } from "@stubwise/db";
import { cancelOpenCorrections } from "@stubwise/notifications";
import { isReadyForRelease, prStateOf, stubwiseTicketNumber, type OpenPull, type PrCorrectionInput } from "@stubwise/shared";
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
  // Tutte le righe di review delle PR (poche per PR): l'ultima, l'ultima
  // completata e il «Solo analisi», che vale su QUALUNQUE riga della PR
  // (scritto su tutte; una review nuova nasce senza).
  const reviewRows = await db
    .select({
      repositoryId: prReviews.repositoryId,
      prNumber: prReviews.prNumber,
      status: prReviews.status,
      headSha: prReviews.headSha,
      verdict: prReviews.verdict,
      summary: prReviews.summary,
      targetBranch: prReviews.targetBranch,
      fromFork: prReviews.fromFork,
      analysisOnly: prReviews.analysisOnly,
      analysisOnlyBy: prReviews.analysisOnlyBy,
      analysisOnlyAt: prReviews.analysisOnlyAt,
    })
    .from(prReviews)
    .where(inArray(prReviews.repositoryId, repoIds))
    .orderBy(desc(prReviews.createdAt));
  const repoRows = await db
    .select({
      id: repositories.id,
      defaultBranch: repositories.defaultBranch,
      releaseBranch: repositories.releaseBranch,
      protectedBranches: repositories.protectedBranches,
      colleaguePrs: repositories.colleaguePrs,
    })
    .from(repositories)
    .where(inArray(repositories.id, repoIds));
  const repoOf = new Map(repoRows.map((r) => [r.id, r]));
  // Le correzioni con l'esito del loro job: `pr_opened` = ha pushato.
  const corrections = await db
    .select({
      repositoryId: prCorrections.repositoryId,
      prNumber: prCorrections.prNumber,
      status: prCorrections.status,
      trigger: prCorrections.trigger,
      createdAt: prCorrections.createdAt,
      jobStatus: aiJobs.status,
    })
    .from(prCorrections)
    .leftJoin(aiJobs, eq(aiJobs.correctionId, prCorrections.id))
    .where(and(inArray(prCorrections.repositoryId, repoIds), ne(prCorrections.status, "cancelled")))
    .orderBy(desc(prCorrections.createdAt));
  const key = (r: string, n: number | null) => `${r}:${n}`;
  const rowsOf = (r: string, n: number | null) => reviewRows.filter((x) => key(x.repositoryId, x.prNumber) === key(r, n));
  const editReleaseNotes = perms.has("release.merge") || perms.has("tickets.edit");
  return items.map((i) => {
    const rows = rowsOf(i.repositoryId, i.prNumber);
    const review = rows[0];
    const completed = rows.find((r) => r.status === "completed");
    const flagged = rows.find((r) => r.analysisOnly);
    const mine = corrections.filter((c) => c.repositoryId === i.repositoryId && c.prNumber === i.prNumber);
    const colleague = i.origin === "external";
    const repo = repoOf.get(i.repositoryId);
    const defaultBranch = repo?.defaultBranch ?? "";
    // Lo stato con le regole di shared (`prStateOf`, lo stesso motore del
    // prototipo): le correzioni più vecchie prima.
    const correctionInputs: PrCorrectionInput[] = [...mine].reverse().flatMap((c): PrCorrectionInput[] => {
      const trigger = c.trigger === "review" ? "auto" : "person";
      if (c.status === "pending") return [];
      if (c.status === "queued") return [{ trigger, state: "running" }];
      return [{ trigger, state: c.jobStatus === "pr_opened" ? "pushed" : "stopped" }];
    });
    const inFlight = review !== undefined && review.status !== "completed" && review.status !== "failed";
    const issues =
      completed?.verdict === "request_changes" ? [{ title: completed.summary ?? "", file: null }] : [];
    const fromFork = colleague ? (completed?.fromFork ?? review?.fromFork ?? null) : false;
    const prState = prStateOf({
      origin: i.origin,
      branch: i.branch,
      baseBranch: review?.targetBranch ?? "",
      defaultBranch,
      releaseBranch: repo?.releaseBranch ?? defaultBranch,
      // Un fork non verificabile vale come fork (il nome del branch non dice dove sta).
      fromFork: fromFork !== false,
      branchProtected: false,
      protectedPatterns: repo?.protectedBranches ?? [],
      // Il ramo di Stubwise di questa PR è `stubwise/ticket-<N>`: è suo.
      ownTaskCode: colleague ? null : `ticket-${i.ticketNumber}`,
      headSha: i.headSha ?? "",
      analysis: inFlight
        ? { sha: review.headSha, status: "running", issues: [] }
        : completed
          ? { sha: completed.headSha, status: "done", issues }
          : null,
      corrections: correctionInputs,
      cap: project?.cap ?? 0,
      repoMode: repo?.colleaguePrs ?? "analyze_only",
      prAnalysisOnly: flagged !== undefined,
    });
    const checksStatus =
      i.checks.status === "success" || i.checks.status === "no_checks"
        ? "passing"
        : i.checks.status === "failure"
          ? "failing"
          : i.checks.status === "pending"
            ? "pending"
            : "unreadable";
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
      analysisOnly: flagged ? { byId: flagged.analysisOnlyBy, at: (flagged.analysisOnlyAt ?? new Date(0)).toISOString() } : null,
      prState,
      ready: isReadyForRelease({ state: "open", checks: checksStatus, mergeable: null, analysis: completed ? { issues } : null }, prState),
      fromFork,
      mergeable: null,
      colleaguePrs: repo?.colleaguePrs ?? "analyze_only",
      issues,
      permissions: {
        analysisOnly: colleague && perms.has("prs.adopt"),
        // Su una PR di un collega: `prs.adopt`, un ramo su cui Stubwise può
        // pushare, e un'impostazione che non la ferma (`colleagueCorrectionAllowed`
        // con una richiesta in Stubwise: «spento» o «Solo analisi» sulla PR).
        requestCorrection: colleague
          ? perms.has("prs.adopt") && !prState.notFixable && repo?.colleaguePrs !== "off" && flagged === undefined
          : perms.has("corrections.request"),
        editReleaseNotes,
      },
    };
  });
}

/**
 * «SOLO ANALISI» SU UNA PR DI UN COLLEGA (area 8, F1, S8; invariante «Le PR
 * dei colleghi»). Chi ha `prs.adopt` nel progetto del repository (404 a chi
 * non lo vede, 403 a chi lo vede senza): nessuna correzione parte più su
 * quella PR, nemmeno chiesta (`colleagueCorrectionAllowed`), e quelle aperte
 * si annullano (una in volo si ferma prima del push: il worker rilegge). Il
 * flag si scrive su TUTTE le righe `pr_reviews` della PR e si legge su
 * qualunque: una review nuova nasce senza. Solo sulle PR dei colleghi: una
 * PR di Stubwise (`stubwise/ticket-N`) risponde 409 `not_colleague_pr`. Una
 * PR mai analizzata non ha righe: 404 `pr_not_found`.
 */
export async function setPrAnalysisOnly(
  db: Db,
  viewer: Pick<SessionUser, "id" | "instancePermissions">,
  input: { repositoryId: string; prNumber: number; on: boolean },
): Promise<{ analysisOnly: { byId: string | null; at: string } | null }> {
  const [repo] = await db.select({ projectId: repositories.projectId }).from(repositories).where(eq(repositories.id, input.repositoryId));
  const perms = repo ? await projectPermissionsFor(db, viewer, repo.projectId) : null;
  if (!repo || !perms) throw new ReleaseError(404, "not_found", "Not found");
  if (!perms.has("prs.adopt")) throw new ReleaseError(403, "forbidden", "Only who can adopt pull requests can set analysis only");
  const where = and(eq(prReviews.repositoryId, input.repositoryId), eq(prReviews.prNumber, input.prNumber));
  const rows = await db.select({ sourceBranch: prReviews.sourceBranch }).from(prReviews).where(where);
  if (rows.length === 0) throw new ReleaseError(404, "pr_not_found", "This pull request has not been analyzed");
  if (rows.some((r) => r.sourceBranch !== null && stubwiseTicketNumber(r.sourceBranch) !== null)) {
    throw new ReleaseError(409, "not_colleague_pr", "Analysis only is for colleagues' pull requests");
  }
  const at = new Date();
  await db
    .update(prReviews)
    .set(input.on ? { analysisOnly: true, analysisOnlyBy: viewer.id, analysisOnlyAt: at } : { analysisOnly: false, analysisOnlyBy: null, analysisOnlyAt: null })
    .where(where);
  if (input.on) {
    await cancelOpenCorrections(db, { repositoryId: input.repositoryId, prNumber: input.prNumber }, { logLine: "[correction] «Solo analisi» sulla PR del collega\n" });
  }
  return { analysisOnly: input.on ? { byId: viewer.id, at: at.toISOString() } : null };
}
