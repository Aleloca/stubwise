import { execa } from "execa";
import {
  AgentRunError,
  AgentTimeoutError,
  type AgentRunner,
  type AgentRunOptions,
  type AgentRunResult,
} from "./runner.js";

/**
 * Implementazione reale di AgentRunner: shella sul CLI `claude` in modalità
 * headless. Invocazione:
 *
 *   claude -p --output-format text --permission-mode acceptEdits \
 *          --max-turns <N> [--model <M>]
 *
 * Scelte deliberate:
 * - Il PROMPT viaggia su STDIN, mai in argv: contiene contenuto non fidato
 *   del ticket e può essere enorme. Lo stdin evita i limiti di lunghezza di
 *   argv e il leak via `ps` (gli argomenti di un processo sono leggibili da
 *   chiunque per tutta la sua durata — stesso razionale di mirrors.ts per
 *   le credenziali git).
 * - L'env del worker viene inoltrato così com'è (+ extraEnv): il CLI claude
 *   si autentica da sé tramite l'ambiente/volume del worker (config in
 *   ~/.claude o variabili dedicate). Non impostiamo variabili CI-specifiche.
 * - Exit code NON-ZERO = risultato valido, restituito con stdout+stderr
 *   combinati: è la pipeline a decidere cosa significa.
 * - Timeout: il processo viene ucciso e lanciamo AgentTimeoutError con
 *   l'output parziale — la pipeline tratta il timeout in modo distinto
 *   (job fallito allegando il log), per questo NON è un exit code fittizio.
 */

export interface ClaudeCliRunnerOptions {
  /** Path (o nome in PATH) del binario claude. Default: "claude". */
  claudePath?: string;
  /** Variabili aggiuntive, unite all'env del processo worker. */
  extraEnv?: Record<string, string>;
}

export class ClaudeCliRunner implements AgentRunner {
  private readonly claudePath: string;
  private readonly extraEnv: Record<string, string> | undefined;

  constructor(options: ClaudeCliRunnerOptions = {}) {
    this.claudePath = options.claudePath ?? "claude";
    this.extraEnv = options.extraEnv;
  }

  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    // Validazione PRIMA dello spawn: un valore assurdo qui è un bug del
    // chiamante, non un esito dell'agente.
    if (!Number.isInteger(opts.maxTurns) || opts.maxTurns <= 0) {
      throw new AgentRunError(`maxTurns non valido: ${opts.maxTurns} (atteso intero > 0)`);
    }
    if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
      throw new AgentRunError(`timeoutMs non valido: ${opts.timeoutMs} (atteso > 0)`);
    }

    const args = [
      "-p",
      "--output-format",
      "text",
      "--permission-mode",
      "acceptEdits",
      "--max-turns",
      String(opts.maxTurns),
    ];
    if (opts.model !== undefined) {
      args.push("--model", opts.model);
    }

    try {
      const { all, exitCode } = await execa(this.claudePath, args, {
        cwd: opts.cwd,
        input: opts.prompt,
        timeout: opts.timeoutMs,
        // extendEnv è true di default: extraEnv si AGGIUNGE all'env del worker.
        env: this.extraEnv,
        // stdout+stderr interleaved in `all`: il report dell'agente e gli
        // eventuali errori del CLI finiscono nello stesso log del job.
        all: true,
      });
      return { output: all ?? "", exitCode: exitCode ?? 0 };
    } catch (error) {
      const e = error as {
        timedOut?: boolean;
        all?: string;
        exitCode?: number;
        shortMessage?: string;
      };
      if (e.timedOut === true) {
        throw new AgentTimeoutError(opts.timeoutMs, e.all ?? "");
      }
      if (typeof e.exitCode === "number") {
        // Exit non-zero: risultato, non eccezione.
        return { output: e.all ?? "", exitCode: e.exitCode };
      }
      // Spawn fallito (binario mancante, permessi) o kill da segnale esterno.
      throw new AgentRunError(
        `Impossibile eseguire ${this.claudePath}: ${e.shortMessage ?? String(error)}`,
      );
    }
  }
}
