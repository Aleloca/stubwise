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

export function createSegmentSink(
  db: Db,
  session: AgentRunSession,
  segmentId: string,
  interactive: boolean,
  opts: { flushMs?: number; heartbeatMs?: number; log?: (m: string) => void } = {},
): SegmentSink {
  const log = opts.log ?? warn;
  const flushMs = opts.flushMs ?? 200;
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  let queue: SessionEventDraft[] = [
    { type: "segment_start", data: { label: session.label, interactive } },
  ];
  let partial = "";
  let flushTimer: NodeJS.Timeout | null = null;
  let chain: Promise<void> = Promise.resolve();
  let ended = false;
  let failures = 0;

  // UNA riga di log per segmento: con il DB giù ogni flush e ogni heartbeat
  // fallirebbero, e un log per ciascuno sommergerebbe quello del job.
  const run = (what: string, fn: () => Promise<unknown>) => {
    chain = chain.then(async () => {
      try {
        await fn();
      } catch (error) {
        if (failures++ === 0) {
          log(
            `sessione ${session.sessionId}: ${what} fallito (registrazione del segmento ${segmentId} in degrado, errori successivi taciuti): ${describeError(error)}`,
          );
        }
      }
    });
  };

  const flush = () => {
    flushTimer = null;
    const batch = queue;
    queue = [];
    const text = partial;
    partial = "";
    if (batch.length > 0) {
      run("scrittura eventi", async () => {
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
    }
    if (text !== "") {
      run("notifica parziale", () =>
        db.execute(
          sql`select pg_notify(${AGENT_SESSION_PARTIAL_CHANNEL}, ${partialPayload(session.sessionId, segmentId, text)})`,
        ),
      );
    }
  };
  const schedule = () => {
    if (flushTimer === null) flushTimer = setTimeout(flush, flushMs);
  };

  const heartbeat = setInterval(() => {
    run("heartbeat", () =>
      db
        .update(agentSessions)
        .set({ heartbeatAt: sql`now()` })
        .where(eq(agentSessions.id, session.sessionId)),
    );
  }, heartbeatMs);
  heartbeat.unref();

  return {
    // Idempotente: il CLI riemette `system/init` a ogni turno; il runner
    // chiama onStart una volta sola, ma un secondo init dello stesso segmento
    // non cambia niente (array_remove + array_append, segment_start già in coda
    // dalla creazione del sink).
    onStart(capabilities) {
      if (ended) return;
      run("apertura segmento", () =>
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
      schedule();
    },
    onEvents(events) {
      if (ended) return;
      queue.push(...events);
      schedule();
    },
    onPartial(text) {
      if (ended) return;
      partial += text;
      schedule();
    },
    async onEnd(info) {
      if (ended) return;
      ended = true;
      clearInterval(heartbeat);
      if (flushTimer !== null) clearTimeout(flushTimer);
      queue.push({
        type: "segment_end",
        data: { exitCode: info.exitCode, timedOut: info.timedOut },
      });
      flush();
      // Toglie SOLO sé stesso. Nelle espressioni del SET, le colonne sono i
      // valori PRIMA dell'update: `remaining` è l'elenco senza questo segmento.
      const remaining = sql`array_remove(${agentSessions.liveSegmentIds}, ${segmentId})`;
      run("chiusura segmento", () =>
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
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        chain.then(() => false),
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
