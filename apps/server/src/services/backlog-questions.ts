/**
 * Domande a bottoni sulla voce di backlog (fase 7), GEMELLO di
 * `./questions.ts` (`answerQuestion`, la risposta alla domanda dell'agente sul
 * fix) ma su un'ancora diversa: `backlog_questions.backlog_item_id`, non un
 * job. Una voce di backlog non convertita non ha né job né ticket, quindi non
 * può riusare `agent_questions` — da qui la tabella gemella (migrazione 0072)
 * e questo servizio gemello, non un'estensione di quello esistente.
 *
 * TRE differenze dal gemello, tutte deliberate:
 *  1. Nessuna identità da verificare: rispondere a una domanda della chat del
 *     backlog è lavoro quotidiano (`requireAuth`, non ristretto al
 *     richiedente/maintainer come `answerQuestion`) — la voce non ha un
 *     "richiedente" del run a cui ancorare il permesso.
 *  2. Il job da riprendere non è quello che ha posto la domanda (qui non c'è
 *     un job "fermo"): `answerBacklogQuestion` ACCODA un nuovo `backlog_jobs`
 *     `chat_turn` con `answeredQuestionId`, che il worker (Task 6,
 *     `chat-turn.ts`) userà per riprendere la sessione CLI con `--resume`,
 *     portando la risposta — solo se la voce ha ancora una sessione di analisi
 *     `active` (altrimenti la risposta resta scritta, senza continuazione:
 *     stesso degrado morbido di `POST /:id/chat` su una sessione chiusa).
 *  3. **Un'uscita in più**: `dismissBacklogQuestion` ("non ora") chiude la
 *     domanda SENZA rispondere. Il sistema ha già pagato una volta il prezzo
 *     di domande senza via d'uscita (`agent_questions`, vedi il commento in
 *     `packages/notifications/src/actions.ts` sul kind non archiviabile):
 *     qui l'uscita è obbligatoria e sempre disponibile, in QUALUNQUE stato.
 */
import {
  backlogChatMessages,
  backlogCodeSessions,
  backlogItems,
  backlogJobs,
  backlogQuestions,
  users,
  type Db,
} from "@stubwise/db";
import {
  ANSWER_TEXT_MAX_CHARS,
  type AgentQuestionAnswer,
} from "@stubwise/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import { renderAnswer } from "./questions.js";
import type { Actor } from "./jobs.js";

/** Un'opzione persistita: gemella di quella di `agent_questions.options`. */
export interface BacklogQuestionOption {
  label: string;
  consequence?: string;
}

export interface AskBacklogQuestionInput {
  backlogItemId: string;
  question: string;
  options: BacklogQuestionOption[];
  recommendedIndex?: number;
  allowFreeText?: boolean;
}

/** Solo i campi che il chiamante (Task 6) ha bisogno di rileggere subito dopo. */
export interface AskedBacklogQuestion {
  id: string;
  askedAt: Date;
}

/**
 * Pone una nuova domanda sulla voce (INSERT puro, nessuna scrittura del
 * messaggio di chat che la referenzia: quella riga la scrive il CHIAMANTE
 * — `chat-turn.ts`, Task 6 — nella STESSA transazione, insieme al resto del
 * turno). `tx` non è opzionale: chi pone una domanda lo fa sempre dentro la
 * transazione del turno che la produce.
 *
 * Validazione STRUTTURALE minima qui (2..4 opzioni, ciascuna con
 * un'etichetta non vuota): la domanda arriva dall'output di un modello, e il
 * chiamante deve poter degradare in prosa un output malformato invece di
 * propagare un errore SQL. Un `recommendedIndex` fuori range non blocca
 * l'inserimento — la UI lo tratta già come "nessuna raccomandazione" (vedi
 * `QuestionPanel`) — ma un numero di opzioni fuori 2..4 sì: non c'è UI che lo
 * regga a bottoni.
 *
 * L'unicità "una sola domanda aperta per voce" è un vincolo del DB (indice
 * parziale): un secondo INSERT con una domanda già aperta lancia (23505), il
 * chiamante lo cattura o lo previene rileggendo prima.
 */
