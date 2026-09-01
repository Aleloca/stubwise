/**
 * RISPOSTA a una domanda dell'agente (`ask_user`, fase 1).
 *
 * Un run di pianificazione può fermarsi su una domanda: il worker scrive la riga
 * `agent_questions`, parcheggia il job in `awaiting_input` e pubblica la notifica
 * `job.awaiting_input`. Da lì la domanda compare su TRE superfici — l'inbox web,
 * il DM Slack, la pagina ticket — e da tutte e tre si risponde. Questo modulo è
 * il punto unico in cui quella risposta ha effetto: le superfici gli passano
 * l'ancora che hanno in mano (la riga d'inbox su cui si è premuto, o il job per
 * chi risponde dalla pagina ticket) e nient'altro.
 *
 * PERCHÉ UN MODULO A PARTE e non dentro `./inbox.ts`: la pagina ticket non ha
 * una notifica in mano, e `./inbox.ts` importa `./jobs.ts`, quindi un servizio
 * ancorato al job non può vivere lì senza legare la risposta alla superficie
 * inbox. Qui le dipendenze sono `db`, `i18n`, il catalogo dei permessi e la
 * propagazione: nessuno può creare un ciclo importandolo.
 *
 * IL COMMENTO SUL TICKET È `system`, NON `user`. È una decisione, non una
 * dimenticanza. `runFix` costruisce il blocco `<indicazioni_del_team>` con gli
 * ultimi commenti `authorType='user'` e lo marca esplicitamente NON FIDATO;
 * la stessa risposta raggiunge però il modello anche dal blocco
 * `<risposta_umana>`/`<decisioni_prese>`, costruito da `agent_questions` e
 * marcato FIDATO e CHIUSO. Con un commento `user` la stessa frase arriverebbe al
 * modello DUE VOLTE con etichette di fiducia opposte: oltre allo spreco,
 * insegnerebbe che l'etichetta è negoziabile — l'esatto contrario di ciò che i
 * blocchi delimitati costruiscono. Con `system` resta fuori dai team comments
 * per costruzione (la query filtra `authorType='user'`) e vale l'invariante
 * pulita: la risposta raggiunge il modello per UN SOLO canale, quello fidato,
 * alimentato dalla fonte di verità. Il commento serve al FEED umano — nomina chi
 * ha risposto e cita la risposta — non al prompt.
 */
import { agentQuestions, aiJobs, comments, notifications, users, type Db } from "@stubwise/db";
import { t } from "@stubwise/i18n";
import { actorAllows, stateAllows } from "@stubwise/notifications";
import { ANSWER_TEXT_MAX_CHARS, type AgentQuestionAnswer } from "@stubwise/shared";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getContentLanguage } from "../settings.js";
import type { Actor } from "./jobs.js";
import { propagateDecision } from "./notifications-propagation.js";

/** Errori tipizzati di {@link answerQuestion}, mappati a HTTP dalle rotte. */
export type AnswerQuestionError =
  | "not_found"
  | "forbidden"
  | "invalid_answer"
  | "question_not_pending"
  | "already_handled";

/**
 * Chi ha già risposto alla domanda: l'id per la UI, l'email per dirlo a parole.
 * Stessa forma di `HandledBy` in `./inbox.ts` (che è assegnabile a questa) —
 * ridichiarata qui per non far dipendere questo modulo dal servizio inbox, che
 * invece dipende da lui.
 */
export interface AnsweredBy {
  id: string;
  email: string;
}

export type AnswerQuestionResult =
  | {
      ok: true;
      /** Job rimesso in coda: il worker lo riprenderà con `resume_mode='plan_continue'`. */
      jobId: string;
      ticketId: string;
      questionId: string;
      /** Copie della notifica chiuse dalla risposta (tutte, di tutti i destinatari). */
      changedNotificationIds: string[];
    }
  | { ok: false; error: AnswerQuestionError; answeredBy?: AnsweredBy };

/**
 * La risposta COME ARRIVA dalla superficie: un indice di opzione oppure un
 * testo libero. Volutamente più larga della forma persistita
 * (`AgentQuestionAnswer`): Slack costruisce l'indice da un `action_id` e la
 * pagina ticket manda JSON: entrambi possono sbagliare, e la validazione — che
 * dipende dalla domanda persistita — deve stare in un posto solo, qui.
 */
export interface AnswerInput {
  optionIndex?: number;
  text?: string;
}

export interface AnswerQuestionInput {
  /**
   * Ancora "riga d'inbox": inbox web e bottoni Slack. Alternativa a `jobId`
   * (che vince, se ci sono entrambi).
   *
   * Serve SOLO a risalire al job: qui NON si verifica che la notifica sia di
   * chi risponde — lo fa `executeAction`, da cui passano entrambe quelle
   * superfici (una riga altrui è `not_found`, non se ne rivela l'esistenza). Chi
   * chiamasse questo servizio con un `notificationId` senza passare di lì
   * otterrebbe comunque il controllo che conta, `actorAllows`, ma non quello di
   * proprietà della riga.
   */
  notificationId?: string;
  /** Ancora "job": la pagina ticket, che una notifica non ce l'ha. */
  jobId?: string;
  actor: Actor;
  answer: AnswerInput;
}

