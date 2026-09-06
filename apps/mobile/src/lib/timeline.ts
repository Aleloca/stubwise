import { UNKNOWN, isUnknown, workStateFor } from "@stubwise/shared";
import type {
  AiJob,
  PrReviewSummary,
  Reader,
  TicketActivityEntry,
  TicketQuestion,
  Unknown,
  WorkState,
} from "@stubwise/shared";

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
  /**
   * Verdetto della review AI, SOLO sul passo `prReview` — `null` su ogni altro
   * passo e quando nessuna review completata esiste per questo ticket. È un
   * fatto della PR, non del lavoro nel suo insieme, e sta qui (invece che in un
   * campo a parte accanto ai passi) perché è la riga della timeline a doverlo
   * mostrare.
   */
  verdict: Reader<PrReviewSummary>["verdict"];
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
  /** Solo i campi che servono (data del passo "Proposto", identità per filtrare le review): non l'intero `TicketDetail`, per restare testabile con fixture minime. */
  ticket: { id: string; createdAt: string };
  /** Dal più recente al più vecchio (contratto di `client.tickets.jobs`): SOLO `jobs[0]` — l'ultimo tentativo — decide il checkpoint. */
  jobs: Reader<AiJob>[];
  questions: Reader<TicketQuestion>[];
  /**
   * Il feed di `GET /api/tickets/:id/activity`, in ordine crescente di
   * `createdAt`. **Opzionale**: è una query in più rispetto alle tre che
   * reggono la schermata, e un suo fallimento non deve svuotare la "Storia del
   * lavoro" — assente, i due passi che ne dipendono tornano semplicemente senza
   * data, com'erano prima della fase 5.
   */
  activity?: Reader<TicketActivityEntry>[];
  /**
   * Le review AI delle PR del PROGETTO (`GET /api/projects/:id/reviews`):
   * quelle di altri ticket vengono scartate qui. Opzionale per la stessa
   * ragione di `activity`.
   */
  reviews?: Reader<PrReviewSummary>[];
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
export function buildTimeline({ ticket, jobs, questions, activity, reviews }: BuildTimelineInput): WorkStep[] {
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
    return {
      id,
      status,
      at: atFor(id, ticket, latestJob, answeredQuestion, activity),
      verdict: id === "prReview" ? verdictFor(ticket.id, reviews) : null,
    };
  });
}

/**
 * L'istante dell'ULTIMA transizione verso `to` nel feed del ticket, `null` se
 * non c'è.
 *
 * L'ultima e non la prima: un ticket rilanciato passa più volte per gli stessi
 * stati, e la riga della timeline racconta il tentativo in corso — lo stesso
 * criterio "solo l'ultimo job conta" che regge il resto di questo modulo. Il
 * feed arriva già ordinato per `createdAt` crescente, ma si confrontano
 * comunque le date invece di prendere l'ultimo elemento che corrisponde: la
 * correttezza non deve dipendere dall'ordine con cui il server risponde.
 */
function lastTransitionTo(activity: Reader<TicketActivityEntry>[] | undefined, to: string): string | null {
  let latest: string | null = null;
  for (const entry of activity ?? []) {
    if (entry.kind !== "event" || entry.eventKind !== "status_changed") continue;
    if (entry.payload?.to !== to) continue;
    if (latest === null || entry.createdAt > latest) latest = entry.createdAt;
  }
  return latest;
}

/**
 * Il verdetto della review più recente COMPLETATA della PR di questo ticket.
 *
 * Una review ancora in corso ha `verdict: null` ed è indistinguibile qui da
 * "nessuna review": in entrambi i casi non c'è niente da dire, e il passo non
 * mostra nulla invece di mostrare un'attesa.
 */
function verdictFor(
  ticketId: string,
  reviews: Reader<PrReviewSummary>[] | undefined,
): Reader<PrReviewSummary>["verdict"] {
  let best: Reader<PrReviewSummary> | undefined;
  for (const row of reviews ?? []) {
    if (row.ticketId !== ticketId || row.verdict === null) continue;
    if (best === undefined || row.createdAt > best.createdAt) best = row;
  }
  return best?.verdict ?? null;
}

function atFor(
  id: WorkStepId,
  ticket: { createdAt: string },
  job: Reader<AiJob> | undefined,
  answeredQuestion: Reader<TicketQuestion> | undefined,
  activity: Reader<TicketActivityEntry>[] | undefined,
): string | null {
  switch (id) {
    case "proposed":
      return ticket.createdAt;
    case "questionAnswered":
      return answeredQuestion?.answeredAt ?? null;
    case "working":
      return job?.startedAt ?? null;
    /**
     * Nessun campo di `AiJob` porta "quando" un piano è stato approvato o
     * "quando" la PR è nata: le due date vengono dagli EVENTI di audit del
     * ticket (fase 5, `recordTicketStatusChange` in `packages/db`).
     *
     * La corrispondenza non è nominale ed è bene dirla: l'approvazione del
     * piano NON lascia un evento suo: lascia un commento di sistema, che è
     * testo tradotto e non un dato. L'evento che l'app data qui è il
     * passaggio a `in_progress`, cioè l'esecuzione che l'approvazione
     * sblocca — scritto dal worker nella stessa transazione in cui il fix
     * comincia. Su un ticket senza gate (nessun piano da approvare) quella
     * data compare comunque, ma il passo era GIÀ `done` per il checkpoint:
     * la data non aggiunge un'affermazione che la riga non facesse già.
     */
    case "planApproved":
      return lastTransitionTo(activity, "in_progress");
    case "prReview":
      return lastTransitionTo(activity, "in_review");
    default:
      // release: mai `done` in v1 (Stubwise non fa merge), nessuna data.
      return null;
  }
}
