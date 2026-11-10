import { and, asc, eq, exists, isNotNull, ne, or, notExists, sql } from "drizzle-orm";
import { agentSessionInputs, claudeConversations, purgeChatToolTokens, type Db } from "@stubwise/db";
import { AGENT_SESSION_EVENTS_CHANNEL, CLAUDE_CONVERSATION_CLOSED_CHANNEL } from "@stubwise/shared";
import type { TurnStarter } from "../sessions/relay.js";
import type { ChatBridge } from "./bridge.js";
import type { ChatTurnOutcome } from "./turn.js";

/**
 * Scheduler dei turni delle conversazioni libere con Claude (chat, fetta 1),
 * sul modello di quello del refinement (`backlog/refine/scheduler.ts`): in
 * memoria (il worker è UN processo), al più UN turno per conversazione, un
 * tetto d'istanza, a fine turno risveglia il relay (il messaggio arrivato
 * nella grazia diventa il turno dopo). Più semplice: niente worktree e niente
 * chiusura per inattività — una conversazione resta aperta finché l'autore
 * non la archivia o la elimina. Il server lo dice su
 * `CLAUDE_CONVERSATION_CLOSED_CHANNEL`: si revoca il ponte, si annulla il
 * turno, gli input ancora in coda di una conversazione archiviata diventano
 * `session_not_live` (una eliminata se li è portati via col CASCADE).
 */
export interface ChatSchedulerDeps {
  db: Db;
  maxConcurrent: number;
  bridge: Pick<ChatBridge, "revokeSession">;
  runTurn: (input: { sessionId: string; inputId: string; signal: AbortSignal }) => Promise<ChatTurnOutcome>;
  listen?: (channel: string, cb: (payload: string) => void) => Promise<unknown>;
  log: (m: string) => void;
}

interface Waker {
  deliverPending(sessionId?: string): Promise<void>;
}

export class ChatScheduler implements TurnStarter {
  private readonly turns = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly closing = new Set<string>();
  private relay: Waker | undefined;
  private stopping = false;

  constructor(private readonly deps: ChatSchedulerDeps) {}

  attachRelay(relay: Waker): void {
    this.relay = relay;
  }

  /** LISTEN di archiviazioni ed eliminazioni. Fail-open: senza, il turno si ferma al token rifiutato. */
  async start(): Promise<void> {
    if (!this.deps.listen) return;
    try {
      await this.deps.listen(CLAUDE_CONVERSATION_CLOSED_CHANNEL, (payload) => {
        let sessionId: unknown;
        try {
          sessionId = (JSON.parse(payload) as { sessionId?: unknown }).sessionId;
        } catch {
          return;
        }
        if (typeof sessionId === "string" && sessionId !== "") void this.closeSession(sessionId);
      });
    } catch (error) {
      this.deps.log(`[chat] LISTEN ${CLAUDE_CONVERSATION_CLOSED_CHANNEL} fallito: ${String(error)}`);
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
    const done = this.runOne(sessionId, controller.signal).then((wake) => {
      this.turns.delete(sessionId);
      if (wake && !this.stopping) void this.relay?.deliverPending();
    });
    this.turns.set(sessionId, { controller, done });
  }

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
      await this.deps.runTurn({ sessionId, inputId: oldest.id, signal });
      return true;
    } catch (error) {
      this.deps.log(`[chat] turno della sessione ${sessionId}: ${String(error)}`);
      return false;
    }
  }

  /**
   * Archiviata o eliminata. Idempotente. Prima il ponte (nessuna lettura dopo
   * la richiesta), poi il turno annullato e atteso, poi gli input in coda —
   * solo se la conversazione è ancora archiviata (riaperta nel frattempo: il
   * messaggio nuovo non diventa mai `undelivered` per tempismo).
   */
  async closeSession(sessionId: string): Promise<void> {
    this.closing.add(sessionId);
    try {
      try {
        this.deps.bridge.revokeSession(sessionId);
      } catch (error) {
        this.deps.log(`[chat] chiusura ${sessionId}: segreti non revocati: ${String(error)}`);
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
          .where(
            and(
              eq(agentSessionInputs.sessionId, sessionId),
              eq(agentSessionInputs.status, "pending"),
              or(
                exists(
                  this.deps.db
                    .select({ one: sql`1` })
                    .from(claudeConversations)
                    .where(
                      and(eq(claudeConversations.sessionId, sessionId), isNotNull(claudeConversations.archivedAt)),
                    ),
                ),
                notExists(
                  this.deps.db
                    .select({ one: sql`1` })
                    .from(claudeConversations)
                    .where(eq(claudeConversations.sessionId, sessionId)),
                ),
              ),
            ),
          )
          .returning({ id: agentSessionInputs.id });
        if (updated.length > 0) {
          await this.deps.db
            .execute(sql`select pg_notify(${AGENT_SESSION_EVENTS_CHANNEL}, ${JSON.stringify({ sessionId })})`)
            .catch(() => undefined);
        }
      } catch (error) {
        this.deps.log(`[chat] chiusura ${sessionId}: input non marcati: ${String(error)}`);
      }
    } finally {
      this.closing.delete(sessionId);
    }
  }

  /** Igiene periodica: via i token dei turni scaduti o revocati. */
  async sweep(): Promise<void> {
    if (this.stopping) return;
    await purgeChatToolTokens(this.deps.db).catch((error: unknown) => {
      this.deps.log(`[chat] pulizia dei token dei turni fallita: ${String(error)}`);
    });
  }

  stopAcceptingTurns(): void {
    this.stopping = true;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    const running = [...this.turns.values()];
    for (const turn of running) turn.controller.abort();
    await Promise.allSettled(running.map((t) => t.done));
  }
}
