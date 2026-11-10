import { and, asc, eq, exists, inArray, isNotNull, lt, ne, or, notExists, sql } from "drizzle-orm";
import { agentSessionInputs, claudeConversations, purgeChatToolTokens, type Db } from "@stubwise/db";
import { AGENT_SESSION_EVENTS_CHANNEL, CLAUDE_CONVERSATION_CLOSED_CHANNEL } from "@stubwise/shared";
import { AGENT_SESSION_RETENTION_DAYS } from "../sessions/store.js";
import {
  chatSessionIdsInCliProjects,
  removeChatCliState,
  removeLegacyChatCliDirs,
  type ChatCliPaths,
} from "./cli-dir.js";
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
  /** Radici di cwd e trascrizioni del CLI (test). */
  cliPaths?: ChatCliPaths;
  /** Dopo quanto riprovare quando un turno ha rigettato (DB giù). Default 5 s. */
  retryMs?: number;
}

interface Waker {
  deliverPending(sessionId?: string): Promise<void>;
}

export class ChatScheduler implements TurnStarter {
  private readonly turns = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly closing = new Set<string>();
  /** Sessioni arrivate a tetto pieno: partono, nell'ordine, appena si libera un posto. */
  private readonly waiting = new Set<string>();
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
    if (this.stopping || this.closing.has(sessionId) || this.turns.has(sessionId)) return;
    if (this.turns.size >= this.deps.maxConcurrent) {
      // Tetto pieno: non si scarta. Il messaggio resta `pending` e la
      // sessione aspetta il primo posto libero (e il poll del relay comunque).
      if (!this.waiting.has(sessionId)) {
        this.waiting.add(sessionId);
        this.deps.log(`[chat] tetto di ${this.deps.maxConcurrent} turni pieno: la sessione ${sessionId} aspetta un posto`);
      }
      return;
    }
    this.waiting.delete(sessionId);
    const controller = new AbortController();
    const done = this.runOne(sessionId, controller.signal).then((ok) => {
      this.turns.delete(sessionId);
      if (this.stopping) return;
      // Un posto libero: prima chi aspettava.
      const next = [...this.waiting].find((id) => !this.turns.has(id));
      if (next) this.requestTurn(next);
      if (ok) void this.relay?.deliverPending();
      else {
        // Il turno ha rigettato (DB giù): il relay si risveglia fra poco, non subito.
        const timer = setTimeout(() => void this.relay?.deliverPending(), this.deps.retryMs ?? 5_000);
        timer.unref?.();
      }
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
      // Eliminata: con lei vanno la cwd e le trascrizioni del CLI. Archiviata no
      // (si può ripristinare, e il `--resume` le ritrova).
      try {
        const [row] = await this.deps.db
          .select({ id: claudeConversations.sessionId })
          .from(claudeConversations)
          .where(eq(claudeConversations.sessionId, sessionId));
        if (!row) await removeChatCliState(sessionId, this.deps.cliPaths);
      } catch (error) {
        this.deps.log(`[chat] chiusura ${sessionId}: trascrizioni del CLI non rimosse: ${String(error)}`);
      }
    } finally {
      this.waiting.delete(sessionId);
      this.closing.delete(sessionId);
    }
  }

  /**
   * Igiene periodica, e la potatura delle trascrizioni del CLI (le sessioni si
   * potano a 14 giorni, `pruneAgentSessions`; le trascrizioni stanno sul
   * volume del CLI e vanno via qui):
   * - i token dei turni scaduti o revocati;
   * - le trascrizioni di conversazioni che non esistono più (eliminate,
   *   potate, o la cui NOTIFY si è persa);
   * - la sessione del CLI nata da più di 14 giorni: si scarta (il turno dopo
   *   riparte col prompt d'avvio e i messaggi rimasti), così il CLI non
   *   ricorda ciò che il server ha già potato.
   * Mai su una conversazione con un turno in corso.
   */
  async sweep(now: Date = new Date()): Promise<void> {
    if (this.stopping) return;
    await purgeChatToolTokens(this.deps.db).catch((error: unknown) => {
      this.deps.log(`[chat] pulizia dei token dei turni fallita: ${String(error)}`);
    });
    const busy = new Set([...this.turns.keys(), ...this.closing]);
    try {
      await removeLegacyChatCliDirs(this.deps.cliPaths);
      const withTranscripts = (await chatSessionIdsInCliProjects(this.deps.cliPaths)).filter((id) => !busy.has(id));
      if (withTranscripts.length > 0) {
        const alive = new Set(
          (
            await this.deps.db
              .select({ id: claudeConversations.sessionId })
              .from(claudeConversations)
              .where(inArray(claudeConversations.sessionId, withTranscripts))
          ).map((r) => r.id),
        );
        for (const id of withTranscripts) if (!alive.has(id)) await removeChatCliState(id, this.deps.cliPaths);
      }
      const cutoff = new Date(now.getTime() - AGENT_SESSION_RETENTION_DAYS * 86_400_000);
      const stale = await this.deps.db
        .select({ id: claudeConversations.sessionId })
        .from(claudeConversations)
        .where(lt(claudeConversations.cliSessionStartedAt, cutoff));
      for (const { id } of stale) {
        if (busy.has(id)) continue;
        await this.deps.db
          .update(claudeConversations)
          .set({ cliSessionId: null, cliSessionStartedAt: null })
          .where(and(eq(claudeConversations.sessionId, id), lt(claudeConversations.cliSessionStartedAt, cutoff)));
        await removeChatCliState(id, this.deps.cliPaths);
      }
    } catch (error) {
      this.deps.log(`[chat] potatura delle trascrizioni del CLI fallita: ${String(error)}`);
    }
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
