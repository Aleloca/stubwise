import {
  aiJobs,
  comments,
  docGenerationJobs,
  docGenerations,
  repositories,
  tickets,
  type Db,
} from "@stubwise/db";
import { t } from "@stubwise/i18n";
import { docsPauseReasonOf } from "@stubwise/notifications";
import { and, eq, sql } from "drizzle-orm";
import {
  resumedAsInteractive,
  resumeGeneration,
  resumeGenerationAsInteractive,
  THRESHOLD_PAUSE_REASON,
} from "../docs/nodes.js";
import { getContentLanguage } from "../settings.js";
import { latestSnapshots, MAX_SNAPSHOT_AGE_MS, parseWindow, type LatestSnapshot } from "./usage-window.js";
import type { ResolvedProvider } from "./chain.js";
import { QuotaWaitLog } from "./quota-wait.js";
import { selectProviders, type SelectDeps, type SelectInput } from "./select.js";

/**
 * RESUME POLLER dei limiti di utilizzo dei provider AI.
 *
 * Task SEPARATO dal loop dei job (pattern pr-review-poller):
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
 * LA DECISIONE È LA SCELTA DEL RUN (preflight D7): per ogni item si chiede a
 * `selectProviders` — la stessa funzione che sceglie l'account del run — chi
 * proverebbe il run adesso, con la stessa classe di lavoro (`interactive` per i
 * fix, `background` per i Docs) e lo stesso pin. Si riprende solo se c'è un
 * candidato con margine (hasHeadroom su ciascuno: il run passa dall'uno
 * all'altro come runWithProviders); senza nessun provider abilitato (auth
 * storica) decide l'ora del limite ricordata in memoria
 * (SelectDeps.legacyLimit), poi il fallback a tempo. Così un account «al
 * limite» (limited_until futuro) non fa riprendere nulla, e la chiave API —
 * che con un abbonamento abilitato non entra mai nella scelta — non fa più
 * ripartire job che il run rimetterebbe subito in held (con due commenti AI sul
 * ticket a ogni giro). Niente logica «progetto fissato / catena» qui: una
 * seconda copia delle regole è come quel giro è nato.
 *
 * DECISIONE DI HEADROOM di un candidato (vedi hasHeadroom):
 *  - credenziale `account` con uno snapshot d'usage FRESCO e PARSATO (poller
 *    /usage, agent/usage-poller.ts): headroom = sessione usata < soglia% E
 *    weekly usata < 100%. Lo snapshot fresco è AUTORITATIVO: se dice "ancora al
 *    limite" NON si degrada al fallback a tempo.
 *  - credenziale `api_key` (nessuno snapshot: /usage esiste solo per gli
 *    account) o snapshot stantio/assente/non parsato → FALLBACK A TEMPO: si
 *    riprende quando la pausa dura da più del cooldown. Il fallback garantisce
 *    che nulla resti fermo per sempre FINCHÉ un provider è risolvibile, anche
 *    con il poll usage disabilitato (USAGE_POLL_MINUTES=0: tutti gli snapshot
 *    invecchiano e si degrada sempre al tempo). Restano fermi BY DESIGN i casi
 *    in cui la scelta è vuota: tutti al limite o oltre soglia (si aspetta: il
 *    poller d'uso azzera limited_until appena torna margine, e comunque
 *    limited_until scade) e «solo questo» su un provider non risolvibile
 *    (serve l'intervento umano: riabilitarlo o togliere il vincolo).
 *
 * VINCOLI (come gli altri poller): NON fa MAI crashare il worker (ogni item in
 * try/catch isolato, l'intero tick a sua volta in try/catch), NON tocca il
 * lock/heartbeat né i timeout dei job in lavorazione (agisce solo su
 * paused/held, stati fermi) e NON logga mai i segreti. Si ferma sull'AbortSignal
 * del worker.
 */

/** Riga di log/commento della ripresa automatica (appesa al log del job). */
const RESUME_LOG_LINE =
  "[stubwise] limite del provider rientrato: job riaccodato automaticamente dal resume poller";

