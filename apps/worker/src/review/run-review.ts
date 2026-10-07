import {
  agentRuns,
  comments,
  decrypt,
  gitAccounts,
  instanceSettings,
  monthlyCostUsd,
  prReviewJobs,
  prReviews,
  projects,
  repositories,
  tickets,
  type Db,
} from "@stubwise/db";
import { getProvider, type GitProvider } from "@stubwise/git";
import { t, type Language } from "@stubwise/i18n";
import type { DbOrTx } from "@stubwise/notifications";
import { STUBWISE_BRANCH_RE, type GitProviderKind } from "@stubwise/shared";
import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { AgentRunner, AgentRunUsage } from "../agent/runner.js";
import type { MirrorManager, MirrorProject } from "../git/mirrors.js";
import { GRAPHIFY_AGENT_ALLOWED_TOOLS, resolveRepoGraphJson } from "../graph/agent-hint.js";
import {
  computeBlastRadius,
  parseChangedFiles,
  renderBlastRadiusSection,
  type BlastRadius,
} from "../graph/blast-radius.js";
import { toSingleLine } from "../pipeline/prompts.js";
import type { PublishFn } from "../pipeline/notify.js";
import {
  loadProviderById,
  loadProviderChain,
  type ResolvedProvider,
} from "../providers/chain.js";
import { isLimitError } from "../providers/limit.js";
import { generatePrSummary } from "../summaries/pr-summary.js";
import {
  afterReviewCompleted,
  notifyCycleStoppedByFailedReview,
  promotePendingAfterFailedReview,
  resolveReviewSha,
  setReviewCommitStatus,
  type ReviewCycleDeps,
} from "./cycle.js";
import { buildReviewPrompt, parseReviewOutput } from "./prompts.js";

/**
 * PR REVIEW automatica — esecuzione di UN job già reclamato dal poller.
 *
 * Il webhook del server accoda in `pr_review_jobs` (debounce, un pending per
 * (repo, PR)); il poller del worker reclama con DELETE...RETURNING, crea nella
 * STESSA transazione la riga `pr_reviews` IN ATTESA (`insertWaitingReview`,
 * `started_at` null: la review esiste dal claim) e chiama `runPrReview` con
 * l'id di quella riga — come `runAutoUpdate` per l'auto-update dei Docs, il job è già
 * stato consumato: qui è tutto BEST-EFFORT, nessun errore risale al chiamante e
 * nessun percorso rimette il pending in coda (il prossimo push sulla PR ne
 * ricreerà uno) — UNICA eccezione il limite di rate/usage del provider, che
 * riaccoda il job con un cooldown (vedi requeueReviewJob).
 *
 * Flusso (l'ORDINE è parte del contratto, vedi i test):
 *  1. contesto: repository→account git→progetto, credenziali decifrate;
 *  2. GATE toggle: `instance_settings.pr_review_enabled` riletto AL CLAIM (una
 *     sola select porta anche cap per-review, budget mensile e lingua) —
 *     spento → return silenzioso (disabilitato dopo l'accodamento);
 *  3. GATE PR aperta: `getPullRequestState` — chiusa → return (la riga in
 *     attesa la cancella il poller); errore API → warning e si PROSEGUE
 *     (fail-open: meglio una review su una PR appena chiusa che nessuna
 *     review per un errore transitorio);
 *  3-bis. guardia anti-doppione sulla stessa head: una review
 *     `running`/`completed` di quella head, ESCLUSA la propria riga e le righe
 *     in attesa più vecchie di `staleMinutes` (orfane) → return;
 *  4. GATE budget mensile: sforato → la riga in attesa diventa `failed` senza
 *     essere mai partita (`started_at` null, visibile nello storico);
 *  5. provider AI: pinned del progetto o chain[0]; pinned non risolvibile →
 *     riga `failed` senza fallback (come l'auto-update);
 *  6. PARTENZA: la riga del claim si marca partita (`started_at`,
 *     `last_activity_at` = now()) + heartbeat su lastActivityAt (60s, unref);
 *     lo sha COMPLETO della head si risolve qui, UNA volta, e lo status di
 *     commit `stubwise-review` va a `pending` su quello sha (l'esito, o il
 *     `failure` di un fallimento dopo la partenza, va sullo stesso);
 *  7. diff dal mirror + agente read-only (plan) nel worktree alla head; se il
 *     repository ha un grafo sul volume (fase 2d graphify) il prompt riceve il
 *     blocco CODE GRAPH e l'impatto deterministico del diff (blast radius), e
 *     il run l'allowlist dei comandi read-only del CLI;
 *  8. registrazione consumi in `agent_runs` (phase "review") — PRIMA di cap e
 *     parse: i costi sono reali anche se l'output è inusabile; poi GUARDIE sul
 *     run: limite di rate/usage del provider → `failed` + job RIACCODATO con
 *     cooldown; exit ≠ 0 → `failed`
 *     (mai un verdetto da un run crashato, anche se l'output parziale parsasse);
 *  9. cap per-review: sforato → `failed`, NESSUNA pubblicazione;
 * 10. parse dell'output: non parsabile → `failed` (mai un verdetto inventato);
 * 11. ticket: branch `stubwise/ticket-N` → il ticket N del progetto; altrimenti
 *     il ticket dell'ultima review della stessa PR; altrimenti se ne CREA uno
 *     di tipo `review` (solo a parse riuscito: una review fallita non lascia
 *     ticket vuoti) — ma prima di creare lo stato PR viene RI-verificato:
 *     chiusa nel frattempo → riga `completed` con verdict/summary e ticketId
 *     null, niente pubblicazioni (race col webhook di chiusura);
 * 12. transazione: commento AI sul ticket + riga → `completed`; al testo
 *     dell'agente si appende la sezione "Impatto sul codice" (blast radius),
 *     omessa se il calcolo non ha prodotto nulla;
 * 13. pubblicazione sulla PR (best-effort, fuori transazione): con l'account
 *     revisore della repository una review VERA (`submitPrReview`), altrimenti
 *     un commento NUOVO dell'account principale; poi lo status di commit
 *     `stubwise-review` (all'avvio `pending`, qui l'esito) — vedi cycle.ts;
 * 14. ciclo review → correzione sulle PR di Stubwise (correzione automatica
 *     sotto il tetto, richiesta umana promossa, stop al tetto) e notifica
 *     `review.completed` — ma non per un giro automatico intermedio.
 *
 * Ogni uscita che chiude la riga `failed` (gate 4-5, errori e guardie dei passi
 * 7-11) — ESCLUSO il limite del provider, che riaccoda — promuove la richiesta
 * umana in fila su questa PR (emendamento E2, `promotePendingAfterFailedReview`):
 * una review fallita non avvia MAI una correzione automatica.
 */

