import { randomUUID } from "node:crypto";
import type { Db } from "@stubwise/db";
import { isConfigurableAiOperation } from "@stubwise/shared";
import { clearProviderLimit, rateLimitAllowsUnlock, writeRateLimitSnapshot } from "../providers/usage-window.js";
import { recordUsage } from "../queue.js";
import { ClaudeCliRunner } from "./claude-cli.js";
import { createModelResolver, type ModelResolver } from "./model-settings.js";
import type { RateLimitInfo } from "./rate-limit-event.js";
import type { AgentRunner, AgentRunOptions, AgentRunResult } from "./runner.js";

export interface TrackingAgentRunnerDeps {
  inner: AgentRunner;
  db: Db;
  models: ModelResolver;
}

/**
 * Decoratore di OGNI runner del worker (design 2026-10-21-modelli-e-consumi):
 * l'unico punto in cui un run sceglie il modello configurato per la sua
 * operazione e lascia traccia dei consumi. Costruito una volta in index.ts
 * attorno al runner reale (streaming o storico), così nessun call site può
 * scavalcarlo.
 *
 * Per ogni `run(opts)`:
 * 1. modello — se l'operazione è configurabile e il tag non ha `modelLocked`,
 *    `opts.model` è sostituito da `ai_model_settings` (con `opts.model` come
 *    ripiego, vedi model-settings.ts). Le operazioni tecniche (smoke, test
 *    credenziali, sonda d'uso) non si toccano mai;
 * 2. `runId` — un uuid per run, restituito nel risultato: raggruppa le righe
 *    per-modello e serve ai writer storici (`record: false`) per scrivere le
 *    proprie;
 * 3. consumi — con `record !== false`, `recordUsage` best-effort (un insert
 *    fallito non fa mai fallire il run).
 *
 * Il PROVIDER non si tocca: lo sceglie `providers/select.ts` prima del run
 * (docs/invariants/providers.md), qui se ne legge solo l'id per la riga.
 *
 * Se `inner.run` LANCIA (timeout, spawn, annullamento) non si registra nulla:
 * senza risultato non c'è `usage` da scrivere, e il consumo parziale di quel
 * run resta fuori dal conteggio. È un limite accettato, non una svista.
 */
export class TrackingAgentRunner implements AgentRunner {
  private readonly inner: AgentRunner;
  private readonly db: Db;
  private readonly models: ModelResolver;

  constructor(deps: TrackingAgentRunnerDeps) {
    this.inner = deps.inner;
    this.db = deps.db;
    this.models = deps.models;
  }

  get recordsSessions(): boolean | undefined {
    return this.inner.recordsSessions;
  }

  /**
   * La `onRateLimit` da passare al runner interno. Per un account concatena
   * quella del chiamante e la scrittura dello snapshot; per api_key o nessun
   * provider lascia quella del chiamante com'è. Non lancia mai e ritorna la
   * promessa del lavoro (lo streaming non l'attende, un test sì).
   */
  private rateLimitHook(opts: AgentRunOptions): Pick<AgentRunOptions, "onRateLimit"> | Record<string, never> {
    const provider = opts.provider;
    if (provider?.kind !== "account") return {};
    const caller = opts.onRateLimit;
    const db = this.db;
    return {
      onRateLimit: async (info: RateLimitInfo, at: Date): Promise<void> => {
        try {
          await caller?.(info, at);
        } catch (err) {
          console.error("[stubwise-worker] usage: onRateLimit del chiamante fallita:", errMessage(err));
        }
        try {
          await writeRateLimitSnapshot(db, provider.id, info, at);
          if (rateLimitAllowsUnlock(info)) await clearProviderLimit(db, provider.id);
        } catch (err) {
          console.error(`[stubwise-worker] usage: snapshot da rate_limit_event non scritto (${provider.id}):`, errMessage(err));
        }
      },
    };
  }

  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    const tag = opts.usage;
    let model = opts.model;
    if (tag.modelLocked !== true && isConfigurableAiOperation(tag.operation)) {
      model = await this.models.resolve(tag.operation, opts.model);
    }
    const runId = randomUUID();
    const result = await this.inner.run({
      ...opts,
      ...(model !== undefined ? { model } : {}),
      ...this.rateLimitHook(opts),
    });
    if (tag.record !== false) {
      await recordUsage(this.db, {
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        tag,
        runId,
        providerId: opts.provider?.id ?? null,
      });
    }
    return { ...result, runId };
  }
}

/**
 * Il `ClaudeCliRunner` storico già avvolto, per i task che girano FUORI dal
 * runner condiviso di index.ts e ne costruivano uno proprio (sonda d'uso,
 * test delle credenziali, smoke dei plugin, `nightly/once.ts`): senza
 * l'involucro i loro consumi non arriverebbero in `agent_runs`. Resta il
 * runner STORICO, non quello in streaming, come prima: cambia solo che il
 * run lascia traccia (e, per le operazioni configurabili, legge il modello).
 */
export function trackedClaudeCliRunner(db: Db): TrackingAgentRunner {
  return new TrackingAgentRunner({ inner: new ClaudeCliRunner(), db, models: createModelResolver(db, console) });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
