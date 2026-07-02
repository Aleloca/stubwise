import {
  aiJobs,
  aiUsageSnapshots,
  comments,
  docGenerationJobs,
  docGenerations,
  projects,
  repositories,
  tickets,
  type Db,
} from "@stubwise/db";
import { t } from "@stubwise/i18n";
import { and, desc, eq, sql } from "drizzle-orm";
import { resumeGeneration } from "../docs/nodes.js";
import { getContentLanguage } from "../settings.js";
import { loadProviderById, loadProviderChain, type ResolvedProvider } from "./chain.js";

/**
 * RESUME POLLER dei limiti di utilizzo dei provider AI.
 *
 * Task SEPARATO dal loop dei job (pattern auto-update-poller / pr-review-poller):
 * su un proprio intervallo riprende automaticamente ciò che si è fermato per un
 * LIMITE di rate/usage del provider:
 *  - generazioni Docs `paused` → tornano `running` (resumeGeneration, guarded);
 *  - ai_jobs `held` con held_reason "limit" → tornano `queued` + commento AI sul
 *    ticket;
 *  - doc_generation_jobs `held` con held_reason "limit" → tornano `queued`
 *    (l'handler creerà una generazione fresca; niente commento, non c'è ticket).
 * SOLO held_reason "limit" viene riaccodato: budget/gate restano decisioni umane
 * (e held_reason null — gli held storici — è conservativamente ignorato).
 *
 * DECISIONE DI HEADROOM per-provider (vedi hasHeadroom):
 *  - credenziale `account` con uno snapshot d'usage FRESCO e PARSATO (poller
 *    /usage, agent/usage-poller.ts): headroom = sessione usata < soglia% E
 *    weekly usata < 100%. Lo snapshot fresco è AUTORITATIVO: se dice "ancora al
 *    limite" NON si degrada al fallback a tempo.
 *  - credenziale `api_key` (nessuno snapshot: /usage esiste solo per gli
 *    account) o snapshot stantio/assente/non parsato → FALLBACK A TEMPO: si
 *    riprende quando la pausa dura da più del cooldown. Il fallback garantisce
 *    che nulla resti fermo per sempre, anche con il poll usage disabilitato
 *    (USAGE_POLL_MINUTES=0: tutti gli snapshot invecchiano e si degrada sempre
 *    al tempo).
 *
 * VINCOLI (come gli altri poller): NON fa MAI crashare il worker (ogni item in
 * try/catch isolato, l'intero tick a sua volta in try/catch), NON tocca il
 * lock/heartbeat né i timeout dei job in lavorazione (agisce solo su
 * paused/held, stati fermi) e NON logga mai i segreti. Si ferma sull'AbortSignal
 * del worker.
 */

/**
 * Età massima di uno snapshot d'usage per considerarlo attendibile: 3 volte il
 * default di USAGE_POLL_MINUTES (5') = 15'. COSTANTE, non una env: se il poll
 * usage è più lento (o disabilitato) gli snapshot risultano stantii e la
 * decisione degrada da sola al fallback a tempo — il comportamento giusto senza
 * un'altra manopola da tenere coerente.
 */
export const MAX_SNAPSHOT_AGE_MS = 3 * 5 * 60_000;

/** Riga di log/commento della ripresa automatica (appesa al log del job). */
const RESUME_LOG_LINE =
  "[stubwise] limite del provider rientrato: job riaccodato automaticamente dal resume poller";

export interface LimitResumeDeps {
  db: Db;
  /** Chiave AES-256 per decifrare le credenziali dei provider. */
  encryptionKey: Buffer;
  /** Soglia di headroom: la sessione deve essere SOTTO questa % di used. */
  headroomPercent: number;
  /** Cooldown del fallback a tempo (api_key o snapshot stantio/assente). */
  cooldownMs: number;
  /** Età massima di uno snapshot per considerarlo attendibile. */
  maxSnapshotAgeMs: number;
  /** Caricatore della catena di provider (iniettabile nei test). */
  loadProviderChainFn?: typeof loadProviderChain;
  /** Risolutore di UN provider per id (iniettabile nei test). */
  loadProviderByIdFn?: typeof loadProviderById;
  /** Ripresa di una generazione paused (iniettabile nei test). */
  resumeGenerationFn?: typeof resumeGeneration;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Finestra di consumo normalizzata dal jsonb libero dello snapshot. Difensiva:
 * campi mancanti o malformati → null, e il chiamante degrada al fallback a
 * tempo (mai fidarsi di un numero che non c'è).
 */
function parseWindow(value: unknown): { percentUsed: number } | null {
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.percentUsed === "number" && Number.isFinite(v.percentUsed)) {
      return { percentUsed: v.percentUsed };
    }
  }
  return null;
}

