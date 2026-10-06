import {
  prCorrections,
  projects,
  ticketRepositories,
  tickets,
  type Db,
} from "@stubwise/db";
import {
  getProvider,
  GitProviderError,
  ReviewCommentFailedError,
  STUBWISE_REVIEW_STATUS_KEY,
  type GitProvider,
} from "@stubwise/git";
import { t, type Language } from "@stubwise/i18n";
import {
  autoRoundsInCurrentSeries,
  cancelPendingCorrection,
  decryptGitCredentials,
  enqueueCorrection,
  prHasOpenCorrection,
  promotePendingCorrection,
  resolveReviewAccountWithCredentials,
} from "@stubwise/notifications";
import {
  isCorrectablePr,
  signReviewBody,
  type GitProviderKind,
  type PrCycleEvent,
} from "@stubwise/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { MirrorManager, MirrorProject } from "../git/mirrors.js";
import { notify, ticketUrl, type PublishFn } from "../pipeline/notify.js";
import type { PrReviewJobRow } from "./run-review.js";

/**
 * CICLO REVIEW → CORREZIONE: ciò che segue una review appena scritta in DB.
 *
 * Tre cose, tutte BEST-EFFORT (la review è già `completed`, un provider giù non
 * la degrada; la verità sta in Stubwise):
 *  1. PUBBLICAZIONE — con l'account revisore della repository la review diventa
 *     uno stato VERO della PR (`submitPrReview`, che pubblica anche il testo);
 *     senza, il commento dell'account principale di sempre;
 *  2. STATUS di commit `stubwise-review` sulla head (sha completo dal mirror);
 *  3. CICLO, solo sulle PR di Stubwise: correzione automatica sotto il tetto,
 *     richiesta umana in attesa promossa, stop al tetto. Il contatore NON si
 *     salva: `autoRoundsInCurrentSeries` lo deriva dalle righe.
 *
 * Più `promotePendingAfterFailedReview`: una review che NON arriva a un
 * verdetto (fallita) è comunque un punto di promozione della richiesta umana
 * in fila su QUESTA PR (emendamento E2), mai di una correzione automatica.
 */

export interface ReviewCycleDeps {
  db: Db;
  encryptionKey: Buffer;
  getProviderFn?: (
    kind: GitProviderKind,
  ) => Pick<GitProvider, "createPrComment" | "submitPrReview" | "setCommitStatus">;
  publicUrl?: string;
  publish?: PublishFn;
}

