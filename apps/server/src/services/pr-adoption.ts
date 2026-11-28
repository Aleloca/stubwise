import {
  prReviews,
  repositories,
  ticketRepositories,
  users,
  type Db,
} from "@stubwise/db";
import {
  isProtectedBranch,
  type PrAdoption,
  type PrAdoptionUnavailableReason,
  type ProjectPermission,
} from "@stubwise/shared";
import { and, desc, eq } from "drizzle-orm";

/**
 * ADOZIONE di una PR aperta da altri (6 ott 2026, design
 * `docs/plans/2026-10-06-adopt-external-pr-design.md`, piano
 * `2026-10-06-adopt-external-pr.md`).
 *
 * Un maintainer preme «Fai correggere a Stubwise» sul ticket `review` di una
 * PR che Stubwise non ha aperto: da lì le correzioni finiscono sul branch di
 * QUELLA PR, col ciclo solito (review dopo ogni correzione, giro automatico
 * fino al tetto, «Chiedi modifiche», «Request changes»). L'adozione è una
 * riga `ticket_repositories` del ticket review con `adopted_at`: da quel
 * momento la regola unica `isCorrectablePr` (@stubwise/shared) la tratta
 * come correggibile, e il resto del ciclo non ha bisogno di sapere altro.
 *
 * Tre confini, e sono il motivo per cui questo modulo esiste:
 *  1. SOLO chi ha `prs.adopt` nel progetto: `config.access` sulla rotta E il controllo qui
 *     dentro, prima di ogni lettura (difesa in profondità come
 *     `preApprovePlan` e `releasePullRequest`);
 *  2. MAI una PR su cui Stubwise non può scrivere in sicurezza, verificato
 *     DAL PROVIDER al momento dell'adozione, fail-closed: un fork (o un fork
 *     non verificabile: il nome del branch, da solo, non dice DOVE sta — una
 *     PR da fork su `main` porterebbe il push sul `main` del repository), un
 *     branch di Stubwise, il branch di default o il target della PR;
 *  3. i commenti sulla PR e sul ticket sono TEMPLATE i18n, mai AI. Quello
 *     sulla PR lo scrive l'account principale, che il webhook considera
 *     «proprio»: non può far partire una correzione.
 */

/** Ticket chiusi: la PR di un ticket review chiuso è chiusa o mergiata (lo fa il webhook). */
const CLOSED_TICKET_STATUSES = new Set(["done", "closed"]);

/** Un branch di Stubwise (`stubwise/ticket-N`, `stubwise/graphify-setup`…): mai di una persona. */
function isStubwiseBranch(branch: string): boolean {
  return branch.startsWith("stubwise/");
}

/**
 * Il branch sorgente è la BASE (il default del repository o il target della
 * PR)? Pushare lì vorrebbe dire pushare sul branch in cui la PR confluisce.
 */
function isBaseBranch(branch: string, defaultBranch: string, targetBranch: string | null): boolean {
  return branch === defaultBranch || (targetBranch !== null && branch === targetBranch);
}

/** L'ultima review COMPLETATA di quel ticket su quel repository: la PR che il ticket ospita. */
async function latestReviewOfTicket(db: Db, ticketId: string, repositoryId?: string) {
  const [row] = await db
    .select({
      id: prReviews.id,
      repositoryId: prReviews.repositoryId,
      prNumber: prReviews.prNumber,
      prUrl: prReviews.prUrl,
      sourceBranch: prReviews.sourceBranch,
      targetBranch: prReviews.targetBranch,
      fromFork: prReviews.fromFork,
      verdict: prReviews.verdict,
    })
    .from(prReviews)
    .where(
      and(
        eq(prReviews.ticketId, ticketId),
        eq(prReviews.status, "completed"),
        ...(repositoryId !== undefined ? [eq(prReviews.repositoryId, repositoryId)] : []),
      ),
    )
    .orderBy(desc(prReviews.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Il campo `prAdoption` del dettaglio ticket, DERIVATO a lettura (CLAUDE.md,
 * «derivati a lettura»): null per un ticket che non è `review` o senza una
 * review completata. `canManage` = `prs.adopt` di CHI GUARDA, mai dedotto dal
 * client (stesso criterio di `canMerge`). Nessuna chiamata al provider: il
 * fork si sa solo se l'evento del webhook l'ha detto (`pr_reviews.from_fork`);
 * quando non lo si sa lo stato è `available`, e l'adozione verifica.
 */
export async function loadPrAdoption(
  db: Db,
  input: {
    ticketId: string;
    ticketType: string;
    ticketStatus: string;
    viewerPermissions: ReadonlySet<ProjectPermission>;
  },
): Promise<PrAdoption | null> {
  if (input.ticketType !== "review") return null;
  const review = await latestReviewOfTicket(db, input.ticketId);
  if (!review) return null;
  const [repo] = await db
    .select({ defaultBranch: repositories.defaultBranch, protectedBranches: repositories.protectedBranches })
    .from(repositories)
    .where(eq(repositories.id, review.repositoryId));
  if (!repo) return null;
  const [row] = await db
    .select({
      branch: ticketRepositories.branch,
      prState: ticketRepositories.prState,
      adoptedAt: ticketRepositories.adoptedAt,
      releasedAt: ticketRepositories.adoptionReleasedAt,
      adoptedByEmail: users.email,
    })
    .from(ticketRepositories)
    .leftJoin(users, eq(users.id, ticketRepositories.adoptedByUserId))
    .where(
      and(eq(ticketRepositories.ticketId, input.ticketId), eq(ticketRepositories.repositoryId, review.repositoryId)),
    );
  // Adottata = adozione attiva E PR ancora aperta. La chiusura rilascia già
  // l'adozione (`releaseAdoptionsOnPrClose`); qui lo si ripete in lettura, così
  // una PR chiusa non offre mai «Smetti di correggere».
  const adopted =
    row !== undefined && row.adoptedAt !== null && row.releasedAt === null && row.prState === "open";
  const branch = row?.branch ?? review.sourceBranch ?? null;
  const closed = CLOSED_TICKET_STATUSES.has(input.ticketStatus) || (row !== undefined && row.prState !== "open");

  let reason: PrAdoptionUnavailableReason | null = null;
  if (!adopted) {
    if (closed) reason = "pr_closed";
    else if (branch !== null && isStubwiseBranch(branch)) reason = "stubwise_pr";
    else if (review.fromFork === true) reason = "fork";
    else if (branch !== null && isBaseBranch(branch, repo.defaultBranch, review.targetBranch)) reason = "base_branch";
    else if (branch !== null && isProtectedBranch(branch, repo.protectedBranches)) reason = "protected_branch";
  }

  return {
    repositoryId: review.repositoryId,
    prNumber: review.prNumber,
    prUrl: review.prUrl,
    branch,
    state: adopted ? "adopted" : reason !== null ? "unavailable" : "available",
    unavailableReason: reason,
    adoptedAt: adopted ? row.adoptedAt!.toISOString() : null,
    adoptedBy: adopted ? (row.adoptedByEmail ?? null) : null,
    canManage: input.viewerPermissions.has("prs.adopt"),
  };
}

