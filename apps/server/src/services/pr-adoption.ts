import {
  comments,
  gitAccounts,
  prReviews,
  repositories,
  ticketRepositories,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import { getProvider, type GitProvider, type PullRequestInfo } from "@stubwise/git";
import { t } from "@stubwise/i18n";
import {
  cancelOpenCorrections,
  decryptGitCredentials,
  enqueueCorrection,
  type ActorRole,
} from "@stubwise/notifications";
import type { GitProviderKind, PrAdoption, PrAdoptionUnavailableReason } from "@stubwise/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { getContentLanguage } from "../settings.js";
import type { Actor } from "./jobs.js";

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
 *  1. SOLO un maintainer: `requireAdmin` sulla rotta E il controllo qui
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

export type AdoptError =
  | "forbidden"
  | "ticket_not_found"
  | "not_review_ticket"
  | "pr_not_found"
  | "already_adopted"
  | "pr_not_open"
  | "pr_unverifiable"
  | "pr_from_fork"
  | "pr_fork_unverifiable"
  | "stubwise_pr"
  | "base_branch";

export type AdoptResult = { ok: true; correctionId: string | null } | { ok: false; error: AdoptError };

export type ReleaseAdoptionError = "forbidden" | "not_adopted";
export type ReleaseAdoptionResult = { ok: true } | { ok: false; error: ReleaseAdoptionError };

export interface AdoptionDeps {
  db: Db;
  encryptionKey: Buffer;
  /** Provider git iniettabile nei test (default: getProvider). */
  getProviderFn?: (kind: GitProviderKind) => Pick<GitProvider, "getPullRequestInfo" | "createPrComment">;
  /** Log best-effort (default: console.warn). */
  warn?: (message: string) => void;
}

/** Ticket chiusi: la PR di un ticket review chiuso è chiusa o mergiata (lo fa il webhook). */
const CLOSED_TICKET_STATUSES = new Set(["done", "closed"]);

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

async function emailOf(db: Db, userId: string): Promise<string> {
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  return row?.email ?? "?";
}

/** Commento sulla PR con l'account PRINCIPALE. Best-effort: mai lancia. */
async function postPrComment(
  deps: AdoptionDeps,
  input: {
    provider: GitProviderKind;
    repoUrl: string;
    defaultBranch: string;
    encryptedCredentials: string;
    prNumber: number;
    body: string;
  },
): Promise<void> {
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const credentials = decryptGitCredentials(input.encryptedCredentials, deps.encryptionKey);
  if (credentials === null) {
    warn(`[pr-adoption] commento sulla PR #${input.prNumber} non pubblicato: credenziali non decifrabili`);
    return;
  }
  try {
    await (deps.getProviderFn ?? getProvider)(input.provider).createPrComment(
      { repoUrl: input.repoUrl, defaultBranch: input.defaultBranch, credentials },
      input.prNumber,
      input.body,
    );
  } catch (err) {
    warn(`[pr-adoption] commento sulla PR #${input.prNumber} non pubblicato (${errText(err)})`);
  }
}

/**
 * «Fai correggere a Stubwise». Vedi il docblock del modulo. Ordine:
 *  1. ruolo (prima di tutto);
 *  2. ticket `review`, la sua review completata su quel repository, e che non
 *     sia già adottata;
 *  3. la PR LETTA DAL PROVIDER: aperta, non da un fork (fail-closed), branch
 *     né di Stubwise né la base;
 *  4. transazione col lock del ticket (lo stesso di `startRun` ed
 *     `enqueueCorrection`): riga adottata + commento di sistema;
 *  5. dopo il commit, la prima correzione (trigger `stubwise`, la review come
 *     indicazione, la nota) — un rifiuto non disfa l'adozione: il ciclo è lì,
 *     e «Chiedi modifiche» la rifà;
 *  6. il commento sulla PR, best-effort.
 */
export async function adoptPullRequest(
  deps: AdoptionDeps,
  input: { ticketId: string; repositoryId: string; actor: Actor; note?: string },
): Promise<AdoptResult> {
  const { db } = deps;
  const { ticketId, repositoryId, actor } = input;
  if (actor.role !== "admin") return { ok: false, error: "forbidden" };

  const [ticket] = await db
    .select({ id: tickets.id, type: tickets.type, status: tickets.status, number: tickets.number })
    .from(tickets)
    .where(eq(tickets.id, ticketId));
  if (!ticket) return { ok: false, error: "ticket_not_found" };
  if (ticket.type !== "review") return { ok: false, error: "not_review_ticket" };
  const review = await latestReviewOfTicket(db, ticketId, repositoryId);
  if (!review) return { ok: false, error: "pr_not_found" };
  if (CLOSED_TICKET_STATUSES.has(ticket.status)) return { ok: false, error: "pr_not_open" };

  const [existing] = await db
    .select({ adoptedAt: ticketRepositories.adoptedAt, releasedAt: ticketRepositories.adoptionReleasedAt })
    .from(ticketRepositories)
    .where(and(eq(ticketRepositories.ticketId, ticketId), eq(ticketRepositories.repositoryId, repositoryId)));
  if (existing && existing.adoptedAt !== null && existing.releasedAt === null) {
    return { ok: false, error: "already_adopted" };
  }

  const [repo] = await db
    .select({
      provider: repositories.provider,
      repoUrl: repositories.repoUrl,
      defaultBranch: repositories.defaultBranch,
      encryptedCredentials: gitAccounts.encryptedCredentials,
    })
    .from(repositories)
    .innerJoin(gitAccounts, eq(gitAccounts.id, repositories.gitAccountId))
    .where(eq(repositories.id, repositoryId));
  if (!repo) return { ok: false, error: "pr_not_found" };

  // La PR com'è ADESSO, dal provider: l'unica fonte che dice dove sta il
  // branch. Qualunque errore → non adottabile (fail-closed).
  const credentials = decryptGitCredentials(repo.encryptedCredentials, deps.encryptionKey);
  if (credentials === null) return { ok: false, error: "pr_unverifiable" };
  let info: PullRequestInfo;
  try {
    info = await (deps.getProviderFn ?? getProvider)(repo.provider).getPullRequestInfo(
      { repoUrl: repo.repoUrl, defaultBranch: repo.defaultBranch, credentials },
      review.prNumber,
    );
  } catch (err) {
    (deps.warn ?? ((m: string) => console.warn(m)))(
      `[pr-adoption] PR #${review.prNumber} non verificabile (${errText(err)})`,
    );
    return { ok: false, error: "pr_unverifiable" };
  }
  if (info.state !== "open") return { ok: false, error: "pr_not_open" };
  if (info.fromFork === true) return { ok: false, error: "pr_from_fork" };
  if (info.fromFork === null) return { ok: false, error: "pr_fork_unverifiable" };
  if (isStubwiseBranch(info.sourceBranch)) return { ok: false, error: "stubwise_pr" };
  if (isBaseBranch(info.sourceBranch, repo.defaultBranch, info.targetBranch)) {
    return { ok: false, error: "base_branch" };
  }

  const lang = await getContentLanguage(db);
  const who = await emailOf(db, actor.id);
  const adopted = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ticketId}))`);
    const [locked] = await tx
      .select({ adoptedAt: ticketRepositories.adoptedAt, releasedAt: ticketRepositories.adoptionReleasedAt })
      .from(ticketRepositories)
      .where(and(eq(ticketRepositories.ticketId, ticketId), eq(ticketRepositories.repositoryId, repositoryId)));
    if (locked && locked.adoptedAt !== null && locked.releasedAt === null) return false;
    const now = new Date();
    const adoption = {
      branch: info.sourceBranch,
      prUrl: review.prUrl,
      prNumber: review.prNumber,
      prState: "open" as const,
      adoptedAt: now,
      adoptedByUserId: actor.id,
      adoptionReleasedAt: null,
      adoptionReleasedByUserId: null,
    };
    await tx
      .insert(ticketRepositories)
      .values({ ticketId, repositoryId, ...adoption })
      .onConflictDoUpdate({
        target: [ticketRepositories.ticketId, ticketRepositories.repositoryId],
        set: adoption,
      });
    await tx.insert(comments).values({
      ticketId,
      authorType: "system",
      body: t(lang, "comment.prAdopted", { who, url: review.prUrl, branch: info.sourceBranch }),
    });
    return true;
  });
  if (!adopted) return { ok: false, error: "already_adopted" };

  // La prima correzione: la review di questa PR come indicazione, più la nota.
  // `trigger: "stubwise"` e `actorRole`: un admin, quindi `manualTrigger`
  // (`correctionManualTrigger`), come il suo click su «Chiedi modifiche».
  const note = input.note?.trim();
  const enqueued = await enqueueCorrection(db, {
    ticketId,
    repositoryId,
    prNumber: review.prNumber,
    trigger: "stubwise",
    requestedByUserId: actor.id,
    actorRole: actor.role,
    reviewId: review.id,
    ...(note ? { note } : {}),
  });
  if (!enqueued.ok) {
    (deps.warn ?? ((m: string) => console.warn(m)))(
      `[pr-adoption] PR #${review.prNumber} adottata, ma la prima correzione non è partita (${enqueued.error})`,
    );
  }

  await postPrComment(deps, {
    ...repo,
    prNumber: review.prNumber,
    body: t(lang, "prComment.adopted", { who, branch: info.sourceBranch }),
  });

  return { ok: true, correctionId: enqueued.ok ? enqueued.correctionId : null };
}