export interface AfterReviewCompletedInput {
  job: PrReviewJobRow;
  reviewId: string;
  /**
   * Sha COMPLETO della head revisionata, risolto UNA volta alla partenza
   * (`resolveReviewSha`): lo status finale va sullo stesso commit del
   * `pending`. `null` = non risolto → nessuno status (riga di log).
   */
  fullSha: string | null;
  /** Repo con le credenziali dell'account PRINCIPALE, già decifrate. */
  mirrorProject: MirrorProject;
  projectId: string;
  /** Nome del REPOSITORY (è il projectName delle notifiche della review). */
  repositoryName: string;
  ticket: { id: string; number: number; title: string };
  verdict: "approve" | "request_changes";
  /** Testo della review (verdetto + analisi + impatto), come sul ticket. */
  reviewBody: string;
  prSummary: string | null;
  lang: Language;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Il link dello status di commit, oppure `undefined` per ometterlo.
 *
 * È una guardia di UTILITÀ, non di sicurezza: evita di perdere lo status per
 * un link che la piattaforma potrebbe rifiutare (o che nessuno può aprire).
 * Il link porta solo all'istanza stessa; nessun dato passa da qui.
 *
 * SCELTA DIFENSIVA, da confermare con B14 §6a (piano): GitHub potrebbe
 * rispondere 422 a un `target_url` non https, e allora un'istanza self-hosted
 * in http perderebbe lo status PER INTERO. Si manda il link solo se l'URL
 * pubblico è `https:` e non punta a localhost/127.0.0.1 (un link che nessun
 * altro può aprire non serve comunque); altrimenti si omette — GitHub accetta
 * lo status senza `target_url`, Bitbucket ripiega sulla pagina della
 * repository (B6) — ripiego necessario: senza `url` Bitbucket risponde 400
 * (B14 T9). Il §6a riguarda GitHub ed è ancora da confermare.
 */
export function commitStatusTargetUrl(publicUrl: string | undefined, ticketId: string): string | undefined {
  if (publicUrl === undefined || publicUrl.trim() === "") return undefined;
  const url = ticketUrl(publicUrl, ticketId);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") return undefined;
  return url;
}

/**
 * Sha COMPLETO della head (le API vogliono 40 caratteri, la head di un webhook
 * Bitbucket ne ha 12), risolto dal mirror UNA volta alla partenza della review:
 * `pending` ed esito vanno sullo stesso commit. `resolveCommitSha` fa
 * `fetch --prune`: si chiama FUORI da ogni callback di worktree. `null` se non
 * si risolve (la review prosegue, senza status). Mai lancia.
 */
export async function resolveReviewSha(
  mirrors: Pick<MirrorManager, "resolveCommitSha">,
  mirrorProject: MirrorProject,
  headSha: string,
): Promise<string | null> {
  try {
    return await mirrors.resolveCommitSha(mirrorProject, headSha);
  } catch (err) {
    console.error(
      `[stubwise-worker] pr-review: sha completo della head ${headSha.slice(0, 7)} non risolto (${errText(err)}): nessuno status di commit`,
    );
    return null;
  }
}

/**
 * Status `stubwise-review` sullo sha COMPLETO (`resolveReviewSha`); `refname`
 * = branch sorgente, senza il quale su Bitbucket lo status non si lega alla
 * PR. Sempre con l'account principale: è quello che ha accesso in scrittura al
 * repo. `sha` null → niente (la risoluzione ha già scritto il suo log). Mai
 * lancia.
 */
export async function setReviewCommitStatus(
  deps: ReviewCycleDeps,
  input: {
    mirrorProject: MirrorProject;
    sha: string | null;
    sourceBranch: string;
    state: "pending" | "success" | "failure";
    description: string;
    url?: string;
  },
): Promise<void> {
  if (input.sha === null) return;
  try {
    await (deps.getProviderFn ?? getProvider)(input.mirrorProject.provider).setCommitStatus(
      input.mirrorProject,
      input.sha,
      {
        state: input.state,
        key: STUBWISE_REVIEW_STATUS_KEY,
        description: input.description,
        refname: input.sourceBranch,
        ...(input.url !== undefined ? { url: input.url } : {}),
      },
    );
  } catch (err) {
    console.error(
      `[stubwise-worker] pr-review: status di commit '${input.state}' non pubblicato (${errText(err)}), proseguo`,
    );
  }
}

/**
 * Il revisore EFFETTIVO della repository (l'esplicito, altrimenti il
 * predefinito del suo ambito: `resolveReviewAccountWithCredentials`, la stessa
 * regola del webhook e della fotografia dei commenti), con le SUE credenziali;
 * null se non c'è — e allora si pubblica col principale. Variante
 * `WithCredentials`: qui ci si AUTENTICA con l'account.
 */
async function loadReviewerProject(
  deps: ReviewCycleDeps,
  repositoryId: string,
  main: MirrorProject,
): Promise<MirrorProject | null> {
  const review = await resolveReviewAccountWithCredentials(deps.db, repositoryId);
  const effective = review?.effective ?? null;
  if (effective === null) return null;
  // Stesso helper del webhook e della correzione (pr-correction-feedback.ts).
  const credentials = decryptGitCredentials(effective.account.encryptedCredentials, deps.encryptionKey);
  if (credentials === null) {
    const source = effective.source === "explicit" ? "esplicito" : "predefinito";
    console.error(
      `[stubwise-worker] pr-review: credenziali dell'account revisore (${source}) del repository ${repositoryId} non decifrabili, pubblico con l'account principale`,
    );
    return null;
  }
  return { ...main, credentials };
}

/** Perché il verdetto dell'account revisore non è stato apposto: solo la CATEGORIA. */
export type VerdictFailureReason = "permissions" | "configuration" | "network" | "other";

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * Classifica l'errore di `submitPrReview` in una CATEGORIA, l'unica cosa che
 * il commento di ripiego dice: il messaggio grezzo resta nel log del worker
 * (può contenere estratti della risposta del provider), mai sulla PR.
 *  - `permissions`: `GitProviderError` con status 401/403, e 404 — il
 *    revisore che non VEDE un repository privato riceve 404, non 403 (su
 *    entrambi i provider: non rivelano l'esistenza della risorsa). Un 404 può
 *    però anche voler dire che la PR (o il repository) è stata CANCELLATA nel
 *    frattempo: dalla risposta i due casi non si distinguono, e il commento
 *    di ripiego parla di permessi anche nel secondo;
 *  - `configuration`: GitHub 422 «own pull request» — l'account revisore è
 *    l'autore della PR. Distinto da `permissions` perché il rimedio è un
 *    altro (un account diverso, non uno scope in più) e si riconosce senza
 *    ambiguità dal corpo della risposta; un 422 qualunque resta `other`. Su
 *    Bitbucket l'approvazione della propria PR NON arriva come un 422 «own
 *    pull request», quindi lì lo stesso errore di configurazione ricade in
 *    `other`;
 *  - `network`: timeout (`AbortError`/`TimeoutError`, `fetchWithTimeout`) o
 *    fetch fallita (`TypeError: fetch failed`, o un codice di rete in `cause`);
 *  - `other`: tutto il resto (4xx/5xx diversi, credenziali incomplete…).
 */
export function verdictFailureReason(err: unknown): VerdictFailureReason {
  if (err instanceof GitProviderError) {
    if (err.status === 401 || err.status === 403 || err.status === 404) return "permissions";
    if (err.status === 422 && /own pull request/i.test(err.responseText)) return "configuration";
    return "other";
  }
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return "network";
    const cause = (err as { cause?: unknown }).cause;
    const code =
      typeof cause === "object" && cause !== null && "code" in cause ? (cause as { code?: unknown }).code : undefined;
    if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) return "network";
    if (err instanceof TypeError && err.message === "fetch failed") return "network";
  }
  return "other";
}

