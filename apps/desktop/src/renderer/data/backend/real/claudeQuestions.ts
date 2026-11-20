import { ApiError } from "@stubwise/api-client";
import type { AgentSessionEvent, ClaudeConversationQuestion, Reader } from "@stubwise/shared";
import type { ConversationEvent } from "../../types";
import { appClient } from "./client";

// Le domande a scelta della conversazione libera (area 10, F2, Task 3 di 72;
// D-2 = a). L'evento `question` della sessione porta solo `{ questionId }`:
// testo, opzioni e risposta li dà la lettura a sé (`GET …/questions`), che
// il server filtra per chi legge come le proposte (chi legge una pubblica
// non vede le domande del seguito privato). Ne nasce l'evento `question` del
// prototipo, e la scheda (`QuestionCard`) lo disegna. La risposta va su
// `POST …/answer`; per indice entra nella conversazione come un messaggio
// della persona con l'etichetta, per testo così com'è (lo fa il server).

type Question = Reader<ClaudeConversationQuestion>;

/** Se fra gli eventi c'è una domanda: senza, la lista non si legge. */
export const hasQuestionEvents = (raw: readonly Reader<AgentSessionEvent>[]): boolean =>
  raw.some((e) => (e.type as string) === "question");

/** Le domande della conversazione, come le vede chi legge; un server senza la rotta: nessuna. */
export async function readQuestions(id: string): Promise<Question[]> {
  try {
    return await appClient().claude.conversations.questions(id);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return [];
    throw error;
  }
}

/** Gli eventi `question` del prototipo, nel punto dei loro eventi; una domanda che la lista non dà non c'è. */
export function questionEventsOf(
  raw: readonly Reader<AgentSessionEvent>[],
  questions: readonly Question[],
): ConversationEvent[] {
  const out: ConversationEvent[] = [];
  const seen = new Set<string>();
  for (const e of raw) {
    if ((e.type as string) !== "question") continue;
    const questionId = (e.data as { questionId?: unknown } | null)?.questionId;
    const q = questions.find((x) => x.id === questionId);
    if (!q || seen.has(q.id)) continue;
    seen.add(q.id);
    out.push({
      id: `question:${q.id}`,
      at: e.at,
      type: "question",
      questionId: q.id,
      text: q.text,
      options: q.options.map((o) => ({
        label: o.label,
        ...(o.description ? { consequence: o.description } : {}),
      })),
      answer: q.answer
        ? {
            optionIndex: q.answer.index,
            text: q.answer.text,
            byId: q.answer.by?.id ?? "",
            at: q.answer.at,
          }
        : null,
    } as ConversationEvent);
  }
  return out;
}

/** La risposta dell'autore, con gli errori nella forma del prototipo (`QuestionCard`). */
export async function answerFreeQuestion(
  id: string,
  questionId: string,
  answer: { optionIndex: number | null; text: string | null },
): Promise<void> {
  const text = answer.text?.trim() ?? "";
  const body = answer.optionIndex !== null ? { index: answer.optionIndex } : { text };
  // Gli errori come `call` di `claudeChat.ts`, scritti qui: importarlo
  // chiuderebbe un giro di import con lo stream.
  try {
    await appClient().claude.conversations.answerQuestion(id, questionId, body);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.code === "answered") {
      // Chi l'ha presa non lo dice il server: la scheda dice «già risposta».
      throw Object.assign(new Error("already_answered"), { byId: null });
    }
    // Il budget del mese finito: lo stesso errore del prototipo (`isBudgetRefusal`).
    if (error.code === "budget_exhausted") throw new Error("invalid: monthly_budget");
    if (error.code === "conversation_archived") throw new Error("forbidden");
    if (error.status === 422) throw new Error("invalid: option");
    if (error.status === 404) throw new Error("not_found");
    throw error;
  }
}