/** Intervallo dell'heartbeat su pr_reviews.lastActivityAt (<< soglia stale). */
const HEARTBEAT_INTERVAL_MS = 60_000;

/** Tetto del titolo del ticket review (il titolo PR arriva dall'esterno). */
const TICKET_TITLE_MAX_CHARS = 200;

/** Forma attesa delle credenziali git decifrate (mirror di auto-update.ts). */
const credentialsSchema = z.object({
  username: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  token: z.string().min(1),
});

/** Riga di pending reclamata dal poller (DELETE...RETURNING), passata qui. */
export interface PrReviewJobRow {
  repositoryId: string;
  prNumber: number;
  prUrl: string;
  prTitle: string;
  prBody: string;
  sourceBranch: string;
  targetBranch: string;
  headSha: string;
  /** La PR viene da un fork (0085)? Null/assente = non si sa. */
  fromFork?: boolean | null;
}

export interface RunPrReviewDeps {
  db: Db;
  mirrors: Pick<MirrorManager, "withWorktreeAtSha" | "getPrDiff" | "resolveCommitSha">;
  runner: AgentRunner;
  /** Chiave AES-256 per decifrare credenziali git e segreti dei provider AI. */
  encryptionKey: Buffer;
  /** Modello AI dell'agente di review. */
  model: string;
  /** Turni massimi del run dell'agente. */
  maxTurns: number;
  /** Timeout (ms) del run dell'agente. */
  agentTimeoutMs: number;
  /** URL pubblico dell'istanza (per il link al ticket nella notifica). */
  publicUrl?: string;
  /** Radice del volume dei grafi (GRAPHS_DIR). Assente o repo senza grafo →
   * review identica a prima (nessun blocco nel prompt, nessuna sezione). */
  graphsDir?: string;
  /** Provider git iniettabile nei test (default: getProvider). */
  getProviderFn?: (
    kind: GitProviderKind,
  ) => Pick<GitProvider, "getPullRequestState" | "createPrComment" | "submitPrReview" | "setCommitStatus">;
  /** Risolutore di UN provider AI per id (iniettabile). Default: loadProviderById. */
  loadProviderByIdFn?: typeof loadProviderById;
  /** Caricatore della catena di provider AI (iniettabile). Default: loadProviderChain. */
  loadProviderChainFn?: typeof loadProviderChain;
  /** Costo mensile dell'istanza (iniettabile). Default: monthlyCostUsd. */
  monthlyCostUsdFn?: (db: Db) => Promise<number>;
  /** Publish delle notifiche (iniettabile). Default: publishNotification. */
  publish?: PublishFn;
  /** Riassunto "in breve" della PR (fase 5): false = nessun run, `pr_summary`
   * resta NULL. Default true (SUMMARIES_ENABLED). */
  summariesEnabled?: boolean;
  /** Modello del run di riassunto (default: `model` della review). */
  summaryModel?: string;
  /** Timeout del run di riassunto in ms (default SUMMARY_TIMEOUT_MS). */
  summaryTimeoutMs?: number;
  /**
   * Minuti oltre cui una riga IN ATTESA (`started_at` null) è orfana (è
   * `WORKER_STALE_MINUTES`, lo stesso valore del recovery del poller): la
   * guardia anti-doppione non la conta più, così una riga rimasta appesa non
   * blocca per sempre le review successive della stessa head.
   */
  staleMinutes: number;
}

/**
 * Timeout del run di riassunto della PR. Corto: run di solo testo, senza tool e
 * senza working tree, appeso in coda a una review già conclusa. Il suo costo
 * peggiore è ritardare di due minuti la chiusura della riga, non trattenere il
 * poller.
 */
const SUMMARY_TIMEOUT_MS = 120_000;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Contesto del repository necessario alla review. */
interface ReviewContext {
  mirrorProject: MirrorProject;
  projectId: string;
  /** Nome del REPOSITORY: è ciò che gli altri dispatch del webhook passano
   * come projectName (vedi routes/webhooks.ts). */
  repositoryName: string;
  aiProviderId: string | null;
}