/**
 * Pubblica la review sulla PR. Con l'account revisore: SOLO submitPrReview, che
 * pubblica anche il testo (GitHub: è la review; Bitbucket: commento + stato) —
 * un createPrComment in più lo farebbe uscire doppio. Se fallisce, ripiego sul
 * commento dell'account principale: il testo non si perde, e non si duplica —
 * su Bitbucket submitPrReview manda il verdetto PRIMA del commento (B8), quindi
 * quando fallisce il testo non è ancora uscito oppure è proprio il commento ad
 * aver fallito (`ReviewCommentFailedError`: allora il verdetto c'è e la riga
 * del ripiego lo dice); su GitHub è una richiesta sola. Ogni review lascia un commento
 * NUOVO, firmato col commit rivisto.
 */
async function publishReview(deps: ReviewCycleDeps, input: AfterReviewCompletedInput): Promise<void> {
  const provider = (deps.getProviderFn ?? getProvider)(input.mirrorProject.provider);
  // La firma la genera `@stubwise/shared`, accanto a chi la riconosce: la
  // fotografia dei commenti e il webhook escludono le review di Stubwise da
  // lei, qualunque account le abbia pubblicate.
  const body = signReviewBody(input.reviewBody, input.job.headSha);
  const reviewer = await loadReviewerProject(deps, input.job.repositoryId, input.mirrorProject);
  // Il commento di ripiego si apre con una riga FISSA (template i18n) SOLO se
  // il ripiego nasce dal fallimento del revisore: senza revisore configurato
  // (o con credenziali non decifrabili) il commento è quello di sempre.
  let fallbackBody = body;
  if (reviewer) {
    try {
      const outcome = await provider.submitPrReview(reviewer, input.job.prNumber, input.verdict, body);
      if (outcome.status === "already_in_state") {
        // Bitbucket 409 sul verdetto (scelta difensiva): l'account revisore
        // era già in quello stato. Nessun errore, e il testo è comunque uscito
        // col commento del revisore. Dal vivo (B14 T21, 1 ott 2026) un
        // verdetto ripetuto risponde 200, mai 409: il ramo oggi non scatta, ed
        // è innocuo. L'estratto arriva già senza credenziali (`@stubwise/git`).
        console.error(
          `[stubwise-worker] pr-review: PR #${input.job.prNumber}: il revisore era già in stato '${input.verdict}' (409: ${JSON.stringify(outcome.responseExcerpt)}), pubblicato il solo commento`,
        );
      }
      return;
    } catch (err) {
      console.error(
        `[stubwise-worker] pr-review: review con l'account revisore sulla PR #${input.job.prNumber} fallita (${errText(err)}), ripiego sul commento`,
      );
      // Verdetto apposto, commento fallito (solo Bitbucket): la riga «non
      // apposto» mentirebbe. Se ne scrive una diversa, non nessuna: sulla PR
      // il verdetto risulta del revisore e il testo dell'account principale,
      // e senza una riga chi legge non sa perché.
      const verdictNotice =
        err instanceof ReviewCommentFailedError
          ? t(input.lang, "comment.reviewVerdictSubmittedCommentFailed")
          : t(input.lang, `comment.reviewVerdictNotSubmitted.${verdictFailureReason(err)}`);
      fallbackBody = `${verdictNotice}\n\n${body}`;
    }
  }
  try {
    await provider.createPrComment(input.mirrorProject, input.job.prNumber, fallbackBody);
  } catch (err) {
    console.error(
      `[stubwise-worker] pr-review: commento sulla PR #${input.job.prNumber} fallito (${errText(err)}), la review resta completata`,
    );
  }
}