export async function askBacklogQuestion(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  input: AskBacklogQuestionInput,
): Promise<AskedBacklogQuestion | null> {
  if (input.options.length < 2 || input.options.length > 4) return null;
  if (input.options.some((option) => option.label.trim() === "")) return null;

  const [row] = await tx
    .insert(backlogQuestions)
    .values({
      backlogItemId: input.backlogItemId,
      question: input.question,
      options: input.options,
      ...(input.recommendedIndex !== undefined ? { recommendedIndex: input.recommendedIndex } : {}),
      ...(input.allowFreeText !== undefined ? { allowFreeText: input.allowFreeText } : {}),
    })
    .returning({ id: backlogQuestions.id, askedAt: backlogQuestions.askedAt });
  return row ?? null;
}

/**
 * Errori tipizzati di {@link answerBacklogQuestion} e
 * {@link dismissBacklogQuestion}, mappati a HTTP dalle rotte:
 * `already_answered` (c'è già una risposta) e `question_not_pending` (chiusa
 * in altro modo — "non ora" per la risposta, già risposta o già "non ora" per
 * il dismiss) sono DISTINTI apposta, non un solo "non più aperta": chi
 * risponde in ritardo a una domanda già decisa merita di sapere che una
 * risposta c'è già, non un generico "non più valida".
 */
export type AnswerBacklogQuestionError =
  | "not_found"
  | "already_answered"
  | "invalid_answer"
  | "question_not_pending";

/** La risposta COME ARRIVA dalla superficie: gemella di `AnswerInput` in `./questions.ts`. */
export interface BacklogAnswerInput {
  optionIndex?: number;
  text?: string;
}

export interface AnswerBacklogQuestionInput {
  /** Voce di backlog attesa: scoping dell'URL annidato, verificato QUI. */
  backlogItemId: string;
  questionId: string;
  actor: Actor;
  answer: BacklogAnswerInput;
}

export type AnswerBacklogQuestionResult =
  | { ok: true; backlogItemId: string }
  | { ok: false; error: AnswerBacklogQuestionError };

/**
 * Registra la risposta umana a una domanda della chat del backlog.
 *
 * L'UNICITÀ della risposta è la stessa disciplina di `answerQuestion`: UPDATE
 * guardato su `answered_at IS NULL` — la seconda risposta concorrente trova 0
 * righe e perde, senza bisogno di un lock esplicito. Diversamente dal
 * gemello, **`dismissed_at IS NULL` fa parte della stessa guardia**: una
 * domanda chiusa con "non ora" non è più rispondibile, ma è un esito DIVERSO
 * da "già risposta" (vedi {@link pendingError}) — chi arriva tardi merita di
 * sapere quale dei due è successo.
 *
 * `backlogItemId` è verificato contro la riga persistita, non solo passato per
 * comodità: la rotta è annidata (`/:id/questions/:questionId/answer`), e senza
 * questo controllo un `questionId` valido ma di UN'ALTRA voce risponderebbe
 * comunque — `not_found` è la risposta giusta a un URL che non torna.
 *
 * Dopo la scrittura, un messaggio `system` nella chat rende la scelta
 * PERMANENTE nella conversazione (design fase 7 §4: "la scelta fatta resta
 * scritta"), con lo stesso `renderAnswer` che usa il gemello per Slack/il
 * commento sul ticket — stessa resa ovunque la stessa risposta compaia.
 */
