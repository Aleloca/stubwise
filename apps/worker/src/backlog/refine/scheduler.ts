import { and, asc, eq, inArray, lt, ne, notExists, notInArray, sql } from "drizzle-orm";
import { agentSessionInputs, backlogRefineSessions, type Db } from "@stubwise/db";
import { AGENT_SESSION_EVENTS_CHANNEL, BACKLOG_REFINE_CLOSED_CHANNEL } from "@stubwise/shared";
import type { TurnStarter } from "../../sessions/relay.js";
import type { RefineBridge } from "./bridge.js";
import type { RefineTurnOutcome } from "./turn.js";
import type { RefineWorktreeRegistry } from "./worktrees.js";

/**
 * Scheduler dei turni di refinement (design 2026-10-14 §3.2, §3.3, §5.5).
 * In memoria: il worker è UN processo (come relay e serializer). Garantisce
 * che su una sessione giri al più UN turno, tiene il tetto d'istanza e pulisce
 * alla chiusura. Non scrive mai la chiusura voluta da una persona (la scrive
 * il server, che poi manda `BACKLOG_REFINE_CLOSED_CHANNEL`); scrive solo
 * quella per inattività.
 *
 * Il turno si avvia da un input `pending` con testo: lo chiede il relay
 * (`TurnStarter`) a ogni sveglia, e a fine turno lo scheduler risveglia il
 * relay su TUTTE le sessioni — il messaggio arrivato nella grazia diventa il
 * turno dopo, e il posto liberato può servire a un'altra sessione in coda.
 * Tetto pieno o turno già attivo: niente, il messaggio resta `pending` e il
 * poll del relay ripete la richiesta.
 */
export interface RefineSchedulerDeps {
  db: Db;
  maxConcurrent: number;
  idleMinutes: number;
  bridge: Pick<RefineBridge, "revokeSession">;
  worktrees: RefineWorktreeRegistry;
  runTurn: (input: { agentSessionId: string; inputId: string; signal: AbortSignal }) => Promise<RefineTurnOutcome>;
  listen?: (channel: string, cb: (payload: string) => void) => Promise<unknown>;
  log: (m: string) => void;
}

interface Waker {
  deliverPending(sessionId?: string): Promise<void>;
}

export class RefineScheduler implements TurnStarter {
  private readonly turns = new Map<string, { controller: AbortController; done: Promise<void> }>();
  /** Sessioni in chiusura: nessun turno nuovo finché i loro input non sono marcati. */
  private readonly closing = new Set<string>();
  private relay: Waker | undefined;
  private stopping = false;

  constructor(private readonly deps: RefineSchedulerDeps) {}

  /** Il relay nasce prima (è lui a chiamare `requestTurn`): si aggancia dopo. */
  attachRelay(relay: Waker): void {
    this.relay = relay;
  }

  /** LISTEN delle chiusure scritte dal server. Fail-open: senza, resta lo sweep. */
  async start(): Promise<void> {
    if (!this.deps.listen) return;
    try {
      await this.deps.listen(BACKLOG_REFINE_CLOSED_CHANNEL, (payload) => {
        let agentSessionId: unknown;
        try {
          agentSessionId = (JSON.parse(payload) as { agentSessionId?: unknown }).agentSessionId;
        } catch {
          return; // payload illeggibile: resta lo sweep
        }
        if (typeof agentSessionId === "string" && agentSessionId !== "") void this.closeSession(agentSessionId);
      });
    } catch (error) {
      this.deps.log(`[refine] LISTEN ${BACKLOG_REFINE_CLOSED_CHANNEL} fallito, resta lo sweep: ${String(error)}`);
    }
  }

  requestTurn(sessionId: string): void {
    if (
      this.stopping ||
      this.closing.has(sessionId) ||
      this.turns.has(sessionId) ||
      this.turns.size >= this.deps.maxConcurrent
    ) {
      return;
    }
    const controller = new AbortController();
    // Registrato SINCRONO, prima di ogni await: una seconda requestTurn lo vede.
    const done = this.runOne(sessionId, controller.signal).then((wake) => {
      this.turns.delete(sessionId);
      // Il messaggio arrivato nella grazia, o un'altra sessione in coda.
      if (wake && !this.stopping) void this.relay?.deliverPending();
    });
    this.turns.set(sessionId, { controller, done });
  }

  /**
   * Un turno. `false` = il turno ha rigettato (DB giù nei passi prima del
   * serializer): l'input resta `pending` e lo riprende la sveglia periodica
   * del relay, non una sveglia immediata che girerebbe a vuoto.
   */
  private async runOne(sessionId: string, signal: AbortSignal): Promise<boolean> {
    try {
      const [oldest] = await this.deps.db
        .select({ id: agentSessionInputs.id })
        .from(agentSessionInputs)
        .where(
          and(
            eq(agentSessionInputs.sessionId, sessionId),
            eq(agentSessionInputs.status, "pending"),
            ne(agentSessionInputs.text, ""),
          ),
        )
        .orderBy(asc(agentSessionInputs.createdAt), asc(agentSessionInputs.id))
        .limit(1);
      if (!oldest || signal.aborted) return true;
      // `skipped` (claim perso, sessione chiusa, budget) non è un errore: il
      // turno stesso ha già sistemato l'input, la sveglia di fine turno basta.
      await this.deps.runTurn({ agentSessionId: sessionId, inputId: oldest.id, signal });
      return true;
    } catch (error) {
      this.deps.log(`[refine] turno della sessione ${sessionId}: ${String(error)}`);
      return false;
    }
  }

