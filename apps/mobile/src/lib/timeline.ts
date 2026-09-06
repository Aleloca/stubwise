import { UNKNOWN, isUnknown, workStateFor } from "@stubwise/shared";
import type { AiJob, Reader, TicketQuestion, Unknown, WorkState } from "@stubwise/shared";

/**
 * I 6 passi "in parole" del canvas (schermate `2c`/`2d`, sezione "Storia del
 * lavoro"): Proposto → Domanda risposta → Piano approvato → In esecuzione →
 * PR e review → Rilascio. Fissi e sempre tutti e 6 presenti (a differenza
 * della timeline TECNICA del web, `apps/web/src/components/ai-job-timeline.tsx`,
 * che elenca i job uno per uno con lo stato grezzo della coda) — qui si mostra
 * SEMPRE lo stesso vocabolario umano, con lo stato di avanzamento a dire cosa
 * è successo.
 */
export const WORK_STEP_ORDER = [
  "proposed",
  "questionAnswered",
  "planApproved",
  "working",
  "prReview",
  "release",
] as const;
export type WorkStepId = (typeof WORK_STEP_ORDER)[number];

export type WorkStepStatus = "done" | "current" | "future";

export interface WorkStep {
  id: WorkStepId;
  status: WorkStepStatus;
  /** ISO 8601, quando conosciuta; `null` altrimenti (compresi tutti i passi `future`). */
  at: string | null;
}

/**
 * Il passo (1-based, indice in {@link WORK_STEP_ORDER}) che uno stato del
 * lavoro ha RAGGIUNTO — cioè il passo "corrente" per gli stati non terminali,
 * o l'ultimo passo completato per quelli terminali (vedi {@link TERMINAL_STATES}).
 *
 * Alcune scelte non sono ovvie dall'enum da sole:
 *
 * - `held`: il gate di automazione scatta SUBITO dopo il triage, prima che
 *   qualunque domanda sia stata posta o piano approvato — quindi resta al
 *   passo 1 ("proposto, in attesa di un avvio manuale"), non al 3 ("piano
 *   approvato") anche se concettualmente è anch'esso "un umano deve
 *   sbloccare": non è un'approvazione di piano, è un via libera a partire.
 * - `failed`: `AiJobStatus` non conserva IN QUALE fase un job è fallito. Il
 *   passo 4 ("In esecuzione") è l'approssimazione più plausibile — un
 *   fallimento capita più spesso durante il fix che durante il triage — ma
 *   resta una stima, non un fatto derivato dai dati.
 * - `skipped`: il triage ha giudicato il ticket non fixabile: non è mai
 *   andato oltre la proposta.
 * - `rejected` (= `pr_closed`): la PR era stata aperta (passo 5 raggiunto) e
 *   un umano l'ha chiusa senza merge.
 * - `done` (= `pr_merged`) ferma a 5, MAI a 6: "Rilascio" non è mai `done` in
 *   v1 — Stubwise non fa merge, è rinviato alla fase 8. Nessuno stato in
 *   questa tabella vale 6 apposta, così il passo 6 è SEMPRE `future`.
 */
const CHECKPOINT: Record<WorkState, number> = {
  proposed: 1,
  planning: 1,
  held: 1,
  waiting_answer: 2,
  waiting_approval: 3,
  working: 4,
  pr_ready: 5,
  done: 5,
  failed: 4,
  skipped: 1,
  rejected: 5,
};

/**
 * Stati TERMINALI: il job non è più "in corso", quindi il passo del
 * checkpoint è `done` (raggiunto e concluso) invece di `current` (in corso
 * adesso) — non c'è più nulla che stia accadendo in questo momento.
 */
const TERMINAL_STATES: ReadonlySet<WorkState> = new Set<WorkState>(["done", "failed", "skipped", "rejected"]);

interface Checkpoint {
  step: number;
  terminal: boolean;
}

