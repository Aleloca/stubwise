import { and, eq, inArray, sql } from "drizzle-orm";
import { agentSessionInputs, agentSessions, comments, type Db } from "@stubwise/db";
import { t } from "@stubwise/i18n";
import {
  AGENT_SESSION_EVENTS_CHANNEL,
  AGENT_SESSION_INPUT_CHANNEL,
  TURN_BASED_SESSION_KINDS,
  type AgentInputReason,
  type AgentSegmentLabel,
  type AgentSessionKind,
} from "@stubwise/shared";
import type { AgentRunSession } from "../agent/runner.js";
import type { LiveProcessHandle, SegmentSink, SessionHooks } from "../agent/streaming-cli.js";
import { getContentLanguage } from "../settings.js";
import { createSegmentSink, resetLiveSegments, safeLogger } from "./store.js";

/**
 * Consegna degli interventi (design §6.2). Il worker è UN processo: questo
 * registro in memoria è l'unico che tiene gli stdin vivi — stessa assunzione
 * del serializer di progetto e di requeueWaitingReviews; va rivista con loro
 * il giorno in cui il worker diventasse multi-processo.
 *
 * Più sveglie (LISTEN, poll di rete, register/unregister) possono chiamare
 * `deliverPending` INSIEME: per questo ogni riga si RECLAMA prima di scriverla
 * su stdin (UPDATE … WHERE status='pending' RETURNING). Chi non vince il claim
 * non consegna. Se poi la scrittura fallisce, la riga torna `undelivered`.
 *
 * La consegna è AT-MOST-ONCE, di proposito: un intervento non arriva mai due
 * volte all'agente. Il prezzo è una finestra nota: se `deliver` risponde false
 * e l'UPDATE che riporta la riga a `undelivered` fallisce (DB giù in
 * quell'istante), la riga resta `delivered` senza essere mai stata scritta su
 * stdin. Non si ritenta (potrebbe essere una doppia consegna travestita): si
 * logga l'id dell'input, così chi indaga sa quale riga mente.
 *
 * Notifica degli eventi e commento sul ticket sono best-effort e SEPARATI:
 * un pg_notify fallito non toglie il commento, e nessuno dei due trasforma
 * una consegna riuscita in una «consegna fallita».
 *
 * `delivered` vuol dire «scritto su stdin», non «preso dal CLI»: lo dice
 * l'eco (`--replay-user-messages`, streaming-cli.ts), ed è lì che il runner
 * scrive l'evento `input`. Ciò che resta senza eco a fine segmento torna qui
 * (`inputsNotEchoed`) e diventa `undelivered` (`stdin_closed`). Lo «Ferma»
 * senza testo non ha eco per costruzione: resta `delivered` (è l'ancora di
 * «in pausa» lato server) e il suo commento è un template, mai un corpo vuoto.
 *
 * Sessioni A TURNI (`TURN_BASED_SESSION_KINDS`, con `turnStarter` configurato):
 * un input senza processo, rifiutato da `deliver` o rimasto senza eco NON
 * diventa `undelivered` — resta/torna `pending` e diventa un turno
 * (`TurnStarter`). Un messaggio non si perde e non entra in due turni: il claim
 * resta l'unico punto di passaggio a `delivered`. Lo «Ferma» senza testo non
 * ha niente da fermare a processo uscito: per lui valgono le regole di sempre.
 */

type InputRow = typeof agentSessionInputs.$inferSelect;

/**
 * Avvia un turno di una sessione A TURNI (design 2026-10-14 §3.2): lo
 * implementa lo scheduler del refinement. Sincrono e idempotente: con un turno
 * già in avvio o in corso sulla sessione non fa niente.
 */
export interface TurnStarter {
  requestTurn(sessionId: string): void;
}

/** Oltre questa soglia la cache dei kind si svuota (non cresce senza fine). */
const KIND_CACHE_MAX = 10_000;

export class SessionInputRelay implements SessionHooks {
  /** Per sessione, i processi vivi in ordine di registrazione: si consegna all'ultimo. */
  private readonly live = new Map<string, LiveProcessHandle[]>();
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly log: (m: string) => void;
  /** Kind per sessione: non cambia mai, si chiede al DB una volta. */
  private readonly kinds = new Map<string, AgentSessionKind>();