type CycleNotice = { notify: false } | { notify: true; cycle?: PrCycleEvent };

/**
 * Stubwise può correggere questa PR per il ticket che ospita la review? Una
 * riga `ticket_repositories` di quel ticket su quel repo con quel branch, e
 * la regola unica `isCorrectablePr` (@stubwise/shared): il branch
 * `stubwise/ticket-N` del ticket, oppure una PR ADOTTATA e non rilasciata (6
 * ott 2026, il ticket `review` che `resolveTicket` ritrova). Il solo nome del
 * branch non basta: `resolveTicket` può aver ripiegato su un ticket `review`
 * se quello del fix è sparito.
 */
async function isCorrectablePrForReview(db: Db, input: AfterReviewCompletedInput): Promise<boolean> {
  const [link] = await db
    .select({
      branch: ticketRepositories.branch,
      adoptedAt: ticketRepositories.adoptedAt,
      adoptionReleasedAt: ticketRepositories.adoptionReleasedAt,
    })
    .from(ticketRepositories)
    .where(
      and(
        eq(ticketRepositories.ticketId, input.ticket.id),
        eq(ticketRepositories.repositoryId, input.job.repositoryId),
        eq(ticketRepositories.branch, input.job.sourceBranch),
      ),
    );
  return link !== undefined && isCorrectablePr({ ...link, ticketNumber: input.ticket.number });
}

/**
 * Decide il passo del ciclo. Vedi il docblock del modulo e il design §2/§6.
 *
 * Tre comportamenti da conoscere:
 *  - AL TETTO la notifica «ferma al tetto» si RIPETE a ogni review successiva
 *    della PR (una persona pusha, la review chiede ancora modifiche): ogni
 *    volta è un fatto nuovo, e il ciclo resta fermo;
 *  - se il tetto viene ABBASSATO a metà serie, l'evento porta il `round`
 *    REALE e il `max` nuovo (es. `round: 3, max: 2`), non un giro inventato;
 *  - con `max === 0` (ciclo spento) una `queued` o `pending` sulla PR
 *    sopprime la notifica come sempre: quei rami vengono prima del tetto.
 */