/**
 * Registra la risposta umana alla domanda aperta di un job e rimette il job in
 * lavorazione.
 *
 * ORDINE DELLE OPERAZIONI, e cosa sta in transazione:
 *
 *  1. risoluzione dell'ancora e lettura di job, domanda e opzioni (letture);
 *  2. permesso (`actorAllows`: il richiedente del run o un maintainer) e stato
 *     (`stateAllows`: il job deve essere davvero fermo su una domanda) —
 *     PRIMA di scrivere, come in `executeAction`;
 *  3. validazione di merito della risposta contro la domanda persistita;
 *  4. **una transazione** con le tre scritture che devono vivere o morire
 *     insieme: risposta sulla domanda (UPDATE guardato su `answered_at IS
 *     NULL`, è ciò che rende la risposta unica), job `awaiting_input` → `queued`
 *     + `resume_mode='plan_continue'` (UPDATE guardato) e commento sul ticket.
 *     Una risposta senza ripresa lascerebbe il job fermo per sempre — e nessuna
 *     seconda risposta potrebbe più sbloccarlo, perché la domanda risulterebbe
 *     chiusa; una ripresa senza risposta farebbe ripianificare il modello senza
 *     la decisione che aspettava;
 *  5. **fuori** dalla transazione: la propagazione. Chiude le copie della
 *     notifica e accoda il rispecchiamento dei DM Slack, cioè tocca I/O esterno
 *     (best-effort per costruzione): tenerla dentro significherebbe far
 *     annullare da un problema di Slack una risposta già data e un job già
 *     ripartito. Stessa scelta di `resolvePlan`.
 */
export async function answerQuestion(
  db: Db,
  input: AnswerQuestionInput,
): Promise<AnswerQuestionResult> {
  const { actor } = input;

  const jobId = input.jobId ?? (await jobIdOfNotification(db, input.notificationId));
  if (!jobId) return { ok: false, error: "not_found" };

  const [job] = await db
    .select({
      id: aiJobs.id,
      status: aiJobs.status,
      ticketId: aiJobs.ticketId,
      requestedByUserId: aiJobs.requestedByUserId,
    })
    .from(aiJobs)
    .where(eq(aiJobs.id, jobId));
  if (!job) return { ok: false, error: "not_found" };

  // Il permesso è di IDENTITÀ, non di ruolo: risponde chi ha chiesto il run
  // (l'unico che sa rispondere nel merito) o un maintainer (che deve poter
  // sbloccare il job di un collega). La regola vive in `actorAllows`, unica
  // sede: qui la si RI-APPLICA, non la si riscrive — le superfici che arrivano
  // qui senza passare dal catalogo (la pagina ticket) devono ottenerla uguale.
  const allowed = actorAllows(
    { kind: "job.awaiting_input", requestedByUserId: job.requestedByUserId },
    "answer",
    actor,
  );
  if (!allowed) return { ok: false, error: "forbidden" };

  const [question] = await db
    .select({
      id: agentQuestions.id,
      round: agentQuestions.round,
      options: agentQuestions.options,
      allowFreeText: agentQuestions.allowFreeText,
    })
    .from(agentQuestions)
    .where(and(eq(agentQuestions.jobId, jobId), isNull(agentQuestions.answeredAt)));
  // Nessuna domanda aperta: o non ce n'è mai stata una (il job non è quello che
  // si crede), oppure qualcuno ha già risposto — e in quel caso il messaggio
  // giusto è "l'ha già fatto X", non "non c'è nulla da rispondere". Va guardato
  // PRIMA dello stato del job, che dopo la risposta è per forza cambiato.
  if (!question) return await notPending(db, jobId);

  if (!stateAllows("answer", job.status)) return { ok: false, error: "question_not_pending" };

  const answer = normalizeAnswer(input.answer, question);
  if (!answer) return { ok: false, error: "invalid_answer" };

  const lang = await getContentLanguage(db);
  const [author] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, actor.id));
  const rendered = renderAnswer(answer, question.options);
  const body = t(lang, "comment.agentQuestionAnswered", {
    actor: author?.email ?? "—",
    round: String(question.round),
    answer: rendered,
  });

  let written: boolean;
  try {
    written = await db.transaction(async (tx): Promise<boolean> => {
      const answered = await tx
        .update(agentQuestions)
        .set({ answer, answeredAt: sql`now()`, answeredByUserId: actor.id })
        .where(and(eq(agentQuestions.id, question.id), isNull(agentQuestions.answeredAt)))
        .returning({ id: agentQuestions.id });
      // Corsa persa: un'altra risposta ha già chiuso la domanda mentre
      // validavamo. Si esce SENZA scrivere nulla (la transazione non ha altro
      // dentro): la seconda UPDATE ha aspettato il lock di riga della prima e
      // ha riletto `answered_at` valorizzato.
      if (answered.length === 0) return false;

      const resumed = await tx
        .update(aiJobs)
        .set({
          status: "queued",
          resumeMode: "plan_continue",
          // Il claim del worker riscriverà `started_at`; qui basta far vedere al
          // job un'attività recente. `cli_session_id` NON si tocca: è la
          // sessione che la ripresa deve riprendere.
          lastActivityAt: sql`now()`,
        })
        .where(and(eq(aiJobs.id, jobId), eq(aiJobs.status, "awaiting_input")))
        .returning({ id: aiJobs.id });
      // Il job è uscito da `awaiting_input` fra la lettura e adesso: la risposta
      // non avrebbe più nessuno che la riprende. Si annulla tutto (rollback) e
      // si risponde come se la domanda non fosse più pendente — perché non lo è.
      if (resumed.length === 0) throw new JobMovedError();

      await tx.insert(comments).values({ ticketId: job.ticketId, authorType: "system", body });
      return true;
    });
  } catch (err) {
    if (err instanceof JobMovedError) return { ok: false, error: "question_not_pending" };
    throw err;
  }

  if (!written) return await notPending(db, jobId);

  // Da qui in poi la risposta è scritta e il job è ripartito: nulla di ciò che
  // segue deve poterlo annullare (vedi il punto 5 del docblock).
  const changedNotificationIds = await propagateDecision(db, {
    target: { jobId, kind: "job.awaiting_input" },
    action: "answer",
    actorId: actor.id,
    answer: rendered,
  });
  return {
    ok: true,
    jobId,
    ticketId: job.ticketId,
    questionId: question.id,
    changedNotificationIds,
  };
}