/** Ultimo snapshot per provider (vedi buildSnapshotIndex). */
interface LatestSnapshot {
  capturedAt: Date;
  parseOk: boolean;
  sessionRemaining: unknown;
  weeklyRemaining: unknown;
}

/**
 * Ultimo snapshot d'usage di CIASCUN provider in un solo round-trip:
 * `DISTINCT ON (provider_id)` ordinato per provider_id, captured_at desc
 * (stesso pattern di apps/server/src/routes/usage-snapshots.ts). Niente filtro
 * sul kind: gli api_key semplicemente non hanno snapshot e cadono nel fallback.
 */
async function buildSnapshotIndex(db: Db): Promise<Map<string, LatestSnapshot>> {
  const rows = await db
    .selectDistinctOn([aiUsageSnapshots.providerId], {
      providerId: aiUsageSnapshots.providerId,
      capturedAt: aiUsageSnapshots.capturedAt,
      parseOk: aiUsageSnapshots.parseOk,
      sessionRemaining: aiUsageSnapshots.sessionRemaining,
      weeklyRemaining: aiUsageSnapshots.weeklyRemaining,
    })
    .from(aiUsageSnapshots)
    .orderBy(aiUsageSnapshots.providerId, desc(aiUsageSnapshots.capturedAt));
  return new Map(rows.map((r) => [r.providerId, r]));
}

/**
 * Decide se `provider` ha di nuovo margine per lavorare.
 *  - `account` con snapshot FRESCO (età <= maxSnapshotAgeMs) e parsato:
 *    sessione usata < headroomPercent E weekly usata < 100. Il dato fresco è
 *    autoritativo in ENTRAMBE le direzioni (niente fallback a tempo se dice
 *    "ancora al limite").
 *  - altrimenti (api_key, snapshot stantio/assente/non parsato/jsonb malformato):
 *    fallback A TEMPO — la pausa dura da più del cooldown. Mai eterno.
 */
function hasHeadroom(
  provider: ResolvedProvider,
  snapshots: Map<string, LatestSnapshot>,
  deps: Pick<LimitResumeDeps, "headroomPercent" | "cooldownMs" | "maxSnapshotAgeMs">,
  pausedSince: Date,
  now: Date,
): boolean {
  if (provider.kind === "account") {
    const snap = snapshots.get(provider.id);
    if (snap && snap.parseOk && now.getTime() - snap.capturedAt.getTime() <= deps.maxSnapshotAgeMs) {
      const session = parseWindow(snap.sessionRemaining);
      const weekly = parseWindow(snap.weeklyRemaining);
      if (session && weekly) {
        return session.percentUsed < deps.headroomPercent && weekly.percentUsed < 100;
      }
      // jsonb malformato: cade nel fallback a tempo qui sotto.
    }
  }
  return now.getTime() - pausedSince.getTime() > deps.cooldownMs;
}

/**
 * Esegue UN giro del resume poller. Ritorna il numero di item ripresi
 * (generazioni + fix job + doc job), utile ai test. BEST-EFFORT: ogni item è in
 * try/catch isolato e l'intero tick a sua volta — non lancia MAI.
 */
export async function pollLimitResumeOnce(deps: LimitResumeDeps): Promise<number> {
  try {
    return await tick(deps);
  } catch (err) {
    // Difesa finale: un tick non deve mai propagare.
    console.error(`[stubwise-worker] limit-resume: tick fallito: ${errText(err)}`);
    return 0;
  }
}

