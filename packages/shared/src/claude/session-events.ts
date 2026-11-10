import { buildTranscript, type TranscriptItem } from "../agent-transcript.js";
import type { Reader } from "../reader.js";
import type { AgentSessionEvent, AgentSessionInput, AgentSessionQuestion } from "../schemas/agent-session.js";
import type { ConversationEvent, Outcome, PlanEvent, QuestionEvent, WorkEvent } from "./work.js";

/**
 * L'adattatore PURO dagli eventi di una sessione del server ai
 * `ConversationEvent` del prototipo (integrazione area 3, fetta 3a): la
 * sezione Claude della task, il riquadro e la pagina Claude dell'app leggono
 * la forma del prototipo, il server ne ha un'altra (segmenti, testo, tool,
 * interventi, `docs/invariants/agent-sessions.md`).
 *
 * Passa da `buildTranscript` (`agent-transcript.ts`), la stessa trascrizione
 * di web e app mobile, così valgono le sue regole senza ricopiarle: le domande
 * `ask_user` collassate sulle domande del dettaglio, gli interventi senza
 * evento al loro punto nel tempo, «In coda» solo a sessione viva, «Ferma»
 * senza testo che non è un messaggio. Poi la mappa:
 *
 * - `segment` → `phase` (l'etichetta del segmento), con l'esito dal suo
 *   `segment_end`: `null` finché è aperto, `ok` con uscita 0, `timed_out` se
 *   è scaduto, altrimenti `failed`;
 * - testo → `assistant` (`done` falso per il parziale dal vivo);
 * - tool → `action` (`running` senza risultato, `failed` con errore); l'input
 *   come stringa (JSON se è un oggetto);
 * - intervento → `user`, con chi l'ha scritto (`""` se non si sa più) e la
 *   consegna (`pending` per quello «In coda»); lo «Ferma» senza testo no;
 * - domanda → `question` (opzioni, la consigliata, la risposta: chi e quando
 *   non li porta il server, quindi `byId` e `at` sono vuoti);
 * - il PIANO non è un evento del server: lo passa il chiamante (il piano del
 *   job, da `/api/tasks/:id/work`) e diventa un `plan` al suo istante.
 *
 * L'interruzione («Ferma e scrivi») e il fine segmento non diventano eventi:
 * il prototipo li legge dallo stato della sessione.
 */

/** Il piano del job della sessione, se c'è (dal ticket: il server non lo mette fra gli eventi). */
export interface SessionPlan {
  text: string;
  summary: string;
  status: PlanEvent["status"];
  /** Quando il piano è arrivato. */
  at: string;
  decidedById?: string;
  instructions?: string;
}

export interface SessionEventsInput {
  /** Ascendenti per id, senza doppi (`mergeEvents`). */
  events: readonly Reader<AgentSessionEvent>[];
  /** segmentId → testo parziale accumulato (`applyPartial`). */
  partials: Record<string, string>;
  inputs: readonly Reader<AgentSessionInput>[];
  questions: readonly Reader<AgentSessionQuestion>[];
  /** La sessione non è conclusa (`detail.state !== "ended"`). */
  live: boolean;
  plan?: SessionPlan | null;
}

function outcomeOf(item: Extract<TranscriptItem, { kind: "segment_end" }>): Outcome {
  if (item.timedOut) return "timed_out";
  return item.exitCode === 0 ? "ok" : "failed";
}

function inputText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function questionOf(item: Extract<TranscriptItem, { kind: "question" }>): QuestionEvent {
  const q = item.question;
  const answer = q.answer;
  return {
    id: item.id,
    at: item.at,
    type: "question",
    questionId: q.id,
    text: q.question,
    options: (q.options ?? []).map((o, index) => ({
      label: o.label,
      ...(o.consequence !== undefined ? { consequence: o.consequence } : {}),
      recommended: q.recommendedIndex === index,
    })),
    answer: answer
      ? {
          optionIndex: "optionIndex" in answer ? answer.optionIndex : null,
          text: "text" in answer ? answer.text : null,
          byId: "",
          at: "",
        }
      : null,
  };
}

export function toConversationEvents(input: SessionEventsInput): WorkEvent[] {
  const items = buildTranscript({
    events: [...input.events],
    partials: input.partials,
    inputs: [...input.inputs],
    questions: [...input.questions],
    live: input.live,
  });
  // Chi ha scritto un intervento: dall'evento (`authorUserId`) o dalla riga.
  const authorOf = new Map<string, string>();
  for (const e of input.events) {
    const author = e.data?.["authorUserId"];
    if (e.type === "input" && typeof author === "string") authorOf.set(e.id, author);
  }
  for (const i of input.inputs) if (i.authorUserId) authorOf.set(`input:${i.id}`, i.authorUserId);

  const out: WorkEvent[] = [];
  let openPhase: number | null = null;
  for (const item of items) {
    switch (item.kind) {
      case "segment":
        openPhase = out.length;
        out.push({ id: item.id, at: item.at, type: "phase", phase: item.label, outcome: null });
        break;
      case "segment_end":
        if (openPhase !== null) {
          const phase = out[openPhase];
          if (phase?.type === "phase") out[openPhase] = { ...phase, outcome: outcomeOf(item) };
          openPhase = null;
        }
        break;
      case "text":
        out.push({ id: item.id, at: item.at, type: "assistant", text: item.text, done: !item.live });
        break;
      case "tool": {
        const text = inputText(item.input);
        out.push({
          id: item.id,
          at: item.at,
          type: "action",
          tool: item.name,
          label: item.name,
          ...(text !== undefined ? { input: text } : {}),
          ...(item.result ? { result: item.result.content, truncated: item.result.truncated } : {}),
          state: item.result === null ? "running" : item.result.isError ? "failed" : "done",
        });
        break;
      }
      case "input":
        if (item.stop) break;
        out.push({
          id: item.id,
          at: item.at,
          type: "user",
          authorId: authorOf.get(item.id) ?? "",
          text: item.text,
          attachments: [],
          delivery: item.queued ? "pending" : item.status === "__unknown__" ? "delivered" : item.status,
          ...(item.reason && item.reason !== "__unknown__" ? { undeliveredReason: item.reason } : {}),
        });
        break;
      case "question":
        out.push(questionOf(item));
        break;
      case "interrupted":
        break;
    }
  }
  if (input.plan) {
    const plan = input.plan;
    const event: PlanEvent = {
      id: `plan:${plan.at}`,
      at: plan.at,
      type: "plan",
      planText: plan.text,
      summary: plan.summary,
      status: plan.status,
      ...(plan.decidedById ? { decidedById: plan.decidedById } : {}),
      ...(plan.instructions ? { instructions: plan.instructions } : {}),
    };
    const t = Date.parse(plan.at);
    let index = out.length;
    while (index > 0 && Date.parse(out[index - 1]!.at) > t) index--;
    out.splice(index, 0, event);
  }
  return out;
}

/** L'ultima domanda ancora senza risposta, o null. */
export function openQuestion(events: readonly ConversationEvent[]): QuestionEvent | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!;
    if (e.type === "question" && e.answer === null) return e;
  }
  return null;
}

/** L'ultimo piano, se aspetta ancora una decisione; null altrimenti. */
export function pendingPlan(events: readonly ConversationEvent[]): PlanEvent | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!;
    if (e.type === "plan") return e.status === "pending" ? e : null;
  }
  return null;
}
