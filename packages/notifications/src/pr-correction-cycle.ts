import { aiJobs, prCorrections, prReviews, type Db } from "@stubwise/db";
import type { PrComment, PrCorrectionTrigger } from "@stubwise/shared";
import { and, desc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { IN_FLIGHT_JOB_STATUSES } from "./actions.js";
import type { DbOrTx, Tx } from "./dispatch.js";

/**
 * IL CICLO DI CORREZIONE di una PR aperta da Stubwise (design
 * `docs/plans/2026-09-30-pr-correction-loop-design.md`), condiviso fra SERVER
 * (il bottone, il webhook del provider, la riga di stato sul ticket) e WORKER
 * (la review che chiede modifiche, la correzione che ha pushato). Sta qui per
 * la stessa ragione di `project-timeline.ts`: due writer della stessa coda in
 * due app diverse sono esattamente due regole che poi divergono.
 *
 * Una correzione è una riga `pr_corrections` più, quando parte, una riga
 * `ai_jobs` con `correction_id`. Il CONTATORE dei giri automatici non si salva
 * da nessuna parte: si deriva dalle righe, così non può andare fuori sincrono.
 */

/** Dove: una PR di una repository. */
export interface PrRef {
  repositoryId: string;
  prNumber: number;
}

/** I trigger di una persona: azzerano il contatore della tornata. */
const HUMAN_TRIGGERS = ["stubwise", "provider"] as const;

/** Le righe di UNA PR. */
function onPr(pr: PrRef) {
  return and(
    eq(prCorrections.repositoryId, pr.repositoryId),
    eq(prCorrections.prNumber, pr.prNumber),
  );
}

/**
 * Quante correzioni AUTOMATICHE (`trigger='review'`) ha fatto la tornata
 * corrente della PR: quelle create DOPO l'ultima richiesta umana
 * (`stubwise`/`provider`), o tutte se una persona non ha mai chiesto niente.
 *
 * Le `cancelled` non contano in nessuno dei due sensi (una correzione annullata
 * con la PR chiusa non è né un giro né un azzeramento). Una richiesta umana
 * ancora `pending` azzera GIÀ: la tornata nuova comincia quando una persona
 * chiede, non quando la sua correzione riesce a partire — altrimenti il ciclo
 * automatico potrebbe fermarsi al tetto proprio mentre una persona ha appena
 * chiesto di andare avanti.
 *
 * A parità di istante l'automatica conta come PRECEDENTE all'umana (confronto `>` stretto): non è un giro della tornata nuova.
 *
 * La correzione `queued` in corso CONTA: è il giro che sta girando ("Giro 2 di
 * 3 · correzione in corso").
 */
export async function autoRoundsInCurrentSeries(db: DbOrTx, pr: PrRef): Promise<number> {
  // UNA sola query: la soglia dell'ultima richiesta umana è una subquery, così
  // il confronto resta in Postgres alla precisione dei microsecondi (un `Date`
  // JS la troncherebbe ai millisecondi) e non c'è una finestra fra due letture.
  const human = alias(prCorrections, "human");
  const lastHumanAt = db
    .select({ at: sql`max(${human.createdAt})` })
    .from(human)
    .where(
      and(
        eq(human.repositoryId, pr.repositoryId),
        eq(human.prNumber, pr.prNumber),
        inArray(human.trigger, [...HUMAN_TRIGGERS]),
        ne(human.status, "cancelled"),
      ),
    );
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(prCorrections)
    .where(
      and(
        onPr(pr),
        eq(prCorrections.trigger, "review"),
        ne(prCorrections.status, "cancelled"),
        sql`${prCorrections.createdAt} > coalesce((${lastHumanAt}), '-infinity'::timestamptz)`,
      ),
    );
  return row?.n ?? 0;
}

/** Cosa chiede una correzione. */
export interface EnqueueCorrectionInput {
  ticketId: string;
  repositoryId: string;
  prNumber: number;
  trigger: PrCorrectionTrigger;
  requestedByUserId?: string | null;
  requestedByProviderLogin?: string | null;
  /** Assente = l'ultima review completata della PR. */
  reviewId?: string | null;
  note?: string | null;
  providerFeedback?: PrComment[] | null;
}

/**
 * Esito. `jobId` è null solo per una `pending` (non ha ancora un job). I due
 * rifiuti non scrivono NIENTE: il server li traduce nel 409 omonimo.
 */
export type EnqueueCorrectionResult =
  | { ok: true; correctionId: string; status: "queued" | "pending"; jobId: string | null }
  | { ok: false; error: "correction_in_flight" | "job_in_flight" };

/**
 * Lo stesso lock advisory di `startRun` (`apps/server/src/services/jobs.ts`):
 * una correzione e un rilancio del fix sullo stesso ticket si serializzano.
 */
async function lockTicket(tx: Tx, ticketId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ticketId}))`);
}

/** La `queued` e la `pending` della PR (al più una ciascuna, per indice unico). */
async function openCorrections(
  db: DbOrTx,
  pr: PrRef,
): Promise<{ queued: string | null; pending: string | null }> {
  const rows = await db
    .select({ id: prCorrections.id, status: prCorrections.status })
    .from(prCorrections)
    .where(and(onPr(pr), inArray(prCorrections.status, ["queued", "pending"])));
  return {
    queued: rows.find((r) => r.status === "queued")?.id ?? null,
    pending: rows.find((r) => r.status === "pending")?.id ?? null,
  };
}

/**
 * QUANDO un job `ai_jobs` blocca una correzione sul suo ticket — l'UNICA
 * definizione, da riusare (`hasJobInFlight`, e `canRequestCorrection` del
 * ciclo), mai da ricopiare:
 *
 * - un job in `IN_FLIGHT_JOB_STATUSES` (qualunque, correzioni comprese);
 * - un FIX parcheggiato in `held` (`correction_id IS NULL`). `held` non è in
 *   `IN_FLIGHT_JOB_STATUSES` (quella lista risponde a un'altra domanda), ma un
 *   fix fermo su limite/budget/gate RIPARTE da solo: se nel frattempo una
 *   correzione avesse pushato sul branch, i due lavori andrebbero in
 *   conflitto sullo stesso branch.
 *
 * Una CORREZIONE `held` invece resta fuori apposta: la sua riga
 * `pr_corrections` è ancora `queued`, quindi la decisione la prende già la
 * regola «c'è una `queued`» (`correction_in_flight`), che è la risposta più
 * precisa.
 */
export function jobBlocksCorrection(): SQL {
  return or(
    inArray(aiJobs.status, [...IN_FLIGHT_JOB_STATUSES]),
    and(eq(aiJobs.status, "held"), isNull(aiJobs.correctionId)),
  )!;
}

/**
 * Vero se il ticket ha un job che blocca una correzione ({@link
 * jobBlocksCorrection}). Qualsiasi job, non solo l'ultimo come in `startRun`:
 * una correzione che partisse accanto a un fix vivo avrebbe due writer sullo
 * stesso branch.
 */
export async function hasJobInFlight(db: DbOrTx, ticketId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: aiJobs.id })
    .from(aiJobs)
    .where(and(eq(aiJobs.ticketId, ticketId), jobBlocksCorrection()))
    .limit(1);
  return row !== undefined;
}

async function latestCompletedReviewId(db: DbOrTx, pr: PrRef): Promise<string | null> {
  const [row] = await db
    .select({ id: prReviews.id })
    .from(prReviews)
    .where(
      and(
        eq(prReviews.repositoryId, pr.repositoryId),
        eq(prReviews.prNumber, pr.prNumber),
        eq(prReviews.status, "completed"),
      ),
    )
    .orderBy(desc(prReviews.createdAt))
    .limit(1);
  return row?.id ?? null;
}

async function insertCorrection(
  tx: Tx,
  input: EnqueueCorrectionInput,
  reviewId: string | null,
  status: "queued" | "pending",
): Promise<string> {
  const [row] = await tx
    .insert(prCorrections)
    .values({
      ticketId: input.ticketId,
      repositoryId: input.repositoryId,
      prNumber: input.prNumber,
      trigger: input.trigger,
      status,
      requestedByUserId: input.requestedByUserId ?? null,
      requestedByProviderLogin: input.requestedByProviderLogin ?? null,
      reviewId,
      note: input.note ?? null,
      providerFeedback: input.providerFeedback ?? null,
    })
    .returning({ id: prCorrections.id });
  return row!.id;
}

/**
 * Unisce due fotografie dei commenti del provider, deduplicando per `id`: a
 * parità di id vince la versione NUOVA (un commento modificato), nella
 * posizione della vecchia; i commenti nuovi si accodano.
 */
function mergeFeedback(
  existing: PrComment[] | null,
  incoming: PrComment[] | null | undefined,
): PrComment[] | null {
  if (incoming == null) return existing;
  if (existing === null) return incoming;
  const byId = new Map<string, PrComment>();
  for (const c of existing) byId.set(c.id, c);
  for (const c of incoming) byId.set(c.id, c);
  return [...byId.values()];
}

/**
 * Fonde una richiesta nella `pending` esistente (design §6: più "Request
 * changes" in attesa diventano una).
 *
 * - I commenti del provider si UNISCONO (dedup per `id`), mai si sostituiscono:
 *   due "Request changes" in attesa sono due insiemi di commenti da leggere.
 * - Una `pending` che porta commenti del provider (`providerFeedback !== null`)
 *   e riceve un CLICK resta `trigger='provider'` e tiene il suo
 *   `requestedByProviderLogin`: il click aggiunge solo `note`,
 *   `requestedByUserId` e `reviewId`. Altrimenti la correzione dimenticherebbe
 *   di essere nata da una review sul provider, e con lei la ragione per cui
 *   la pipeline deve rileggere quei commenti.
 * - Negli altri casi chi ha chiesto è l'ULTIMO; nota e review si sostituiscono
 *   solo se la richiesta nuova le porta.
 */
async function mergeIntoPending(
  tx: Tx,
  pendingId: string,
  input: EnqueueCorrectionInput,
  reviewId: string | null,
): Promise<string> {
  const [current] = await tx
    .select({ providerFeedback: prCorrections.providerFeedback })
    .from(prCorrections)
    .where(eq(prCorrections.id, pendingId));
  const existingFeedback = current?.providerFeedback ?? null;
  const keepProvider = existingFeedback !== null && input.trigger !== "provider";
  const providerFeedback = mergeFeedback(existingFeedback, input.providerFeedback);
  await tx
    .update(prCorrections)
    .set({
      ...(keepProvider
        ? {}
        : {
            trigger: input.trigger,
            requestedByProviderLogin: input.requestedByProviderLogin ?? null,
          }),
      requestedByUserId: input.requestedByUserId ?? null,
      ...(input.note != null ? { note: input.note } : {}),
      ...(providerFeedback !== existingFeedback ? { providerFeedback } : {}),
      ...(reviewId !== null ? { reviewId } : {}),
    })
    .where(eq(prCorrections.id, pendingId));
  return pendingId;
}

/**
 * Il job di una correzione. `manualTrigger` solo per le richieste di una
 * persona: come ogni avvio a mano scavalca i tetti di spesa (`fix.ts`), mentre
 * il ciclo automatico si ferma al budget mensile (design §2). Niente gate del
 * piano: una correzione non è un piano nuovo (design §3).
 */
async function createCorrectionJob(
  tx: Tx,
  job: {
    ticketId: string;
    correctionId: string;
    trigger: PrCorrectionTrigger;
    requestedByUserId: string | null;
  },
): Promise<string> {
  const [row] = await tx
    .insert(aiJobs)
    .values({
      ticketId: job.ticketId,
      status: "queued",
      correctionId: job.correctionId,
      manualTrigger: job.trigger !== "review",
      requestedByUserId: job.requestedByUserId,
      planApprovalRequired: false,
      resumeMode: null,
      planText: null,
    })
    .returning({ id: aiJobs.id });
  return row!.id;
}

/** `pending → queued` più il suo job. Da chiamare sotto il lock del ticket. */
async function promoteRow(tx: Tx, correctionId: string, reviewId: string | null): Promise<string> {
  const [row] = await tx
    .update(prCorrections)
    .set({ status: "queued", ...(reviewId !== null ? { reviewId } : {}) })
    .where(and(eq(prCorrections.id, correctionId), eq(prCorrections.status, "pending")))
    .returning({
      ticketId: prCorrections.ticketId,
      trigger: prCorrections.trigger,
      requestedByUserId: prCorrections.requestedByUserId,
    });
  if (!row) throw new Error(`correzione ${correctionId} non più pending: promozione impossibile`);
  return createCorrectionJob(tx, { ...row, correctionId });
}

/**
 * Accoda una correzione sulla PR — l'UNICO punto che scrive una riga
 * `pr_corrections` nuova. La tabella di decisione (trigger × cosa è in volo)
 * è nel piano della Tappa A e nei test: in breve, il bottone e la review
 * rifiutano se qualcosa è in volo, "Request changes" non si può rifiutare a
 * chi l'ha premuto e diventa `pending`; una `pending` libera parte al posto di
 * qualunque richiesta nuova (vince la persona).
 *
 * Il lock è lo stesso di `startRun` (`pg_advisory_xact_lock(hashtext(ticketId))`),
 * e ha tre conseguenze per chi la chiama:
 *
 * - accetta anche una transazione (dentro ne apre una annidata, un savepoint),
 *   ma il lock advisory vale fino al COMMIT della transazione ESTERNA: per
 *   tutto quel tempo ogni `startRun` sullo stesso ticket resta in attesa.
 *   Tenere corta la transazione esterna;
 * - protegge solo in READ COMMITTED (il default): sotto REPEATABLE READ lo
 *   snapshot è preso alla prima query, prima di ottenere il lock, e le letture
 *   non vedrebbero ciò che l'altro ha appena committato;
 * - dentro una transazione esterna va chiamata PRIMA di altre scritture su
 *   `ai_jobs`/`pr_corrections`: `startRun` prende il lock e POI scrive, e
 *   l'ordine inverso (righe bloccate, poi il lock) è un deadlock con lui.
 */
export async function enqueueCorrection(
  db: DbOrTx,
  input: EnqueueCorrectionInput,
): Promise<EnqueueCorrectionResult> {
  const pr: PrRef = { repositoryId: input.repositoryId, prNumber: input.prNumber };
  // Cast e non union: `transaction` su `Db | Tx` non è chiamabile per il
  // compilatore, ma entrambi la espongono (su una Tx è un savepoint).
  return (db as Db).transaction(async (tx): Promise<EnqueueCorrectionResult> => {
    await lockTicket(tx, input.ticketId);
    const open = await openCorrections(tx, pr);
    const jobBusy = await hasJobInFlight(tx, input.ticketId);
    const reviewId = input.reviewId ?? (await latestCompletedReviewId(tx, pr));

    if (open.queued !== null || jobBusy) {
      if (input.trigger !== "provider") {
        return { ok: false, error: open.queued !== null ? "correction_in_flight" : "job_in_flight" };
      }
      const correctionId =
        open.pending !== null
          ? await mergeIntoPending(tx, open.pending, input, reviewId)
          : await insertCorrection(tx, input, reviewId, "pending");
      return { ok: true, correctionId, status: "pending", jobId: null };
    }

    if (open.pending !== null) {
      // Una richiesta umana aspettava e niente la blocca più: parte lei. Una
      // richiesta umana nuova ci si fonde; la review no — ha perso (§6).
      if (input.trigger !== "review") await mergeIntoPending(tx, open.pending, input, reviewId);
      const jobId = await promoteRow(tx, open.pending, reviewId);
      return { ok: true, correctionId: open.pending, status: "queued", jobId };
    }

    const correctionId = await insertCorrection(tx, input, reviewId, "queued");
    const jobId = await createCorrectionJob(tx, {
      ticketId: input.ticketId,
      correctionId,
      trigger: input.trigger,
      requestedByUserId: input.requestedByUserId ?? null,
    });
    return { ok: true, correctionId, status: "queued", jobId };
  });
}

/**
 * `queued → done`: il job della correzione è TERMINATO (qualunque esito — il
 * fallimento si legge da `ai_jobs.status`). Il worker la chiama nella STESSA
 * transazione che rende terminale il job (`completeJob`/`failJob` accettano una
 * `tx`), e solo se quella chiusura è riuscita (ownership del job ancora sua);
 * poi, fuori dalla transazione, `promotePendingCorrection`/la review: finché la
 * `queued` esiste, nessuna `pending` può partire. `false` = non era più
 * `queued` (es. annullata alla chiusura della PR): niente da fare.
 */
export async function completeCorrection(db: DbOrTx, correctionId: string): Promise<boolean> {
  const rows = await db
    .update(prCorrections)
    .set({ status: "done" })
    .where(and(eq(prCorrections.id, correctionId), eq(prCorrections.status, "queued")))
    .returning({ id: prCorrections.id });
  return rows.length > 0;
}
