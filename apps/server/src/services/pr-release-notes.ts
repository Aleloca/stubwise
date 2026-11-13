import { gitAccounts, prReleaseNotes, prReviews, projects, repositories, ticketRepositories, tickets, type Db } from "@stubwise/db";
import { getProvider, type GitProvider } from "@stubwise/git";
import { decryptGitCredentials } from "@stubwise/notifications";
import { citedTaskCodes, releaseNotesDraft, type GitProviderKind, type PrReleaseNotes } from "@stubwise/shared";
import { and, eq, inArray, ne } from "drizzle-orm";
import { projectPermissionsFor } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { ReleaseError } from "./releases.js";

/**
 * LE NOTE DI RILASCIO DI UNA PR (area 8, F1, S9). Leggere: chi vede il
 * progetto del repository (404 altrimenti). Scrivere: `release.merge` o
 * `tickets.edit` nel progetto (come `permissions.editReleaseNotes` di
 * `/pulls`). Il testo si FERMA nel rilascio al merge (`recordRelease`).
 *
 * La bozza è CALCOLATA a ogni lettura, mai salvata e mai scritta da un
 * modello (`releaseNotesDraft` di shared): una riga per task, dalla task
 * della PR (la riga `ticket_repositories` di un fix di Stubwise; il ticket
 * `review` di una PR di un collega non è una task da annunciare) e dai
 * commit della PR che citano un codice del progetto. Solo task del progetto
 * della PR: un codice di un altro progetto o inesistente non dà righe (la
 * bozza non inventa task). I commit si leggono dal provider; un errore non fa
 * fallire la lettura (`commitsRead: false`).
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;
type ProviderFor = (kind: GitProviderKind) => Pick<GitProvider, "getPullRequestCommits">;

async function scopeOf(db: Db, viewer: Viewer, repositoryId: string, prNumber: number) {
  const [repo] = await db
    .select({ repository: repositories, account: gitAccounts, projectCode: projects.code })
    .from(repositories)
    .innerJoin(gitAccounts, eq(gitAccounts.id, repositories.gitAccountId))
    .innerJoin(projects, eq(projects.id, repositories.projectId))
    .where(eq(repositories.id, repositoryId));
  const perms = repo ? await projectPermissionsFor(db, viewer, repo.repository.projectId) : null;
  if (!repo || !perms) throw new ReleaseError(404, "not_found", "Not found");
  // La PR deve essere nota a Stubwise: una riga di un fix o una review.
  const [link] = await db
    .select({ ticketNumber: tickets.number, ticketType: tickets.type })
    .from(ticketRepositories)
    .innerJoin(tickets, eq(tickets.id, ticketRepositories.ticketId))
    .where(and(eq(ticketRepositories.repositoryId, repositoryId), eq(ticketRepositories.prNumber, prNumber), ne(tickets.type, "review")));
  const [review] = link
    ? [undefined]
    : await db.select({ id: prReviews.id }).from(prReviews).where(and(eq(prReviews.repositoryId, repositoryId), eq(prReviews.prNumber, prNumber))).limit(1);
  if (!link && !review) throw new ReleaseError(404, "pr_not_found", "This pull request is not known to Stubwise");
  return { ...repo, perms, ownTaskCode: link ? `${repo.projectCode}-${link.ticketNumber}` : null };
}

export async function getPrReleaseNotes(
  db: Db,
  encryptionKey: Buffer,
  viewer: Viewer,
  input: { repositoryId: string; prNumber: number },
  providerFor: ProviderFor = getProvider,
): Promise<PrReleaseNotes> {
  const scope = await scopeOf(db, viewer, input.repositoryId, input.prNumber);
  const [saved] = await db
    .select()
    .from(prReleaseNotes)
    .where(and(eq(prReleaseNotes.repositoryId, input.repositoryId), eq(prReleaseNotes.prNumber, input.prNumber)));

  let commitMessages: string[] = [];
  let commitsRead = false;
  const credentials = decryptGitCredentials(scope.account.encryptedCredentials, encryptionKey);
  if (credentials) {
    const read = await providerFor(scope.repository.provider).getPullRequestCommits(
      { repoUrl: scope.repository.repoUrl, defaultBranch: scope.repository.defaultBranch, credentials },
      input.prNumber,
    );
    if (read.status === "ok") {
      commitMessages = read.messages;
      commitsRead = true;
    }
  }
  // Le task dei codici citati, SOLO del progetto della PR (prefisso = codice del progetto).
  const prefix = `${scope.projectCode}-`;
  const numbers = citedTaskCodes(scope.ownTaskCode, commitMessages)
    .filter((c) => c.startsWith(prefix))
    .map((c) => Number(c.slice(prefix.length)))
    .filter((n) => Number.isSafeInteger(n));
  const found = numbers.length
    ? await db
        .select({ number: tickets.number, title: tickets.title })
        .from(tickets)
        .where(and(eq(tickets.projectId, scope.repository.projectId), inArray(tickets.number, numbers)))
    : [];
  const draft = releaseNotesDraft({
    ownTaskCode: scope.ownTaskCode,
    commitMessages,
    tasks: found.map((t) => ({ code: `${prefix}${t.number}`, title: t.title })),
  });
  return {
    repositoryId: input.repositoryId,
    prNumber: input.prNumber,
    body: saved?.body ?? null,
    updatedById: saved?.updatedBy ?? null,
    updatedAt: saved?.updatedAt.toISOString() ?? null,
    draft,
    commitsRead,
    canEdit: scope.perms.has("release.merge") || scope.perms.has("tickets.edit"),
  };
}

export async function putPrReleaseNotes(
  db: Db,
  encryptionKey: Buffer,
  viewer: Viewer,
  input: { repositoryId: string; prNumber: number; body: string },
  providerFor: ProviderFor = getProvider,
): Promise<PrReleaseNotes> {
  const scope = await scopeOf(db, viewer, input.repositoryId, input.prNumber);
  if (!scope.perms.has("release.merge") && !scope.perms.has("tickets.edit")) {
    throw new ReleaseError(403, "forbidden", "You can't edit the release notes of this pull request");
  }
  const now = new Date();
  await db
    .insert(prReleaseNotes)
    .values({ repositoryId: input.repositoryId, prNumber: input.prNumber, body: input.body, updatedBy: viewer.id, updatedAt: now })
    .onConflictDoUpdate({ target: [prReleaseNotes.repositoryId, prReleaseNotes.prNumber], set: { body: input.body, updatedBy: viewer.id, updatedAt: now } });
  return getPrReleaseNotes(db, encryptionKey, viewer, input, providerFor);
}
