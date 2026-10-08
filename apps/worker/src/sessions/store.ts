// apps/worker/src/sessions/store.ts
import { eq, lt, sql } from "drizzle-orm";
import { agentSessionEvents, agentSessionInputs, agentSessions, type Db } from "@stubwise/db";
import {
  AGENT_SESSION_EVENTS_CHANNEL,
  AGENT_SESSION_PARTIAL_CHANNEL,
  type AgentSessionKind,
} from "@stubwise/shared";
import type { AgentRunSession } from "../agent/runner.js";
import type { SegmentSink } from "../agent/streaming-cli.js";
import type { SessionEventDraft } from "./stream-parser.js";

/**
 * Persistenza delle sessioni (design §5.3–5.4, §6.4). TUTTO fail-open: ogni
 * errore si logga e si ingoia, perché guardare è un di più e non deve mai far
 * fallire un fix.
 *
 * SEGMENTI VIVI: una sessione può avere più processi aperti insieme (i nodi di
 * una generazione Docs girano in parallelo). `live_segment_ids` li elenca: ogni
 * segmento aggiunge sé stesso all'`init` e toglie SOLO sé stesso alla fine;
 * il segmento attivo (`active_segment_*`) si svuota solo a elenco vuoto.
 * `heartbeat_at` lo rinfresca qualunque segmento vivo. La sessione è viva se
 * l'elenco non è vuoto e l'heartbeat è fresco (lettura: Task 10).
 */

export const AGENT_SESSION_RETENTION_DAYS = 14;
/**
 * Il payload di NOTIFY è limitato a 8000 BYTE (non caratteri): il testo
 * parziale si tiene in coda finché il payload JSON sta sotto questo tetto.
 */
const MAX_NOTIFY_PAYLOAD_BYTES = 7500;
/**
 * Quanto `onEnd` aspetta le scritture in coda: con un DB lento o appeso la
 * fine del run non deve restare in ostaggio della registrazione (fail-open).
 */
const END_WAIT_MS = 5000;

export interface EnsureSessionInput {
  ownerKey: string;
  kind: AgentSessionKind;
  title: string;
  projectId?: string | null;
  ticketId?: string | null;
  aiJobId?: string | null;
  backlogItemId?: string | null;
  prReviewId?: string | null;
  docGenerationId?: string | null;
  backlogJobId?: string | null;
  mailboxOwnerUserId?: string | null;
}

const warn = (msg: string) => console.warn(msg);
const describeError = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Un logger che lancia non deve uscire da qui: nel sink lascerebbe lo
 * scrittore con `running` a true (nessuna scrittura più, nessun segment_end)
 * e una promise rifiutata senza gestore — e con
 * `--unhandled-rejections=throw` (il default di Node) il worker uscirebbe a
 * metà run. Esportato per il relay, che ha la stessa forma.
 */
export function safeLogger(log: (m: string) => void): (m: string) => void {
  return (m) => {
    try {
      log(m);
    } catch {
      // Il log è un di più: se non si può scrivere, si tace.
    }
  };
}

/**
 * Payload del parziale entro il tetto di NOTIFY: tiene la CODA del testo (è
 * quella che chi guarda sta leggendo) e non spezza una coppia surrogata.
 */
function partialPayload(sessionId: string, segmentId: string, text: string): string {
  let tail = text;
  for (;;) {
    const payload = JSON.stringify({ sessionId, segmentId, text: tail });
    if (Buffer.byteLength(payload, "utf8") <= MAX_NOTIFY_PAYLOAD_BYTES) return payload;
    const excess = Buffer.byteLength(payload, "utf8") - MAX_NOTIFY_PAYLOAD_BYTES;
    // Almeno un carattere ogni 4 byte in eccesso: converge in pochi giri.
    let cut = Math.max(1, Math.ceil(excess / 4));
    const code = tail.charCodeAt(cut);
    if (code >= 0xdc00 && code <= 0xdfff) cut += 1;
    tail = tail.slice(cut);
  }
}

