import { and, eq, inArray } from "drizzle-orm";
import {
  decrypt,
  gitAccounts,
  prReviews,
  projectEnvironments,
  projects,
  repositories,
  ticketRepositories,
  tickets,
  type Db,
} from "@stubwise/db";
import { getProvider, MergeNotAllowedError, parsePrNumberFromUrl } from "@stubwise/git";
import type { ReleaseQueueItem } from "@stubwise/shared";
import type { Actor } from "./jobs.js";
import { loadLatestServicesByServer } from "./server-samples.js";

/**
 * Rilascia (mergia) una PR — fase 8, Task 9. **Il cancello che rende vero il
 * secondo divieto della fase 7**: fino a questa fase "gli operatori non
 * mandano niente in produzione" era vero per ASSENZA di funzionalità
 * (nessuna capacità di merge esisteva); da qui in poi deve essere un
 * controllo vero. `actor.role !== "admin"` è verificato QUI, non solo dal
 * `preHandler: requireAdmin` della rotta — stessa difesa in profondità di
 * `preApprovePlan`/`resolvePlan` (jobs.ts): un test verifica sia il 403 sia
 * che nessun merge sia partito.
 *
 * Le due difese di merito, entrambe PRIMA di scrivere qualunque cosa: (1)
 * `prState` deve essere `open` — una PR già chiusa risponde pulito, senza
 * nemmeno interrogare il provider; (2) i check del provider (letti LIVE, mai
 * da una colonna: sono la verità di ADESSO) non devono essere `failure` — una
 * PR coi check rossi non si rilascia, a prescindere da cosa dice l'admin.
 * `pending`/`no_checks` NON bloccano: è una scelta dell'admin che vede la
 * coda, non un'automazione a discrezione.
 */

export type ReleasePullRequestError =
  | "forbidden"
  | "not_found"
  | "already_closed"
  | "checks_failed"
  | "not_mergeable"
  | "merge_forbidden"
  | "merge_failed";

export type ReleasePullRequestResult =
  | { ok: true; sha: string }
  | { ok: false; error: ReleasePullRequestError };

interface GitCredentials {
  username?: string;
  email?: string;
  token: string;
}

/** `null` se le credenziali cifrate dell'account non si decifrano (config errata). */
function decryptCredentials(encryptedCredentials: string, encryptionKey: Buffer): GitCredentials | null {
  try {
    return JSON.parse(decrypt(encryptedCredentials, encryptionKey)) as GitCredentials;
  } catch {
    return null;
  }
}

export async function releasePullRequest(
  db: Db,
  encryptionKey: Buffer,
  input: { ticketId: string; repositoryId: string; actor: Actor },
): Promise<ReleasePullRequestResult> {
  const { ticketId, repositoryId, actor } = input;
  if (actor.role !== "admin") return { ok: false, error: "forbidden" };

  const [row] = await db
    .select({ tr: ticketRepositories, repository: repositories, account: gitAccounts })
    .from(ticketRepositories)
    .innerJoin(repositories, eq(ticketRepositories.repositoryId, repositories.id))
    .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
    .where(
      and(eq(ticketRepositories.ticketId, ticketId), eq(ticketRepositories.repositoryId, repositoryId)),
    );
  if (!row) return { ok: false, error: "not_found" };
  const { tr, repository, account } = row;

  // PR già chiusa (mergiata da qualcun altro, o rifiutata): risposta pulita,
  // nessuna chiamata al provider — non c'è nulla da rilasciare.
  if (tr.prState !== "open" || tr.prUrl === null) {
    return { ok: false, error: "already_closed" };
  }

  const prNumber = parsePrNumberFromUrl(tr.prUrl);
  if (prNumber === null) return { ok: false, error: "merge_failed" };

  const credentials = decryptCredentials(account.encryptedCredentials, encryptionKey);
  if (!credentials) return { ok: false, error: "merge_failed" };

  const gitConfig = {
    repoUrl: repository.repoUrl,
    defaultBranch: repository.defaultBranch,
    credentials,
  };
  const provider = getProvider(repository.provider);

  // Check rossi → non si rilascia. pending/no_checks passano: la scelta di
  // rilasciare senza un verdetto certo resta dell'admin, che li vede in coda.
  const checks = await provider.getPullRequestChecks(gitConfig, prNumber, { fetchImpl: fetch });
  if (checks.status === "failure") return { ok: false, error: "checks_failed" };

  try {
    const result = await provider.mergePullRequest(gitConfig, prNumber, { fetchImpl: fetch });
    // NIENTE update di ticket_repositories/notifiche qui: il merge fa
    // scattare il webhook del provider, che chiude già il ticket e pubblica
    // job.pr_closed (design fase 8 §4) — la stessa strada di un merge fatto
    // a mano su GitHub/Bitbucket. Duplicare quella logica qui aprirebbe una
    // corsa fra due scritture indipendenti sullo stesso stato.
    return { ok: true, sha: result.sha };
  } catch (error) {
    if (error instanceof MergeNotAllowedError) {
      if (error.reason === "forbidden") return { ok: false, error: "merge_forbidden" };
      if (error.reason === "already_merged") return { ok: false, error: "already_closed" };
      return { ok: false, error: "not_mergeable" };
    }
    throw error;
  }
}