async function tick(deps: LimitResumeDeps): Promise<number> {
  const { db } = deps;

  // 1. Candidati alla ripresa. Se non c'è NULLA di fermo per limite si esce
  //    subito, senza nemmeno interrogare catena e snapshot (il caso comune).
  const pausedGenerations = await db
    .select({
      id: docGenerations.id,
      pinnedProviderId: docGenerations.pinnedProviderId,
      pausedAt: docGenerations.pausedAt,
      startedAt: docGenerations.startedAt,
      createdAt: docGenerations.createdAt,
    })
    .from(docGenerations)
    .where(eq(docGenerations.status, "paused"));
  const heldFixJobs = await db
    .select({
      id: aiJobs.id,
      ticketId: aiJobs.ticketId,
      finishedAt: aiJobs.finishedAt,
      lastActivityAt: aiJobs.lastActivityAt,
    })
    .from(aiJobs)
    .where(and(eq(aiJobs.status, "held"), eq(aiJobs.heldReason, "limit")));
  const heldDocJobs = await db
    .select({
      id: docGenerationJobs.id,
      repositoryId: docGenerationJobs.repositoryId,
      finishedAt: docGenerationJobs.finishedAt,
      lastActivityAt: docGenerationJobs.lastActivityAt,
    })
    .from(docGenerationJobs)
    .where(and(eq(docGenerationJobs.status, "held"), eq(docGenerationJobs.heldReason, "limit")));

  if (pausedGenerations.length === 0 && heldFixJobs.length === 0 && heldDocJobs.length === 0) {
    return 0;
  }

  // 2. Catena dei provider abilitati + ultimo snapshot per provider.
  const loadChain = deps.loadProviderChainFn ?? loadProviderChain;
  const loadById = deps.loadProviderByIdFn ?? loadProviderById;
  const resumeGen = deps.resumeGenerationFn ?? resumeGeneration;
  const chain = await loadChain(db, deps.encryptionKey);
  const snapshots = await buildSnapshotIndex(db);
  const now = new Date();

  let resumed = 0;

  // 3. Generazioni paused: il provider della generazione è il PIN (blindato
  //    all'avvio) o, senza pin, la prima credenziale della catena — la stessa
  //    scelta della pipeline docs. Non risolvibile / catena vuota → skip: si
  //    riproverà al prossimo tick (o interverrà l'umano).
  for (const gen of pausedGenerations) {
    try {
      let provider: ResolvedProvider | undefined;
      if (gen.pinnedProviderId) {
        const pinned = await loadById(db, deps.encryptionKey, gen.pinnedProviderId);
        if (!pinned) {
          console.error(
            `[stubwise-worker] limit-resume: generazione ${gen.id} saltata: provider blindato non risolvibile (disabilitato/cancellato)`,
          );
          continue;
        }
        provider = pinned;
      } else {
        provider = chain[0];
        if (!provider) continue; // Catena vuota: niente base per decidere.
      }
      // pausedAt è sempre valorizzato per una paused; i fallback sono difensivi.
      const pausedSince = gen.pausedAt ?? gen.startedAt ?? gen.createdAt;
      if (!hasHeadroom(provider, snapshots, deps, pausedSince, now)) continue;
      if (await resumeGen(db, gen.id)) {
        resumed++;
        console.error(`[stubwise-worker] limit-resume: generazione ${gen.id} ripresa`);
      }
    } catch (err) {
      // Best-effort: un item fallito non blocca gli altri di questo giro.
      console.error(
        `[stubwise-worker] limit-resume: generazione ${gen.id} saltata: ${errText(err)}`,
      );
    }
  }

  // 4. Fix job held per limite: la decisione rispecchia processJob (handler.ts).
  //    Progetto con provider STRICT → decide SOLO quel provider; altrimenti
  //    basta l'headroom su ALMENO UNA credenziale della catena (il failover
  //    proverà comunque tutte). pausedSince = finishedAt (holdJob lo imposta),
  //    fallback lastActivityAt.
  for (const job of heldFixJobs) {
    try {
      const [row] = await db
        .select({ aiProviderId: projects.aiProviderId })
        .from(tickets)
        .innerJoin(projects, eq(projects.id, tickets.projectId))
        .where(eq(tickets.id, job.ticketId));
      if (!row) continue; // Ticket/progetto spariti: niente da riaccodare.

      const pausedSince = job.finishedAt ?? job.lastActivityAt;
      let ok: boolean;
      if (row.aiProviderId) {
        const pinned = await loadById(db, deps.encryptionKey, row.aiProviderId);
        ok = pinned !== null && hasHeadroom(pinned, snapshots, deps, pausedSince, now);
      } else {
        ok = chain.some((p) => hasHeadroom(p, snapshots, deps, pausedSince, now));
      }
      if (!ok) continue;

      // held → queued, GUARDED su status+heldReason: se nel frattempo un umano
      // l'ha già riaccodato (run-ai) l'update non tocca righe. Semantica di
      // run-ai (tickets.ts) ridotta al minimo: startedAt/finishedAt azzerati
      // (claimNextJob reimposta startedAt; finishedAt non deve restare di un run
      // concluso), lastActivityAt bumpato, riga di log. heldReason resta com'è
      // (storico dell'ultimo hold); resumeMode/planText restano INVARIATI di
      // proposito: si ri-esegue lo STESSO job nella stessa modalità in cui si è
      // fermato (un execute approvato riparte come execute, col suo piano).
      const updated = await db
        .update(aiJobs)
        .set({
          status: "queued",
          startedAt: null,
          finishedAt: null,
          lastActivityAt: sql`now()`,
          log: sql`${aiJobs.log} || ${`${RESUME_LOG_LINE}\n`}`,
        })
        .where(
          and(eq(aiJobs.id, job.id), eq(aiJobs.status, "held"), eq(aiJobs.heldReason, "limit")),
        )
        .returning({ id: aiJobs.id });
      if (updated.length === 0) continue;
      resumed++;
      console.error(`[stubwise-worker] limit-resume: fix job ${job.id} riaccodato`);

      // Commento AI di sistema sul ticket, BEST-EFFORT: un errore qui non
      // annulla la ripresa (il job è già queued).
      try {
        const lang = await getContentLanguage(db);
        await db.insert(comments).values({
          ticketId: job.ticketId,
          authorType: "ai",
          body: t(lang, "comment.limitResumed"),
        });
      } catch (err) {
        console.error(
          `[stubwise-worker] limit-resume: commento sul ticket ${job.ticketId} fallito: ${errText(err)}`,
        );
      }
    } catch (err) {
      console.error(`[stubwise-worker] limit-resume: fix job ${job.id} saltato: ${errText(err)}`);
    }
  }

  // 5. Doc job (trigger di generazione) held per limite: alla ripresa l'handler
  //    creerà una generazione FRESCA, che userà il provider del progetto (strict)
  //    o chain[0] — la decisione di headroom rispecchia quella scelta. Niente
  //    commento: un doc-job non ha un ticket.
  for (const job of heldDocJobs) {
    try {
      const [row] = await db
        .select({ aiProviderId: projects.aiProviderId })
        .from(repositories)
        .innerJoin(projects, eq(projects.id, repositories.projectId))
        .where(eq(repositories.id, job.repositoryId));
      if (!row) continue; // Repository/progetto spariti: niente da riaccodare.

      let provider: ResolvedProvider | undefined;
      if (row.aiProviderId) {
        const pinned = await loadById(db, deps.encryptionKey, row.aiProviderId);
        if (!pinned) continue; // Strict non risolvibile: MAI fallback.
        provider = pinned;
      } else {
        provider = chain[0];
        if (!provider) continue;
      }
      const pausedSince = job.finishedAt ?? job.lastActivityAt;
      if (!hasHeadroom(provider, snapshots, deps, pausedSince, now)) continue;

      // held → queued, GUARDED su status+heldReason (mirror del fix job qui
      // sopra). `error` viene azzerato: holdDocJob vi aveva scritto la ragione
      // della sospensione, che non descrive più lo stato del job riaccodato.
      const updated = await db
        .update(docGenerationJobs)
        .set({
          status: "queued",
          startedAt: null,
          finishedAt: null,
          error: null,
          lastActivityAt: sql`now()`,
          log: sql`${docGenerationJobs.log} || ${`${RESUME_LOG_LINE}\n`}`,
        })
        .where(
          and(
            eq(docGenerationJobs.id, job.id),
            eq(docGenerationJobs.status, "held"),
            eq(docGenerationJobs.heldReason, "limit"),
          ),
        )
        .returning({ id: docGenerationJobs.id });
      if (updated.length === 0) continue;
      resumed++;
      console.error(`[stubwise-worker] limit-resume: doc job ${job.id} riaccodato`);
    } catch (err) {
      console.error(`[stubwise-worker] limit-resume: doc job ${job.id} saltato: ${errText(err)}`);
    }
  }

  return resumed;
}

