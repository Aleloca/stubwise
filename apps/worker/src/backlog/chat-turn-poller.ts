import { backlogChatMessages, backlogJobs } from "@stubwise/db";
import { t } from "@stubwise/i18n";
import { backlogChatTurnPayloadSchema } from "@stubwise/shared";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@stubwise/db";
import { createProjectSerializer, type ProjectSerializer } from "../handler.js";
import { getContentLanguage } from "../settings.js";
import { runChatTurn, type ChatTurnDeps } from "./chat-turn.js";
import { claimNextChatTurnJob, type BacklogJob, type BacklogLogger } from "./poller.js";

/**
 * POLLER VELOCE dei turni della sessione di analisi sul codice (`chat_turn`).
 *
 * Separato dal poller lento del backlog (20s, intake/deep_dive): i turni sono
 * interattivi (l'utente attende la risposta in chat) quindi girano su un proprio
 * intervallo breve (default 2s). Reclama SOLO i `chat_turn` (claimNextChatTurnJob,
 * indice parziale dei queued → costo trascurabile) e li esegue.
 *
 * SERIALIZZAZIONE PER-ITEM: due turni della STESSA voce non devono mai girare in
 * parallelo (un `--resume` concorrente della stessa sessione CLI, o doppia
 * apertura del worktree al primo turno). Ogni turno passa da un serializer keyed
 * per itemId (pattern createProjectSerializer) CONDIVISO fra i tick (creato una
 * volta in startChatTurnPoller): turni di voci DIVERSE procedono in parallelo
 * (chat reattiva), quelli della stessa voce si accodano — anche a cavallo di tick.
 *
 * NESSUNA BARRIERA DI TICK: pollChatTurnsOnce reclama i turni e li DISPATCHA senza
 * attenderne il completamento (ritorna le promise in volo). Così una domanda sulla
 * voce B posta mentre un turno da minuti gira sulla voce A parte subito (motivo
 * della feature: multi-utente reattivo). Il doppio claim è impedito dallo status
 * `running` (un turno già in volo non è più `queued`); la serializzazione
 * stessa-voce dal serializer condiviso.
 *
 * RECOVERY ORFANI: i `chat_turn` `running` col startedAt oltre soglia sono di un
 * worker crashato → `failed` SENZA retry (un turno non si ritenta: la domanda
 * resta in chat, l'utente può rimandarla) + messaggio assistant di errore i18n
 * (coerente col fallimento in-process).
 *
 * BEST-EFFORT: ogni job in try/catch isolato, l'intero tick idem; non fa MAI
 * crashare il worker. Si ferma sull'AbortSignal.
 */

/** Minuti MINIMI oltre cui un `chat_turn` `running` è considerato orfano. */
export const CHAT_TURN_STALE_MINUTES = 15;

/**
 * Soglia di staleness derivata dal timeout del turno: un turno può ATTENDERE in
 * coda dietro un altro turno della STESSA voce (fino al timeout) e poi GIRARE
 * (fino al timeout) = 2× timeout, più margine. Mai sotto CHAT_TURN_STALE_MINUTES.
 * Evita la trappola di WORKER_STALE_MINUTES: alzando BACKLOG_CHAT_TURN_TIMEOUT_MS
 * oltre ~15' la soglia si adegua da sola (nessun recovery di un turno ancora vivo).
 */
export function chatTurnStaleMinutes(timeoutMs: number): number {
  return Math.max(CHAT_TURN_STALE_MINUTES, 2 * Math.ceil(timeoutMs / 60_000) + 5);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Recupero degli orfani (fase 0 del tick): i `chat_turn` `running` col startedAt
 * oltre soglia sono di un worker crashato → `failed` (nessun retry). Un solo
 * UPDATE status-guarded con `returning` per, PER OGNI orfano, lasciare in chat il
 * messaggio assistant di errore (come il path in-process): la voce non resta con
 * la domanda "appesa" senza risposta. L'inserimento è best-effort (la voce
 * potrebbe essere sparita); i log via `logger` se fornito. Il poller è
 * single-process e i tick non si sovrappongono, quindi un `running` stantio è
 * sempre orfano, mai vivo.
 */
export async function recoverStaleChatTurnJobs(
  db: Db,
  staleMinutes: number,
  logger?: BacklogLogger,
): Promise<void> {
  const recovered = await db
    .update(backlogJobs)
    .set({ status: "failed", error: "worker crash durante il turno di chat", finishedAt: sql`now()` })
    .where(
      and(
        eq(backlogJobs.kind, "chat_turn"),
        eq(backlogJobs.status, "running"),
        sql`${backlogJobs.startedAt} < now() - make_interval(mins => ${staleMinutes}::int)`,
      ),
    )
    .returning({ id: backlogJobs.id, payload: backlogJobs.payload });
  if (recovered.length === 0) return;
  const lang = await getContentLanguage(db);
  for (const row of recovered) {
    const parsed = backlogChatTurnPayloadSchema.safeParse(row.payload);
    if (!parsed.success) continue;
    try {
      await db.insert(backlogChatMessages).values({
        itemId: parsed.data.itemId,
        role: "assistant",
        content: t(lang, "backlog.codeTurnError"),
      });
    } catch (err) {
      // Best-effort: la voce potrebbe non esistere più (cascade), FK violata.
      logger?.warn(
        { err, jobId: row.id, itemId: parsed.data.itemId },
        "[backlog] chat turn: messaggio di errore del recovery non inserito",
      );
    }
  }
}

async function completeChatTurnJob(db: Db, jobId: string): Promise<void> {
  await db
    .update(backlogJobs)
    .set({ status: "done", error: null, finishedAt: sql`now()` })
    .where(and(eq(backlogJobs.id, jobId), eq(backlogJobs.status, "running")));
}