async function advanceCycle(db: Db, input: AfterReviewCompletedInput): Promise<CycleNotice> {
  if (!(await isCorrectablePrForReview(db, input))) return { notify: true };
  const where = { repositoryId: input.job.repositoryId, prNumber: input.job.prNumber };
  const [project] = await db
    .select({ max: projects.prCorrectionMaxRounds })
    .from(projects)
    .where(eq(projects.id, input.projectId));
  const max = project?.max ?? 0;

  // Prima le richieste umane già in fila, QUALUNQUE sia il verdetto: la fine
  // di una review è un punto di promozione della `pending` di QUESTA PR (A7),
  // e una richiesta arrivata durante una review che poi approva non deve
  // restare ferma finché non succede qualcos'altro. Solo di QUESTA PR: quelle
  // di altre PR del ticket partono alla fine del giro automatico (la
  // correzione chiude con promotePendingForTicket) o dal tick del worker
  // (promoteStalePendings). Promuoverle qui farebbe rifiutare il giro
  // automatico di questa PR, che è la cosa che la review ha appena chiesto.
  const promoteThisPr = async (why: string): Promise<void> => {
    const promoted = await promotePendingCorrection(db, where);
    console.error(
      `[stubwise-worker] pr-review: PR #${where.prNumber}: ${why}, correzione in attesa (${pendingTrigger}) avviata (${promoted ?? "nessuna: la ferma un altro lavoro del ticket"})`,
    );
  };
  const open = await db
    .select({ status: prCorrections.status, trigger: prCorrections.trigger })
    .from(prCorrections)
    .where(
      and(
        eq(prCorrections.repositoryId, where.repositoryId),
        eq(prCorrections.prNumber, where.prNumber),
        inArray(prCorrections.status, ["pending", "queued"]),
      ),
    );
  const hasQueued = open.some((c) => c.status === "queued");
  const pendingTrigger = open.find((c) => c.status === "pending")?.trigger ?? null;
  const hasPending = pendingTrigger !== null;

  if (input.verdict === "approve") {
    // Una `pending` AUTOMATICA (`trigger='review'`: un giro messo in fila da
    // una review precedente che chiedeva modifiche) è SUPERATA da questa
    // approvazione: si annulla, non si promuove — farebbe un giro di
    // correzione su una PR già approvata. Sotto il lock del ticket, col
    // trigger riletto sotto lock: se nel frattempo un click ci si è fuso
    // (trigger → `stubwise`) non si annulla, e la si tratta come umana. Vale
    // anche con una `queued` davanti: il giro resta superato.
    let humanPending = hasPending && pendingTrigger !== "review";
    if (pendingTrigger === "review") {
      const cancelled = await cancelPendingCorrection(db, where, { trigger: "review" });
      if (cancelled !== null) {
        console.error(
          `[stubwise-worker] pr-review: PR #${where.prNumber}: approvata, giro automatico in fila superato e annullato (${cancelled})`,
        );
      } else {
        humanPending = true; // diventata umana (o sparita: la promozione dà null)
      }
    }
    // Una `queued` (richiesta arrivata durante la review) parte già da sé; una
    // `pending` UMANA senza `queued` davanti si promuove qui. L'approvazione si
    // notifica comunque: è un fatto, anche se una persona ha chiesto altro.
    if (!hasQueued && humanPending) await promoteThisPr("approvata");
    const round = await autoRoundsInCurrentSeries(db, where);
    return { notify: true, cycle: { round, max, stopped: false } };
  }

  // request_changes.
  if (hasQueued) {
    // Una richiesta umana è arrivata DURANTE la review e parte già: il suo push
    // riaccoderà la review. Accodarne un'altra sarebbe un doppione.
    console.error(
      `[stubwise-worker] pr-review: PR #${where.prNumber}: correzione già in coda, nessun giro automatico`,
    );
    return { notify: false };
  }
  if (hasPending) {
    // Vince la richiesta in fila (§6). Se un altro lavoro del ticket la ferma,
    // resta `pending` e partirà alla fine di quel lavoro.
    await promoteThisPr("al posto del giro automatico");
    return { notify: false };
  }
  if (max === 0) return { notify: true, cycle: { round: 0, max: 0, stopped: false } };

  // Il tetto si controlla PRIMA di enqueueCorrection. Una pending `review` in
  // fila conta già come giro (`autoRoundsInCurrentSeries`).
  const round = await autoRoundsInCurrentSeries(db, where);
  if (round < max) {
    const result = await enqueueCorrection(db, {
      ticketId: input.ticket.id,
      repositoryId: where.repositoryId,
      prNumber: where.prNumber,
      trigger: "review",
      reviewId: input.reviewId,
    });
    if (!result.ok) {
      // Con `trigger: "review"` restano `correction_in_flight` — una `queued`
      // su QUESTA PR comparsa dopo la lettura qui sopra (una richiesta arrivata
      // nel frattempo): parte già, e il suo push riaccoderà la review — e
      // `pr_not_open`: la PR si è chiusa nel frattempo, niente da correggere.
      console.error(
        `[stubwise-worker] pr-review: PR #${where.prNumber}: correzione automatica non accodata (${result.error})`,
      );
      return { notify: false };
    }
    // `status: "pending"` = un altro lavoro del ticket (la correzione di
    // un'altra PR, un fix) blocca: il giro è in fila e partirà alla sua fine
    // (promotePendingForTicket) o dal tick. NON si notifica: il ciclo non è
    // finito, come per un giro accodato — la persona riceverà «approvata» o
    // «ferma al tetto».
    console.error(
      result.status === "pending"
        ? `[stubwise-worker] pr-review: PR #${where.prNumber}: correzione automatica ${round + 1}/${max} in fila (${result.correctionId}): parte quando finisce il lavoro in corso sul ticket`
        : `[stubwise-worker] pr-review: PR #${where.prNumber}: correzione automatica ${round + 1}/${max} accodata (${result.correctionId})`,
    );
    return { notify: false };
  }
  return { notify: true, cycle: { round, max, stopped: true, stoppedReason: "cap" } };
}