export interface StartLimitResumePollerOptions
  extends Omit<LimitResumeDeps, "maxSnapshotAgeMs"> {
  /** Intervallo di poll in minuti. ≤ 0 = disabilitato (non avvia nulla). */
  intervalMinutes: number;
  signal: AbortSignal;
}

/**
 * Avvia il poller su un proprio setInterval, separato dal loop dei job. Ad ogni
 * tick riprende ciò che è fermo per limite (vedi pollLimitResumeOnce). Lo stop
 * avviene sull'AbortSignal del worker. Ritorna una funzione di stop idempotente.
 * intervalMinutes ≤ 0 = disabilitato. maxSnapshotAgeMs è la costante
 * MAX_SNAPSHOT_AGE_MS (non una env, vedi sopra).
 */
export function startLimitResumePoller(opts: StartLimitResumePollerOptions): () => void {
  if (opts.intervalMinutes <= 0) {
    return () => {};
  }
  const { intervalMinutes, signal, ...rest } = opts;
  const deps: LimitResumeDeps = { ...rest, maxSnapshotAgeMs: MAX_SNAPSHOT_AGE_MS };
  let running = false;

  const tickOnce = async (): Promise<void> => {
    // Evita sovrapposizioni se un giro è più lento dell'intervallo.
    if (running) return;
    running = true;
    try {
      await pollLimitResumeOnce(deps);
    } catch (err) {
      // Difesa finale (pollLimitResumeOnce già non lancia): mai propagare.
      console.error(`[stubwise-worker] limit-resume: tick fallito: ${errText(err)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tickOnce();
  }, intervalMinutes * 60_000);
  // Non tenere vivo il processo solo per il poller.
  if (typeof timer.unref === "function") timer.unref();

  const stop = (): void => clearInterval(timer);
  signal.addEventListener("abort", stop, { once: true });
  return stop;
}