export interface LimitResumeDeps {
  db: Db;
  /** La scelta dell'account del worker (la stessa dei run): decide chi riprenderebbe. */
  select: SelectDeps;
  /** Soglia di headroom: la sessione deve essere SOTTO questa % di used. */
  headroomPercent: number;
  /** Cooldown del fallback a tempo (api_key o snapshot stantio/assente). */
  cooldownMs: number;
  /** Età massima di uno snapshot per considerarlo attendibile. */
  maxSnapshotAgeMs: number;
  /**
   * Oltre quanto (ms) una generazione in pausa per la SOGLIA di sfondo riparte
   * come `interactive` (DOCS_BACKGROUND_PAUSE_MAX_HOURS, vedi il docblock).
   */
  backgroundPauseMaxMs: number;
  /**
   * Una riga di log all'INGRESSO di un item in un'attesa di configurazione
   * («solo questo» non risolvibile, nessun segreto decifrabile), non a ogni
   * giro. Default: un'istanza per poller (startLimitResumePoller).
   */
  waitLog?: QuotaWaitLog;
  /** Ripresa di una generazione paused (iniettabile nei test). */
  resumeGenerationFn?: typeof resumeGeneration;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Decide se `provider` ha di nuovo margine per lavorare.
 *  - `account` con snapshot FRESCO (età <= maxSnapshotAgeMs) e parsato:
 *    sessione usata < headroomPercent E weekly usata < 100. Il dato fresco è
 *    autoritativo in ENTRAMBE le direzioni (niente fallback a tempo se dice
 *    "ancora al limite").
 *  - altrimenti (api_key, snapshot stantio/assente/non parsato/jsonb malformato):
 *    fallback A TEMPO — la pausa dura da più del cooldown. Mai eterno PER UN
 *    CANDIDATO DELLA SCELTA: i casi in cui la scelta è vuota restano fermi,
 *    vedi il docblock del modulo.
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
 * La ripresa di un item: la scelta del run, con la sua classe di lavoro e il
 * suo pin, e il margine di ALMENO UN candidato (preflight D7, lo stesso failover del run). Auth storica
 * (nessun provider abilitato) → fallback a tempo: non c'è uno stato da leggere,
 * e lasciarlo fermo per sempre sarebbe peggio di un tentativo in più.
 */
async function canResume(
  deps: LimitResumeDeps,
  key: string,
  input: SelectInput,
  snapshots: Map<string, LatestSnapshot>,
  pausedSince: Date,
  now: Date,
): Promise<boolean> {
  const sel = await (deps.select.selectProvidersFn ?? selectProviders)(deps.select, input);
  // Auth storica: se è finita al limite la scelta è vuota per quota fino
  // all'ora ricordata (SelectDeps.legacyLimit), quindi qui si arriva solo
  // quando quell'ora è passata (o dopo un riavvio, che l'ha persa).
  if (sel.legacyAuth) return now.getTime() - pausedSince.getTime() > deps.cooldownMs;
  if (sel.candidates.length === 0) {
    const reason = sel.emptyReason;
    if (
      deps.waitLog &&
      (reason === "exclusive_unavailable" || reason === "no_usable_provider") &&
      deps.waitLog.enter(key)
    ) {
      console.error(
        `[stubwise-worker] limit-resume: ${key} resta fermo: ${reason === "exclusive_unavailable" ? "provider «solo questo» del progetto non disponibile (disabilitato o cancellato)" : "nessun provider AI utilizzabile (segreti non decifrabili)"}`,
      );
    }
    return false;
  }
  // Basta UN candidato con margine: il run passa comunque dagli altri se il
  // primo è al limite (lo stesso failover di runWithProviders).
  return sel.candidates.some((c) => hasHeadroom(c, snapshots, deps, pausedSince, now));
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
  //    subito, senza nemmeno interrogare scelta e snapshot (il caso comune).
  const pausedGenerations = await db
    .select({
      id: docGenerations.id,
      projectId: repositories.projectId,
      pinnedProviderId: docGenerations.pinnedProviderId,
      pausedAt: docGenerations.pausedAt,
      pauseReason: docGenerations.pauseReason,
      stats: docGenerations.stats,
      startedAt: docGenerations.startedAt,
      createdAt: docGenerations.createdAt,
    })
    .from(docGenerations)
    .innerJoin(repositories, eq(repositories.id, docGenerations.repositoryId))
    .where(eq(docGenerations.status, "paused"));
  const heldFixJobs = await db
    .select({
      id: aiJobs.id,
      ticketId: aiJobs.ticketId,
      projectId: tickets.projectId,
      finishedAt: aiJobs.finishedAt,
      lastActivityAt: aiJobs.lastActivityAt,
    })
    .from(aiJobs)
    .innerJoin(tickets, eq(tickets.id, aiJobs.ticketId))
    .where(and(eq(aiJobs.status, "held"), eq(aiJobs.heldReason, "limit")));
  const heldDocJobs = await db
    .select({
      id: docGenerationJobs.id,
      projectId: repositories.projectId,
      finishedAt: docGenerationJobs.finishedAt,
      lastActivityAt: docGenerationJobs.lastActivityAt,
    })
    .from(docGenerationJobs)
    .innerJoin(repositories, eq(repositories.id, docGenerationJobs.repositoryId))
    .where(and(eq(docGenerationJobs.status, "held"), eq(docGenerationJobs.heldReason, "limit")));

  if (pausedGenerations.length === 0 && heldFixJobs.length === 0 && heldDocJobs.length === 0) {
    return 0;
  }

  // 2. Ultimo snapshot per provider (il margine del primo candidato).
  const resumeGen = deps.resumeGenerationFn ?? resumeGeneration;
  const snapshots = await latestSnapshots(db);
  const now = deps.select.now?.() ?? new Date();

  let resumed = 0;

  // 3. Generazioni paused: generazione completa = lavoro di SFONDO (decisione
  //    A-6), col pin della generazione se è nata con «solo questo». Interattiva
  //    se già ripresa come tale, o se è ferma per la SOGLIA da più di
  //    backgroundPauseMaxMs (F2a, vedi il docblock del modulo).
  for (const gen of pausedGenerations) {
    try {
      // pausedAt è sempre valorizzato per una paused; i fallback sono difensivi.
      const pausedSince = gen.pausedAt ?? gen.startedAt ?? gen.createdAt;
      const interactive =
        resumedAsInteractive(gen.stats) ||
        // Il CODICE della reason, non l'uguaglianza col testo (F2b): una pausa
        // scritta prima dei codici porta ancora la frase storica della soglia.
        (docsPauseReasonOf(gen.pauseReason) === THRESHOLD_PAUSE_REASON &&
          now.getTime() - pausedSince.getTime() > deps.backgroundPauseMaxMs);
      const input: SelectInput = {
        projectId: gen.projectId,
        workClass: interactive ? "interactive" : "background",
        pinnedProviderId: gen.pinnedProviderId,
      };
      const key = `generazione ${gen.id}`;
      if (!(await canResume(deps, key, input, snapshots, pausedSince, now))) continue;
      deps.waitLog?.leave(key);
      const ok = interactive
        ? await resumeGenerationAsInteractive(db, gen.id)
        : await resumeGen(db, gen.id);
      if (ok) {
        resumed++;
        console.error(
          `[stubwise-worker] limit-resume: generazione ${gen.id} ripresa${interactive ? " come lavoro interattivo" : ""}`,
        );
      }
    } catch (err) {
      // Best-effort: un item fallito non blocca gli altri di questo giro.
      console.error(
        `[stubwise-worker] limit-resume: generazione ${gen.id} saltata: ${errText(err)}`,
      );
    }
  }

  // 4. Fix job held per limite: la stessa scelta di processJob (handler.ts),
  //    classe `interactive`. pausedSince = finishedAt (holdJob lo imposta),
  //    fallback lastActivityAt.
  for (const job of heldFixJobs) {
    try {
      const pausedSince = job.finishedAt ?? job.lastActivityAt;
      const input: SelectInput = { projectId: job.projectId, workClass: "interactive" };
      const key = `fix job ${job.id}`;
      if (!(await canResume(deps, key, input, snapshots, pausedSince, now))) continue;
      deps.waitLog?.leave(key);

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
  //    creerà una generazione FRESCA con la stessa scelta (sfondo, provider del
  //    progetto preferito o esclusivo). Niente commento: un doc-job non ha un
  //    ticket.
  for (const job of heldDocJobs) {
    try {
      const pausedSince = job.finishedAt ?? job.lastActivityAt;
      const input: SelectInput = { projectId: job.projectId, workClass: "background" };
      const key = `doc job ${job.id}`;
      if (!(await canResume(deps, key, input, snapshots, pausedSince, now))) continue;
      deps.waitLog?.leave(key);

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
  const deps: LimitResumeDeps = {
    waitLog: new QuotaWaitLog(),
    ...rest,
    maxSnapshotAgeMs: MAX_SNAPSHOT_AGE_MS,
  };
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