/**
 * Dopo la transazione che rende `completed` la review (run-review.ts, passo 12):
 * pubblicazione, status, ciclo, notifica. Mai lancia.
 */
export async function afterReviewCompleted(
  deps: ReviewCycleDeps,
  input: AfterReviewCompletedInput,
): Promise<void> {
  await publishReview(deps, input).catch((err: unknown) => {
    console.error(`[stubwise-worker] pr-review: pubblicazione fallita (${errText(err)})`);
  });
  const statusUrl = commitStatusTargetUrl(deps.publicUrl, input.ticket.id);
  await setReviewCommitStatus(deps, {
    mirrorProject: input.mirrorProject,
    sha: input.fullSha,
    sourceBranch: input.job.sourceBranch,
    state: input.verdict === "approve" ? "success" : "failure",
    description: t(
      input.lang,
      input.verdict === "approve" ? "commitStatus.approved" : "commitStatus.changesRequested",
    ),
    ...(statusUrl !== undefined ? { url: statusUrl } : {}),
  });

  let notice: CycleNotice;
  try {
    notice = await advanceCycle(deps.db, input);
  } catch (err) {
    // Il ciclo non è partito: la persona deve comunque sapere della review.
    console.error(`[stubwise-worker] pr-review: ciclo di correzione non avanzato (${errText(err)})`);
    notice = { notify: true };
  }
  if (!notice.notify) return;

  await notify(
    {
      ...(deps.publicUrl !== undefined ? { publicUrl: deps.publicUrl } : {}),
      projectName: input.repositoryName,
      ...(deps.publish !== undefined ? { publish: deps.publish } : {}),
    },
    deps.db,
    {
      kind: "review.completed",
      ticketNumber: input.ticket.number,
      ticketTitle: input.ticket.title,
      projectName: input.repositoryName,
      ticketUrl: ticketUrl(deps.publicUrl, input.ticket.id),
      prUrl: input.job.prUrl,
      verdict: input.verdict,
      ...(input.prSummary !== null ? { summary: input.prSummary } : {}),
      // Un fatto vero al momento della publish (giro, tetto, fermo): è giusto
      // scriverlo nell'evento (vedi l'invariante «derivati a lettura»).
      ...(notice.cycle !== undefined ? { cycle: notice.cycle } : {}),
    },
    // NIENTE jobId: vedi il commento storico in run-review.ts (FK su ai_jobs).
    { projectId: input.projectId, ticketId: input.ticket.id },
  );
}

