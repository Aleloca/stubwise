import {
  aiJobs,
  comments,
  gitAccounts,
  monthlyCostUsd,
  prCorrections,
  prReviewJobs,
  prReviews,
  projects,
  repositories,
  ticketCostUsd,
  ticketRepositories,
  tickets,
  type Db,
} from "@stubwise/db";
import { getProvider, STUBWISE_REVIEW_STATUS_KEY, type GitProvider } from "@stubwise/git";
import { t } from "@stubwise/i18n";
import {
  cancelPendingCorrection,
  completeCorrection,
  decryptGitCredentials,
  prHasOpenCorrection,
  promotePendingForTicket,
  providerFeedbackCutoff,
  resolveProviderUserId,
  selectProviderFeedback,
  MAX_PERMISSION_LOOKUPS_PER_SNAPSHOT,
  WEBHOOK_REVIEW_BODY_ID,
  type ExcludedAuthor,
  type FetchAuthorPermission,
  type FetchPlatformIdentity,
} from "@stubwise/notifications";
import {
  prCommentSchema,
  prNumberFromUrl,
  STUBWISE_BRANCH_RE,
  stubwiseTicketNumber,
  type GitProviderKind,
  type PrComment,
} from "@stubwise/shared";
import { and, count, desc, eq, gt, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { AgentRunError, AgentTimeoutError, type AgentRunUsage } from "../agent/runner.js";
import { BranchNotFoundError, PushRejectedError, mirrorSlug, type MirrorProject } from "../git/mirrors.js";
import { GRAPHIFY_AGENT_ALLOWED_TOOLS, resolveRepoGraphJson } from "../graph/agent-hint.js";
import { openRunPlugins } from "../plugins/materialize-run.js";
import { isLimitError, ProviderLimitError } from "../providers/limit.js";
import {
  appendLog,
  completeJob,
  failJob,
  recordAgentRun,
  touchJob,
  type AiJob,
  type CompleteJobInput,
  type FailJobInput,
} from "../queue.js";
import { enqueuePrReviewNow } from "../review/enqueue.js";
import { getContentLanguage } from "../settings.js";
import { loadProjectEnvFiles, materializeEnvFiles } from "./env-files.js";
import {
  DEFAULT_FIX_ALLOWED_TOOLS,
  DEFAULT_FIX_TIMEOUT_MS,
  DEFAULT_INSTALL_TIMEOUT_MS,
  DEFAULT_SELF_REPAIR_MAX_ATTEMPTS,
  DEFAULT_SELF_REPAIR_TEST_TIMEOUT_MS,
  defaultRunInstallCommand,
  defaultRunTestCommand,
  type FixDeps,
} from "./fix.js";
import { resolveInstallCommand } from "./install-command.js";
import {
  checkBudgetsBeforeRun,
  DEFAULT_SUMMARY_TIMEOUT_MS,
  holdForBudget,
  notifyJobFailed,
  type JobOutcomeContext,
} from "./job-outcomes.js";
import { commitStatusTargetUrl } from "../review/cycle.js";
import { ticketUrl, type NotifyDeps } from "./notify.js";
import { buildCorrectionPrompt, buildCorrectionRepairPrompt, REPORT_FILENAME, toSingleLine } from "./prompts.js";
import { computeReleaseRisk } from "./release-risk.js";
import {
  AgentExitError,
  BudgetExceededError,
  commitAsStubwise,
  gitIn,
  materializeEnvAndInstall,
  newRepoState,
  NoChangesError,
  readAndRemoveReport,
  runSelfRepairLoop,
  SelfRepairFailedError,
  truncateForLog,
  type RepoStepsDeps,
} from "./repo-steps.js";
import { resolveTestCommand } from "./test-command.js";

/**
 * CORREZIONE POST-PR (ciclo review → correzione): applica il feedback — la
 * review AI, una richiesta dal bottone o un "Request changes" dalla
 * piattaforma — a una PR che Stubwise ha GIÀ aperto, sul suo branch.
 *
 * È la pipeline del fix ristretta: un solo repo (quello della PR), worktree
 * sulla head del branch della PR (`fromExistingBranch`), un solo run di
 * esecuzione + self-repair, niente piano, niente `ask_user`, niente
 * `openPullRequest`. I passi per-repo (env di test, install, test, report,
 * commit con esclusione degli env) e gli esiti (budget-held, job.failed con
 * riassunto) sono GLI STESSI del fix: vivono in repo-steps.ts e
 * job-outcomes.ts proprio perché le due pipeline non possano divergere.
 *
 * Il push è in avanti, MAI `--force`: se qualcuno ha pushato sul branch nel
 * frattempo il push è rifiutato e la correzione fallisce dicendolo; la prossima
 * richiesta ripartirà dal branch aggiornato. Prima del push si ricontrolla che
 * la PR sia ancora aperta.
 *
 * Chiusura (contratto di `completeCorrection`): esito terminale del job e
 * `completeCorrection` (libera l'unica `queued` ammessa per PR) in UNA
 * transazione, la seconda solo se il job è stato davvero chiuso; poi, e solo
 * allora, `promotePendingForTicket` e — se questa PR non ha una correzione
 * aperta — `enqueuePrReviewNow`. Anche un fallimento SENZA push a PR aperta
 * (push rifiutato, nessuna modifica, test rossi, errore dell'agente) accoda la
 * review, sulla head ATTUALE del branch: il webhook non la accoda finché la
 * correzione è aperta, e un push di una persona arrivato nel frattempo non lo
 * rivedrebbe nessuno. A ownership persa non si fa niente: il job è
 * di chi l'ha ripreso. Correzione annullata (PR chiusa) mentre si lavorava:
 * prima del push → niente push, job `skipped`; dopo il push → niente review né
 * promozione. `held`/`limit` lasciano la correzione `queued` (niente review:
 * il job non è terminale e verrà ripreso).
 *
 * Come runFix, va chiamata SERIALMENTE per progetto (handler.ts).
 */

export type CorrectionOutcome =
  /** Correzione pushata; review riaccodata o richiesta in attesa promossa. */
  | "pushed"
  /** L'agente non ha cambiato niente: giro contato, job failed con la risposta. */
  | "no_changes"
  | "failed"
  /** Tetto di spesa: job in pausa, correzione ancora in coda. */
  | "held"
  /** Limite del provider prima di ogni effetto: il handler fa failover. */
  | "limit"
  /** Niente da fare (PR chiusa, correzione già chiusa o annullata a metà lavoro). */
  | "skipped"
  /**
   * Ownership del job persa (requeueStale l'ha rimesso in coda) PRIMA di poter
   * dichiarare un esito: niente è stato chiuso né comunicato, il job è di chi
   * l'ha ripreso. Solo sui percorsi senza push (col push l'esito resta
   * `pushed`: il push è un fatto).
   */
  | "lost";

export type CorrectionDeps = Omit<FixDeps, "getProviderFn"> & {
  /** Iniettabile nei test: provider FINTO senza HTTP. Default: getProvider. */
  getProviderFn?: (
    kind: GitProviderKind,
  ) => Pick<
    GitProvider,
    | "getPullRequestState"
    | "setCommitStatus"
    | "listPrComments"
    | "getAuthenticatedUserId"
    | "getCollaboratorPermission"
  >;
};

/** Heartbeat durante il run (vedi il gemello in fix.ts): << soglia di staleness. */
const HEARTBEAT_INTERVAL_MS = 60_000;

/** Tetto del titolo del ticket dentro il titolo della PR/commit. */
const TITLE_MAX_CHARS = 200;

/** Tetto della risposta dell'AI nel commento e nella notifica di «nessuna modifica». */
const NO_CHANGES_ANSWER_MAX_CHARS = 1500;

/** Commenti utente del ticket passati al prompt (i più recenti). */
const TEAM_COMMENTS_MAX = 10;

/** La PR è stata chiusa/mergiata mentre la correzione lavorava. */
class PrNoLongerOpenError extends Error {
  constructor() {
    super("la PR non è più aperta: niente push");
    this.name = "PrNoLongerOpenError";
  }
}

/**
 * L'agente ha creato dei commit da sé (una skill, un `git commit` nonostante il
 * prompt): la head del worktree non è più quella di partenza. Non si pusha
 * niente — quei commit non passano dall'esclusione degli env e del report di
 * `commitAsStubwise`, e non si sa cosa contengano.
 */
class AgentCommittedError extends Error {
  constructor(startSha: string, head: string) {
    super(
      `l'agente ha creato dei commit da sé (HEAD ${head.slice(0, 7)} invece di ${startSha.slice(0, 7)}): per sicurezza niente push`,
    );
    this.name = "AgentCommittedError";
  }
}

/**
 * Il corpo della PR per la riga di `pr_review_jobs`: quello dell'ultima review
 * che l'aveva (`pr_reviews.pr_body`, dalla 0081) o dell'ultimo accodamento
 * rimasto; altrimenti vuoto. La review lo legge come contesto della PR.
 */
async function loadPrBody(db: Db, pr: { repositoryId: string; prNumber: number }): Promise<string> {
  const [fromReview] = await db
    .select({ body: prReviews.prBody })
    .from(prReviews)
    .where(
      and(
        eq(prReviews.repositoryId, pr.repositoryId),
        eq(prReviews.prNumber, pr.prNumber),
        isNotNull(prReviews.prBody),
      ),
    )
    .orderBy(desc(prReviews.createdAt))
    .limit(1);
  if (fromReview?.body) return fromReview.body;
  const [fromJob] = await db
    .select({ body: prReviewJobs.prBody })
    .from(prReviewJobs)
    .where(and(eq(prReviewJobs.repositoryId, pr.repositoryId), eq(prReviewJobs.prNumber, pr.prNumber)));
  return fromJob?.body ?? "";
}

/**
 * L'ultimo push di Stubwise sulla PR: il fix che l'ha aperta e ogni correzione
 * che ci ha pushato chiudono in `pr_opened` con `pr_url` della PR. Righe
 * storiche senza job: la creazione di `ticket_repositories`.
 */
async function lastStubwisePushAt(db: Db, ticketId: string, prUrl: string, fallback: Date): Promise<Date> {
  const [row] = await db
    .select({ at: aiJobs.finishedAt })
    .from(aiJobs)
    .where(
      and(
        eq(aiJobs.ticketId, ticketId),
        eq(aiJobs.status, "pr_opened"),
        eq(aiJobs.prUrl, prUrl),
        isNotNull(aiJobs.finishedAt),
      ),
    )
    .orderBy(desc(aiJobs.finishedAt))
    .limit(1);
  return row?.at ?? fallback;
}

/** L'ultima review da applicare: quella della richiesta, o l'ultima completata sulla PR. */
async function loadReview(
  db: Db,
  correction: typeof prCorrections.$inferSelect,
): Promise<{ verdict: "approve" | "request_changes" | null; summary: string | null; prTitle: string } | null> {
  const cols = { verdict: prReviews.verdict, summary: prReviews.summary, prTitle: prReviews.prTitle };
  const [row] =
    correction.reviewId !== null
      ? await db.select(cols).from(prReviews).where(eq(prReviews.id, correction.reviewId))
      : await db
          .select(cols)
          .from(prReviews)
          .where(
            and(
              eq(prReviews.repositoryId, correction.repositoryId),
              eq(prReviews.prNumber, correction.prNumber),
              eq(prReviews.status, "completed"),
            ),
          )
          .orderBy(desc(prReviews.createdAt))
          .limit(1);
  return row ?? null;
}

/**
 * RIFÀ la fotografia dei commenti della PR per una correzione che porta
 * commenti del provider (`providerFeedback !== null`; una `pending` fusa porta
 * l'unione delle fotografie prese ai webhook). Con GLI STESSI helper del
 * webhook (`@stubwise/notifications`, pr-correction-feedback.ts), perché due
 * copie di «quali commenti ha già letto l'AI» divergerebbero: identità degli
 * account propri risolta (e salvata) al primo uso, taglio = ultima correzione
 * conclusa CON fotografia, filtro degli account propri e del PERMESSO (E3:
 * `author_association` fidata come scorciatoia, poi il permesso reale col
 * token principale; una verifica fallita esclude).
 *
 * Tre esiti diversi, di proposito:
 * - identità di un account propria NON risolvibile → si tiene la fotografia
 *   esistente (già filtrata dal server), RIFILTRATA col permesso: rifarla
 *   senza poter escludere i propri account rimetterebbe nel prompt la review
 *   AI come se fosse feedback umano (fail-closed, design §5), ma il filtro del
 *   permesso non ha bisogno delle identità e si applica come nel ripiego qui
 *   sotto; nessuna scrittura, `feedbackComplete` resta false (E1);
 * - lettura dei commenti fallita → la fotografia esistente RIFILTRATA col
 *   permesso (difesa in profondità), `review-body` sempre conservata; nessuna
 *   scrittura, `feedbackComplete` resta false (E1) (fail-open: la richiesta è
 *   già stata accettata, il feedback c'è);
 * - lettura riuscita → la fotografia nuova, più le `review-body` del webhook
 *   che la rilettura scarterebbe (conservate, con una riga nel log), scritta
 *   con `feedbackComplete: true`.
 */
async function refreshProviderFeedback(input: {
  db: Db;
  jobId: string;
  encryptionKey: Buffer;
  provider: Pick<GitProvider, "listPrComments" | "getCollaboratorPermission">;
  fetchIdentity: FetchPlatformIdentity;
  project: MirrorProject;
  /** Account principale e (se c'è) revisore: le identità da escludere. */
  accounts: (typeof gitAccounts.$inferSelect)[];
  correctionId: string;
  pr: { repositoryId: string; prNumber: number };
  /** La fotografia presa ai webhook (quella che la correzione porta). */
  existing: PrComment[];
}): Promise<PrComment[]> {
  const { db, jobId } = input;
  const log = (line: string): Promise<void> =>
    appendLog(db, jobId, `[correction] ${line}`).catch(() => {
      // Log best-effort.
    });
  // Il permesso reale (E3), col token PRINCIPALE (`input.project` è il
  // mirrorProject, con le credenziali dell'account principale). L'errore
  // diventa `unverifiable`; il suo messaggio si tiene per login e finisce
  // nell'UNICA riga di log di quell'autore (logExcluded), non in due.
  // Definito PRIMA delle identità: serve anche al ripiego «identità non
  // risolvibile», che non ha bisogno di sapere chi siamo per rifiltrare.
  const permissionErrors = new Map<string, string>();
  const fetchPermission: FetchAuthorPermission = async (login) => {
    try {
      const get = input.provider.getCollaboratorPermission;
      if (!get) throw new Error(`${input.project.provider}: il provider non sa dire il permesso di un utente`);
      return await get.call(input.provider, input.project, login);
    } catch (err) {
      permissionErrors.set(login, err instanceof Error ? err.message : String(err));
      throw err;
    }
  };
  // UNA riga per autore escluso, col motivo — e, se la piattaforma ha dato
  // errore, il suo messaggio (i GitProviderError non contengono il token).
  const logExcluded = async (excluded: ExcludedAuthor[]): Promise<void> => {
    for (const e of excluded) {
      const why =
        e.detail === "bot"
          ? "account di un bot o di una GitHub App"
          : e.detail === "lookup_limit"
            ? `permesso non verificabile: superato il tetto di ${MAX_PERMISSION_LOOKUPS_PER_SNAPSHOT} verifiche per fotografia`
            : e.reason === "denied"
              ? "senza permesso di scrittura sul repository"
              : `permesso non verificabile (${permissionErrors.get(e.login) ?? "errore sconosciuto"})`;
      await log(`commenti di ${e.login} esclusi dalla fotografia: ${why}`);
    }
  };
  const isWebhookReviewBody = (c: PrComment): boolean => c.id === WEBHOOK_REVIEW_BODY_ID;
  /**
   * I DUE ripieghi (identità non risolvibile, lettura fallita): la fotografia
   * del webhook RIFILTRATA col permesso — difesa in profondità, D2 l'ha già
   * filtrata. La `review-body` resta SEMPRE (D2 ha già ammesso il suo
   * autore). Nessun taglio (è la fotografia della richiesta), nessuna
   * scrittura: feedbackComplete resta false (E1). `ownIds` sono le identità
   * risolte fin lì (anche nessuna): la fotografia esistente le esclude già.
   */
  const refilterExisting = async (ownIds: string[]): Promise<PrComment[]> => {
    const others = input.existing.filter((c) => !isWebhookReviewBody(c));
    const refiltered = await selectProviderFeedback(others, {
      cutoff: null,
      ownIds,
      provider: input.project.provider,
      fetchPermission,
    });
    await logExcluded(refiltered.excludedAuthors);
    return [...input.existing.filter(isWebhookReviewBody), ...refiltered.comments];
  };
  const ownIds: string[] = [];
  for (const account of input.accounts) {
    // Il motivo vero (401, 403 con lo scope mancante, rate limit…) arriva da
    // onError: il messaggio di GitProviderError non contiene il token.
    let identityError: string | null = null;
    const id = await resolveProviderUserId(db, input.encryptionKey, account, input.fetchIdentity, {
      onError: (err) => {
        identityError = err instanceof Error ? err.message : String(err);
      },
    });
    if (id === null) {
      if (identityError !== null) {
        await log(`identità dell'account git ${account.id}: ${identityError}`);
      }
      await log(
        `identità sulla piattaforma dell'account git ${account.id} non risolvibile: tengo la fotografia dei commenti presa alla richiesta, rifiltrata`,
      );
      return refilterExisting(ownIds);
    }
    ownIds.push(id);
  }

  let listed: PrComment[];
  try {
    listed = await input.provider.listPrComments(input.project, input.pr.prNumber);
  } catch (err) {
    await log(
      `commenti della PR non leggibili (${err instanceof Error ? err.message : String(err)}): parto con la fotografia presa alla richiesta, rifiltrata`,
    );
    return refilterExisting(ownIds);
  }
  const cutoff = await providerFeedbackCutoff(db, input.pr);
  // `provider` e `fetchPermission` (E3): obbligatori nel tipo, dimenticarli
  // non compila.
  const selection = await selectProviderFeedback(listed, {
    cutoff,
    ownIds,
    provider: input.project.provider,
    fetchPermission,
  });
  await logExcluded(selection.excludedAuthors);
  // DECISIONE (2): una `review-body` del webhook già ammessa da D2 si
  // CONSERVA se la rilettura non porta QUELLA review (stesso autore, stesso
  // testo): la rilettura la scarterebbe (permesso cambiato o non verificabile,
  // taglio), ma la richiesta è già stata accettata. Se invece la porta, vince
  // la voce `review-<id>`: il testo non entra mai due volte.
  const conserved = input.existing.filter(
    (wb) =>
      isWebhookReviewBody(wb) &&
      !selection.comments.some(
        (c) => c.id.startsWith("review-") && c.authorId === wb.authorId && c.body.trim() === wb.body.trim(),
      ),
  );
  for (const c of conserved) {
    await log(`testo della review di ${c.authorLogin} conservato dalla richiesta: ammesso dal webhook, la rilettura lo scarterebbe`);
  }
  const fresh = [...conserved, ...selection.comments];
  await db
    .update(prCorrections)
    .set({ providerFeedback: fresh, feedbackComplete: true, updatedAt: new Date() })
    .where(eq(prCorrections.id, input.correctionId));
  return fresh;
}

/**
 * Esegue la correzione del job (già `fixing`, `correctionId` valorizzato). Il
 * job viene SEMPRE chiuso qui dentro, tranne `held`/`limit` (come runFix).
 */
export async function runCorrection(deps: CorrectionDeps, job: AiJob): Promise<CorrectionOutcome> {
  const { db, runner, mirrors } = deps;
  const maxTurns = deps.maxTurns ?? 80;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_FIX_TIMEOUT_MS;
  const executeModel = deps.executeModel ?? "sonnet";
  const baseAllowedTools = deps.allowedTools ?? DEFAULT_FIX_ALLOWED_TOOLS;
  const selfRepairMaxAttempts = deps.selfRepairMaxAttempts ?? DEFAULT_SELF_REPAIR_MAX_ATTEMPTS;
  const getProviderFn = deps.getProviderFn ?? getProvider;
  const providerOpt = deps.provider !== undefined ? { provider: deps.provider } : {};
  const lang = await getContentLanguage(db);

  const logLine = (line: string): Promise<void> =>
    appendLog(db, job.id, `[correction] ${line}`).catch(() => {
      // Log best-effort.
    });

  if (job.correctionId === null) {
    // Il handler manda qui solo i job con correction_id: difesa, non un percorso.
    await failJob(db, job.id, { log: "[correction] job senza correzione", error: "job senza correzione" });
    return "failed";
  }
  const [correction] = await db.select().from(prCorrections).where(eq(prCorrections.id, job.correctionId));
  if (!correction) {
    await failJob(db, job.id, {
      log: `[correction] correzione ${job.correctionId} non trovata`,
      error: "correzione del job non trovata",
    });
    return "failed";
  }
  // Solo una correzione `queued` si esegue. `done`/`cancelled` = riga del job
  // riusata da un rilancio (startRun riusa l'ultima riga del ticket) o PR
  // chiusa mentre il job era già reclamato: niente da fare, e soprattutto MAI
  // ricadere nel fix, che ripartirebbe dal default e pusherebbe un branch
  // divergente.
  if (correction.status !== "queued") {
    await completeJob(db, job.id, {
      status: "skipped",
      log: `[correction] la correzione ${correction.id} è già '${correction.status}': niente da fare`,
    });
    return "skipped";
  }

  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, job.ticketId));
  const [row] = await db
    .select({ repository: repositories, account: gitAccounts, projectName: projects.name })
    .from(repositories)
    .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
    .innerJoin(projects, eq(projects.id, repositories.projectId))
    .where(eq(repositories.id, correction.repositoryId));
  const [link] = ticket
    ? await db
        .select()
        .from(ticketRepositories)
        .where(
          and(
            eq(ticketRepositories.ticketId, ticket.id),
            eq(ticketRepositories.repositoryId, correction.repositoryId),
          ),
        )
    : [];

  // Chiusura ATOMICA (contratto di completeCorrection). Nella STESSA
  // transazione: la riga della correzione letta `FOR UPDATE` (l'annullamento
  // della chiusura della PR, D3, la aggiorna: così non ci si incrocia), poi
  // l'esito del job e `completeCorrection`. Tre esiti, e il chiamante fa cose
  // diverse per ciascuno:
  // - "closed": job terminale e correzione `done` — l'unico dopo cui si
  //   comunica (commento, notifica, status), si promuove e si accoda la review;
  // - "cancelled": la correzione NON era più `queued` (la PR è stata chiusa
  //   mentre si lavorava). Il job chiude `skipped`, qualunque esito il
  //   chiamante volesse scrivere: un «fallito» sarebbe falso, il lavoro si è
  //   fermato perché la PR non c'è più. Unica eccezione, `keepIfCancelled`: il
  //   ramo del push chiude comunque `pr_opened` (il push è un fatto). Niente
  //   notifica, niente commento, niente review, niente promozione;
  // - "lost": ownership persa (requeueStale ha rimesso il job in coda): niente
  //   di scritto, la correzione resta `queued` per chi lo riprende.
  let correctionDone = false;
  type Closure = "closed" | "cancelled" | "lost";
  const closeJobAndCorrection = async (
    close: { kind: "complete"; input: CompleteJobInput; keepIfCancelled?: boolean } | { kind: "fail"; input: FailJobInput },
  ): Promise<Closure> => {
    const closure = await db.transaction(async (tx): Promise<Closure> => {
      const [current] = await tx
        .select({ status: prCorrections.status })
        .from(prCorrections)
        .where(eq(prCorrections.id, correction.id))
        .for("update");
      if (current?.status !== "queued") {
        const keep = close.kind === "complete" && close.keepIfCancelled === true;
        const ok = keep
          ? await completeJob(tx, job.id, close.input)
          : await completeJob(tx, job.id, {
              status: "skipped",
              log: `${close.input.log}\n[correction] la correzione non era più in coda (annullata: PR chiusa): job chiuso come saltato`,
            });
        return ok ? "cancelled" : "lost";
      }
      const ok =
        close.kind === "complete"
          ? await completeJob(tx, job.id, close.input)
          : await failJob(tx, job.id, close.input);
      if (!ok) return "lost";
      // Sotto il FOR UPDATE la riga è ancora `queued`: `false` qui sarebbe
      // un'anomalia, e la si tratta come un annullamento (niente seguito).
      return (await completeCorrection(tx, correction.id)) ? "closed" : "cancelled";
    });
    correctionDone = closure === "closed";
    if (closure === "lost") {
      await logLine("ownership del job persa: la correzione resta in coda per chi lo ha ripreso");
    } else if (closure === "cancelled") {
      await logLine("la correzione non era più in coda (annullata: PR chiusa): niente review né promozione");
    }
    return closure;
  };
  // Dopo una chiusura avvenuta (job terminale E correzione `done`): le richieste
  // umane in attesa del TICKET — il job vivo blocca per ticket, quindi una
  // pending su un'altra PR aspettava proprio questa correzione. MAI dentro la
  // transazione di chiusura: lì hasJobInFlight vedrebbe questo job. Non si
  // chiama quando la PR non c'è più o non è nostra: lì fallirebbe allo stesso
  // modo.
  const promotePending = async (): Promise<string[]> => {
    if (!correctionDone) return [];
    try {
      const promoted = await promotePendingForTicket(db, correction.ticketId);
      for (const id of promoted) await logLine(`richiesta di correzione in attesa avviata (${id})`);
      return promoted;
    } catch (err) {
      await logLine(
        `promozione delle richieste in attesa fallita: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  };

  // La PR della correzione è QUELLA che Stubwise ha aperto per QUESTO ticket:
  // branch `stubwise/ticket-<numero del ticket>` e stesso numero di PR (dalla
  // colonna, o dall'URL sulle righe precedenti a C7). Altrimenti si
  // lavorerebbe — e si pusherebbe — su un branch che non è di questa PR.
  const linkPrNumber = link ? (link.prNumber ?? (link.prUrl ? prNumberFromUrl(link.prUrl) : null)) : null;
  if (
    !ticket ||
    !row ||
    !link ||
    !link.prUrl ||
    !STUBWISE_BRANCH_RE.test(link.branch) ||
    stubwiseTicketNumber(link.branch) !== ticket.number ||
    linkPrNumber !== correction.prNumber
  ) {
    const closure = await closeJobAndCorrection({
      kind: "fail",
      input: {
        log: `[correction] PR ${correction.prNumber} del repository ${correction.repositoryId} non è una PR aperta da Stubwise su questo ticket`,
        error: "PR della correzione non trovata o non di Stubwise",
      },
    });
    return closure === "closed" ? "failed" : closure === "cancelled" ? "skipped" : "lost";
  }
  const prUrl = link.prUrl;
  const branch = link.branch;
  if (link.prState !== "open") {
    const closure = await closeJobAndCorrection({
      kind: "complete",
      input: { status: "skipped", log: `[correction] la PR ${prUrl} non è più aperta` },
    });
    // Una PR chiusa non si corregge più: le richieste in attesa sulla stessa
    // PR vanno annullate, o il tick le ripromuoverebbe a ogni giro.
    if (closure !== "lost") {
      const cancelled = await cancelPendingCorrection(db, {
        repositoryId: correction.repositoryId,
        prNumber: correction.prNumber,
      }).catch(() => null);
      if (cancelled !== null) await logLine(`richiesta in attesa ${cancelled} annullata: la PR non è più aperta`);
    }
    return closure === "lost" ? "lost" : "skipped";
  }

  const projectName = row.projectName;
  const notifyDeps: NotifyDeps = {
    ...(deps.publicUrl !== undefined ? { publicUrl: deps.publicUrl } : {}),
    projectName,
    ...(deps.publish !== undefined ? { publish: deps.publish } : {}),
  };
  const url = ticketUrl(deps.publicUrl, ticket.id);
  // Il link dello status di commit segue la STESSA regola della review
  // (`commitStatusTargetUrl`, review/cycle.ts): solo verso un'istanza https
  // non locale — una regola sola per lo status `stubwise-review`.
  const statusUrl = commitStatusTargetUrl(deps.publicUrl, ticket.id);
  const outcomeCtx: JobOutcomeContext = {
    db,
    jobId: job.id,
    ticket: { id: ticket.id, number: ticket.number, title: ticket.title },
    projectName,
    lang,
    url,
    notifyDeps,
    notifyRefs: { projectId: ticket.projectId, ticketId: ticket.id, jobId: job.id },
    runner,
    ...(deps.provider !== undefined ? { provider: deps.provider } : {}),
    ...(deps.summariesEnabled !== undefined ? { summariesEnabled: deps.summariesEnabled } : {}),
    ...(deps.summaryModel !== undefined ? { summaryModel: deps.summaryModel } : {}),
    summaryTimeoutMs: deps.summaryTimeoutMs ?? DEFAULT_SUMMARY_TIMEOUT_MS,
    logPrefix: "[correction]",
  };

  // Tetti di spesa, come il fix. `manual_trigger` lo mette enqueueCorrection:
  // true per una richiesta umana (bottone o piattaforma), che li scavalca come
  // un avvio a mano; false per il ciclo automatico, che il budget mensile ferma.
  const budget = await checkBudgetsBeforeRun(db, {
    ticketId: ticket.id,
    ticketType: ticket.type,
    manualTrigger: job.manualTrigger,
    ticketCostUsdFn: deps.ticketCostUsdFn ?? ticketCostUsd,
    monthlyCostUsdFn: deps.monthlyCostUsdFn ?? monthlyCostUsd,
  });
  if (budget.kind === "held") {
    await holdForBudget(outcomeCtx, budget.scope, budget.limitUsd, budget.spentUsd);
    return "held";
  }
  const { maxCostUsd, ticketCostBaseline } = budget;

  const credentials = decryptGitCredentials(row.account.encryptedCredentials, deps.encryptionKey);
  if (credentials === null) {
    const error = "credenziali dell'account git non decifrabili";
    const closure = await closeJobAndCorrection({
      kind: "fail",
      input: {
        log: `[correction] impossibile decifrare le credenziali dell'account git del repository '${row.repository.name}'`,
        error,
      },
    });
    if (closure !== "closed") return closure === "cancelled" ? "skipped" : "lost";
    await notifyJobFailed(outcomeCtx, error);
    return "failed";
  }
  const mirrorProject: MirrorProject = {
    provider: row.repository.provider,
    repoUrl: row.repository.repoUrl,
    defaultBranch: row.repository.defaultBranch,
    credentials,
  };
  const provider = getProviderFn(mirrorProject.provider);

  // --- Input del prompt -----------------------------------------------------
  const since = await lastStubwisePushAt(db, ticket.id, prUrl, link.createdAt);
  const review = await loadReview(db, correction);
  const teamCommentRows = await db
    .select({ body: comments.body })
    .from(comments)
    .where(
      and(eq(comments.ticketId, ticket.id), eq(comments.authorType, "user"), gt(comments.createdAt, since)),
    )
    .orderBy(desc(comments.createdAt))
    .limit(TEAM_COMMENTS_MAX);
  let feedback: PrComment[] = (() => {
    const parsed = z.array(prCommentSchema).safeParse(correction.providerFeedback ?? []);
    return parsed.success ? parsed.data : [];
  })();
  // La condizione è sul DATO, non sul trigger (revisione di A6). Il test di
  // questa regola lo scrive C8: una correzione con `providerFeedback` non
  // null rilegge i commenti, una con `providerFeedback` null no.
  if (correction.providerFeedback !== null) {
    const [reviewerAccount] =
      row.repository.reviewGitAccountId !== null
        ? await db.select().from(gitAccounts).where(eq(gitAccounts.id, row.repository.reviewGitAccountId))
        : [];
    // Chi è il token sulla piattaforma: la stessa chiamata che fa il server.
    const fetchIdentity: FetchPlatformIdentity = ({ provider: kind, credentials: creds }) =>
      getProviderFn(kind).getAuthenticatedUserId({ credentials: creds });
    // Heartbeat ANCHE qui, non solo nel worktree (C11): la rilettura sta prima
    // del worktree e fa fino a qualche decina di chiamate HTTP (identità,
    // pagine dei commenti, MAX_PERMISSION_LOOKUPS_PER_SNAPSHOT permessi) che
    // nel provider non hanno un timeout loro. Senza battito il tempo fino al
    // primo `last_activity_at` non avrebbe un tetto noto alla config, e
    // requeueStale potrebbe riaccodare un job vivo. Il fix non ha questo tratto.
    const feedbackHeartbeat = setInterval(() => {
      void touchJob(db, job.id).catch(() => {
        // Il prossimo battito riproverà.
      });
    }, deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
    feedbackHeartbeat.unref();
    try {
      feedback = await refreshProviderFeedback({
        db,
        jobId: job.id,
        encryptionKey: deps.encryptionKey,
        provider,
        fetchIdentity,
        project: mirrorProject,
        accounts: [row.account, ...(reviewerAccount ? [reviewerAccount] : [])],
        correctionId: correction.id,
        pr: { repositoryId: correction.repositoryId, prNumber: correction.prNumber },
        existing: feedback,
      });
    } finally {
      clearInterval(feedbackHeartbeat);
    }
  }

  const repoDir = mirrorSlug(mirrorProject.repoUrl);
  const graphJsonPath =
    deps.graphsDir !== undefined ? resolveRepoGraphJson(deps.graphsDir, row.repository.id) : null;
  const allowedTools =
    graphJsonPath !== null ? [...baseAllowedTools, ...GRAPHIFY_AGENT_ALLOWED_TOOLS] : baseAllowedTools;
  const teamComments = teamCommentRows.map((r) => r.body);
  const prompt = buildCorrectionPrompt(
    {
      ticket,
      prUrl,
      branch,
      repo: { dir: repoDir, name: row.repository.name, ...(graphJsonPath !== null ? { graphJsonPath } : {}) },
      review:
        review && review.verdict !== null && review.summary !== null
          ? { verdict: review.verdict, summary: review.summary }
          : null,
      note: correction.note,
      teamComments,
      providerFeedback: feedback.map((c) => ({
        authorLogin: c.authorLogin,
        body: c.body,
        path: c.path,
        line: c.line,
      })),
    },
    lang,
  );

  await logLine(
    `avviata sulla PR ${prUrl} (branch ${branch}, richiesta: ${correction.trigger}, modello ${executeModel})`,
  );

  // Status di commit best-effort: un errore del provider non ferma mai la
  // correzione (la verità sta in Stubwise). `refname` = branch sorgente: su
  // Bitbucket è ciò che lega lo status alla PR.
  const setStatus = async (sha: string, state: "pending" | "success" | "failure", description: string): Promise<void> => {
    try {
      await provider.setCommitStatus(mirrorProject, sha, {
        state,
        key: STUBWISE_REVIEW_STATUS_KEY,
        description,
        ...(statusUrl !== undefined ? { url: statusUrl } : {}),
        refname: branch,
      });
    } catch (err) {
      await logLine(`status di commit non pubblicato (${err instanceof Error ? err.message : String(err)}): proseguo`);
    }
  };
  // La head di PARTENZA, per lo status "in corso" e per rimetterlo a posto se
  // la correzione non pusha (altrimenti resterebbe "in corso" per sempre e, con
  // la review obbligatoria nelle regole del branch, bloccherebbe il merge).
  let startSha: string | null = null;
  const restoreStatus = async (): Promise<void> => {
    if (startSha === null) return;
    if (review?.verdict === "approve") {
      await setStatus(startSha, "success", t(lang, "commitStatus.approved"));
    } else {
      await setStatus(startSha, "failure", t(lang, "commitStatus.correctionFailed"));
    }
  };

  const runPlugins = await openRunPlugins(db, {
    projectId: ticket.projectId,
    ...(deps.pluginsDir !== undefined ? { pluginsDir: deps.pluginsDir } : {}),
    log: (message) => appendLog(db, job.id, message),
  });
  const pluginOpt = runPlugins.options;

  const usages: Array<AgentRunUsage | undefined> = [];
  const recordAllUsages = async (): Promise<void> => {
    for (const usage of usages) {
      await recordAgentRun(db, { jobId: job.id, phase: "fix", usage });
    }
  };
  const steps: RepoStepsDeps = {
    db,
    jobId: job.id,
    encryptionKey: deps.encryptionKey,
    logPrefix: "[correction]",
    loadEnvFilesFn: deps.loadEnvFilesFn ?? loadProjectEnvFiles,
    materializeEnvFilesFn: deps.materializeEnvFilesFn ?? materializeEnvFiles,
    resolveInstallCommandFn: deps.resolveInstallCommandFn ?? resolveInstallCommand,
    runInstallCommand: deps.runInstallCommand ?? defaultRunInstallCommand,
    installTimeoutMs: deps.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
    resolveTestCommandFn: deps.resolveTestCommandFn ?? resolveTestCommand,
    runTestCommand: deps.runTestCommand ?? defaultRunTestCommand,
    testTimeoutMs: deps.testTimeoutMs ?? DEFAULT_SELF_REPAIR_TEST_TIMEOUT_MS,
  };

  // La review di QUESTA PR, se non ha una correzione aperta (appena promossa o
  // in attesa del suo turno: la review arriverà dopo il suo push, o dalla sua
  // chiusura). Errore della lettura → si accoda: una review in più è innocua.
  // I DUE chiamanti la chiamano solo dopo una chiusura avvenuta con la
  // correzione davvero `done` (a ownership persa il job è di chi l'ha ripreso,
  // e una correzione annullata vuol dire PR chiusa): il ramo del push col
  // `return` dopo closeJobAndCorrection, quello del fallimento con la guardia
  // di reviewCurrentHead.
  const enqueueReview = async (headSha: string): Promise<void> => {
    const hasOpen = await prHasOpenCorrection(db, {
      repositoryId: correction.repositoryId,
      prNumber: correction.prNumber,
    }).catch(() => false);
    if (hasOpen) {
      await logLine("richiesta di correzione aperta su questa PR: la review arriverà dopo il suo turno");
      return;
    }
    await enqueuePrReviewNow(db, {
      repositoryId: row.repository.id,
      prNumber: correction.prNumber,
      prUrl,
      prTitle: review?.prTitle ?? `fix: ${toSingleLine(ticket.title, TITLE_MAX_CHARS)} (#${ticket.number})`,
      prBody: await loadPrBody(db, { repositoryId: correction.repositoryId, prNumber: correction.prNumber }).catch(
        () => "",
      ),
      sourceBranch: branch,
      targetBranch: mirrorProject.defaultBranch,
      headSha,
    });
  };
  // Nessun push: la head da rivedere è quella ATTUALE del branch sull'upstream
  // (un collega può averci pushato durante la correzione — il caso del push
  // rifiutato). Letta dal mirror FUORI dalla callback del worktree (il fetch
  // --prune toglierebbe il ref del worktree aperto), sha completo. Non
  // leggibile → una riga di log e niente review: il prossimo evento la accoderà.
  const reviewCurrentHead = async (): Promise<void> => {
    if (!correctionDone) return;
    let head: string;
    try {
      head = await mirrors.resolveBranchHead(mirrorProject, branch);
    } catch (err) {
      await logLine(
        `head attuale del branch ${branch} non leggibile (${err instanceof Error ? err.message : String(err)}): nessuna review accodata`,
      );
      return;
    }
    await logLine(`nessun push: review accodata sulla head attuale ${head.slice(0, 7)} del branch`);
    await enqueueReview(head);
  };

  interface Pushed {
    report: string | null;
    agentOutput: string;
    testStatus: "passed" | "skipped";
    headSha: string;
    /** File dell'intera PR (default...HEAD): l'input del rischio aggiornato. */
    prFiles: string[];
  }
  // Valorizzato SUBITO dopo `pushBranch`, dentro la callback: da lì in poi il
  // push è un fatto, e un'eccezione che arrivasse dopo (smontaggio del
  // worktree nel `finally` di withProjectWorktrees, un passo best-effort che
  // lancia) NON deve raccontare un fallimento né lasciare la PR senza review.
  // `as`: TS non vede l'assegnazione dentro la callback e lo restringerebbe a
  // `null` nel catch.
  let pushed = null as Pushed | null;
  // Nessun commit dell'agente: la head del worktree dev'essere ancora quella di
  // partenza prima di ogni stage/commit di Stubwise (e dopo ogni run). Un
  // commit dell'agente sfuggirebbe altrimenti al rilevamento delle modifiche
  // (status pulito → «nessuna modifica») o finirebbe nel push senza le
  // esclusioni di commitAsStubwise.
  const assertNoAgentCommit = async (dir: string): Promise<void> => {
    const head = (await gitIn(dir, ["rev-parse", "HEAD"])).trim();
    if (startSha !== null && head !== startSha) throw new AgentCommittedError(startSha, head);
  };
  try {
    await mirrors.withProjectWorktrees(
      [mirrorProject],
      branch,
      async ({ parentDir, worktrees }): Promise<void> => {
        const heartbeat = setInterval(() => {
          void touchJob(db, job.id).catch(() => {
            // Il prossimo battito riproverà.
          });
        }, deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
        heartbeat.unref();
        try {
          const wt = worktrees[0]!;
          const state = newRepoState(
            {
              repositoryId: row.repository.id,
              name: row.repository.name,
              installCommand: row.repository.installCommand,
              testCommand: row.repository.testCommand,
            },
            wt.dir,
          );
          startSha = (await gitIn(state.dir, ["rev-parse", "HEAD"])).trim();
          await setStatus(startSha, "pending", t(lang, "commitStatus.correcting"));

          await materializeEnvAndInstall(steps, [state]);

          const result = await runner.run({
            cwd: parentDir,
            prompt,
            model: executeModel,
            permissionMode: "acceptEdits",
            maxTurns,
            timeoutMs,
            allowedTools,
            ...providerOpt,
            ...pluginOpt,
          });
          usages.push(result.usage);
          // Limite PRIMA di ogni effetto (niente commit né push): failover sicuro.
          if (isLimitError(result)) throw new ProviderLimitError(result.output);
          if (result.exitCode !== 0) throw new AgentExitError(result.exitCode, result.output);
          await assertNoAgentCommit(state.dir);

          const loop = await runSelfRepairLoop(steps, {
            states: [state],
            maxAttempts: selfRepairMaxAttempts,
            initialOutput: result.output,
            beforeRepair: () => {
              if (!job.manualTrigger && maxCostUsd != null) {
                const runCost = usages.reduce((sum, u) => sum + (u?.totalCostUsd ?? 0), 0);
                const estimated = ticketCostBaseline + runCost;
                if (estimated >= maxCostUsd) throw new BudgetExceededError("ticket", maxCostUsd, estimated);
              }
            },
            repair: async (redOutput) => {
              const repair = await runner.run({
                cwd: parentDir,
                // NON il prompt di riparazione del fix: quello mette il report
                // nella radice del repo e lo chiama corpo della PR, falso qui.
                prompt: buildCorrectionRepairPrompt(
                  { ticket, teamComments, testOutput: redOutput, repo: { dir: repoDir, name: row.repository.name } },
                  lang,
                ),
                model: executeModel,
                permissionMode: "acceptEdits",
                maxTurns,
                timeoutMs,
                allowedTools: baseAllowedTools,
                ...providerOpt,
                ...pluginOpt,
              });
              usages.push(repair.usage);
              if (isLimitError(repair)) throw new ProviderLimitError(repair.output);
              if (repair.exitCode !== 0) throw new AgentExitError(repair.exitCode, repair.output);
              await assertNoAgentCommit(state.dir);
              return repair.output;
            },
          });

          const report = await readAndRemoveReport(parentDir);
          await assertNoAgentCommit(state.dir);
          await commitAsStubwise(
            state,
            `fix: applica le correzioni richieste (#${ticket.number})\n\n` +
              `Ticket #${ticket.number} — ${toSingleLine(ticket.title, TITLE_MAX_CHARS)}\n` +
              `Correzione automatica di Stubwise AI (richiesta: ${correction.trigger})`,
          );
          // CORREZIONE ANCORA IN CODA? È il nostro dato, e si rilegge PRIMA di
          // chiedere al provider: la chiusura della PR (webhook, D3) porta la
          // riga a `cancelled` senza toccare un job già in lavorazione, ed è qui
          // che il lavoro si ferma. Non è fail-open come lo stato del provider.
          const [current] = await db
            .select({ status: prCorrections.status })
            .from(prCorrections)
            .where(eq(prCorrections.id, correction.id));
          if (current?.status !== "queued") throw new PrNoLongerOpenError();
          // PR ANCORA APERTA? Controllata a ridosso del push. Errore dell'API →
          // si prosegue (fail-open, come il gate della review): il push è in
          // avanti, sul NOSTRO branch, e un commit su una PR appena chiusa non
          // fa danni; un errore transitorio che buttasse via il lavoro sì.
          let prState: "open" | "closed" | "unknown" = "unknown";
          try {
            prState = await provider.getPullRequestState(mirrorProject, correction.prNumber);
          } catch (err) {
            await logLine(
              `stato della PR non verificabile (${err instanceof Error ? err.message : String(err)}): pusho comunque`,
            );
          }
          if (prState === "closed") throw new PrNoLongerOpenError();
          const headSha = (await gitIn(state.dir, ["rev-parse", "HEAD"])).trim();
          // I file dell'intera PR PRIMA del push: dopo, ogni eccezione deve
          // trovare il lavoro già descritto per intero.
          const prFiles = (
            await gitIn(state.dir, ["diff", "--name-only", `refs/heads/${mirrorProject.defaultBranch}...HEAD`])
          )
            .split("\n")
            .filter((line) => line.length > 0);
          const testStatus = loop.testStatusByRepo.get(state.prepared.repositoryId) ?? "skipped";
          // MAI --force: un rifiuto è PushRejectedError, gestito sotto.
          await mirrors.pushBranch(mirrorProject, branch);
          pushed = { report, agentOutput: loop.output, testStatus, headSha, prFiles };
        } finally {
          clearInterval(heartbeat);
        }
      },
      { fromExistingBranch: true },
    );
  } catch (err) {
    if (pushed !== null) {
      // DOPO il push: il lavoro c'è, sulla PR. Si prosegue come un successo
      // (qui sotto, fuori dal catch) invece di chiudere `failed` una
      // correzione pushata e lasciarla senza review.
      await logLine(
        `errore dopo il push (${err instanceof Error ? err.message : String(err)}): il push c'è, proseguo come riuscita`,
      );
    } else {
      return await handleNoPush(err);
    }
  } finally {
    await runPlugins.cleanup().catch(async (err: unknown) => {
      await logLine(`pulizia dei plugin del run fallita: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  if (pushed === null) {
    // Impossibile: la callback o pusha o lancia. Difesa, non un percorso.
    return handleNoPush(new Error("la correzione è terminata senza push né errore"));
  }
  return finishPushed(pushed);

  // --- Esito senza push -----------------------------------------------------
  async function handleNoPush(err: unknown): Promise<CorrectionOutcome> {
    await recordAllUsages().catch(() => undefined);
    // Fallimento comune: job failed + correzione chiusa (conta come giro) in
    // una transazione; SOLO se la chiusura è avvenuta ("closed"), status
    // rimesso a posto, `afterClose` (es. il commento sul ticket), richiesta in
    // attesa promossa, notifica + riassunto. Correzione annullata a metà
    // ("cancelled", PR chiusa): job `skipped` e nient'altro. Ownership persa
    // ("lost"): non si tocca niente, il job è di chi lo ha ripreso.
    //
    // Poi, come ULTIMO passo, la review della head ATTUALE del branch (regola
    // del coordinatore, 30 set 2026): il webhook `opened`/`updated` non accoda
    // la review mentre sulla PR c'è una correzione aperta (D3), quindi un push
    // di una persona arrivato durante questa correzione non lo rivedrebbe
    // nessuno. Vale per ogni fallimento a PR ancora aperta; `reviewHead:
    // false` dove non c'è una head da rivedere (branch sparito).
    const fail = async (
      log: string,
      error: string,
      opts: { promote?: boolean; reviewHead?: boolean; afterClose?: () => Promise<void> } = {},
    ): Promise<CorrectionOutcome> => {
      const closure = await closeJobAndCorrection({ kind: "fail", input: { log, error } });
      if (closure === "lost") return "lost";
      if (closure === "cancelled") return "skipped";
      await restoreStatus();
      if (opts.afterClose) await opts.afterClose();
      if (opts.promote ?? true) await promotePending();
      await notifyJobFailed(outcomeCtx, error);
      if (opts.reviewHead ?? true) await reviewCurrentHead();
      return "failed";
    };
    if (err instanceof ProviderLimitError) {
      // Nessuna chiusura: il handler fa failover sulla credenziale successiva.
      // Lo status resta «in corso» apposta: il job riprenderà e lo riscriverà
      // lui (e con la catena esaurita il job va `held`, ancora vivo).
      await appendLog(db, job.id, "[correction] provider AI al limite di rate/usage: failover");
      return "limit";
    }
    if (err instanceof BudgetExceededError) {
      // Status rimesso SOLO se il hold è avvenuto: a ownership persa il job è
      // di chi l'ha ripreso, e lo status lo scrive lui.
      const held = await holdForBudget(outcomeCtx, err.scope, err.limitUsd, err.spentUsd);
      if (held) await restoreStatus();
      return held ? "held" : "lost";
    }
    if (err instanceof PrNoLongerOpenError) {
      const closure = await closeJobAndCorrection({
        kind: "complete",
        input: {
          status: "skipped",
          log: `[correction] la PR ${prUrl} è stata chiusa durante la correzione: niente push`,
        },
      });
      return closure === "lost" ? "lost" : "skipped";
    }
    if (err instanceof NoChangesError) {
      // Conta come giro e la risposta dell'AI va a chi ha chiesto: spesso la
      // review (o la nota) chiedeva una cosa sbagliata, ed è proprio questo che
      // l'AI ha scritto invece di cambiare il codice.
      const answer = truncateForLog(err.agentOutput.trim()).slice(0, NO_CHANGES_ANSWER_MAX_CHARS);
      const outcome = await fail(
        `[correction] output agente:\n${truncateForLog(err.agentOutput)}\n[correction] nessuna modifica prodotta: niente push`,
        `nessuna modifica prodotta: ${toSingleLine(answer, NO_CHANGES_ANSWER_MAX_CHARS)}`,
        {
          afterClose: async () => {
            await db.insert(comments).values({
              ticketId: ticket!.id,
              authorType: "ai",
              body: `${t(lang, "comment.correctionNoChanges", { url: prUrl })}\n\n${answer}`,
            });
          },
        },
      );
      // L'esito dice cosa è successo davvero: «nessuna modifica» solo se il
      // giro si è chiuso come tale.
      return outcome === "failed" ? "no_changes" : outcome;
    }
    if (err instanceof AgentCommittedError) {
      return fail(`[correction] ${err.message}`, err.message);
    }
    if (err instanceof PushRejectedError) {
      return fail(
        `[correction] ${err.message}\n[correction] mai --force: la prossima richiesta ripartirà dal branch aggiornato`,
        `push rifiutato: qualcuno ha pushato sul branch ${branch} durante la correzione`,
      );
    }
    if (err instanceof BranchNotFoundError) {
      // Branch sparito: la PR non si può più correggere. La pending della
      // STESSA PR va annullata, non lasciata lì: il tick
      // (promoteStalePendings) la ripromuoverebbe a ogni giro e ogni giro
      // finirebbe qui. Niente promozione di altre PR da qui (le ripesca il tick).
      return fail(`[correction] ${err.message}`, `branch ${branch} non trovato`, {
        promote: false,
        reviewHead: false,
        afterClose: async () => {
          const cancelled = await cancelPendingCorrection(db, {
            repositoryId: correction!.repositoryId,
            prNumber: correction!.prNumber,
          }).catch(() => null);
          if (cancelled !== null) {
            await logLine(`richiesta in attesa ${cancelled} annullata: il branch della PR non esiste più`);
          }
        },
      });
    }
    if (err instanceof AgentExitError) {
      return fail(
        `[correction] output agente (exit ${err.exitCode}):\n${truncateForLog(err.agentOutput)}\n[correction] exit non-zero: per prudenza niente push`,
        err.message,
      );
    }
    if (err instanceof SelfRepairFailedError) {
      return fail(
        `[correction] output agente:\n${truncateForLog(err.agentOutput)}\n` +
          `[correction] test ancora falliti dopo ${selfRepairMaxAttempts} tentativi di riparazione:\n${truncateForLog(err.testOutput)}\n` +
          `[correction] test rossi: per prudenza niente push`,
        err.message,
      );
    }
    if (err instanceof AgentTimeoutError) {
      return fail(
        `[correction] output parziale prima del timeout:\n${truncateForLog(err.partialOutput)}`,
        `correzione interrotta per timeout dopo ${err.timeoutMs}ms`,
      );
    }
    if (err instanceof AgentRunError) {
      return fail(`[correction] agente non eseguibile: ${err.message}`, err.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    return fail(`[correction] errore: ${message}`, message);
  }

  // --- Esito col push -------------------------------------------------------
  async function finishPushed(done: Pushed): Promise<CorrectionOutcome> {
    await recordAllUsages().catch(async (err: unknown) => {
      await logLine(`consumi del run non registrati: ${err instanceof Error ? err.message : String(err)}`);
    });
    // Rischio aggiornato e commento «applicata»: BEST-EFFORT. La chiusura del
    // job e la review non devono dipendere da loro — un errore qui lascerebbe
    // una correzione pushata con un job ancora `fixing` e la PR senza review.
    try {
      // Rischio sull'INTERA PR (default...HEAD), non solo su questo giro: una
      // correzione che tocca una migrazione alza il rischio della PR. Il numero
      // di repository resta quello delle PR aperte del ticket, così un fix
      // multi-repo non perde il suo rischio di coordinamento.
      const [openPrs] = await db
        .select({ value: count() })
        .from(ticketRepositories)
        .where(and(eq(ticketRepositories.ticketId, ticket!.id), eq(ticketRepositories.prState, "open")));
      const risk = computeReleaseRisk(done.prFiles, Math.max(1, openPrs?.value ?? 1));
      await db
        .update(ticketRepositories)
        .set({ testStatus: done.testStatus, risk: risk.level, riskReason: risk.reason })
        .where(eq(ticketRepositories.id, link!.id));
    } catch (err) {
      await logLine(`rischio della PR non aggiornato: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const reportBody =
        done.report !== null ? done.report.trim() : t(lang, "comment.reportMissing", { filename: REPORT_FILENAME });
      await db.insert(comments).values({
        ticketId: ticket!.id,
        authorType: "ai",
        body: `${t(lang, "comment.correctionApplied", { url: prUrl })}\n\n${reportBody}`,
      });
    } catch (err) {
      await logLine(`commento sul ticket non scritto: ${err instanceof Error ? err.message : String(err)}`);
    }
    await closeJobAndCorrection({
      kind: "complete",
      // Il push c'è stato: anche con la correzione annullata dopo il controllo
      // il job dice `pr_opened`, ma senza review né promozione.
      keepIfCancelled: true,
      input: {
        status: "pr_opened",
        log:
          `[correction] output agente:\n${truncateForLog(done.agentOutput)}\n` +
          `[correction] pushato ${done.headSha.slice(0, 7)} su ${branch}` +
          (done.report === null ? `\n[correction] attenzione: ${REPORT_FILENAME} non trovato` : ""),
        prUrl,
      },
    });
    // Ownership persa DOPO il push: il push resta (è un fatto), ma la
    // correzione è ancora `queued` e il job è di chi l'ha ripreso — né
    // promozione né review da qui. Correzione annullata (PR chiusa) dopo il
    // controllo pre-push: il push c'è stato, ma la PR non si corregge più — né
    // promozione né review (la riga di log l'ha scritta closeJobAndCorrection).
    if (!correctionDone) return "pushed";

    // Dopo il push: prima le richieste umane in attesa del ticket; poi la review
    // di QUESTA PR, se non ha una correzione aperta. Sulla head ATTUALE del
    // branch, non su quella pushata: un push umano arrivato nei secondi fra il
    // nostro push e la chiusura sarebbe rimasto senza review (il webhook non la
    // accoda con la correzione aperta). Head non leggibile → quella pushata.
    // L'accodamento è l'ULTIMO passo del job (emendamento «la review esiste dal
    // claim», C10): niente scritture, notifiche o commenti DOPO di lui.
    await promotePending();
    let head = done.headSha;
    try {
      head = await mirrors.resolveBranchHead(mirrorProject!, branch);
    } catch (err) {
      await logLine(
        `head attuale del branch non leggibile (${err instanceof Error ? err.message : String(err)}): review sulla head pushata`,
      );
    }
    await enqueueReview(head);
    return "pushed";
  }
}