export async function ensureAgentSession(
  db: Db,
  input: EnsureSessionInput,
  log: (m: string) => void = warn,
): Promise<string | null> {
  try {
    const [row] = await db
      .insert(agentSessions)
      .values({
        ownerKey: input.ownerKey,
        kind: input.kind,
        title: input.title,
        projectId: input.projectId ?? null,
        ticketId: input.ticketId ?? null,
        aiJobId: input.aiJobId ?? null,
        backlogItemId: input.backlogItemId ?? null,
        prReviewId: input.prReviewId ?? null,
        docGenerationId: input.docGenerationId ?? null,
        backlogJobId: input.backlogJobId ?? null,
        mailboxOwnerUserId: input.mailboxOwnerUserId ?? null,
      })
      .onConflictDoUpdate({ target: agentSessions.ownerKey, set: { title: input.title } })
      .returning({ id: agentSessions.id });
    return row?.id ?? null;
  } catch (error) {
    log(`sessione ${input.ownerKey}: creazione fallita: ${describeError(error)}`);
    return null;
  }
}

/**
 * Tetto agli eventi in attesa di scrittura (in coda + nel batch in volo). Con
 * il DB appeso la scrittura non avanza e un run di 2 h accumulerebbe memoria
 * senza limite: oltre il tetto si scartano i PIÙ VECCHI. Perdere parte della
 * trascrizione è accettabile, la memoria illimitata no.
 */
export const MAX_PENDING_EVENTS = 5000;
/** Tetto al parziale accumulato e non ancora notificato (si tiene la coda). */
const MAX_PENDING_PARTIAL_CHARS = 32_000;

export type RecordingSegmentSink = SegmentSink & {
  /** Eventi non ancora scritti (in coda + batch in volo): per i test. */
  pendingEvents(): number;
};