/**
 * Carica repository + account git + progetto e decifra le credenziali (pattern
 * loadProjectContext di auto-update.ts). Ritorna null (con log) se qualcosa è
 * sparito o non si decifra: la review è best-effort, il pending è già consumato.
 */
async function loadReviewContext(
  deps: RunPrReviewDeps,
  repositoryId: string,
): Promise<ReviewContext | null> {
  const [row] = await deps.db
    .select({
      repository: repositories,
      account: gitAccounts,
      projectId: projects.id,
      aiProviderId: projects.aiProviderId,
    })
    .from(repositories)
    .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
    .innerJoin(projects, eq(projects.id, repositories.projectId))
    .where(eq(repositories.id, repositoryId));
  if (!row) {
    console.error(
      `[stubwise-worker] pr-review: repository ${repositoryId} o account git collegato non trovato, salto`,
    );
    return null;
  }
  const { repository, account } = row;

  let credentials: z.infer<typeof credentialsSchema>;
  try {
    credentials = credentialsSchema.parse(
      JSON.parse(decrypt(account.encryptedCredentials, deps.encryptionKey)),
    );
  } catch {
    console.error(
      `[stubwise-worker] pr-review: credenziali git del repository ${repositoryId} non decifrabili, salto`,
    );
    return null;
  }

  return {
    mirrorProject: {
      provider: repository.provider,
      repoUrl: repository.repoUrl,
      defaultBranch: repository.defaultBranch,
      credentials,
    },
    projectId: row.projectId,
    repositoryName: repository.name,
    aiProviderId: row.aiProviderId,
  };
}

/**
 * Risolve il provider AI della review: pinned del progetto (SOLO quello, niente
 * fallback) oppure chain[0]. Stesso contratto di resolveProvider in
 * auto-update.ts: `{ blocked: true }` = pinned non risolvibile.
 */
async function resolveProvider(
  deps: RunPrReviewDeps,
  aiProviderId: string | null,
): Promise<{ provider: ResolvedProvider | undefined } | { blocked: true }> {
  if (aiProviderId) {
    const loadById = deps.loadProviderByIdFn ?? loadProviderById;
    const pinned = await loadById(deps.db, deps.encryptionKey, aiProviderId);
    if (!pinned) return { blocked: true };
    return { provider: pinned };
  }
  const loadChain = deps.loadProviderChainFn ?? loadProviderChain;
  const chain = await loadChain(deps.db, deps.encryptionKey);
  return { provider: chain[0] };
}

/**
 * La riga `pr_reviews` IN ATTESA (`started_at` null) di un job appena
 * reclamato: la scrive il poller nella STESSA transazione del DELETE su
 * `pr_review_jobs` (poller.ts), così la review esiste dal claim e il ciclo
 * della PR si legge `reviewing` anche mentre aspetta nel serializer. I
 * metadati del job restano sulla riga per il riaccodamento all'avvio
 * (`requeueWaitingReviews`). Esportata per i test (`runClaimed`).
 */
export async function insertWaitingReview(db: DbOrTx, job: PrReviewJobRow): Promise<string> {
  const [row] = await db
    .insert(prReviews)
    .values({
      repositoryId: job.repositoryId,
      prNumber: job.prNumber,
      prUrl: job.prUrl,
      prTitle: job.prTitle,
      headSha: job.headSha,
      prBody: job.prBody,
      sourceBranch: job.sourceBranch,
      targetBranch: job.targetBranch,
      fromFork: job.fromFork ?? null,
      status: "running",
    })
    .returning({ id: prReviews.id });
  if (!row) throw new Error("insert della review in attesa non ha restituito la riga");
  return row.id;
}

/** La riga IN ATTESA diventa TERMINALE failed senza essere mai partita (gate
 * falliti prima della partenza: budget, provider): `started_at` resta null, e
 * lo storico lo dice. La guardia su `started_at IS NULL` la rende innocua su
 * una riga già presa o chiusa. Best-effort: un errore qui logga solo. */
async function failWaitingReview(db: Db, reviewId: string, error: string): Promise<void> {
  try {
    await db
      .update(prReviews)
      .set({ status: "failed", error, finishedAt: sql`now()`, lastActivityAt: sql`now()` })
      .where(and(eq(prReviews.id, reviewId), eq(prReviews.status, "running"), isNull(prReviews.startedAt)));
  } catch (err) {
    console.error(
      `[stubwise-worker] pr-review: chiusura failed della review in attesa ${reviewId} fallita (${errText(err)})`,
    );
  }
}

/** Chiude come failed una riga running (mai lancia). La guardia sullo status
 * rende innocua una scrittura tardiva se il recovery delle righe stale l'ha
 * già chiusa (riga non più running → update a vuoto). */
async function failRunningReview(db: Db, reviewId: string, error: string): Promise<boolean> {
  try {
    const closed = await db
      .update(prReviews)
      .set({ status: "failed", error, finishedAt: sql`now()`, lastActivityAt: sql`now()` })
      .where(and(eq(prReviews.id, reviewId), eq(prReviews.status, "running")))
      .returning({ id: prReviews.id });
    return closed.length > 0;
  } catch (err) {
    console.error(
      `[stubwise-worker] pr-review: update failed della review ${reviewId} fallito (${errText(err)})`,
    );
    return false;
  }
}

