import { and, desc, eq, inArray } from "drizzle-orm";
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
import {
  getProvider,
  MergeNotAllowedError,
  parsePrNumberFromUrl,
  type GitProvider,
  type PullRequestChecks,
} from "@stubwise/git";
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
 * Due sorgenti (review fix Task 1): una PR nata dal fix (`ticket_repositories`,
 * con `prState`/`prUrl` come fonte di verità) o una PR aperta a mano fuori da
 * Stubwise ma rivista dall'automazione PR review (`pr_reviews`, che non ha un
 * `prState` — lo stato si legge LIVE dal provider). Il chiamante (la rotta)
 * passa sempre `ticketId` + `repositoryId`: per una PR esterna, `ticketId` è
 * il ticket di tipo `review` che `run-review.ts` crea (o riusa) per quella PR.
 */

export type ReleasePullRequestError =
  | "forbidden"
  | "not_found"
  | "already_closed"
  | "checks_failed"
  | "checks_unreadable"
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

/**
 * Check + merge su una PR GIÀ risolta come aperta (fase 8, review fix
 * condivisa fra la sorgente interna ed esterna: prima di questo punto le due
 * strade divergono su COME sanno che la PR è aperta, da qui in poi è lo
 * stesso identico controllo).
 */
async function releaseAt(
  provider: GitProvider,
  gitConfig: { repoUrl: string; defaultBranch: string; credentials: GitCredentials },
  prNumber: number,
): Promise<ReleasePullRequestResult> {
  // Check rossi → non si rilascia. pending/no_checks passano: la scelta di
  // rilasciare senza un verdetto certo resta dell'admin, che li vede in coda.
  // `unknown` (review fix Task 2) è un TERZO caso, mai confuso con
  // `no_checks`: un errore di lettura blocca, non apre — altrimenti una PR
  // coi check DAVVERO rossi diventerebbe rilasciabile ogni volta che la
  // lettura del provider fallisce nell'istante sbagliato.
  const checks = await provider.getPullRequestChecks(gitConfig, prNumber, { fetchImpl: fetch });
  if (checks.status === "failure") return { ok: false, error: "checks_failed" };
  if (checks.status === "unknown") return { ok: false, error: "checks_unreadable" };

  try {
    const result = await provider.mergePullRequest(gitConfig, prNumber, { fetchImpl: fetch });
    // NIENTE update di ticket_repositories/notifiche qui: il merge fa
    // scattare il webhook del provider, che chiude già il ticket (fix o
    // review) e pubblica job.pr_closed (design fase 8 §4) — la stessa
    // strada di un merge fatto a mano su GitHub/Bitbucket. Duplicare quella
    // logica qui aprirebbe una corsa fra due scritture indipendenti sullo
    // stesso stato.
    return { ok: true, sha: result.sha };
  } catch (error) {
    if (error instanceof MergeNotAllowedError) {
      if (error.reason === "forbidden") return { ok: false, error: "merge_forbidden" };
      if (error.reason === "not_mergeable") {
        // `MergeFailureReason` non distingue più "conflitti reali" da "PR
        // già mergiata da qualcun altro" (review fix Task 4: nessun
        // provider lanciava mai "already_merged", un ramo dichiarato e mai
        // raggiungibile è peggio di uno assente). La distinzione, quando
        // conta, la fa QUESTO chiamante rileggendo lo stato LIVE — non
        // inferendola dallo status HTTP del fallimento del merge.
        // Best-effort: se anche questa rilettura fallisce, riportiamo
        // l'errore originale del merge, non lo nascondiamo dietro un
        // secondo fallimento.
        try {
          const state = await provider.getPullRequestState(gitConfig, prNumber, { fetchImpl: fetch });
          if (state === "closed") return { ok: false, error: "already_closed" };
        } catch {
          // vedi sopra: fallback sul not_mergeable originale.
        }
      }
      return { ok: false, error: "not_mergeable" };
    }
    throw error;
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

  if (row) {
    const { tr, repository, account } = row;
    // PR già chiusa (mergiata da qualcun altro, o rifiutata): risposta
    // pulita, nessuna chiamata al provider — non c'è nulla da rilasciare.
    if (tr.prState !== "open" || tr.prUrl === null) {
      return { ok: false, error: "already_closed" };
    }
    const prNumber = parsePrNumberFromUrl(tr.prUrl);
    if (prNumber === null) return { ok: false, error: "merge_failed" };
    const credentials = decryptCredentials(account.encryptedCredentials, encryptionKey);
    if (!credentials) return { ok: false, error: "merge_failed" };
    const gitConfig = { repoUrl: repository.repoUrl, defaultBranch: repository.defaultBranch, credentials };
    return releaseAt(getProvider(repository.provider), gitConfig, prNumber);
  }

  // Nessuna riga ticket_repositories: prova la sorgente ESTERNA (review fix
  // Task 1) — una PR aperta fuori da Stubwise ma rivista dall'automazione PR
  // review, il cui ticket (tipo `review`) è quello passato dal chiamante. La
  // review PIÙ RECENTE, se ce ne sono state più d'una (re-review sullo
  // stesso PR aggiornano lo stesso ticket).
  const [externalRow] = await db
    .select({ review: prReviews, repository: repositories, account: gitAccounts })
    .from(prReviews)
    .innerJoin(repositories, eq(prReviews.repositoryId, repositories.id))
    .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
    .where(and(eq(prReviews.ticketId, ticketId), eq(prReviews.repositoryId, repositoryId)))
    .orderBy(desc(prReviews.createdAt))
    .limit(1);
  if (!externalRow) return { ok: false, error: "not_found" };

  const { review, repository, account } = externalRow;
  const credentials = decryptCredentials(account.encryptedCredentials, encryptionKey);
  if (!credentials) return { ok: false, error: "merge_failed" };
  const gitConfig = { repoUrl: repository.repoUrl, defaultBranch: repository.defaultBranch, credentials };
  const provider = getProvider(repository.provider);

  // `pr_reviews` non ha un `prState` (a differenza di `ticket_repositories`):
  // non è mai stato progettato per essere la fonte di verità sullo stato
  // della PR, solo del suo VERDETTO. Si legge LIVE — un errore qui blocca il
  // rilascio invece di procedere alla cieca su uno stato sconosciuto.
  let state: "open" | "closed";
  try {
    state = await provider.getPullRequestState(gitConfig, review.prNumber, { fetchImpl: fetch });
  } catch {
    return { ok: false, error: "merge_failed" };
  }
  if (state !== "open") return { ok: false, error: "already_closed" };

  return releaseAt(provider, gitConfig, review.prNumber);
}

/**
 * La coda di rilascio (fase 8, Task 9-10; review fix Task 1): TUTTE le PR
 * aperte sui repository collegati, **di qualunque origine** — la review le
 * tratta già tutte allo stesso modo (design §4), e prima di questo fix la
 * funzione lo PROMETTEVA senza mantenerlo: partiva solo da
 * `ticket_repositories`, che scrive SOLO la pipeline di fix — una PR aperta a
 * mano (che riceve comunque verdetto, riassunto, commento sticky e un ticket
 * di tipo `review` se `pr_review_enabled` è acceso) non compariva mai.
 *
 * Due sorgenti, dedup per `(repositoryId, prNumber)`:
 *  - INTERNE (`ticket_repositories`, `prState = 'open'`): hanno test interno e
 *    rischio, perché la pipeline li ha calcolati aprendo la PR.
 *  - ESTERNE (`pr_reviews`, nessuna riga interna per lo stesso PR): hanno
 *    verdetto e riassunto (dalla review), MAI test interno né rischio —
 *    `null` per un motivo STRUTTURALE (Stubwise non ha mai eseguito nulla su
 *    quella PR), non "non ancora calcolato" — lo dice `origin: "external"`
 *    nello schema, non un `null` generico.
 *
 * `pr_reviews` non registra lo stato della PR (a differenza di
 * `ticket_repositories.prState`): "è ancora aperta?" si decide così —
 * (1) candidati = l'ULTIMA review per ogni (repository, prNumber) che questa
 * lista non ha già dalla sorgente interna; (2) filtro economico: se il
 * ticket collegato è già `done`/`closed` (il webhook di merge/chiusura lo fa
 * per i ticket di tipo `review`, vedi `webhooks.ts`), la PR è quasi
 * certamente chiusa — SALTATO senza una chiamata al provider; (3) per i
 * candidati rimasti, `getPullRequestState` LIVE decide per davvero — mai una
 * PR mostrata come aperta sulla sola fiducia nel webhook, che può non essere
 * arrivato. Il costo (una chiamata in più per candidato "forse aperto") è
 * limitato dal filtro (2): solo le review i cui ticket sono ancora aperti lo
 * pagano.
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
  const internalRows = allRows.filter(
    (r): r is typeof r & { tr: { prUrl: string } } => r.tr.prUrl !== null,
  );

  // Chiave di dedup: le PR interne "occupano" (repositoryId, prNumber), le
  // candidate esterne con la stessa chiave sono già rappresentate (con la
  // loro review già unita sotto, come sempre) e non vanno duplicate.
  const internalKeys = new Set(
    internalRows.map((r) => `${r.repository.id}:${parsePrNumberFromUrl(r.tr.prUrl)}`),
  );

  // Review: LEFT JOIN manuale via una seconda query (repositoryId, prUrl) —
  // niente in comune con una query unica perché pr_reviews non ha FK verso
  // ticket_repositories (sono scritte da percorsi indipendenti: fix vs
  // automazione review). Serve alle righe INTERNE (verdetto/riassunto);
  // quelle esterne il verdetto ce l'hanno già dalla query dei candidati sotto.
  const internalPrUrls = internalRows.map((r) => r.tr.prUrl);
  const reviewRows = internalPrUrls.length > 0
    ? await db
        .select({
          repositoryId: prReviews.repositoryId,
          prUrl: prReviews.prUrl,
          verdict: prReviews.verdict,
          prSummary: prReviews.prSummary,
        })
        .from(prReviews)
        .where(inArray(prReviews.prUrl, internalPrUrls))
    : [];
  const reviewByKey = new Map(reviewRows.map((r) => [`${r.repositoryId}:${r.prUrl}`, r]));

  // Candidati esterni: l'ULTIMA review per ogni (repository, prNumber) di
  // TUTTA l'istanza — non c'è un altro modo di sapere quali PR esterne
  // Stubwise conosce, se non guardare cosa ha già rivisto.
  const latestExternalReviews = await db
    .selectDistinctOn([prReviews.repositoryId, prReviews.prNumber], {
      repositoryId: prReviews.repositoryId,
      prNumber: prReviews.prNumber,
      prUrl: prReviews.prUrl,
      prTitle: prReviews.prTitle,
      ticketId: prReviews.ticketId,
      verdict: prReviews.verdict,
      prSummary: prReviews.prSummary,
      createdAt: prReviews.createdAt,
    })
    .from(prReviews)
    .orderBy(prReviews.repositoryId, prReviews.prNumber, desc(prReviews.createdAt));

  const externalCandidates = latestExternalReviews.filter((c) => {
    if (internalKeys.has(`${c.repositoryId}:${c.prNumber}`)) return false;
    // Senza ticketId non c'è un ticket da passare all'azione di rilascio —
    // capita solo quando l'ULTIMA review di quel PR non è andata a buon
    // fine (parse fallito, nessun ticket creato): è un caso raro e si
    // autorisolve alla prossima review riuscita. Va scartato qui, non
    // nascosto più a valle: mostrare una riga senza un modo di rilasciarla
    // sarebbe peggio di non mostrarla.
    if (c.ticketId === null) return false;
    return true;
  });

  // Filtro economico (2): un ticket `review` già done/closed (il webhook di
  // merge/chiusura lo fa scattare, vedi webhooks.ts) è un segnale forte che
  // la PR è chiusa — salta la chiamata al provider per questi. Non è la
  // fonte di verità (il webhook può non essere arrivato): è solo un modo di
  // non pagare una chiamata live per ogni PR mai rivista nella storia
  // dell'istanza.
  const candidateTicketIds = [...new Set(externalCandidates.map((c) => c.ticketId!))];
  const candidateTickets = candidateTicketIds.length > 0
    ? await db
        .select({ id: tickets.id, number: tickets.number, title: tickets.title, status: tickets.status })
        .from(tickets)
        .where(inArray(tickets.id, candidateTicketIds))
    : [];
  const ticketById = new Map(candidateTickets.map((t) => [t.id, t]));
  const maybeOpenCandidates = externalCandidates.filter((c) => {
    const ticket = ticketById.get(c.ticketId!);
    // Ticket sparito (cancellato) o già done/closed: fuori dai candidati.
    if (!ticket || ticket.status === "done" || ticket.status === "closed") return false;
    return true;
  });

  // Repository/account/progetto dei candidati rimasti (batch, niente N+1).
  const candidateRepoIds = [...new Set(maybeOpenCandidates.map((c) => c.repositoryId))];
  const candidateRepoRows = candidateRepoIds.length > 0
    ? await db
        .select({ repository: repositories, project: projects, account: gitAccounts })
        .from(repositories)
        .innerJoin(projects, eq(repositories.projectId, projects.id))
        .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
        .where(inArray(repositories.id, candidateRepoIds))
    : [];
  const repoContextById = new Map(candidateRepoRows.map((r) => [r.repository.id, r]));

  // "Già su staging?": gli ambienti NON-test dei progetti coinvolti (interni
  // + esterni), e l'ultimo campione di ciascun server collegato.
  const allProjectIds = [
    ...new Set([
      ...internalRows.map((r) => r.project.id),
      ...maybeOpenCandidates
        .map((c) => repoContextById.get(c.repositoryId)?.project.id)
        .filter((id): id is string => id !== undefined),
    ]),
  ];
  const stagingEnvironments = allProjectIds.length > 0
    ? await db
        .select()
        .from(projectEnvironments)
        .where(and(inArray(projectEnvironments.projectId, allProjectIds), eq(projectEnvironments.kind, "staging")))
    : [];
  // "production" conta anche come "già rilasciato da qualche parte": una
  // query a sé per lo stesso motivo per cui il CHECK non ammette una lista.
  const productionEnvironments = allProjectIds.length > 0
    ? await db
        .select()
        .from(projectEnvironments)
        .where(and(inArray(projectEnvironments.projectId, allProjectIds), eq(projectEnvironments.kind, "production")))
    : [];
  const deployTargets = [...stagingEnvironments, ...productionEnvironments];
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

  const internalItems = await Promise.all(
    internalRows.map(async ({ tr, ticket, repository, project, account }): Promise<ReleaseQueueItem> => {
      const review = reviewByKey.get(`${repository.id}:${tr.prUrl}`);
      const prNumber = parsePrNumberFromUrl(tr.prUrl);

      // Tipato sulla forma del PACCHETTO git (con headSha/headRef), non su
      // quella pubblica dello schema: serve internamente per deployedOn, mai
      // esposto al client (releaseChecksSchema non ha quei campi).
      let checks: PullRequestChecks = { status: "no_checks", checks: [] };
      const credentials = decryptCredentials(account.encryptedCredentials, encryptionKey);
      if (credentials && prNumber !== null) {
        const gitConfig = { repoUrl: repository.repoUrl, defaultBranch: repository.defaultBranch, credentials };
        checks = await getProvider(repository.provider).getPullRequestChecks(gitConfig, prNumber, {
          fetchImpl: fetch,
        });
      }

      return {
        origin: "stubwise",
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
        // Head sha dalla STESSA lettura dei check (review fix Task 4), MAI
        // dall'artefatto di un'altra automazione (`pr_reviews.headSha`, che
        // esiste solo se la review è girata su QUESTA PR): senza review una
        // PR nata da Stubwise vedrebbe sempre "deployedOn" vuoto anche se lo
        // era davvero.
        deployedOn: deployedOnFor(project.id, checks.headSha),
      };
    }),
  );

  const externalItems = (
    await Promise.all(
      maybeOpenCandidates.map(async (candidate): Promise<ReleaseQueueItem | null> => {
        const ctx = repoContextById.get(candidate.repositoryId);
        const ticket = ticketById.get(candidate.ticketId!);
        if (!ctx || !ticket) return null; // sparito fra le due query, raro.
        const { repository, project, account } = ctx;

        const credentials = decryptCredentials(account.encryptedCredentials, encryptionKey);
        if (!credentials) return null; // credenziali non decifrabili: nessun modo di leggere niente su questa PR.
        const gitConfig = { repoUrl: repository.repoUrl, defaultBranch: repository.defaultBranch, credentials };
        const provider = getProvider(repository.provider);

        // La conferma VERA di "è ancora aperta" (il filtro sul ticket sopra
        // è solo economico, non autoritativo).
        let state: "open" | "closed";
        try {
          state = await provider.getPullRequestState(gitConfig, candidate.prNumber, { fetchImpl: fetch });
        } catch {
          return null; // non siamo riusciti a leggere lo stato: non la mostriamo come aperta alla cieca.
        }
        if (state !== "open") return null;

        const checks = await provider.getPullRequestChecks(gitConfig, candidate.prNumber, { fetchImpl: fetch });

        return {
          origin: "external",
          ticketId: ticket.id,
          ticketNumber: ticket.number,
          ticketTitle: ticket.title,
          repositoryId: repository.id,
          repositoryName: repository.name,
          projectId: project.id,
          projectName: project.name,
          // Il nome del branch reale, dalla stessa lettura dei check — mai
          // stato "stubwise/ticket-N", non è una PR di Stubwise. Se anche
          // quella lettura non lo risolve (checks: "unknown" senza PR
          // risolta), il titolo della PR resta un'etichetta sempre presente.
          branch: checks.headRef ?? candidate.prTitle,
          prUrl: candidate.prUrl,
          prNumber: candidate.prNumber,
          // L'ULTIMA review, non l'apertura della PR: pr_reviews non
          // registra quando la PR è stata aperta, solo quando è stata
          // rivista — la data più vicina che abbiamo.
          createdAt: candidate.createdAt.toISOString(),
          reviewVerdict: candidate.verdict,
          reviewSummary: candidate.prSummary,
          checks,
          // Strutturalmente assenti, non "non ancora calcolati": Stubwise
          // non ha mai eseguito un fix su questa PR. `origin: "external"`
          // lo dice esplicitamente, questi null non vanno confusi con una
          // riga storica pre-fase-8.
          testStatus: null,
          risk: null,
          riskReason: null,
          deployedOn: deployedOnFor(project.id, checks.headSha),
        };
      }),
    )
  ).filter((item): item is ReleaseQueueItem => item !== null);

  return [...internalItems, ...externalItems];
}