export function createSegmentSink(
  db: Db,
  session: AgentRunSession,
  segmentId: string,
  interactive: boolean,
  opts: { flushMs?: number; heartbeatMs?: number; log?: (m: string) => void } = {},
): RecordingSegmentSink {
  const log = safeLogger(opts.log ?? warn);
  const flushMs = opts.flushMs ?? 200;
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  let queue: SessionEventDraft[] = [
    { type: "segment_start", data: { label: session.label, interactive } },
  ];
  let inflight = 0;
  let dropped = 0;
  // Operazioni NON-evento: ognuna è un flag o un valore unico (coalescenza),
  // mai una closure per occorrenza. Un solo scrittore le consuma in ordine.
  let startPending: string[] | null = null;
  let partial = "";
  let heartbeatPending = false;
  let endPending = false;
  let flushTimer: NodeJS.Timeout | null = null;
  // `running` si azzera in modo SINCRONO nello stesso passo in cui drain()
  // verifica che non resti niente: nessuna finestra in cui un kick() venga perso.
  let running = false;
  let draining: Promise<void> = Promise.resolve();
  let ended = false;
  let failures = 0;

  // UNA riga di log per segmento: con il DB giù ogni scrittura fallirebbe, e
  // un log per ciascuna sommergerebbe quello del job.
  const attempt = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (error) {
      if (failures++ === 0) {
        log(
          `sessione ${session.sessionId}: ${what} fallito (registrazione del segmento ${segmentId} in degrado, errori successivi taciuti): ${describeError(error)}`,
        );
      }
    }
  };

  const drain = async () => {
    running = true;
    try {
      await drainLoop();
    } catch (error) {
      // SOLO sull'uscita per eccezione (un `finally` no): su quella normale
      // `drainLoop` azzera `running` nello stesso passo in cui vede la coda
      // vuota, e riazzerarlo un microtask dopo potrebbe spegnere il flag di
      // uno scrittore NUOVO partito nel frattempo — due scrittori insieme.
      // Senza questo ramo un'eccezione lascerebbe `running` a true e ogni
      // kick() muto: niente più scritture, niente segment_end.
      running = false;
      log(
        `sessione ${session.sessionId}: scrittore del segmento ${segmentId} interrotto: ${describeError(error)}`,
      );
    }
  };
  const drainLoop = async () => {
    for (;;) {
      if (startPending !== null) {
        const capabilities = startPending;
        startPending = null;
        await attempt("apertura segmento", () =>
          db
            .update(agentSessions)
            .set({
              liveSegmentIds: sql`array_append(array_remove(${agentSessions.liveSegmentIds}, ${segmentId}), ${segmentId})`,
              activeSegmentId: segmentId,
              activeSegmentLabel: session.label,
              activeSegmentInteractive: interactive,
              capabilities,
              heartbeatAt: sql`now()`,
            })
            .where(eq(agentSessions.id, session.sessionId)),
        );
        continue;
      }
      if (queue.length > 0) {
        const batch = queue;
        queue = [];
        inflight = batch.length;
        await attempt("scrittura eventi", async () => {
          await db.insert(agentSessionEvents).values(
            batch.map((e) => ({
              sessionId: session.sessionId,
              segmentId,
              type: e.type,
              data: e.data,
            })),
          );
          await db
            .update(agentSessions)
            .set({ lastEventAt: sql`now()`, heartbeatAt: sql`now()` })
            .where(eq(agentSessions.id, session.sessionId));
          await db.execute(
            sql`select pg_notify(${AGENT_SESSION_EVENTS_CHANNEL}, ${JSON.stringify({ sessionId: session.sessionId })})`,
          );
        });
        inflight = 0;
        continue;
      }
      if (partial !== "") {
        const text = partial;
        partial = "";
        await attempt("notifica parziale", () =>
          db.execute(
            sql`select pg_notify(${AGENT_SESSION_PARTIAL_CHANNEL}, ${partialPayload(session.sessionId, segmentId, text)})`,
          ),
        );
        continue;
      }
      if (heartbeatPending) {
        heartbeatPending = false;
        await attempt("heartbeat", () =>
          db
            .update(agentSessions)
            .set({ heartbeatAt: sql`now()` })
            .where(eq(agentSessions.id, session.sessionId)),
        );
        continue;
      }
      if (endPending) {
        endPending = false;
        // Toglie SOLO sé stesso. Nelle espressioni del SET, le colonne sono i
        // valori PRIMA dell'update: `remaining` è l'elenco senza questo segmento.
        const remaining = sql`array_remove(${agentSessions.liveSegmentIds}, ${segmentId})`;
        await attempt("chiusura segmento", () =>
          db
            .update(agentSessions)
            .set({
              liveSegmentIds: remaining,
              activeSegmentId: sql`case when cardinality(${remaining}) = 0 then null else ${agentSessions.activeSegmentId} end`,
              activeSegmentLabel: sql`case when cardinality(${remaining}) = 0 then null else ${agentSessions.activeSegmentLabel} end`,
              activeSegmentInteractive: sql`case when cardinality(${remaining}) = 0 then false else ${agentSessions.activeSegmentInteractive} end`,
            })
            .where(eq(agentSessions.id, session.sessionId)),
        );
        continue;
      }
      running = false;
      return;
    }
  };
  // Un solo scrittore alla volta: se è già in corso (magari appeso) raccoglierà
  // da sé quello che si è accumulato, senza altre closure in coda.
  const kick = () => {
    if (running) return;
    // Mai una promise rifiutata senza gestore (vedi safeLogger): `drain` non
    // rifiuta già da sé, il catch è la cintura.
    draining = drain().catch(() => undefined);
  };

  const trim = () => {
    const over = queue.length + inflight - MAX_PENDING_EVENTS;
    if (over <= 0) return;
    // `segment_start` non si scarta mai: si parte dal primo evento dopo di lui.
    // Né `segment_end` in coda: si scartano solo eventi ordinari.
    const from = queue[0]?.type === "segment_start" ? 1 : 0;
    const keepTail = queue.at(-1)?.type === "segment_end" ? 1 : 0;
    const n = Math.max(0, Math.min(over, queue.length - from - keepTail));
    queue.splice(from, n);
    dropped += n;
  };

  const flush = () => {
    flushTimer = null;
    kick();
  };
  const schedule = () => {
    if (flushTimer === null) flushTimer = setTimeout(flush, flushMs);
  };

  const heartbeat = setInterval(() => {
    heartbeatPending = true;
    kick();
  }, heartbeatMs);
  heartbeat.unref();

  return {
    pendingEvents: () => queue.length + inflight,
    // Idempotente: il CLI riemette `system/init` a ogni turno; il runner
    // chiama onStart una volta sola, ma un secondo init dello stesso segmento
    // non cambia niente (array_remove + array_append, segment_start già in coda
    // dalla creazione del sink).
    onStart(capabilities) {
      if (ended) return;
      startPending = capabilities;
      kick();
      schedule();
    },
    onEvents(events) {
      if (ended) return;
      queue.push(...events);
      trim();
      schedule();
    },
    onPartial(text) {
      if (ended) return;
      partial += text;
      if (partial.length > MAX_PENDING_PARTIAL_CHARS) {
        let cut = partial.length - MAX_PENDING_PARTIAL_CHARS;
        const code = partial.charCodeAt(cut);
        if (code >= 0xdc00 && code <= 0xdfff) cut += 1;
        partial = partial.slice(cut);
      }
      schedule();
    },
    async onEnd(info) {
      if (ended) return;
      ended = true;
      clearInterval(heartbeat);
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushTimer = null;
      queue.push({
        type: "segment_end",
        data: { exitCode: info.exitCode, timedOut: info.timedOut },
      });
      trim();
      endPending = true;
      // UNA riga per segmento, col conteggio finale (dopo l'ultimo evento).
      if (dropped > 0) log(`sessione ${session.sessionId}: ${dropped} eventi scartati, DB lento`);
      kick();
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        draining.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), END_WAIT_MS);
          timer.unref();
        }),
      ]);
      clearTimeout(timer);
      if (timedOut)
        log(
          `sessione ${session.sessionId}: scritture del segmento ${segmentId} ancora in corso dopo ${END_WAIT_MS} ms, il run prosegue`,
        );
    },
  };
}

