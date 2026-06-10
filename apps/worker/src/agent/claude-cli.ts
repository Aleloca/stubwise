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
 * - L'env del child è una ALLOWLIST esplicita, NON l'intero process.env
 *   (extendEnv:false). Il prompt è contenuto non fidato del ticket e gli
 *   allowedTools permettono di eseguire comandi (i test): un ticket ostile
 *   che ottiene injection potrebbe esfiltrare segreti del master via un
 *   comando. Per questo l'agente NON vede MAI ENCRYPTION_KEY (decifra le
 *   credenziali git di TUTTI i progetti), DATABASE_URL o SESSION_SECRET.
 *   Passano solo PATH/HOME, le var di auth claude (prefissi ANTHROPIC_ e
 *   CLAUDE_) e
 *   ciò che extraEnv aggiunge esplicitamente — l'allowlist ha però l'ultima
 *   parola, così extraEnv non può reintrodurre un segreto bloccato.
 * - Exit code NON-ZERO = risultato valido, restituito con stdout+stderr
 *   combinati: è la pipeline a decidere cosa significa.
 * - Timeout: il processo viene ucciso e lanciamo AgentTimeoutError con
 *   l'output parziale — la pipeline tratta il timeout in modo distinto
 *   (job fallito allegando il log), per questo NON è un exit code fittizio.
 */

export interface ClaudeCliRunnerOptions {
  /** Path (o nome in PATH) del binario claude. Default: "claude". */
  claudePath?: string;
  /** Variabili extra esplicite per il child (filtrate dall'allowlist negata). */
  extraEnv?: Record<string, string>;
}

/**
 * Nomi ESATTI di process.env che possono raggiungere il child: il minimo per
 * eseguire e autenticare il CLI. Tutto il resto (compresi i segreti del
 * master) viene scartato. Le var di auth claude usano un prefisso (sotto).
 */
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  // Config home del CLI claude (es. ~/.claude o override).
  "CLAUDE_CONFIG_DIR",
  "XDG_CONFIG_HOME",
] as const;

/**
 * Prefissi di var di auth/config del CLI claude da inoltrare per intero
 * (ANTHROPIC_API_KEY, CLAUDE_CODE_*, ecc.): non conosciamo a priori ogni
 * nome, ma il namespace è del provider e non contiene segreti di Stubwise.
 */
const ENV_ALLOWLIST_PREFIXES = ["ANTHROPIC_", "CLAUDE_"] as const;

/**
 * Var che NON devono MAI raggiungere il child, nemmeno via extraEnv: sono i
 * segreti del master. Difesa in profondità sopra l'allowlist (l'allowlist da
 * sola già le escluderebbe da process.env, ma questa lista blocca anche un
 * extraEnv che le contenesse per errore).
 */
const ENV_DENYLIST = new Set(["ENCRYPTION_KEY", "DATABASE_URL", "SESSION_SECRET"]);

/**
 * Costruisce l'env del child a partire da un'allowlist di process.env più gli
 * extraEnv espliciti. La denylist ha la precedenza assoluta: un segreto del
 * master non passa per nessuna via.
 */
export function buildAgentEnv(
  parentEnv: NodeJS.ProcessEnv,
  extraEnv?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  const allow = (name: string): boolean =>
    !ENV_DENYLIST.has(name) &&
    ((ENV_ALLOWLIST as readonly string[]).includes(name) ||
      ENV_ALLOWLIST_PREFIXES.some((prefix) => name.startsWith(prefix)));

  for (const [name, value] of Object.entries(parentEnv)) {
    if (value !== undefined && allow(name)) env[name] = value;
  }
  // extraEnv è esplicito ma resta soggetto alla denylist.
  for (const [name, value] of Object.entries(extraEnv ?? {})) {
    if (!ENV_DENYLIST.has(name)) env[name] = value;
  }
  return env;
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
    if (opts.allowedTools !== undefined && opts.allowedTools.length > 0) {
      // Sintassi CLI: `--allowedTools <tools...>` accetta più valori dopo il
      // flag (space-separated), es. --allowedTools "Bash(npm test:*)" "Read".
      args.push("--allowedTools", ...opts.allowedTools);
    }

    try {
      const { all, exitCode } = await execa(this.claudePath, args, {
        cwd: opts.cwd,
        input: opts.prompt,
        timeout: opts.timeoutMs,
        // Al timeout: SIGTERM, poi SIGKILL dopo 5s se il processo non muore.
        forceKillAfterDelay: 5000,
        // extendEnv:false + env allowlist: il child NON eredita l'intero
        // process.env (niente segreti del master). Vedi docblock del modulo.
        extendEnv: false,
        env: buildAgentEnv(process.env, this.extraEnv),
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