/** Cooldown del riaccodo su limite provider (fallback a tempo, come da design). */
const LIMIT_REQUEUE_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Ri-upserta il job della review con notBefore oltre il cooldown (best-effort).
 * Su conflitto NON tocca head/metadati: se un webhook ha già ri-upsertato un
 * push più nuovo, i suoi dati vincono — qui si sposta solo la finestra.
 */
async function requeueReviewJob(db: Db, job: PrReviewJobRow): Promise<void> {
  try {
    const notBefore = new Date(Date.now() + LIMIT_REQUEUE_COOLDOWN_MS);
    await db
      .insert(prReviewJobs)
      .values({ ...job, notBefore })
      .onConflictDoUpdate({
        target: [prReviewJobs.repositoryId, prReviewJobs.prNumber],
        set: { notBefore },
      });
  } catch (err) {
    console.error(`[stubwise-worker] pr-review: riaccodo su limite fallito (${errText(err)})`);
  }
}

/**
 * Registra i consumi del run in agent_runs con `prReviewId` (phase "review"):
 * replica di recordAgentRun (queue.ts), che è job-only. Una riga per modello,
 * costo toFixed(6), BEST-EFFORT: mai un errore da qui.
 */
async function recordReviewRun(db: Db, reviewId: string, usage?: AgentRunUsage): Promise<void> {
  try {
    const models = usage?.models ?? [];
    if (models.length === 0) return;
    await db.insert(agentRuns).values(
      models.map((m) => ({
        prReviewId: reviewId,
        phase: "review" as const,
        model: m.model,
        inputTokens: Math.trunc(m.inputTokens) || 0,
        outputTokens: Math.trunc(m.outputTokens) || 0,
        cacheReadTokens: Math.trunc(m.cacheReadTokens) || 0,
        costUsd: m.costUsd !== undefined ? m.costUsd.toFixed(6) : null,
      })),
    );
  } catch {
    // Inghiottito di proposito: i consumi sono accessori, la review no.
  }
}

/** Costo USD del run: totale del CLI se riportato, altrimenti somma per-modello. */
function runCostUsd(usage?: AgentRunUsage): number {
  if (!usage) return 0;
  if (usage.totalCostUsd !== undefined) return usage.totalCostUsd;
  return usage.models.reduce((sum, m) => sum + (m.costUsd ?? 0), 0);
}

/**
 * Risolve il ticket che ospita la review — SOLO a parse riuscito (una review
 * fallita non deve creare ticket):
 *  1. branch `stubwise/ticket-N` → il ticket N del progetto (PR aperta dal fix);
 *  2. l'ultima review della stessa (repo, PR) con ticketId non-null → riuso
 *     (re-review di una PR esterna);
 *  3. altrimenti si CREA un ticket `review` (source webhook, priority medium)
 *     claimando il numero dal contatore del progetto — stesso pattern
 *     transazionale di createTicket in apps/server/src/db/tickets.ts (il worker
 *     non può importare da apps/server).
 *
 * SOLO nel ramo 3 lo stato della PR viene RI-verificato (`getPrState`) appena
 * prima di creare: `{ prClosed: true }` = PR chiusa nel frattempo, niente
 * ticket (vedi il commento inline sulla race col webhook di chiusura). I rami
 * 1 e 2 non ne hanno bisogno: il ticket esiste già e il webhook di chiusura
 * della PR lo gestisce.
 */
async function resolveTicket(
  db: Db,
  ctx: ReviewContext,
  job: PrReviewJobRow,
  lang: Language,
  getPrState: () => Promise<"open" | "closed">,
): Promise<{ id: string; number: number; title: string } | { prClosed: true } | null> {
  const branchMatch = STUBWISE_BRANCH_RE.exec(job.sourceBranch);
  if (branchMatch) {
    const [existing] = await db
      .select({ id: tickets.id, number: tickets.number, title: tickets.title })
      .from(tickets)
      .where(
        and(eq(tickets.projectId, ctx.projectId), eq(tickets.number, Number(branchMatch[1]))),
      );
    if (existing) return existing;
    // Ticket del fix sparito: si prosegue con le strategie successive.
  }

  const [previous] = await db
    .select({ ticketId: prReviews.ticketId })
    .from(prReviews)
    .where(
      and(
        eq(prReviews.repositoryId, job.repositoryId),
        eq(prReviews.prNumber, job.prNumber),
        isNotNull(prReviews.ticketId),
      ),
    )
    .orderBy(desc(prReviews.createdAt))
    .limit(1);
  if (previous?.ticketId) {
    // ticketId è ON DELETE SET NULL: non-null ⇒ il ticket esiste ancora, ma la
    // select conferma e porta numero/titolo per la notifica.
    // Edge case ACCETTATO (v1): una PR riaperta riusa il ticket anche se già
    // done/closed — il commento AI finisce su un ticket chiuso.
    const [existing] = await db
      .select({ id: tickets.id, number: tickets.number, title: tickets.title })
      .from(tickets)
      .where(eq(tickets.id, previous.ticketId));
    if (existing) return existing;
  }

  // Ri-verifica dello stato PR APPENA PRIMA di creare il ticket: il gate
  // iniziale è girato MINUTI fa (il run dell'agente è lungo) e nel frattempo
  // la PR può essere stata chiusa. In quel caso il webhook di chiusura non ha
  // trovato alcun ticket da chiudere (pr_reviews.ticketId era ancora null):
  // crearne uno ORA lo lascerebbe aperto per sempre, perché nessun evento
  // futuro lo chiuderà. Errore API → fail-open (si crea comunque), coerente
  // col gate iniziale.
  try {
    if ((await getPrState()) === "closed") return { prClosed: true };
  } catch (err) {
    console.error(
      `[stubwise-worker] pr-review: stato della PR #${job.prNumber} non ri-verificabile (${errText(err)}), procedo a creare il ticket`,
    );
  }

  // Creazione del ticket review: titolo CAPPATO (il titolo PR è dell'autore
  // esterno) e su una riga sola.
  const title = `PR Review: ${toSingleLine(job.prTitle, TICKET_TITLE_MAX_CHARS)} (#${job.prNumber})`;
  const body = t(lang, "comment.reviewTicketBody", {
    url: job.prUrl,
    branch: job.sourceBranch,
  });
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(projects)
      .set({ nextTicketNumber: sql`${projects.nextTicketNumber} + 1` })
      .where(eq(projects.id, ctx.projectId))
      .returning({ nextTicketNumber: projects.nextTicketNumber });
    if (!claimed) return null; // progetto sparito nel frattempo.
    const [ticket] = await tx
      .insert(tickets)
      .values({
        projectId: ctx.projectId,
        number: claimed.nextTicketNumber - 1,
        title,
        body,
        type: "review",
        priority: "medium",
        source: "webhook",
      })
      .returning({ id: tickets.id, number: tickets.number, title: tickets.title });
    return ticket ?? null;
  });
}