  /**
   * Pulisce una sessione chiusa (dal server o dallo sweep). Idempotente.
   * L'ordine conta: segreti del ponte revocati PRIMA (nessuna scrittura dopo
   * la richiesta di chiusura), poi il turno annullato e ATTESO (un turno
   * annullato in attesa del serializer rimette il suo input `pending`), poi
   * gli input `pending` → `undelivered`/`session_not_live`, infine i worktree.
   * I worktree che un turno annullato a metà apertura smonta da sé non sono
   * compito di questo metodo.
   */
  async closeSession(sessionId: string): Promise<void> {
    this.closing.add(sessionId);
    try {
      try {
        this.deps.bridge.revokeSession(sessionId);
      } catch (error) {
        this.deps.log(`[refine] chiusura ${sessionId}: segreti non revocati: ${String(error)}`);
      }
      const turn = this.turns.get(sessionId);
      if (turn) {
        turn.controller.abort();
        await turn.done;
      }
      try {
        const updated = await this.deps.db
          .update(agentSessionInputs)
          .set({ status: "undelivered", reason: "session_not_live", deliveredAt: null })
          .where(and(eq(agentSessionInputs.sessionId, sessionId), eq(agentSessionInputs.status, "pending")))
          .returning({ id: agentSessionInputs.id });
        if (updated.length > 0) await this.notifyEvents(sessionId);
      } catch (error) {
        this.deps.log(`[refine] chiusura ${sessionId}: input non marcati: ${String(error)}`);
      }
      await this.deps.worktrees.remove(sessionId).catch((error: unknown) => {
        this.deps.log(`[refine] chiusura ${sessionId}: worktree non smontati: ${String(error)}`);
      });
    } finally {
      this.closing.delete(sessionId);
    }
  }

  /**
   * (a) Chiude per inattività (`idle`) le sessioni `active` ferme da più di
   * `idleMinutes`, senza input `pending` e senza turno in corso: UPDATE
   * guardato sugli stessi predicati. (b) Riconcilia: una sessione nel
   * registro dei worktree la cui riga non è più `active` (chiusa dal server
   * con la NOTIFY persa) si pulisce comunque.
   */
  async sweepIdle(now: Date = new Date()): Promise<void> {
    if (this.stopping) return;
    const cutoff = new Date(now.getTime() - this.deps.idleMinutes * 60_000);
    const busy = [...this.turns.keys(), ...this.closing];
    try {
      const closed = await this.deps.db
        .update(backlogRefineSessions)
        .set({ status: "closed", closedReason: "idle", closedAt: now })
        .where(
          and(
            eq(backlogRefineSessions.status, "active"),
            lt(backlogRefineSessions.lastActivityAt, cutoff),
            notExists(
              this.deps.db
                .select({ one: sql`1` })
                .from(agentSessionInputs)
                .where(
                  and(
                    eq(agentSessionInputs.sessionId, backlogRefineSessions.agentSessionId),
                    eq(agentSessionInputs.status, "pending"),
                  ),
                ),
            ),
            ...(busy.length > 0 ? [notInArray(backlogRefineSessions.agentSessionId, busy)] : []),
          ),
        )
        .returning({ agentSessionId: backlogRefineSessions.agentSessionId });
      for (const { agentSessionId } of closed) {
        await this.notifyEvents(agentSessionId);
        await this.closeSession(agentSessionId);
      }
      const open = this.deps.worktrees.ids();
      if (open.length > 0) {
        const active = new Set(
          (
            await this.deps.db
              .select({ id: backlogRefineSessions.agentSessionId })
              .from(backlogRefineSessions)
              .where(
                and(
                  inArray(backlogRefineSessions.agentSessionId, open),
                  eq(backlogRefineSessions.status, "active"),
                ),
              )
          ).map((r) => r.id),
        );
        for (const id of open) if (!active.has(id)) await this.closeSession(id);
      }
    } catch (error) {
      this.deps.log(`[refine] sweep fallito: ${String(error)}`);
    }
  }

  /** Niente turni nuovi, annulla e attende quelli in corso, smonta i worktree. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    const running = [...this.turns.values()];
    for (const turn of running) turn.controller.abort();
    await Promise.allSettled(running.map((t) => t.done));
    await this.deps.worktrees.closeAll().catch((error: unknown) => {
      this.deps.log(`[refine] shutdown: worktree non smontati: ${String(error)}`);
    });
  }

  /** Lo stream SSE rilegge il dettaglio a ogni notifica. Best-effort. */
  private async notifyEvents(sessionId: string): Promise<void> {
    await this.deps.db
      .execute(sql`select pg_notify(${AGENT_SESSION_EVENTS_CHANNEL}, ${JSON.stringify({ sessionId })})`)
      .catch(() => undefined);
  }
}