export async function answerBacklogQuestion(
  db: Db,
  input: AnswerBacklogQuestionInput,
): Promise<AnswerBacklogQuestionResult> {
  const { questionId, actor } = input;

  const [question] = await db
    .select({
      backlogItemId: backlogQuestions.backlogItemId,
      options: backlogQuestions.options,
      allowFreeText: backlogQuestions.allowFreeText,
      answeredAt: backlogQuestions.answeredAt,
      dismissedAt: backlogQuestions.dismissedAt,
    })
    .from(backlogQuestions)
    .where(eq(backlogQuestions.id, questionId));
  if (!question || question.backlogItemId !== input.backlogItemId) {
    return { ok: false, error: "not_found" };
  }
  const notPending = pendingError(question);
  if (notPending) return { ok: false, error: notPending };

  const answer = normalizeBacklogAnswer(input.answer, question);
  if (!answer) return { ok: false, error: "invalid_answer" };

  const [actorRow] = await db.select({ email: users.email }).from(users).where(eq(users.id, actor.id));
  const rendered = renderAnswer(answer, question.options);

  const written = await db.transaction(async (tx) => {
    const answered = await tx
      .update(backlogQuestions)
      .set({ answer, answeredAt: sql`now()`, answeredByUserId: actor.id })
      .where(
        and(
          eq(backlogQuestions.id, questionId),
          isNull(backlogQuestions.answeredAt),
          isNull(backlogQuestions.dismissedAt),
        ),
      )
      .returning({ id: backlogQuestions.id });
    // Corsa persa (o "non ora" arrivato per primo): niente da scrivere oltre.
    if (answered.length === 0) return false;

    await tx.insert(backlogChatMessages).values({
      itemId: question.backlogItemId,
      role: "system",
      content: `${actorRow?.email ?? "—"}: ${rendered}`,
    });

    // Accoda il turno di RIPRESA (fase 7, Task 6): solo se la voce ha ancora
    // una sessione di analisi `active` — è lì che l'agente aveva posto la
    // domanda, ed è lì che deve riprendere. Nessuna sessione attiva (chiusa
    // nel frattempo) → la risposta resta scritta ma senza continuazione,
    // stesso degrado morbido di `POST /:id/chat` su una sessione chiusa.
    const [session] = await tx
      .select({ id: backlogCodeSessions.id, projectId: backlogItems.projectId })
      .from(backlogCodeSessions)
      .innerJoin(backlogItems, eq(backlogItems.id, backlogCodeSessions.itemId))
      .where(
        and(
          eq(backlogCodeSessions.itemId, question.backlogItemId),
          eq(backlogCodeSessions.status, "active"),
        ),
      );
    if (session) {
      await tx.insert(backlogJobs).values({
        projectId: session.projectId,
        kind: "chat_turn",
        payload: {
          itemId: question.backlogItemId,
          sessionId: session.id,
          answeredQuestionId: questionId,
        },
      });
    }
    return true;
  });
  if (!written) {
    // Corsa persa fra il pre-check e la scrittura: si rilegge per dire il
    // motivo vero (un'altra risposta ha vinto, o è arrivato un "non ora").
    const [current] = await db
      .select({ answeredAt: backlogQuestions.answeredAt, dismissedAt: backlogQuestions.dismissedAt })
      .from(backlogQuestions)
      .where(eq(backlogQuestions.id, questionId));
    return { ok: false, error: (current && pendingError(current)) ?? "question_not_pending" };
  }

  return { ok: true, backlogItemId: question.backlogItemId };
}

/**
 * `null` se la domanda è ancora aperta, l'errore giusto altrimenti:
 * `already_answered` se ha una risposta, `question_not_pending` se è stata
 * chiusa con "non ora". Condivisa fra {@link answerBacklogQuestion} (pre-check
 * e ricontrollo dopo una corsa persa) e {@link dismissBacklogQuestion}.
 */
function pendingError(question: {
  answeredAt: Date | null;
  dismissedAt: Date | null;
}): "already_answered" | "question_not_pending" | null {
  if (question.answeredAt !== null) return "already_answered";
  if (question.dismissedAt !== null) return "question_not_pending";
  return null;
}