/** Fallisce il turno SENZA riaccodarlo (un turno non si ritenta mai). */
async function failChatTurnJob(db: Db, jobId: string, error: string): Promise<void> {
  await db
    .update(backlogJobs)
    .set({ status: "failed", error, finishedAt: sql`now()` })
    .where(and(eq(backlogJobs.id, jobId), eq(backlogJobs.status, "running")));
}

export interface ChatTurnPollerDeps extends ChatTurnDeps {
  /** Minuti oltre cui un `running` è orfano. Default CHAT_TURN_STALE_MINUTES. */
  staleMinutes?: number;
  /** Esecutore del turno, iniettabile nei test. Default runChatTurn. */
  runChatTurnFn?: typeof runChatTurn;
  /** Stop cooperativo: interrompe il drain a metà tick. */
  signal?: AbortSignal;
}

/**
 * Processa UN job chat_turn: valida il payload (malformato → failed subito,
 * niente retry) e lo esegue nel serializer PER-ITEM. Successo → done; qualunque
 * errore → failed SENZA retry. Ritorna true se il turno è stato completato con
 * successo (utile ai test). Non lancia.
 */
async function processChatTurnJob(
  deps: ChatTurnPollerDeps,
  job: BacklogJob,
  serializer: ProjectSerializer,
): Promise<boolean> {
  const parsed = backlogChatTurnPayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    await failChatTurnJob(deps.db, job.id, `payload chat_turn non valido: ${parsed.error.message}`).catch(
      (err: unknown) =>
        deps.logger.error({ err, jobId: job.id }, "[backlog] chat turn: fallimento payload malformato"),
    );
    return false;
  }
  const runFn = deps.runChatTurnFn ?? runChatTurn;
  try {
    await serializer.run(parsed.data.itemId, () => runFn(deps, job, parsed.data));
    await completeChatTurnJob(deps.db, job.id);
    return true;
  } catch (err) {
    // Un turno NON si ritenta: failed diretto (la domanda resta in chat).
    await failChatTurnJob(deps.db, job.id, errText(err)).catch((txErr: unknown) =>
      deps.logger.error({ err: txErr, jobId: job.id }, "[backlog] chat turn: chiusura failed fallita"),
    );
    return false;
  }
}

/**
 * Esegue UN giro: (0) recovery degli orfani, poi reclama TUTTI i `chat_turn`
 * queued e li DISPATCHA sul `itemSerializer` CONDIVISO (per-item: stessa voce ⇒
 * sequenziale, anche a cavallo di tick; voci diverse ⇒ parallelo). NON attende il
 * completamento dei turni (niente barriera): ritorna appena reclamati, con le
 * promise in volo (utile ai test per attenderle). Un turno lento su una voce non
 * blocca quindi i turni delle altre né i tick successivi. Non lancia mai.
 */
export async function pollChatTurnsOnce(
  deps: ChatTurnPollerDeps,
  itemSerializer: ProjectSerializer,
): Promise<Promise<boolean>[]> {
  const staleMinutes = deps.staleMinutes ?? chatTurnStaleMinutes(deps.timeoutMs);
  try {
    await recoverStaleChatTurnJobs(deps.db, staleMinutes, deps.logger);
  } catch (err) {
    deps.logger.error({ err }, "[backlog] chat turn: recupero degli orfani fallito");
  }

  const dispatched: Promise<boolean>[] = [];
  while (!deps.signal?.aborted) {
    let job: BacklogJob | null;
    try {
      job = await claimNextChatTurnJob(deps.db);
    } catch (err) {
      deps.logger.error({ err }, "[backlog] chat turn: claim del prossimo turno fallito");
      break;
    }
    if (!job) break;
    dispatched.push(processChatTurnJob(deps, job, itemSerializer));
  }
  return dispatched;
}

export interface StartChatTurnPollerOptions extends ChatTurnPollerDeps {
  /** Intervallo di poll in secondi. ≤ 0 = disabilitato (non avvia nulla). */
  intervalSeconds: number;
  signal: AbortSignal;
}

/**
 * Avvia il poller veloce su un proprio setInterval. Il serializer per-item è
 * creato UNA VOLTA e condiviso fra tutti i tick (così un turno reclamato in un
 * tick si accoda correttamente dietro un turno della stessa voce ancora in volo
 * da un tick precedente). Ogni tick recupera gli orfani e reclama i turni queued,
 * dispatchandoli SENZA attendere (il claim è breve; i turni girano in background).
 * Il guard `running` serializza solo la fase di CLAIM (che è rapida), non i turni.
 * Stop sull'AbortSignal. Ritorna uno stop idempotente. intervalSeconds ≤ 0 =
 * disabilitato.
 */
export function startChatTurnPoller(opts: StartChatTurnPollerOptions): () => void {
  if (opts.intervalSeconds <= 0) {
    return () => {};
  }
  const { intervalSeconds, ...deps } = opts;
  const itemSerializer = createProjectSerializer();
  let claiming = false;
  const tick = async (): Promise<void> => {
    if (claiming) return;
    claiming = true;
    try {
      // Le promise dei turni dispatchati sono volutamente NON attese qui:
      // processChatTurnJob non rigetta mai (cattura tutto), quindi niente
      // unhandled rejection; i turni proseguono in background.
      await pollChatTurnsOnce(deps, itemSerializer);
    } catch (err) {
      deps.logger.error({ err }, "[backlog] chat turn: tick fallito");
    } finally {
      claiming = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalSeconds * 1000);
  if (typeof timer.unref === "function") timer.unref();
  const stop = (): void => clearInterval(timer);
  opts.signal.addEventListener("abort", stop, { once: true });
  return stop;
}