/**
 * «Smetti di correggere»: la PR torna a chi l'ha aperta. La riga resta (la PR
 * esiste ancora: chiusura e merge la aggiornano come sempre), marcata
 * rilasciata; le correzioni aperte si annullano (una in corso si ferma prima
 * del push: `runCorrection` rilegge la correzione, la trova `cancelled`); i
 * commit già pushati restano. Commento sul ticket e sulla PR.
 *
 * Ordine: PRIMA la riga rilasciata (sotto il lock del ticket), POI
 * l'annullamento. `enqueueCorrection` rilegge la correggibilità sotto lo
 * stesso lock: un «Request changes» arrivato in mezzo o vede la PR non più
 * correggibile (`pr_not_correctable`) o ha già scritto la sua riga quando
 * l'annullamento la cerca. Stessa forma della chiusura della PR nel webhook.
 */
export async function releaseAdoption(
  deps: AdoptionDeps,
  input: { ticketId: string; repositoryId: string; actor: Actor },
): Promise<ReleaseAdoptionResult> {
  const { db } = deps;
  const { ticketId, repositoryId, actor } = input;
  if (actor.role !== "admin") return { ok: false, error: "forbidden" };

  const lang = await getContentLanguage(db);
  const who = await emailOf(db, actor.id);
  const released = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ticketId}))`);
    const [row] = await tx
      .select({
        id: ticketRepositories.id,
        branch: ticketRepositories.branch,
        prUrl: ticketRepositories.prUrl,
        prNumber: ticketRepositories.prNumber,
        adoptedAt: ticketRepositories.adoptedAt,
        releasedAt: ticketRepositories.adoptionReleasedAt,
      })
      .from(ticketRepositories)
      .where(and(eq(ticketRepositories.ticketId, ticketId), eq(ticketRepositories.repositoryId, repositoryId)));
    if (!row || row.adoptedAt === null || row.releasedAt !== null || row.prNumber === null) return null;
    await tx
      .update(ticketRepositories)
      .set({ adoptionReleasedAt: new Date(), adoptionReleasedByUserId: actor.id })
      .where(eq(ticketRepositories.id, row.id));
    await tx.insert(comments).values({
      ticketId,
      authorType: "system",
      body: t(lang, "comment.prAdoptionReleased", { who, url: row.prUrl ?? "" }),
    });
    return { branch: row.branch, prNumber: row.prNumber };
  });
  if (!released) return { ok: false, error: "not_adopted" };

  await cancelOpenCorrections(
    db,
    { repositoryId, prNumber: released.prNumber },
    { lockTicketIds: [ticketId], logLine: t(lang, "log.adoptionReleasedCancel") },
  );

  const [repo] = await db
    .select({
      provider: repositories.provider,
      repoUrl: repositories.repoUrl,
      defaultBranch: repositories.defaultBranch,
      encryptedCredentials: gitAccounts.encryptedCredentials,
    })
    .from(repositories)
    .innerJoin(gitAccounts, eq(gitAccounts.id, repositories.gitAccountId))
    .where(eq(repositories.id, repositoryId));
  if (repo) {
    await postPrComment(deps, {
      ...repo,
      prNumber: released.prNumber,
      body: t(lang, "prComment.adoptionReleased", { who, branch: released.branch }),
    });
  }
  return { ok: true };
}

/**
 * Il campo `prAdoption` del dettaglio ticket, DERIVATO a lettura (CLAUDE.md,
 * «derivati a lettura»): null per un ticket che non è `review` o senza una
 * review completata. `canManage` col ruolo di CHI GUARDA, mai dedotto dal
 * client (stesso criterio di `canMerge`). Nessuna chiamata al provider: il
 * fork si sa solo se l'evento del webhook l'ha detto (`pr_reviews.from_fork`);
 * quando non lo si sa lo stato è `available`, e l'adozione verifica.
 */
export async function loadPrAdoption(
  db: Db,
  input: { ticketId: string; ticketType: string; ticketStatus: string; viewerRole: ActorRole },
): Promise<PrAdoption | null> {
  if (input.ticketType !== "review") return null;
  const review = await latestReviewOfTicket(db, input.ticketId);
  if (!review) return null;
  const [repo] = await db
    .select({ defaultBranch: repositories.defaultBranch })
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
  const adopted = row !== undefined && row.adoptedAt !== null && row.releasedAt === null;
  const branch = row?.branch ?? review.sourceBranch ?? null;
  const closed = CLOSED_TICKET_STATUSES.has(input.ticketStatus) || (row !== undefined && row.prState !== "open");

  let reason: PrAdoptionUnavailableReason | null = null;
  if (!adopted) {
    if (closed) reason = "pr_closed";
    else if (branch !== null && isStubwiseBranch(branch)) reason = "stubwise_pr";
    else if (review.fromFork === true) reason = "fork";
    else if (branch !== null && isBaseBranch(branch, repo.defaultBranch, review.targetBranch)) reason = "base_branch";
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
    canManage: input.viewerRole === "admin",
  };
}