  constructor(
    private readonly deps: {
      db: Db;
      listen?: (channel: string, cb: (payload: string) => void) => Promise<unknown>;
      pollMs?: number;
      log?: (m: string) => void;
      /** Senza: nessuna sessione segue le regole a turni (comportamento di sempre). */
      turnStarter?: TurnStarter;
    },
  ) {
    // Un logger che lancia non deve far rifiutare le `void deliverPending(...)`
    // (unhandledRejection): ogni log del relay passa da qui.
    this.log = safeLogger(deps.log ?? ((m) => console.warn(m)));
  }

  async start(): Promise<void> {
    if (this.deps.listen) {
      try {
        await this.deps.listen(AGENT_SESSION_INPUT_CHANNEL, (payload) => {
          try {
            const { sessionId } = JSON.parse(payload) as { sessionId?: string };
            void this.deliverPending(sessionId);
          } catch {
            void this.deliverPending();
          }
        });
      } catch (error) {
        this.log(`relay: LISTEN fallito, resta il poll: ${String(error)}`);
      }
    }
    this.pollTimer = setInterval(() => void this.deliverPending(), this.deps.pollMs ?? 3000);
    this.pollTimer.unref();
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  openSegment(session: AgentRunSession, segmentId: string, interactive: boolean): SegmentSink {
    return createSegmentSink(this.deps.db, session, segmentId, interactive, { log: this.log });
  }

  register(sessionId: string, handle: LiveProcessHandle): () => void {
    const list = this.live.get(sessionId) ?? [];
    list.push(handle);
    this.live.set(sessionId, list);
    void this.deliverPending(sessionId);
    return () => {
      const current = this.live.get(sessionId) ?? [];
      const rest = current.filter((h) => h !== handle);
      if (rest.length > 0) this.live.set(sessionId, rest);
      else this.live.delete(sessionId);
      // Ciò che resta in coda per questa sessione non avrà più un processo.
      void this.deliverPending(sessionId);
    };
  }

  private handleFor(sessionId: string): LiveProcessHandle | undefined {
    const list = this.live.get(sessionId);
    return list?.[list.length - 1];
  }

  /** Consegna (o marca undelivered) gli input pending. Fail-open. */
  async deliverPending(sessionId?: string): Promise<void> {
    try {
      const pending = await this.deps.db
        .select()
        .from(agentSessionInputs)
        .where(
          sessionId
            ? and(
                eq(agentSessionInputs.status, "pending"),
                eq(agentSessionInputs.sessionId, sessionId),
              )
            : eq(agentSessionInputs.status, "pending"),
        )
        .orderBy(agentSessionInputs.createdAt);
      const turnBased = await this.turnBasedOf(pending.map((p) => p.sessionId));
      const requested = new Set<string>();
      const requestTurn = (id: string) => {
        if (requested.has(id)) return;
        requested.add(id);
        this.deps.turnStarter?.requestTurn(id);
      };
      /** Un messaggio con testo di una sessione a turni: mai `undelivered` per tempismo. */
      const becomesTurn = (input: InputRow) => turnBased.has(input.sessionId) && input.text !== "";
      for (const input of pending) {
        const handle = this.handleFor(input.sessionId);
        if (!handle) {
          if (becomesTurn(input)) {
            requestTurn(input.sessionId);
            continue;
          }
          await this.markUndelivered(input, "session_not_live", "pending");
          continue;
        }
        // CLAIM prima di scrivere su stdin: chi perde non consegna.
        const claimed = await this.deps.db
          .update(agentSessionInputs)
          .set({ status: "delivered", deliveredAt: sql`now()` })
          .where(and(eq(agentSessionInputs.id, input.id), eq(agentSessionInputs.status, "pending")))
          .returning({ id: agentSessionInputs.id });
        if (claimed.length === 0) continue;
        const ok = handle.deliver(input.text, input.interrupt, {
          inputId: input.id,
          authorUserId: input.authorUserId,
        });
        if (!ok) {
          if (becomesTurn(input)) {
            // Il turno sta finendo: la riga torna in coda e diventa il turno dopo.
            await this.backToPending(input);
            requestTurn(input.sessionId);
            continue;
          }
          // `stdin_closed` copre anche il caso in cui lo stdin è tecnicamente
          // ancora aperto (grazia dopo il result riuscito di un deliverable
          // nell'output): per chi scrive è lo stesso fatto, "non è entrato".
          // Nessun valore di enum nuovo, di proposito.
          try {
            await this.markUndelivered(input, "stdin_closed", "delivered");
          } catch (error) {
            // Finestra nota dell'at-most-once (vedi docblock del modulo).
            this.log(
              `relay: input ${input.id} rimasto 'delivered' senza essere scritto (stdin chiuso, rollback fallito): ${String(error)}`,
            );
          }
          continue;
        }
        await this.notifyChanged(input.sessionId);
        await this.writeTicketComment(input, handle.label);
      }
    } catch (error) {
      this.log(`relay: consegna fallita: ${String(error)}`);
    }
  }

  /** Le sessioni (fra quelle date) con le regole a turni. Vuoto senza turnStarter. */
  private async turnBasedOf(sessionIds: Iterable<string>): Promise<Set<string>> {
    if (this.deps.turnStarter === undefined) return new Set();
    const ids = [...new Set(sessionIds)];
    const unknown = ids.filter((id) => !this.kinds.has(id));
    if (unknown.length > 0) {
      if (this.kinds.size > KIND_CACHE_MAX) this.kinds.clear();
      const rows = await this.deps.db
        .select({ id: agentSessions.id, kind: agentSessions.kind })
        .from(agentSessions)
        .where(inArray(agentSessions.id, unknown));
      for (const r of rows) this.kinds.set(r.id, r.kind);
    }
    return new Set(
      ids.filter((id) => {
        const kind = this.kinds.get(id);
        return kind !== undefined && TURN_BASED_SESSION_KINDS.has(kind);
      }),
    );
  }

  /** Riporta a `pending` una riga reclamata e mai entrata. */
  private async backToPending(input: InputRow): Promise<void> {
    const updated = await this.deps.db
      .update(agentSessionInputs)
      .set({ status: "pending", deliveredAt: null })
      .where(and(eq(agentSessionInputs.id, input.id), eq(agentSessionInputs.status, "delivered")))
      .returning({ id: agentSessionInputs.id });
    if (updated.length > 0) await this.notifyChanged(input.sessionId);
  }

  private async markUndelivered(
    input: InputRow,
    reason: AgentInputReason,
    from: "pending" | "delivered",
  ): Promise<void> {
    const updated = await this.deps.db
      .update(agentSessionInputs)
      .set({ status: "undelivered", reason, deliveredAt: null })
      .where(and(eq(agentSessionInputs.id, input.id), eq(agentSessionInputs.status, from)))
      .returning({ id: agentSessionInputs.id });
    if (updated.length > 0) await this.notifyChanged(input.sessionId);
  }

  /**
   * A fine segmento, gli interventi scritti su stdin e mai ripresi dal CLI
   * (nessuna eco): da `delivered` a `undelivered` (`stdin_closed`), stesso
   * esito di uno arrivato a stdin chiuso — per chi l'ha scritto è lo stesso
   * fatto, «non è entrato». Solo righe `delivered` di QUESTA sessione: lo
   * «Ferma» senza testo non arriva mai qui (il runner non lo aspetta). Il
   * commento già scritto alla consegna resta: limite noto (vedi report Q2).
   * Per una sessione A TURNI le righe tornano invece `pending` e si chiede il
   * turno dopo (solo righe con testo arrivano qui).
   */
  async inputsNotEchoed(sessionId: string, inputIds: string[]): Promise<void> {
    if (inputIds.length === 0) return;
    if ((await this.turnBasedOf([sessionId])).has(sessionId)) {
      const back = await this.deps.db
        .update(agentSessionInputs)
        .set({ status: "pending", deliveredAt: null })
        .where(
          and(
            eq(agentSessionInputs.sessionId, sessionId),
            inArray(agentSessionInputs.id, inputIds),
            eq(agentSessionInputs.status, "delivered"),
          ),
        )
        .returning({ id: agentSessionInputs.id });
      if (back.length > 0) {
        await this.notifyChanged(sessionId);
        this.deps.turnStarter?.requestTurn(sessionId);
      }
      return;
    }
    const updated = await this.deps.db
      .update(agentSessionInputs)
      .set({ status: "undelivered", reason: "stdin_closed", deliveredAt: null })
      .where(
        and(
          eq(agentSessionInputs.sessionId, sessionId),
          inArray(agentSessionInputs.id, inputIds),
          eq(agentSessionInputs.status, "delivered"),
        ),
      )
      .returning({ id: agentSessionInputs.id });
    if (updated.length > 0) await this.notifyChanged(sessionId);
  }

  /** Lo stream SSE rilegge il dettaglio (e con lui `inputs`) a ogni notifica. */
  private async notifyChanged(sessionId: string): Promise<void> {
    try {
      await this.deps.db.execute(
        sql`select pg_notify(${AGENT_SESSION_EVENTS_CHANNEL}, ${JSON.stringify({ sessionId })})`,
      );
    } catch (error) {
      // Best-effort: lo stato è già in tabella, lo stream lo rilegge al
      // prossimo evento o al prossimo poll del client.
      this.log(
        `relay: notifica degli eventi della sessione ${sessionId} fallita: ${String(error)}`,
      );
    }
  }

  /**
   * Commento sul ticket (design §6.6): template i18n, mai AI. Best-effort.
   * L'etichetta è quella del processo che ha RICEVUTO l'input (registrata con
   * l'handle), non il segmento attivo sulla sessione al momento del commento,
   * che può essere già finito o di un altro tipo. Un'etichetta senza
   * traduzione (o assente) usa il template generico: mai una chiave grezza.
   * Lo «Ferma» senza testo ha i suoi template (`comment.agentStopped*`): chi
   * l'ha premuto è l'autore del commento, e un corpo vuoto non si scrive mai.
   */
  private async writeTicketComment(
    input: InputRow,
    label: AgentSegmentLabel | undefined,
  ): Promise<void> {
    try {
      const db = this.deps.db;
      const [session] = await db
        .select({ ticketId: agentSessions.ticketId })
        .from(agentSessions)
        .where(eq(agentSessions.id, input.sessionId));
      if (!session?.ticketId) return;
      const lang = await getContentLanguage(db);
      const segmentKey = `agentSegment.${label ?? ""}`;
      const segment = label ? t(lang, segmentKey) : segmentKey;
      const known = segment !== segmentKey;
      const stop = input.text === "";
      const body = stop
        ? known
          ? t(lang, "comment.agentStopped", { segment })
          : t(lang, "comment.agentStoppedGeneric")
        : known
          ? t(lang, "comment.agentIntervention", { segment, text: input.text })
          : t(lang, "comment.agentInterventionGeneric", { text: input.text });
      await db.insert(comments).values({
        ticketId: session.ticketId,
        authorType: "user",
        authorId: input.authorUserId,
        body,
      });
    } catch (error) {
      this.log(`relay: commento sul ticket fallito: ${String(error)}`);
    }
  }
}

/**
 * `resetLiveSegments` per l'AVVIO del worker (stessa forma di
 * `requeueWaitingReviewsAtStartup`): un errore (DB giù, tabella assente) si
 * logga e dà 0 — le sessioni non devono mai impedire al worker di partire.
 * Il worker è UN processo: nessun segmento di un processo precedente è vivo.
 */
export async function resetLiveSegmentsAtStartup(
  db: Db,
  opts: { reset?: typeof resetLiveSegments; log?: (m: string) => void } = {},
): Promise<number> {
  const reset = opts.reset ?? resetLiveSegments;
  const log = opts.log ?? ((m: string) => console.error(m));
  try {
    const n = await reset(db);
    if (n > 0) log(`[stubwise-worker] sessioni: ${n} segmenti rimasti vivi da un riavvio azzerati`);
    return n;
  } catch (error) {
    log(
      `[stubwise-worker] sessioni: azzeramento dei segmenti vivi fallito all'avvio: ${String(error)}`,
    );
    return 0;
  }
}