/**
 * Esegue la review di una PR per un pending GIÀ RECLAMATO. Best-effort: mai
 * lancia verso il chiamante; ogni percorso d'uscita logga con prefisso
 * `[stubwise-worker] pr-review:`. Vedi il docblock del modulo per il flusso.
 */
export async function runPrReview(
  deps: RunPrReviewDeps,
  job: PrReviewJobRow,
  /** La riga IN ATTESA creata dal poller al claim (`insertWaitingReview`). */
  reviewId: string,
): Promise<void> {
  const getProviderFn = deps.getProviderFn ?? getProvider;
  const monthlyCostUsdFn = deps.monthlyCostUsdFn ?? monthlyCostUsd;
  // Uscita terminale `failed` di una review MAI PARTITA (E2): la riga si
  // chiude, poi la richiesta umana in fila su questa PR parte. Nessuno status
  // di commit: il `pending` non è mai stato scritto. L'uscita gemella per le
  // review PARTITE (`failRunningAndPromote`) nasce al passo 6.
  const failWaitingAndPromote = async (error: string): Promise<void> => {
    await failWaitingReview(deps.db, reviewId, error);
    await promotePendingAfterFailedReview(deps.db, job);
  };

  // 1. Contesto (repo/account/progetto + credenziali decifrate).
  const ctx = await loadReviewContext(deps, job.repositoryId);
  if (!ctx) return;

  // 2. GATE toggle (riletto al claim) + cap/budget/lingua in UNA select del
  // singleton. Riga mancante (istanza non seedata) = default: review spenta.
  const [settings] = await deps.db
    .select({
      prReviewEnabled: instanceSettings.prReviewEnabled,
      prReviewMaxCostUsd: instanceSettings.prReviewMaxCostUsd,
      monthlyBudgetUsd: instanceSettings.monthlyBudgetUsd,
      contentLanguage: instanceSettings.contentLanguage,
    })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1));
  if (!settings?.prReviewEnabled) return; // spento dopo l'accodamento: silenzioso.
  const lang = settings.contentLanguage;

  // 3. GATE PR ancora aperta: chiusa → niente riga (il lavoro non serve più).
  // Errore API → warning e si prosegue (fail-open, errore transitorio).
  try {
    const state = await getProviderFn(ctx.mirrorProject.provider).getPullRequestState(
      ctx.mirrorProject,
      job.prNumber,
    );
    if (state === "closed") {
      console.error(
        `[stubwise-worker] pr-review: PR #${job.prNumber} del repository ${job.repositoryId} già chiusa, salto`,
      );
      return;
    }
  } catch (err) {
    console.error(
      `[stubwise-worker] pr-review: stato della PR #${job.prNumber} non verificabile (${errText(err)}), proseguo`,
    );
  }

  // 3-bis. GUARDIA ANTI-DOPPIONE: la stessa head della stessa PR ha già una
  // review viva o completata → niente run. Succede quando il worker ha accodato
  // la review da sé (fix/correzione, vedi enqueuePrReviewNow) e il webhook del
  // provider arriva DOPO il claim. Confronto per prefisso: la head di un webhook
  // Bitbucket è abbreviata, quella del worker completa. Una review `failed`
  // (limite compreso) resta ripetibile. La PROPRIA riga (in attesa, `running`,
  // stessa head) è esclusa: senza, ogni review troverebbe sé stessa e si
  // salterebbe. Una SECONDA riga in attesa della stessa head la trova e si
  // salta: la sua riga la cancella il poller.
  const [duplicate] = await deps.db
    .select({ id: prReviews.id })
    .from(prReviews)
    .where(
      and(
        eq(prReviews.repositoryId, job.repositoryId),
        eq(prReviews.prNumber, job.prNumber),
        ne(prReviews.id, reviewId),
        inArray(prReviews.status, ["running", "completed"]),
        // Una riga IN ATTESA più vecchia della soglia è orfana (un run che non
        // l'ha mai marcata partita né cancellata): non blocca. Le partite e le
        // completate contano sempre.
        or(
          isNotNull(prReviews.startedAt),
          sql`${prReviews.createdAt} > now() - make_interval(mins => ${deps.staleMinutes})`,
        ),
        or(
          sql`starts_with(${prReviews.headSha}, ${job.headSha})`,
          sql`starts_with(${job.headSha}, ${prReviews.headSha})`,
        ),
      ),
    )
    .limit(1);
  if (duplicate) {
    console.error(
      `[stubwise-worker] pr-review: head ${job.headSha.slice(0, 7)} della PR #${job.prNumber} già revisionata, salto`,
    );
    return;
  }

  // 4. GATE budget mensile dell'istanza: sforato → la riga in attesa diventa
  // failed senza essere mai partita (storico visibile).
  if (settings.monthlyBudgetUsd != null) {
    const budget = Number(settings.monthlyBudgetUsd);
    let spent: number;
    try {
      spent = await monthlyCostUsdFn(deps.db);
    } catch (err) {
      // Scelta deliberata: NESSUNA riga failed (a differenza del budget
      // sforato, che è uno stato "vero" da mostrare nello storico) — qui
      // l'errore è transitorio (query sul DB fallita) e il prossimo push
      // sulla PR ri-accoderà il job; una riga failed sporcherebbe lo storico.
      console.error(
        `[stubwise-worker] pr-review: costo mensile non calcolabile (${errText(err)}), salto`,
      );
      return;
    }
    if (spent >= budget) {
      await failWaitingAndPromote(
        `budget mensile superato: spesi $${spent.toFixed(4)} sul limite di $${budget.toFixed(4)}`,
      );
      return;
    }
  }

  // 5. Provider AI: pinned del progetto o chain[0]; pinned non risolvibile →
  // failed senza fallback (coerente con auto-update e generazione Docs).
  const resolved = await resolveProvider(deps, ctx.aiProviderId);
  if ("blocked" in resolved) {
    await failWaitingAndPromote("provider AI del progetto non disponibile (disabilitato o eliminato)");
    return;
  }

  // 6. PARTENZA: la riga del claim diventa "partita". `last_activity_at` si
  // rinnova qui: una review rimasta in attesa oltre la soglia non deve essere
  // presa per un run stantio dal recovery al primo tick (che guarda solo le
  // partite, poller.ts). Nessuna riga = già chiusa o presa: non si parte. Da
  // qui in poi ogni fallimento chiude QUESTA riga.
  let started: { id: string } | undefined;
  try {
    [started] = await deps.db
      .update(prReviews)
      .set({ startedAt: sql`now()`, lastActivityAt: sql`now()` })
      .where(and(eq(prReviews.id, reviewId), eq(prReviews.status, "running"), isNull(prReviews.startedAt)))
      .returning({ id: prReviews.id });
  } catch (err) {
    console.error(
      `[stubwise-worker] pr-review: partenza della review ${reviewId} (PR #${job.prNumber}) non registrata (${errText(err)})`,
    );
    return;
  }
  if (!started) return;

  // Heartbeat: bumpa lastActivityAt ogni 60s così il recovery delle righe
  // running orfane (riavvio del worker) non tocca una review viva. Pattern
  // touchJob (queue.ts); unref = il timer non tiene in vita il processo.
  const heartbeat = setInterval(() => {
    deps.db
      .update(prReviews)
      .set({ lastActivityAt: sql`now()` })
      .where(eq(prReviews.id, reviewId))
      .catch(() => {
        // Heartbeat best-effort: un errore transitorio non fallisce la review.
      });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  // Dipendenze del ciclo (status, pubblicazione, correzioni): le stesse della review.
  const cycleDeps: ReviewCycleDeps = {
    db: deps.db,
    encryptionKey: deps.encryptionKey,
    ...(deps.getProviderFn !== undefined ? { getProviderFn: deps.getProviderFn } : {}),
    ...(deps.publicUrl !== undefined ? { publicUrl: deps.publicUrl } : {}),
    ...(deps.publish !== undefined ? { publish: deps.publish } : {}),
  };
  // Sha COMPLETO della head, risolto UNA volta (fuori da ogni worktree): il
  // `pending` qui e l'esito alla fine (o il `failure` di un fallimento) vanno
  // sullo stesso commit anche se nel frattempo il branch si muove.
  const fullSha = await resolveReviewSha(deps.mirrors, ctx.mirrorProject, job.headSha);
  // Status "in corso" sulla head: con la review obbligatoria nelle regole del
  // branch, finché non c'è un esito il merge aspetta. Best-effort. Senza link:
  // il ticket che ospita la review non è ancora risolto a questo punto.
  await setReviewCommitStatus(cycleDeps, {
    mirrorProject: ctx.mirrorProject,
    sha: fullSha,
    sourceBranch: job.sourceBranch,
    state: "pending",
    description: t(lang, "commitStatus.reviewing"),
  });
  // Uscita terminale `failed` di una review PARTITA (E2): la riga si chiude,
  // lo status «in corso» diventa `failure` — altrimenti, con la review
  // obbligatoria nelle regole del branch, la PR resterebbe bloccata — e la
  // richiesta umana in fila su questa PR parte. Lo status si scrive SOLO se
  // questa chiusura è avvenuta: una riga già chiusa (dal recovery, o
  // `completed` prima di un errore tardivo) non si contraddice. Mai per il
  // limite del provider: lì la review è riaccodata e lo status resta
  // `pending` fino alla ripartenza. LIMITE: se il worker muore a review
  // partita, nessuno scrive l'esito — lo status resta `pending` fino al push
  // successivo (il recovery chiude la riga, ma non tocca la piattaforma).
  //
  // C10b: dentro una serie di correzioni automatiche la chiusura avvisa che il
  // ciclo si è fermato (`notifyCycleStoppedByFailedReview`), DOPO la
  // promozione — una richiesta umana appena partita vuol dire che il ciclo
  // non è fermo — e solo se la chiusura è stata nostra.
  const failRunningAndPromote = async (error: string): Promise<void> => {
    const closed = await failRunningReview(deps.db, reviewId, error);
    if (closed) {
      await setReviewCommitStatus(cycleDeps, {
        mirrorProject: ctx.mirrorProject,
        sha: fullSha,
        sourceBranch: job.sourceBranch,
        state: "failure",
        description: t(lang, "commitStatus.reviewFailed"),
      });
    }
    await promotePendingAfterFailedReview(deps.db, job);
    if (closed) {
      await notifyCycleStoppedByFailedReview(cycleDeps, {
        job,
        projectId: ctx.projectId,
        repositoryName: ctx.repositoryName,
      });
    }
  };

  // Grafo del repository sul volume (fase 2d graphify): quando esiste, il
  // prompt riceve il blocco CODE GRAPH e il run l'allowlist dei comandi
  // read-only del CLI (prima apertura Bash di questo run plan-mode, stesso
  // razionale del deep dive). Assente → tutto identico a prima.
  const graphJsonPath =
    deps.graphsDir !== undefined ? resolveRepoGraphJson(deps.graphsDir, job.repositoryId) : null;
  // Impatto deterministico del diff sul grafo: calcolato prima del run (finisce
  // nel prompt) e riusato dopo (sezione del commento pubblicato). Mai lancia:
  // computeBlastRadius è fail-open per contratto. Se il diff è TRONCATO il
  // calcolo copre solo i file arrivati fin lì (e l'ultimo header, se tagliato a
  // metà, conta come file fuori dal grafo): parziale, mai fuorviante.
  let blastRadius: BlastRadius | null = null;

  try {
    // 7. Diff dal mirror + agente read-only nel worktree alla head della PR.
    let result;
    try {
      const { diff, truncated } = await deps.mirrors.getPrDiff(
        ctx.mirrorProject,
        job.headSha,
        job.targetBranch,
      );
      if (graphJsonPath !== null) {
        blastRadius = await computeBlastRadius({
          graphJsonPath,
          changedFiles: parseChangedFiles(diff),
        });
      }
      const prompt = buildReviewPrompt({
        prTitle: job.prTitle,
        prBody: job.prBody,
        sourceBranch: job.sourceBranch,
        targetBranch: job.targetBranch,
        diff,
        diffTruncated: truncated,
        language: lang,
        ...(graphJsonPath !== null ? { graphJsonPath } : {}),
        blastRadius,
      });
      result = await deps.mirrors.withWorktreeAtSha(ctx.mirrorProject, job.headSha, (dir) =>
        deps.runner.run({
          cwd: dir,
          prompt,
          model: deps.model,
          permissionMode: "plan",
          maxTurns: deps.maxTurns,
          timeoutMs: deps.agentTimeoutMs,
          ...(graphJsonPath !== null ? { allowedTools: GRAPHIFY_AGENT_ALLOWED_TOOLS } : {}),
          ...(resolved.provider !== undefined ? { provider: resolved.provider } : {}),
        }),
      );
    } catch (err) {
      // Errori tipati dell'agente (AgentTimeoutError/AgentRunError) e del git
      // (sha irraggiungibile, mirror rotto): failed col messaggio.
      await failRunningAndPromote(errText(err));
      return;
    }

    // 8. Consumi PRIMA di cap e parse: i costi si registrano anche se l'output
    // è inusabile o oltre il tetto (la spesa è comunque avvenuta).
    await recordReviewRun(deps.db, reviewId, result.usage);

    // Limite di rate/usage: la review non ha failover di catena, ma la sua
    // coda è già temporizzata — si riaccoda con un cooldown. Se il limite
    // persiste al prossimo claim, si ri-accoda di nuovo: un run sonda ogni
    // cooldown, autolimitante. La chiusura della PR pulisce la coda. NIENTE
    // promozione della richiesta in fila (E2): la review ripartirà, e la
    // promozione avverrà alla sua fine.
    if (isLimitError(result)) {
      await failRunningReview(
        deps.db,
        reviewId,
        "provider AI al limite di rate/usage: review riaccodata",
      );
      await requeueReviewJob(deps.db, job);
      return;
    }

    // Run crashato (exit ≠ 0 senza marcatore di limite): runner.run RISOLVE
    // anche su exit non-zero (vedi claude-cli.ts), quindi senza questa guardia
    // l'output parziale finirebbe nel parse — errore attribuito male ("output
    // non parsabile") o, peggio, un JSON valido PUBBLICATO da un run fallito.
    // Mai un verdetto da un run fallito: stessa scelta di fix.ts
    // (AgentExitError), più stretta di auto-update.ts.
    if (result.exitCode !== 0) {
      await failRunningAndPromote(`agente uscito con exit ${result.exitCode}`);
      return;
    }

    // 9. Cap per-review: sforato → failed, NESSUNA pubblicazione (né ticket né
    // commenti né notifica).
    if (settings.prReviewMaxCostUsd != null) {
      const cap = Number(settings.prReviewMaxCostUsd);
      const cost = runCostUsd(result.usage);
      if (cost > cap) {
        await failRunningAndPromote(
          `costo della review ($${cost.toFixed(4)}) oltre il tetto per-review ($${cap.toFixed(4)}): risultato scartato`,
        );
        return;
      }
    }

    // 10. Parse dell'output: mai un verdetto inventato.
    const parsed = parseReviewOutput(result.output);
    if (!parsed) {
      await failRunningAndPromote("output dell'agente non parsabile");
      return;
    }

    // 10-bis. Riassunto "in breve" della PR (fase 5): un secondo run di solo
    // testo che traduce verdetto e analisi appena parsati per chi non legge
    // codice. Sta QUI — dopo il parse e dopo il cap di costo — di proposito: una
    // review scartata dal cap o non parsabile non produce nulla che qualcuno
    // leggerà, e non deve costare un run in più. Best-effort: `null` su
    // qualunque fallimento, e la review si completa comunque.
    const prSummary = await generatePrSummary(
      {
        runner: deps.runner,
        timeoutMs: deps.summaryTimeoutMs ?? SUMMARY_TIMEOUT_MS,
        model: deps.summaryModel ?? deps.model,
        ...(resolved.provider !== undefined ? { provider: resolved.provider } : {}),
        ...(deps.summariesEnabled !== undefined ? { enabled: deps.summariesEnabled } : {}),
      },
      {
        lang,
        prTitle: job.prTitle,
        prBody: job.prBody,
        verdict: parsed.verdict,
        analysis: parsed.summary,
      },
    );

    // 11. Ticket che ospita la review (creato SOLO ora, a parse riuscito).
    const ticket = await resolveTicket(deps.db, ctx, job, lang, () =>
      getProviderFn(ctx.mirrorProject.provider).getPullRequestState(
        ctx.mirrorProject,
        job.prNumber,
      ),
    );
    if (!ticket) {
      await failRunningAndPromote("ticket della review non risolvibile");
      return;
    }
    if ("prClosed" in ticket) {
      // PR esterna chiusa DURANTE il run (race col webhook di chiusura, vedi
      // resolveTicket): la riga si chiude completed con verdict/summary (lo
      // storico e i costi restano consultabili) ma SENZA ticket, commento
      // sulla PR né notifica — il lavoro non serve più a nessuno.
      console.error(
        `[stubwise-worker] pr-review: PR #${job.prNumber} chiusa durante la review, completo senza ticket`,
      );
      await deps.db
        .update(prReviews)
        .set({
          status: "completed",
          verdict: parsed.verdict,
          summary: parsed.summary,
          prSummary,
          finishedAt: sql`now()`,
          lastActivityAt: sql`now()`,
        })
        .where(eq(prReviews.id, reviewId));
      return;
    }

    // 12. Commento AI sul ticket + riga → completed, in UNA transazione.
    const verdictText = t(
      lang,
      parsed.verdict === "approve"
        ? "comment.reviewVerdict.approve"
        : "comment.reviewVerdict.requestChanges",
      { url: job.prUrl },
    );
    // Sezione "Impatto sul codice" (fase 2d): appesa DETERMINISTICAMENTE dopo
    // l'output dell'agente, mai prodotta da lui. Stringa vuota (sezione omessa)
    // senza grafo, con grafo illeggibile o se nessun file del diff sta nel
    // grafo. Va in ENTRAMBI i commenti: ticket e PR mostrano lo stesso testo,
    // convenzione già in vigore per verdetto e summary.
    const impact = renderBlastRadiusSection(lang, blastRadius);
    const reviewBody = `${verdictText}\n\n${parsed.summary}${impact ? `\n\n${impact}` : ""}`;
    await deps.db.transaction(async (tx) => {
      await tx.insert(comments).values({
        ticketId: ticket.id,
        authorType: "ai",
        body: reviewBody,
      });
      await tx
        .update(prReviews)
        .set({
          status: "completed",
          verdict: parsed.verdict,
          summary: parsed.summary,
          // Il riassunto entra nella STESSA transazione di verdetto e analisi:
          // le tre colonne descrivono lo stesso risultato e nessuno stato
          // intermedio deve poter mostrare un verdetto senza la sua traduzione.
          prSummary,
          ticketId: ticket.id,
          finishedAt: sql`now()`,
          lastActivityAt: sql`now()`,
        })
        .where(eq(prReviews.id, reviewId));
    });

    // 13-14. Pubblicazione sulla PR (account revisore o principale), status di
    // commit, ciclo di correzione e notifica: vedi cycle.ts. Tutto best-effort:
    // la review è già completed.
    await afterReviewCompleted(cycleDeps, {
      job,
      reviewId,
      fullSha,
      mirrorProject: ctx.mirrorProject,
      projectId: ctx.projectId,
      repositoryName: ctx.repositoryName,
      ticket,
      verdict: parsed.verdict,
      reviewBody,
      prSummary,
      lang,
    });
  } catch (err) {
    // Errore inatteso: chiudi la riga running e logga, MAI propagare.
    console.error(
      `[stubwise-worker] pr-review: errore inatteso sulla PR #${job.prNumber} (${errText(err)})`,
    );
    await failRunningAndPromote(errText(err));
  } finally {
    clearInterval(heartbeat);
  }
}