/**
 * La coda di rilascio (fase 8, Task 9-10): TUTTE le PR aperte sui repository
 * collegati, di qualunque origine — la review le tratta già tutte allo
 * stesso modo (design §4), quindi nasconderne metà renderebbe la pagina
 * bugiarda. `encryptionKey` serve a decifrare le credenziali per leggere i
 * check LIVE da ogni provider: una riga la cui decifratura fallisce, o il cui
 * URL non si fa risalire a un numero di PR, resta in lista con
 * `checks: { status: "no_checks", checks: [] }` — degradata, mai scomparsa.
 */
export async function listReleaseQueue(db: Db, encryptionKey: Buffer): Promise<ReleaseQueueItem[]> {
  const allRows = await db
    .select({ tr: ticketRepositories, ticket: tickets, repository: repositories, project: projects, account: gitAccounts })
    .from(ticketRepositories)
    .innerJoin(tickets, eq(ticketRepositories.ticketId, tickets.id))
    .innerJoin(repositories, eq(ticketRepositories.repositoryId, repositories.id))
    .innerJoin(projects, eq(repositories.projectId, projects.id))
    .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
    .where(eq(ticketRepositories.prState, "open"));
  // `prState: "open"` implica per costruzione prUrl valorizzato (stesso
  // insert in fix.ts) — filtrata comunque, difensivo: una riga senza URL non
  // ha nulla da mostrare come PR e romperebbe releaseQueueItemSchema (prUrl
  // è un URL, mai una stringa vuota).
  const rows = allRows.filter(
    (r): r is typeof r & { tr: { prUrl: string } } => r.tr.prUrl !== null,
  );
  if (rows.length === 0) return [];

  // Review: LEFT JOIN manuale via una seconda query (repositoryId, prUrl) —
  // niente in comune con una query unica perché pr_reviews non ha FK verso
  // ticket_repositories (sono scritte da percorsi indipendenti: fix vs
  // automazione review).
  const prUrls = rows.map((r) => r.tr.prUrl);
  const reviewRows = prUrls.length > 0
    ? await db
        .select({
          repositoryId: prReviews.repositoryId,
          prUrl: prReviews.prUrl,
          verdict: prReviews.verdict,
          prSummary: prReviews.prSummary,
          headSha: prReviews.headSha,
        })
        .from(prReviews)
        .where(inArray(prReviews.prUrl, prUrls))
    : [];
  const reviewByKey = new Map(reviewRows.map((r) => [`${r.repositoryId}:${r.prUrl}`, r]));

  // "Già su staging?": gli ambienti NON-test dei progetti coinvolti, e
  // l'ultimo campione di ciascun server collegato — stessa lettura della
  // rotta ambienti (Task 4), qui per confrontare l'head sha della PR.
  const projectIds = [...new Set(rows.map((r) => r.project.id))];
  const environments = projectIds.length > 0
    ? await db
        .select()
        .from(projectEnvironments)
        .where(
          and(
            inArray(projectEnvironments.projectId, projectIds),
            eq(projectEnvironments.kind, "staging"),
          ),
        )
    : [];
  // "production" conta anche come "già rilasciato da qualche parte": una
  // query a sé per lo stesso motivo per cui il CHECK non ammette una lista.
  const productionEnvironments = projectIds.length > 0
    ? await db
        .select()
        .from(projectEnvironments)
        .where(
          and(
            inArray(projectEnvironments.projectId, projectIds),
            eq(projectEnvironments.kind, "production"),
          ),
        )
    : [];
  const deployTargets = [...environments, ...productionEnvironments];
  const serverIds = [...new Set(deployTargets.flatMap((e) => (e.serverId ? [e.serverId] : [])))];
  const servicesByServer = await loadLatestServicesByServer(db, serverIds);

  function deployedOnFor(projectId: string, headSha: string | undefined): string[] {
    if (!headSha) return [];
    const names: string[] = [];
    for (const env of deployTargets) {
      if (env.projectId !== projectId || !env.serverId) continue;
      const services = servicesByServer.get(env.serverId) ?? [];
      const match = services.some((s) => s.commitSha !== undefined && headSha.startsWith(s.commitSha));
      if (match) names.push(env.name);
    }
    return names;
  }

  const items = await Promise.all(
    rows.map(async ({ tr, ticket, repository, project, account }): Promise<ReleaseQueueItem> => {
      const review = reviewByKey.get(`${repository.id}:${tr.prUrl}`);
      const prNumber = parsePrNumberFromUrl(tr.prUrl);

      let checks: ReleaseQueueItem["checks"] = { status: "no_checks", checks: [] };
      const credentials = decryptCredentials(account.encryptedCredentials, encryptionKey);
      if (credentials && prNumber !== null) {
        const gitConfig = { repoUrl: repository.repoUrl, defaultBranch: repository.defaultBranch, credentials };
        checks = await getProvider(repository.provider).getPullRequestChecks(gitConfig, prNumber, {
          fetchImpl: fetch,
        });
      }

      return {
        ticketId: ticket.id,
        ticketNumber: ticket.number,
        ticketTitle: ticket.title,
        repositoryId: repository.id,
        repositoryName: repository.name,
        projectId: project.id,
        projectName: project.name,
        branch: tr.branch,
        prUrl: tr.prUrl,
        prNumber,
        createdAt: tr.createdAt.toISOString(),
        reviewVerdict: review?.verdict ?? null,
        reviewSummary: review?.prSummary ?? null,
        checks,
        testStatus: tr.testStatus,
        risk: tr.risk,
        riskReason: tr.riskReason,
        deployedOn: deployedOnFor(project.id, review?.headSha),
      };
    }),
  );

  return items;
}