/** Sentinella interna: il job non è più `awaiting_input` → rollback. */
class JobMovedError extends Error {}

/** Il `job_id` della notifica, o `null` se la riga non esiste o non ha un job dietro. */
async function jobIdOfNotification(db: Db, notificationId?: string): Promise<string | null> {
  if (!notificationId) return null;
  const [row] = await db
    .select({ jobId: notifications.jobId })
    .from(notifications)
    .where(eq(notifications.id, notificationId));
  return row?.jobId ?? null;
}

/**
 * Esito quando il job non ha (più) una domanda aperta: `already_handled` con
 * l'autore se qualcuno ha già risposto, `question_not_pending` se di domande non
 * ce n'erano proprio.
 */
async function notPending(db: Db, jobId: string): Promise<AnswerQuestionResult> {
  // La domanda più recente del job (round più alto). LEFT JOIN e non INNER:
  // `answered_by_user_id` è ON DELETE SET NULL, quindi una risposta di un utente
  // cancellato resta una risposta — solo senza un nome da fare.
  const [row] = await db
    .select({
      answeredAt: agentQuestions.answeredAt,
      userId: users.id,
      email: users.email,
    })
    .from(agentQuestions)
    .leftJoin(users, eq(users.id, agentQuestions.answeredByUserId))
    .where(eq(agentQuestions.jobId, jobId))
    .orderBy(desc(agentQuestions.round))
    .limit(1);
  if (!row || row.answeredAt === null) return { ok: false, error: "question_not_pending" };
  return {
    ok: false,
    error: "already_handled",
    ...(row.userId && row.email ? { answeredBy: { id: row.userId, email: row.email } } : {}),
  };
}

/** Quel poco della domanda persistita che serve a validare e a rendere la risposta. */
interface PersistedQuestion {
  options: { label: string; consequence?: string }[];
  allowFreeText: boolean;
}

/**
 * Valida la risposta CONTRO la domanda persistita e la normalizza nella forma
 * che va sul jsonb. `null` = risposta non valida (il chiamante fa
 * `invalid_answer`).
 *
 * Le regole, tutte insieme perché tutte hanno la stessa risposta: esattamente
 * uno dei due campi; indice intero dentro le opzioni DAVVERO persistite (non
 * quelle che il client crede di avere: possono essere di un round precedente);
 * testo solo se quella domanda lo ammette, trimmato, non vuoto e al più
 * {@link ANSWER_TEXT_MAX_CHARS} caratteri.
 */
function normalizeAnswer(
  answer: AnswerInput,
  question: PersistedQuestion,
): AgentQuestionAnswer | null {
  const hasIndex = answer.optionIndex !== undefined;
  const hasText = answer.text !== undefined;
  if (hasIndex === hasText) return null;

  if (hasIndex) {
    const index = answer.optionIndex!;
    if (!Number.isInteger(index) || index < 0 || index >= question.options.length) return null;
    return { optionIndex: index };
  }

  if (!question.allowFreeText) return null;
  const text = answer.text!.trim();
  if (text === "" || text.length > ANSWER_TEXT_MAX_CHARS) return null;
  return { text };
}

/**
 * La risposta in una riga di testo, per il commento sul ticket e per la nota dei
 * DM Slack: l'etichetta dell'opzione scelta (con la sua conseguenza, che è
 * metà del significato della scelta) oppure il testo libero.
 */
function renderAnswer(
  answer: AgentQuestionAnswer,
  options: { label: string; consequence?: string }[],
): string {
  if ("text" in answer) return answer.text;
  const option = options[answer.optionIndex];
  if (!option) return `#${answer.optionIndex + 1}`;
  return option.consequence ? `${option.label} — ${option.consequence}` : option.label;
}