/**
 * All'avvio del worker: nessun segmento sopravvive a un riavvio (il worker è
 * UN processo, stessa assunzione del serializer e di requeueWaitingReviews).
 * Senza, un `live_segment_ids` rimasto da un crash terrebbe la sessione «viva»
 * per i 90 s di heartbeat dopo la fine di ogni segmento successivo.
 */
export async function resetLiveSegments(db: Db): Promise<number> {
  const rows = await db
    .update(agentSessions)
    .set({
      liveSegmentIds: sql`'{}'`,
      activeSegmentId: null,
      activeSegmentLabel: null,
      activeSegmentInteractive: false,
    })
    .where(
      sql`cardinality(${agentSessions.liveSegmentIds}) > 0 or ${agentSessions.activeSegmentId} is not null`,
    )
    .returning({ id: agentSessions.id });
  return rows.length;
}

/**
 * Potatura (design §5.4, preflight M2): sessioni senza attività da 14 giorni
 * (con eventi e input in cascata) E, nelle sessioni che vivono a lungo (una
 * voce di backlog), gli eventi e gli interventi più vecchi di 14 giorni.
 * `coalesce(last_event_at, started_at)` è la STESSA espressione dell'elenco
 * (Task 10) e dell'indice `agent_sessions_last_activity_idx`.
 */
export async function pruneAgentSessions(
  db: Db,
  now: Date = new Date(),
): Promise<{ sessions: number; events: number; inputs: number }> {
  // Stringa ISO con cast esplicito: postgres-js non serializza un Date dentro
  // un frammento `sql` grezzo (la coalesce), solo nei confronti su colonna.
  const cutoff = sql`${new Date(now.getTime() - AGENT_SESSION_RETENTION_DAYS * 86_400_000).toISOString()}::timestamptz`;
  const sessions = await db
    .delete(agentSessions)
    .where(lt(sql`coalesce(${agentSessions.lastEventAt}, ${agentSessions.startedAt})`, cutoff))
    .returning({ id: agentSessions.id });
  const events = await db
    .delete(agentSessionEvents)
    .where(lt(agentSessionEvents.createdAt, cutoff))
    .returning({ id: agentSessionEvents.id });
  const inputs = await db
    .delete(agentSessionInputs)
    .where(lt(agentSessionInputs.createdAt, cutoff))
    .returning({ id: agentSessionInputs.id });
  return { sessions: sessions.length, events: events.length, inputs: inputs.length };
}