/**
 * Checkpoint di un job, con degrado esplicito per uno stato che questa build
 * non conosce ({@link isUnknown} — un server più nuovo dell'app, stesso
 * principio di `waitingKindKey` in `lib/pulse-line.ts`): `workStateFor` esiste
 * solo per `AiJobStatus` CHIUSO, quindi qui ci si affida ai soli segnali
 * temporali sempre presenti nello schema — mai un valore grezzo mostrato, mai
 * un crash. `finishedAt` valorizzato → si assume concluso (checkpoint 5,
 * terminale); solo `startedAt` → si assume ancora in esecuzione (checkpoint
 * 4); nessuno dei due → si resta al passo 1.
 */
function checkpointFor(job: Reader<AiJob> | undefined): Checkpoint {
  if (!job) return { step: 1, terminal: false };
  if (isUnknown(job.status)) {
    if (job.finishedAt !== null) return { step: 5, terminal: true };
    if (job.startedAt !== null) return { step: 4, terminal: false };
    return { step: 1, terminal: false };
  }
  const workState = workStateFor(job.status);
  return { step: CHECKPOINT[workState], terminal: TERMINAL_STATES.has(workState) };
}

/**
 * Lo stato "in parole" dell'ultimo job di un ticket — `null` se non ha ancora
 * nessun job. SEPARATO da {@link checkpointFor}: quello ha bisogno di
 * un'euristica di fallback per posizionare un job di stato ignoto sui 6 passi,
 * questo restituisce il dato grezzo (`UNKNOWN` incluso) e lascia al chiamante
 * ({@link StatusBadge}, il badge di testata della schermata Lavoro) decidere
 * come mostrarlo.
 */
export function resolveWorkState(job: Reader<AiJob> | undefined): WorkState | Unknown | null {
  if (!job) return null;
  if (isUnknown(job.status)) return UNKNOWN;
  return workStateFor(job.status);
}

export interface BuildTimelineInput {
  /** Solo il campo che serve (data del passo "Proposto"): non l'intero `TicketDetail`, per restare testabile con fixture minime. */
  ticket: { createdAt: string };
  /** Dal più recente al più vecchio (contratto di `client.tickets.jobs`): SOLO `jobs[0]` — l'ultimo tentativo — decide il checkpoint. */
  jobs: Reader<AiJob>[];
  questions: Reader<TicketQuestion>[];
}

/**
 * Le 6 righe della "Storia del lavoro" (canvas `2c`/`2d`), derivate dall'
 * ULTIMO job del ticket (`jobs[0]`): un ticket può avere più job nella sua
 * storia (fix, ripianificazione, rilanci manuali), ma solo il più recente
 * rappresenta "come sta andando adesso" — stessa scelta di `latestJob` nella
 * pagina ticket web (`apps/web/src/routes/tickets/$id.tsx`).
 *
 * Senza NESSUN job (ticket creato ma mai avviato), il passo 1 è `current` con
 * la data di creazione del ticket e tutto il resto `future`.
 */
export function buildTimeline({ ticket, jobs, questions }: BuildTimelineInput): WorkStep[] {
  const latestJob = jobs[0];
  const { step: checkpoint, terminal } = checkpointFor(latestJob);

  // La domanda (se c'è) del round più recente RISPOSTO sul job corrente — mai
  // di un job precedente: stessa regola "solo l'ultimo job conta" di sopra.
  const answeredQuestion = latestJob
    ? questions.find((question) => question.jobId === latestJob.id && question.answeredAt !== null)
    : undefined;

  return WORK_STEP_ORDER.map((id, index) => {
    const stepIndex = index + 1;
    const status: WorkStepStatus =
      stepIndex < checkpoint ? "done" : stepIndex === checkpoint ? (terminal ? "done" : "current") : "future";
    return { id, status, at: atFor(id, ticket, latestJob, answeredQuestion) };
  });
}

function atFor(
  id: WorkStepId,
  ticket: { createdAt: string },
  job: Reader<AiJob> | undefined,
  answeredQuestion: Reader<TicketQuestion> | undefined,
): string | null {
  switch (id) {
    case "proposed":
      return ticket.createdAt;
    case "questionAnswered":
      return answeredQuestion?.answeredAt ?? null;
    case "working":
      return job?.startedAt ?? null;
    default:
      // planApproved: nessun campo dati porta "quando" è stato approvato un
      // piano (né su `AiJob` né altrove) — solo CHE lo stato lo implica.
      // prReview/release: idem, nessuna data dedicata nello schema attuale.
      return null;
  }
}