/**
 * Emendamento E2 — una review FALLITA (errore, costo oltre il tetto, output non
 * parsabile, budget, provider…) non passa da `afterReviewCompleted`, ma è
 * comunque un punto di promozione: la richiesta umana in fila su QUESTA PR
 * (`pending`) parte, invece di restare ferma senza un evento che la sblocchi.
 * Solo la `pending` esistente: una review fallita non avvia MAI una correzione
 * automatica (nessun `enqueueCorrection` qui). Solo su una PR CORREGGIBILE
 * (`isCorrectablePr`: branch di Stubwise del ticket, o adottata e non
 * rilasciata — 6 ott 2026), provata sulla riga `ticket_repositories` di quel
 * branch e di quel numero, mai dal solo nome del branch. NON va chiamata nel ramo «limite del
 * provider → riaccodata»: la review ripartirà, e la promozione avverrà lì.
 * Best-effort: un errore è una riga di log, mai rilanciato.
 */
export async function promotePendingAfterFailedReview(db: Db, job: PrReviewJobRow): Promise<void> {
  try {
    if (!(await hasCorrectableRow(db, job))) return;
    const promoted = await promotePendingCorrection(db, {
      repositoryId: job.repositoryId,
      prNumber: job.prNumber,
    });
    if (promoted !== null) {
      console.error(
        `[stubwise-worker] pr-review: PR #${job.prNumber}: review fallita, richiesta umana in attesa avviata (${promoted})`,
      );
    }
  } catch (err) {
    console.error(
      `[stubwise-worker] pr-review: PR #${job.prNumber}: promozione della richiesta in attesa dopo una review fallita non riuscita (${errText(err)})`,
    );
  }
}

/**
 * Esiste una riga `ticket_repositories` APERTA su questo repository, branch e
 * numero di PR che Stubwise può correggere (`isCorrectablePr`)? La prova che
 * serve prima di toccare la coda delle correzioni dopo una review fallita.
 */
async function hasCorrectableRow(db: Db, job: PrReviewJobRow): Promise<boolean> {
  const rows = await db
    .select({
      number: tickets.number,
      branch: ticketRepositories.branch,
      adoptedAt: ticketRepositories.adoptedAt,
      adoptionReleasedAt: ticketRepositories.adoptionReleasedAt,
      prNumber: ticketRepositories.prNumber,
    })
    .from(ticketRepositories)
    .innerJoin(tickets, eq(tickets.id, ticketRepositories.ticketId))
    .where(
      and(
        eq(ticketRepositories.repositoryId, job.repositoryId),
        eq(ticketRepositories.branch, job.sourceBranch),
        eq(ticketRepositories.prState, "open"),
      ),
    );
  return rows.some(
    (r) =>
      isCorrectablePr({ ...r, ticketNumber: r.number }) && (r.prNumber === null || r.prNumber === job.prNumber),
  );
}

/**
 * C10b — dentro una serie di correzioni automatiche una review FALLITA (partita
 * e poi chiusa `failed`: errore dell'agente o del git, exit ≠ 0, costo oltre il
 * tetto, output non parsabile, ticket non risolvibile, errore inatteso) spegne
 * il ciclo: nessuna correzione automatica riparte da una review senza verdetto.
 * Senza avviso si spegnerebbe IN SILENZIO. Si notifica allora `review.completed`
 * — MAI un kind nuovo (un valore nuovo di `notification_kind` è la trappola del
 * 500 su `/api/inbox` al rollback) — con `verdict: null` e `cycle.stoppedReason:
 * "review_failed"`, agli stessi destinatari dello stop al tetto
 * (`projectId`+`ticketId`, niente jobId).
 *
 * Solo se:
 *  - la PR è correggibile per un ticket del progetto: una riga
 *    `ticket_repositories` su quel repo e branch, col numero della PR e
 *    ancora APERTA, che passa `isCorrectablePr` (branch di Stubwise del
 *    ticket, o adottata e non rilasciata — stessa prova di
 *    `isCorrectablePrForReview` più lo stato; il ticket qui non è ancora
 *    stato risolto da `resolveTicket`, che gira solo a parse riuscito);
 *  - la serie corrente ha fatto almeno un giro automatico
 *    (`autoRoundsInCurrentSeries > 0`): una review normale fallita resta
 *    silenziosa come oggi. Una richiesta umana (anche `pending`) azzera già il
 *    contatore, quindi in quel caso non si notifica;
 *  - nessuna correzione è ancora aperta sulla PR (`pending`/`queued`, anche
 *    appena promossa): lì il ciclo NON è fermo, qualcosa sta per ripartire.
 *    Va quindi chiamata DOPO `promotePendingAfterFailedReview`.
 *
 * L'avviso si RIPETE a ogni review fallita della serie, come quello dello stop
 * al tetto a ogni review successiva: ogni review nasce da un'azione (un push,
 * una richiesta), e ogni fallimento è un fatto nuovo da sapere.
 *
 * Il chiamante la invoca solo quando la chiusura `failed` è davvero sua (una
 * riga già chiusa dal recovery non si ri-notifica) e MAI nel ramo del limite
 * del provider: lì la review è riaccodata e ripartirà. Best-effort: un errore è
 * una riga di log, mai rilanciato.
 */
