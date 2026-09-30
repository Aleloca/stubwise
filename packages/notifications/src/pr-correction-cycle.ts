import {
  aiJobs,
  prCorrections,
  prReviewJobs,
  prReviews,
  projects,
  repositories,
  ticketRepositories,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import {
  prNumberFromUrl,
  type AiJobStatus,
  stubwiseTicketNumber,
  type PrComment,
  type PrCorrectionTrigger,
  type PrCycle,
  type PrCycleState,
} from "@stubwise/shared";
import { and, desc, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
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
 *
 * `status: "pending"` con `trigger='review'` ha due forme: una pending NUOVA
 * (giro automatico bloccato da un job su un'altra parte del ticket), oppure —
 * se sulla PR ce n'era già una — l'id di QUELLA, invariata: nessuna riga
 * scritta. Per il chiamante sono la stessa cosa: il giro partirà dopo.
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
 * Vero se la PR ha una correzione `pending` o `queued`. È la domanda che fix e
 * correzione si fanno DOPO {@link promotePendingForTicket}, per ogni loro PR:
 * con una correzione aperta la review NON si accoda — arriverà dopo il push di
 * quella correzione (design §6: la richiesta umana parte al posto della
 * review). La promozione è per ticket e ne dice solo gli id, per questo serve
 * una domanda per PR.
 */
export async function prHasOpenCorrection(db: DbOrTx, pr: PrRef): Promise<boolean> {
  const open = await openCorrections(db, pr);
  return open.queued !== null || open.pending !== null;
}

/**
 * QUANDO un job `ai_jobs` blocca una correzione sul suo ticket — l'UNICA
 * definizione, da riusare (`hasJobInFlight`, `promoteStalePendings` e
 * `canRequestCorrection` del ciclo), mai da ricopiare. La regola è UN LAVORO
 * PER TICKET, qualunque sia la PR:
 *
 * - un job in `IN_FLIGHT_JOB_STATUSES` (qualunque, correzioni comprese);
 * - un job parcheggiato in `held`, di QUALUNQUE tipo. `held` non è in
 *   `IN_FLIGHT_JOB_STATUSES` (quella lista risponde a un'altra domanda), ma un
 *   job fermo su limite/budget/gate RIPARTE da solo. Un FIX `held` che
 *   ripartisse dopo il push di una correzione andrebbe in conflitto sullo
 *   stesso branch; una CORREZIONE `held` sulla PR A deve bloccare anche la PR
 *   B, altrimenti la rete di sicurezza (`promoteStalePendings`) farebbe
 *   partire una seconda correzione sullo stesso ticket e al risveglio della
 *   prima ce ne sarebbero due in volo.
 *
 * (Fino alla revisione di A7 una correzione `held` restava fuori, lasciando
 * decidere alla sua riga `queued`: ma quella regola è per PR, e bastava una
 * seconda PR sullo stesso ticket per aggirarla.)
 */
export function jobBlocksCorrection(): SQL {
  return or(inArray(aiJobs.status, [...IN_FLIGHT_JOB_STATUSES]), eq(aiJobs.status, "held"))!;
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
 * è nel piano della Tappa A e nei test: in breve, il bottone rifiuta se
 * qualcosa è in volo; la review rifiuta se sulla SUA PR c'è una `queued`, ma
 * se a bloccare è un job su un'altra parte del ticket diventa una `pending`
 * `trigger='review'` (o risponde con la pending già in fila sulla PR);
 * "Request changes" non si può rifiutare a chi l'ha premuto e diventa
 * `pending`; una `pending` libera parte al posto di qualunque richiesta nuova
 * (vince la persona).
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

    // GIRO AUTOMATICO bloccato dal lavoro su un'ALTRA parte del ticket (un
    // job che blocca, nessuna `queued` su QUESTA PR): non si perde, diventa
    // una `pending` con `trigger='review'` che partirà alla fine di quel
    // lavoro (promotePendingForTicket, o il tick). Se sulla PR c'è già una
    // pending (umana o automatica) non si crea e non si fonde niente: si
    // risponde con QUELLA — la richiesta in fila vale già per questa PR, e una
    // richiesta umana non deve prendere il trigger della review.
    if (input.trigger === "review" && open.queued === null && jobBusy) {
      if (open.pending !== null) {
        return { ok: true, correctionId: open.pending, status: "pending", jobId: null };
      }
      const correctionId = await insertCorrection(
        tx,
        { ...input, requestedByUserId: null, requestedByProviderLogin: null },
        reviewId,
        "pending",
      );
      return { ok: true, correctionId, status: "pending", jobId: null };
    }

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
 * poi, fuori dalla transazione, `promotePendingForTicket`/la review: finché la
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

/**
 * Fa partire la richiesta umana in attesa sulla PR, se niente la blocca più:
 * nessuna `queued` sulla PR e nessun job vivo sul ticket ({@link
 * hasJobInFlight}). Ritorna l'id della correzione promossa, o null (nessuna
 * pending, o ancora bloccata — resta lì, e la ripescherà il prossimo punto di
 * promozione: fine di una correzione, fine di un fix — aperto, fallito o
 * saltato —, fine di una review con QUALUNQUE verdetto).
 *
 * Il worker la chiama DOPO la transazione che chiude job e correzione: a una
 * correzione che ha pushato segue la `pending` AL POSTO della review (design §6).
 *
 * ⚠️ MAI chiamarla nella transazione in cui il job del chiamante non è ancora
 * terminale: `hasJobInFlight` vedrebbe quel job stesso e la pending non
 * partirebbe mai (nessun errore, solo un null). Prende lo stesso lock del
 * ticket di `enqueueCorrection`/`startRun`, e — come lì — dentro una
 * transazione esterna il lock resta attivo fino al COMMIT di quella esterna.
 *
 * Il job vivo blocca per TICKET, la pending è per PR: chi chiude il lavoro di
 * un ticket chiami {@link promotePendingForTicket}, non questa su una PR sola,
 * o la pending di un'altra PR dello stesso ticket resterebbe ferma.
 */
export async function promotePendingCorrection(db: DbOrTx, pr: PrRef): Promise<string | null> {
  return (db as Db).transaction(async (tx) => {
    const [pending] = await tx
      .select({ id: prCorrections.id, ticketId: prCorrections.ticketId })
      .from(prCorrections)
      .where(and(onPr(pr), eq(prCorrections.status, "pending")))
      .limit(1);
    if (!pending) return null;
    await lockTicket(tx, pending.ticketId);
    // Riletto SOTTO il lock: fra la prima lettura e il lock un'altra
    // transazione può averla promossa o annullata.
    const open = await openCorrections(tx, pr);
    if (open.pending !== pending.id || open.queued !== null) return null;
    if (await hasJobInFlight(tx, pending.ticketId)) return null;
    await promoteRow(tx, pending.id, await latestCompletedReviewId(tx, pr));
    return pending.id;
  });
}

/** La riga che il job annullato riceve nel log, nello stile di `queue.ts` del worker. */
const CANCELLED_LOG_LINE = "[correction] PR chiusa: correzione annullata\n";

/** Stati del job di una correzione che l'annullamento può ancora fermare. */
const CANCELLABLE_JOB_STATUSES = ["queued", "held"] as const;

/**
 * La PR si è chiusa (mergiata o rifiutata): le correzioni `pending` e `queued`
 * diventano `cancelled`, e i loro job che non sono ancora partiti (`queued`)
 * o sono parcheggiati (`held`, che il resume poller riaccoderebbe) diventano
 * `skipped`. Un job GIÀ in lavorazione non si tocca: è `runCorrection` a
 * ricontrollare lo stato della PR prima del push (design §7).
 *
 * Prende i lock dei ticket coinvolti (in ordine, niente deadlock) per non
 * incrociarsi con un `enqueueCorrection`/`promotePendingCorrection` a metà.
 * Ritorna quante correzioni ha annullato.
 */
export async function cancelOpenCorrections(db: DbOrTx, pr: PrRef): Promise<number> {
  return (db as Db).transaction(async (tx) => {
    const open = await tx
      .select({ ticketId: prCorrections.ticketId })
      .from(prCorrections)
      .where(and(onPr(pr), inArray(prCorrections.status, ["pending", "queued"])));
    if (open.length === 0) return 0;
    for (const ticketId of [...new Set(open.map((r) => r.ticketId))].sort()) {
      await lockTicket(tx, ticketId);
    }
    const cancelled = await tx
      .update(prCorrections)
      .set({ status: "cancelled" })
      .where(and(onPr(pr), inArray(prCorrections.status, ["pending", "queued"])))
      .returning({ id: prCorrections.id });
    if (cancelled.length > 0) {
      const now = new Date();
      await tx
        .update(aiJobs)
        .set({
          status: "skipped",
          finishedAt: now,
          lastActivityAt: now,
          log: sql`${aiJobs.log} || ${CANCELLED_LOG_LINE}`,
        })
        .where(
          and(
            inArray(
              aiJobs.correctionId,
              cancelled.map((c) => c.id),
            ),
            inArray(aiJobs.status, [...CANCELLABLE_JOB_STATUSES]),
          ),
        );
    }
    return cancelled.length;
  });
}

/** Le PR distinte con una `pending`, filtrate da `where`, in ordine stabile. */
async function prsWithPending(db: DbOrTx, where: SQL | undefined): Promise<PrRef[]> {
  return db
    .selectDistinct({ repositoryId: prCorrections.repositoryId, prNumber: prCorrections.prNumber })
    .from(prCorrections)
    .where(and(eq(prCorrections.status, "pending"), where))
    .orderBy(prCorrections.repositoryId, prCorrections.prNumber);
}

/**
 * Prova a far partire le `pending` di TUTTE le PR del ticket: il punto di
 * promozione da chiamare alla fine di una review, di un fix (qualunque esito) e
 * di una correzione. Il job vivo blocca per ticket, mentre la pending è per PR:
 * promuovere solo la PR del lavoro appena finito lascerebbe ferma per sempre
 * la pending di un'altra PR dello stesso ticket.
 *
 * Al più una parte davvero (la prima crea un job `queued`, che blocca le
 * altre): le restanti le ripesca il prossimo punto di promozione. Ritorna gli
 * id promossi. Stesse avvertenze di {@link promotePendingCorrection}.
 */
export async function promotePendingForTicket(db: DbOrTx, ticketId: string): Promise<string[]> {
  const promoted: string[] = [];
  for (const pr of await prsWithPending(db, eq(prCorrections.ticketId, ticketId))) {
    const id = await promotePendingCorrection(db, pr);
    if (id !== null) promoted.push(id);
  }
  return promoted;
}

/**
 * RETE DI SICUREZZA per il tick periodico del worker: promuove le `pending` dei
 * ticket su cui nessun job blocca più una correzione ({@link
 * jobBlocksCorrection}). Copre ogni punto di promozione mancato — un worker
 * morto fra la chiusura del job e la promozione, un errore ingoiato, un
 * percorso futuro che dimentica di chiamarla, e le pending di un'altra PR
 * dopo una review (la review promuove solo la SUA). Una `queued` ancora
 * presente la scarta già `promotePendingCorrection`.
 *
 * Best-effort PER RIGA: un errore su una pending va a `onError` (default: una
 * riga `console.warn`) e non ferma le altre. Il worker passa un `onError` che
 * avvisa una volta sola per id: la stessa riga fallirebbe a ogni tick.
 * Ritorna gli id promossi, così il chiamante logga una riga per ciascuno.
 */
export async function promoteStalePendings(
  db: DbOrTx,
  opts: { onError?: (pendingId: string, pr: PrRef, error: unknown) => void } = {},
): Promise<string[]> {
  const onError =
    opts.onError ??
    ((pendingId: string, pr: PrRef, error: unknown) => {
      console.warn(
        `[correction] promozione della pending ${pendingId} su ${pr.repositoryId}#${pr.prNumber} fallita:`,
        error,
      );
    });
  // Una pending per PR (indice unico): l'id identifica anche la PR.
  const candidates = await db
    .select({
      id: prCorrections.id,
      repositoryId: prCorrections.repositoryId,
      prNumber: prCorrections.prNumber,
    })
    .from(prCorrections)
    .where(
      and(
        eq(prCorrections.status, "pending"),
        sql`not exists (${db
          .select({ one: sql`1` })
          .from(aiJobs)
          .where(and(eq(aiJobs.ticketId, prCorrections.ticketId), jobBlocksCorrection()))})`,
      ),
    )
    .orderBy(prCorrections.repositoryId, prCorrections.prNumber);
  const promoted: string[] = [];
  for (const { id: pendingId, ...pr } of candidates) {
    try {
      const id = await promotePendingCorrection(db, pr);
      if (id !== null) promoted.push(id);
    } catch (error) {
      onError(pendingId, pr, error);
    }
  }
  return promoted;
}

/**
 * Gli stati TERMINALI di un job `ai_jobs`, per la riconciliazione delle
 * correzioni orfane ({@link reconcileOrphanCorrections}). Un ELENCO ESPLICITO,
 * non il complemento di {@link jobBlocksCorrection}, e il verso è voluto: se
 * uno stato nuovo dell'enum finisse qui per default, una correzione col job
 * ancora VIVO verrebbe chiusa e ne partirebbe un doppione — un danno
 * silenzioso. Con l'elenco esplicito, al peggio la correzione resta appesa:
 * si vede, e si recupera.
 *
 * Gli stati di attesa umana (`awaiting_plan_approval`, `awaiting_input`) sono
 * in `IN_FLIGHT_JOB_STATUSES`, e `held` blocca a sé: il lavoro non è finito.
 *
 * ⚠️ Uno stato NUOVO di `aiJobStatusSchema` obbliga a una scelta esplicita:
 * o qui (terminale) o fra quelli che bloccano (`IN_FLIGHT_JOB_STATUSES`/`held`).
 * Il test di PARTIZIONE in `pr-correction-cycle.test.ts` diventa rosso finché
 * non la si fa.
 */
export const TERMINAL_JOB_STATUSES = [
  "pr_opened",
  "pr_merged",
  "pr_closed",
  "failed",
  "skipped",
] as const satisfies readonly AiJobStatus[];

/** La riga che il job di una correzione riconciliata riceve nel log. */
const reconciledLogLine = (jobStatus: string) =>
  `[correction] correzione chiusa dalla riconciliazione: il job era ${jobStatus}\n`;

/**
 * RETE DI SICUREZZA gemella di {@link promoteStalePendings}, da chiamare nel
 * tick del worker SUBITO PRIMA di lei: chiude (`queued → done`) le correzioni
 * `queued` rimaste ORFANE del loro job — il job è in uno stato terminale
 * ({@link TERMINAL_JOB_STATUSES}) oppure non esiste affatto.
 *
 * Il percorso normale è `completeCorrection` nella stessa transazione che rende
 * terminale il job. Ma un job può diventare terminale per altre strade: un'eccezione
 * non gestita nel handler (`failJob` chiamato fuori da `closeJobAndCorrection`),
 * il recovery degli stantii, un rollback manuale sul database, o un percorso
 * futuro che dimentica la correzione. Senza questa rete la `queued` resterebbe lì per sempre — stato
 * `correcting` eterno, bottone tolto, ogni `pending` della PR bloccata. I
 * percorsi terminali cambiano nel tempo; questa rete no.
 *
 * Per riga, sotto il lock del ticket (lo stesso di `startRun`/
 * `enqueueCorrection`/`promotePendingCorrection`) e con un UPDATE guardato
 * (`status = 'queued'`): non corre con `completeCorrection` del worker né con
 * un annullamento. Lo stato del job si RILEGGE sotto il lock: un job che nel
 * frattempo è ripartito (es. `held → queued`) lascia la correzione intatta. Al
 * job esistente si appende una riga di log. Non promuove niente: lo fa
 * `promoteStalePendings`, dopo, nello stesso tick.
 *
 * Best-effort PER RIGA, come `promoteStalePendings`: un errore va a `onError`
 * (default: `console.warn`) e non ferma le altre. Ritorna gli id riconciliati.
 */
export async function reconcileOrphanCorrections(
  db: DbOrTx,
  opts: { onError?: (correctionId: string, error: unknown) => void } = {},
): Promise<string[]> {
  const onError =
    opts.onError ??
    ((correctionId: string, error: unknown) => {
      console.warn(`[correction] riconciliazione della correzione ${correctionId} fallita:`, error);
    });
  const candidates = await db
    .select({ id: prCorrections.id, ticketId: prCorrections.ticketId })
    .from(prCorrections)
    .leftJoin(aiJobs, eq(aiJobs.correctionId, prCorrections.id))
    .where(
      and(
        eq(prCorrections.status, "queued"),
        or(sql`${aiJobs.id} is null`, inArray(aiJobs.status, [...TERMINAL_JOB_STATUSES])),
      ),
    )
    .orderBy(prCorrections.id);
  const reconciled: string[] = [];
  for (const { id, ticketId } of candidates) {
    try {
      const done = await (db as Db).transaction(async (tx) => {
        await lockTicket(tx, ticketId);
        // Riletto SOTTO il lock: il job può essere ripartito, o la correzione
        // chiusa da `completeCorrection`/annullata, fra la lettura e il lock.
        const [job] = await tx
          .select({ id: aiJobs.id, status: aiJobs.status })
          .from(aiJobs)
          .where(eq(aiJobs.correctionId, id));
        if (job && !(TERMINAL_JOB_STATUSES as readonly string[]).includes(job.status)) return false;
        const [row] = await tx
          .update(prCorrections)
          .set({ status: "done" })
          .where(and(eq(prCorrections.id, id), eq(prCorrections.status, "queued")))
          .returning({ id: prCorrections.id });
        if (!row) return false;
        if (job) {
          await tx
            .update(aiJobs)
            .set({ log: sql`${aiJobs.log} || ${reconciledLogLine(job.status)}` })
            .where(eq(aiJobs.id, job.id));
        }
        return true;
      });
      if (done) reconciled.push(id);
    } catch (error) {
      onError(id, error);
    }
  }
  return reconciled;
}

/**
 * Annulla la `pending` della PR, se c'è (`pending → cancelled`; non ha ancora
 * un job). Per quando la PR non si può più correggere ma è ancora aperta — il
 * branch sparito (`BranchNotFoundError` nella correzione): senza, la rete di
 * sicurezza la ripromuoverebbe a ogni tick, e ogni giro fallirebbe allo stesso
 * modo. Sotto il lock del ticket, come la promozione, per non annullare una
 * riga che un altro sta promuovendo. Ritorna l'id annullato, o null.
 */
export async function cancelPendingCorrection(
  db: DbOrTx,
  pr: PrRef,
  /**
   * `trigger`: annulla la pending SOLO se ha questo trigger, riletto SOTTO il
   * lock (nell'UPDATE guardato). Serve a C10: un'approvazione annulla un giro
   * automatico ormai superato (`review`), mai una richiesta umana — e un click
   * fuso nella pending prima del lock ne cambia il trigger in `stubwise`, che
   * così resta intatta. Assente = qualunque trigger (comportamento di sempre).
   */
  opts: { trigger?: PrCorrectionTrigger } = {},
): Promise<string | null> {
  return (db as Db).transaction(async (tx) => {
    const [pending] = await tx
      .select({ id: prCorrections.id, ticketId: prCorrections.ticketId })
      .from(prCorrections)
      .where(and(onPr(pr), eq(prCorrections.status, "pending")))
      .limit(1);
    if (!pending) return null;
    await lockTicket(tx, pending.ticketId);
    const [row] = await tx
      .update(prCorrections)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(prCorrections.id, pending.id),
          eq(prCorrections.status, "pending"),
          ...(opts.trigger !== undefined ? [eq(prCorrections.trigger, opts.trigger)] : []),
        ),
      )
      .returning({ id: prCorrections.id });
    return row?.id ?? null;
  });
}

/** I fatti da cui si deriva lo stato: vedi la tabella di verità nel piano (Task A8). */
export interface PrCycleFacts {
  prOpen: boolean;
  /** C'è una correzione `queued` sulla PR. */
  correctionQueued: boolean;
  /**
   * C'è una correzione `pending` con `trigger='review'` sulla PR: un giro
   * AUTOMATICO messo in fila perché un altro lavoro del ticket blocca. Si
   * legge come correzione in arrivo (`correcting`), non come una richiesta
   * umana in attesa.
   */
  autoCorrectionPending: boolean;
  /** Review in coda (`pr_review_jobs`) o l'ultima non fallita è `running`. */
  reviewInProgress: boolean;
  /** L'ultima review `completed`. */
  lastCompletedReview: {
    verdict: "approve" | "request_changes" | null;
    createdAt: Date;
  } | null;
  /** L'ultima correzione `done` e se il suo job è fallito. */
  lastDoneCorrection: { createdAt: Date; jobFailed: boolean } | null;
  round: number;
  maxRounds: number;
}

/**
 * La precedenza degli stati, PURA (tabella di verità del piano, Tappa A,
 * Task A8). La prima regola che combacia vince:
 *
 * 1. PR aperta + correzione in corso (`queued`) o giro automatico in fila
 *    (`pending` `review`) → `correcting`;
 * 2. PR aperta + review in coda/in corso → `reviewing`;
 * 3–4. l'ultima correzione chiusa è PIÙ RECENTE dell'ultima review: se il suo
 *    job è fallito `correction_failed`, altrimenti `idle` (nessuno ha ancora
 *    guardato la versione corretta);
 * 5. nessuna review (o senza verdetto) → `idle`;
 * 6. `approve` → `approved`;
 * 7–9. `request_changes`: tetto 0 → `changes_requested`; round ≥ tetto →
 *    `stopped_at_cap`; altrimenti `changes_requested`.
 *
 * Con la PR non aperta le regole 1–2 non si applicano: le correzioni aperte
 * sono già annullate, e una review a metà non racconta più niente.
 */
export function resolvePrCycleState(f: PrCycleFacts): PrCycleState {
  if (f.prOpen && (f.correctionQueued || f.autoCorrectionPending)) return "correcting";
  if (f.prOpen && f.reviewInProgress) return "reviewing";
  const review = f.lastCompletedReview;
  const done = f.lastDoneCorrection;
  if (done && (!review || done.createdAt > review.createdAt)) {
    return done.jobFailed ? "correction_failed" : "idle";
  }
  if (!review || review.verdict === null) return "idle";
  if (review.verdict === "approve") return "approved";
  if (f.maxRounds > 0 && f.round >= f.maxRounds) return "stopped_at_cap";
  return "changes_requested";
}

/**
 * Il ciclo di UNA PR di un ticket, come la riga sotto la PR lo racconta (web e
 * app lo LEGGONO dalla risposta del dettaglio ticket, non lo ricostruiscono).
 * `null` = la PR non è di Stubwise (o non c'è ancora): niente ciclo, niente
 * bottone. Sette letture per PR (riga del ticket, correzioni, due su
 * `pr_reviews`, `pr_review_jobs`, job che blocca, giri della tornata): si
 * chiama per ogni voce PR del dettaglio di UN ticket, non su liste.
 *
 * «Correzione più recente della review» (regole 3–4) confronta
 * `pr_corrections.created_at`, cioè l'ora della RICHIESTA, non quella della
 * chiusura (`updated_at` si sposta con `completeCorrection`). Caso limite
 * accettato: una review creata MENTRE la correzione gira (sulla versione
 * precedente al push) risulta più recente della correzione, e finché non
 * arriva la review della versione nuova lo stato può mostrare quel verdetto
 * stantio.
 *
 * `lastRequest.name` ha un ripiego (login ↔ email) e può essere `""`: una
 * richiesta dal bottone il cui utente è stato cancellato (`requested_by_user_id`
 * SET NULL) non ha né email né login. In quel caso il client omette «da X».
 *
 * Le `pending` si leggono per TRIGGER: una umana (`stubwise`/`provider`) è
 * `pendingRequest` e `lastRequest`; una `review` è un giro automatico in fila
 * (stato `correcting`, e conta già in `round`, come in
 * {@link autoRoundsInCurrentSeries}).
 */
export async function derivePrCycle(
  db: DbOrTx,
  input: { ticketId: string; repositoryId: string },
): Promise<PrCycle | null> {
  const [tr] = await db
    .select({
      branch: ticketRepositories.branch,
      prUrl: ticketRepositories.prUrl,
      prState: ticketRepositories.prState,
      prNumber: ticketRepositories.prNumber,
      maxRounds: projects.prCorrectionMaxRounds,
      provider: repositories.provider,
      ticketNumber: tickets.number,
    })
    .from(ticketRepositories)
    .innerJoin(tickets, eq(tickets.id, ticketRepositories.ticketId))
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .innerJoin(repositories, eq(repositories.id, ticketRepositories.repositoryId))
    .where(
      and(
        eq(ticketRepositories.ticketId, input.ticketId),
        eq(ticketRepositories.repositoryId, input.repositoryId),
      ),
    );
  // Solo `stubwise/ticket-<N>` del TICKET stesso (STUBWISE_BRANCH_RE di
  // @stubwise/shared, la regex unica del monorepo): è la condizione della rotta
  // delle correzioni, quindi un ciclo mostrato è un bottone che funziona.
  if (!tr || tr.prUrl === null || stubwiseTicketNumber(tr.branch) !== tr.ticketNumber) return null;
  // Riga senza `pr_number` (scritta da un worker precedente alla 0081 dopo il
  // backfill): la regola unica di @stubwise/shared, null se non combacia.
  const prNumber = tr.prNumber ?? prNumberFromUrl(tr.prUrl);
  if (prNumber === null) return null;
  const pr: PrRef = { repositoryId: input.repositoryId, prNumber };

  const corrections = await db
    .select({
      status: prCorrections.status,
      trigger: prCorrections.trigger,
      createdAt: prCorrections.createdAt,
      updatedAt: prCorrections.updatedAt,
      login: prCorrections.requestedByProviderLogin,
      email: users.email,
      jobStatus: aiJobs.status,
    })
    .from(prCorrections)
    .leftJoin(users, eq(users.id, prCorrections.requestedByUserId))
    .leftJoin(aiJobs, eq(aiJobs.correctionId, prCorrections.id))
    .where(and(onPr(pr), ne(prCorrections.status, "cancelled")))
    .orderBy(desc(prCorrections.createdAt), desc(prCorrections.id));

  const reviewOnPr = and(
    eq(prReviews.repositoryId, pr.repositoryId),
    eq(prReviews.prNumber, pr.prNumber),
  );
  const [lastLive] = await db
    .select({ status: prReviews.status })
    .from(prReviews)
    .where(and(reviewOnPr, inArray(prReviews.status, ["running", "completed"])))
    .orderBy(desc(prReviews.createdAt))
    .limit(1);
  const [lastCompleted] = await db
    .select({ verdict: prReviews.verdict, createdAt: prReviews.createdAt })
    .from(prReviews)
    .where(and(reviewOnPr, eq(prReviews.status, "completed")))
    .orderBy(desc(prReviews.createdAt))
    .limit(1);
  const [reviewJob] = await db
    .select({ id: prReviewJobs.id })
    .from(prReviewJobs)
    .where(
      and(eq(prReviewJobs.repositoryId, pr.repositoryId), eq(prReviewJobs.prNumber, pr.prNumber)),
    )
    .limit(1);
  // La regola del job che blocca è UNA (`jobBlocksCorrection`, `held` compreso):
  // qui si riusa, mai si ricopia.
  const jobBusy = await hasJobInFlight(db, input.ticketId);
  const round = await autoRoundsInCurrentSeries(db, pr);

  const isHuman = (t: PrCorrectionTrigger) => t === "stubwise" || t === "provider";
  const prOpen = tr.prState === "open";
  const queued = corrections.some((c) => c.status === "queued");
  const autoPending = corrections.some((c) => c.status === "pending" && c.trigger === "review");
  const done = corrections.find((c) => c.status === "done");
  const human = corrections.find((c) => isHuman(c.trigger));

  const state = resolvePrCycleState({
    prOpen,
    correctionQueued: queued,
    autoCorrectionPending: autoPending,
    reviewInProgress: reviewJob !== undefined || lastLive?.status === "running",
    lastCompletedReview: lastCompleted ?? null,
    lastDoneCorrection: done
      ? { createdAt: done.createdAt, jobFailed: done.jobStatus === "failed" }
      : null,
    round,
    maxRounds: tr.maxRounds,
  });

  return {
    state,
    round,
    maxRounds: tr.maxRounds,
    // Solo una PERSONA in attesa: un giro automatico in fila è `correcting`.
    pendingRequest: corrections.some((c) => c.status === "pending" && isHuman(c.trigger)),
    lastRequest: human
      ? {
          via: human.trigger === "provider" ? "provider" : "stubwise",
          // La piattaforma è quella della repository: "Request changes" arriva
          // solo dal provider che la ospita.
          platform: human.trigger === "provider" ? tr.provider : null,
          name:
            (human.trigger === "provider"
              ? (human.login ?? human.email)
              : (human.email ?? human.login)) ?? "",
          // L'ora della RICHIESTA: `updated_at` solo per una `pending` (la
          // fusione la rinnova); su una chiusa si è spostato col push.
          at: (human.status === "pending" ? human.updatedAt : human.createdAt).toISOString(),
        }
      : null,
    // La stessa condizione per cui `enqueueCorrection` (trigger `stubwise`) NON
    // rifiuterebbe: un bottone mostrato è un bottone che funziona. Una pending
    // (umana o automatica) non toglie il bottone: il click vi si fonde.
    canRequestCorrection: prOpen && !queued && !jobBusy,
  };
}
