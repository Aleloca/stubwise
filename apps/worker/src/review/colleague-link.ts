import { repositories, ticketRepositories, tickets, type Db } from "@stubwise/db";
import type { PullRequestInfo } from "@stubwise/git";
import { colleaguePrBlock, type NotFixableReason } from "@stubwise/shared";
import { and, eq, sql } from "drizzle-orm";

/**
 * LE PR DEI COLLEGHI SENZA ADOZIONE (area 8, F1, S8; invariante «Le PR dei
 * colleghi», `docs/invariants/pr-corrections.md`). Quando la review di una PR
 * che Stubwise non ha aperto si chiude, il suo ticket `review` riceve la riga
 * `ticket_repositories` che prima scriveva l'adozione: da lì il ciclo di
 * sempre (`isCorrectablePr`, i ricontrolli prima del worktree e del push, mai
 * force) la tratta come correggibile. `adopted_by_user_id` resta null: l'ha
 * scritta il SISTEMA; chi ha usato la rotta di adozione resta riconoscibile
 * (vale «analisi e correzioni» su quella PR).
 *
 * Se la correzione poi PARTE lo decide l'impostazione
 * (`colleagueCorrectionAllowed`, in `enqueueCorrection` e prima del push):
 * qui solo se Stubwise ci POTREBBE pushare in sicurezza. Le regole del ramo
 * sono `colleaguePrBlock` (@stubwise/shared), sui fatti letti DAL PROVIDER
 * adesso, fail-closed: un errore di lettura o un fork non verificabile non
 * scrivono niente. Il repository «spento» nemmeno. Un'adozione rilasciata
 * («Smetti di correggere») non si riscrive.
 */

export type LinkColleaguePrOutcome =
  | "linked"
  | "already"
  | "released"
  | "not_review_ticket"
  | "off"
  | "unverifiable"
  | "not_open"
  | `blocked:${NotFixableReason}`;

export async function linkColleaguePr(
  deps: {
    db: Db;
    /** La PR com'è adesso, dal provider. */
    getPullRequestInfo: () => Promise<PullRequestInfo>;
  },
  input: { ticketId: string; repositoryId: string; prNumber: number; prUrl: string },
): Promise<LinkColleaguePrOutcome> {
  const { db } = deps;
  const [ticket] = await db.select({ type: tickets.type }).from(tickets).where(eq(tickets.id, input.ticketId));
  if (ticket?.type !== "review") return "not_review_ticket";
  const existing = await rowOf(db, input);
  if (existing) return existing.adoptionReleasedAt !== null ? "released" : "already";

  const [repo] = await db
    .select({
      mode: repositories.colleaguePrs,
      defaultBranch: repositories.defaultBranch,
      releaseBranch: repositories.releaseBranch,
      protectedBranches: repositories.protectedBranches,
    })
    .from(repositories)
    .where(eq(repositories.id, input.repositoryId));
  if (!repo || repo.mode === "off") return "off";

  let info: PullRequestInfo;
  try {
    info = await deps.getPullRequestInfo();
  } catch {
    return "unverifiable";
  }
  if (info.state !== "open") return "not_open";
  const block = colleaguePrBlock({
    branch: info.sourceBranch,
    baseBranch: info.targetBranch,
    defaultBranch: repo.defaultBranch,
    releaseBranch: repo.releaseBranch ?? repo.defaultBranch,
    // Un fork non verificabile è un fork (il nome del branch non dice DOVE sta).
    fromFork: info.fromFork !== false,
    branchProtected: false,
    protectedPatterns: repo.protectedBranches,
    ownTaskCode: null,
  });
  if (block) return `blocked:${block}`;

  // Sotto il lock del ticket (lo stesso di `startRun`, `enqueueCorrection`,
  // dell'adozione): una rotta di adozione arrivata nel frattempo vince.
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.ticketId}))`);
    const [locked] = await tx
      .select({ releasedAt: ticketRepositories.adoptionReleasedAt })
      .from(ticketRepositories)
      .where(and(eq(ticketRepositories.ticketId, input.ticketId), eq(ticketRepositories.repositoryId, input.repositoryId)));
    if (locked) return locked.releasedAt !== null ? "released" : "already";
    await tx.insert(ticketRepositories).values({
      ticketId: input.ticketId,
      repositoryId: input.repositoryId,
      branch: info.sourceBranch,
      prUrl: input.prUrl,
      prNumber: input.prNumber,
      prState: "open",
      adoptedAt: new Date(),
      adoptedByUserId: null,
    });
    return "linked";
  });
}

async function rowOf(db: Db, input: { ticketId: string; repositoryId: string }) {
  const [row] = await db
    .select({ adoptionReleasedAt: ticketRepositories.adoptionReleasedAt })
    .from(ticketRepositories)
    .where(and(eq(ticketRepositories.ticketId, input.ticketId), eq(ticketRepositories.repositoryId, input.repositoryId)));
  return row;
}