export type DismissBacklogQuestionError = "not_found" | "already_answered" | "question_not_pending";
export type DismissBacklogQuestionResult =
  | { ok: true; backlogItemId: string }
  | { ok: false; error: DismissBacklogQuestionError };

/**
 * "Non ora": chiude la domanda SENZA rispondere, lasciando la conversazione
 * libera. Nessun messaggio di chat — a differenza della risposta, "non ora"
 * non è una decisione da tramandare, è solo la scelta di non decidere adesso.
 *
 * Stessa guardia di `answerBacklogQuestion` (`answered_at IS NULL AND
 * dismissed_at IS NULL`): rispondere e "non ora" sono simmetriche, la prima
 * che arriva vince.
 */
export async function dismissBacklogQuestion(
  db: Db,
  input: { backlogItemId: string; questionId: string; actor: Actor },
): Promise<DismissBacklogQuestionResult> {
  const [question] = await db
    .select({
      backlogItemId: backlogQuestions.backlogItemId,
      answeredAt: backlogQuestions.answeredAt,
      dismissedAt: backlogQuestions.dismissedAt,
    })
    .from(backlogQuestions)
    .where(eq(backlogQuestions.id, input.questionId));
  if (!question || question.backlogItemId !== input.backlogItemId) {
    return { ok: false, error: "not_found" };
  }
  const notPending = pendingError(question);
  if (notPending) return { ok: false, error: notPending };

  const dismissed = await db
    .update(backlogQuestions)
    .set({ dismissedAt: sql`now()` })
    .where(
      and(
        eq(backlogQuestions.id, input.questionId),
        isNull(backlogQuestions.answeredAt),
        isNull(backlogQuestions.dismissedAt),
      ),
    )
    .returning({ id: backlogQuestions.id });
  if (dismissed.length === 0) {
    const [current] = await db
      .select({ answeredAt: backlogQuestions.answeredAt, dismissedAt: backlogQuestions.dismissedAt })
      .from(backlogQuestions)
      .where(eq(backlogQuestions.id, input.questionId));
    return { ok: false, error: (current && pendingError(current)) ?? "question_not_pending" };
  }
  return { ok: true, backlogItemId: question.backlogItemId };
}

/**
 * Chiude senza risposta l'eventuale domanda ancora aperta di una voce: la
 * chiamano `POST /:id/convert` e l'archiviazione (PATCH status=archived e
 * l'assorbita di un merge), SEMPRE dentro la STESSA transazione dell'azione
 * — non dopo, non best-effort. È l'uscita automatica dichiarata nel design
 * (§4): una voce che sparisce dal flusso normale non deve lasciarsi dietro
 * una domanda che nessuno vedrà mai più. UPDATE guardato come le altre due
 * chiusure: su una voce senza domanda aperta è un no-op (0 righe), non un
 * errore.
 */
export async function closeOpenBacklogQuestion(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  backlogItemId: string,
): Promise<void> {
  await tx
    .update(backlogQuestions)
    .set({ dismissedAt: sql`now()` })
    .where(
      and(
        eq(backlogQuestions.backlogItemId, backlogItemId),
        isNull(backlogQuestions.answeredAt),
        isNull(backlogQuestions.dismissedAt),
      ),
    );
}

/** Quel poco della domanda persistita che serve a validare la risposta. */
interface PersistedBacklogQuestion {
  options: BacklogQuestionOption[];
  allowFreeText: boolean;
}

/**
 * Valida la risposta CONTRO la domanda persistita. Gemella di
 * `normalizeAnswer` in `./questions.ts` — non condivisa (non esportata dal
 * gemello): la validazione dipende solo dalla forma persistita, che qui è
 * un'altra tabella, e duplicarla tiene i due servizi indipendenti come
 * dichiarato nel design ("un gemello, non un'estensione").
 */
function normalizeBacklogAnswer(
  answer: BacklogAnswerInput,
  question: PersistedBacklogQuestion,
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