export async function notifyCycleStoppedByFailedReview(
  deps: ReviewCycleDeps,
  input: { job: PrReviewJobRow; projectId: string; repositoryName: string },
): Promise<void> {
  const { job } = input;
  try {
    const rows = await deps.db
      .select({
        id: tickets.id,
        number: tickets.number,
        title: tickets.title,
        branch: ticketRepositories.branch,
        adoptedAt: ticketRepositories.adoptedAt,
        adoptionReleasedAt: ticketRepositories.adoptionReleasedAt,
        prNumber: ticketRepositories.prNumber,
      })
      .from(tickets)
      .innerJoin(
        ticketRepositories,
        and(
          eq(ticketRepositories.ticketId, tickets.id),
          eq(ticketRepositories.repositoryId, job.repositoryId),
          eq(ticketRepositories.branch, job.sourceBranch),
          // PR chiusa (magari durante la review): niente ciclo da dichiarare
          // fermo, la chiusura ha già annullato le correzioni.
          eq(ticketRepositories.prState, "open"),
        ),
      )
      .where(eq(tickets.projectId, input.projectId));
    const ticket = rows.find(
      (r) =>
        isCorrectablePr({ ...r, ticketNumber: r.number }) &&
        // Una riga senza numero (pre-0081) vale per il branch, come prima.
        (r.prNumber === null || r.prNumber === job.prNumber),
    );
    if (!ticket) return;
    const where = { repositoryId: job.repositoryId, prNumber: job.prNumber };
    const round = await autoRoundsInCurrentSeries(deps.db, where);
    if (round === 0) return;
    if (await prHasOpenCorrection(deps.db, where)) return;
    const [project] = await deps.db
      .select({ max: projects.prCorrectionMaxRounds })
      .from(projects)
      .where(eq(projects.id, input.projectId));
    const max = project?.max ?? 0;
    console.error(
      `[stubwise-worker] pr-review: PR #${job.prNumber}: review fallita dopo ${round} correzioni automatiche, ciclo fermato (notifico)`,
    );
    await notify(
      {
        ...(deps.publicUrl !== undefined ? { publicUrl: deps.publicUrl } : {}),
        projectName: input.repositoryName,
        ...(deps.publish !== undefined ? { publish: deps.publish } : {}),
      },
      deps.db,
      {
        kind: "review.completed",
        ticketNumber: ticket.number,
        ticketTitle: ticket.title,
        projectName: input.repositoryName,
        ticketUrl: ticketUrl(deps.publicUrl, ticket.id),
        prUrl: job.prUrl,
        verdict: null,
        cycle: { round, max, stopped: true, stoppedReason: "review_failed" },
      },
      { projectId: input.projectId, ticketId: ticket.id },
    );
  } catch (err) {
    console.error(
      `[stubwise-worker] pr-review: PR #${job.prNumber}: avviso del ciclo fermato dalla review fallita non pubblicato (${errText(err)})`,
    );
  }
}
