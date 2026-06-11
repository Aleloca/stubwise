import { execa } from "execa";
import {
  AgentRunError,
  AgentTimeoutError,
  type AgentModelUsage,
  type AgentRunner,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentRunUsage,
} from "./runner.js";

/**
 * Implementazione reale di AgentRunner: shella sul CLI `claude` in modalità
 * headless. Invocazione:
 *
 *   claude -p --output-format json --permission-mode acceptEdits \
 *          --max-turns <N> [--model <M>]
 *
 * Con `--output-format json` il CLI emette su stdout UN SINGOLO oggetto JSON:
 * `result` (la risposta testuale finale dell'agente, che sostituisce ciò che
 * prima era l'output testuale), `total_cost_usd`, `usage` e `modelUsage` (il
 * dettaglio per modello, usato per lo split dei consumi). I file scritti dai
 * tool (es. STUBWISE_REPORT.md) NON sono toccati dal formato di output.
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
 *   Passano solo PATH/HOME/USER, le var di auth claude (prefissi ANTHROPIC_
 *   e CLAUDE_) e
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
  // USER/LOGNAME: NON segreti, ma necessari per l'auth OAuth/MAX su macOS.
  // Lì le credenziali del login OAuth del CLI claude vivono nel Keychain del
  // login, indicizzate per $USER: senza USER il lookup del Keychain fallisce e
  // headless claude risponde "Not logged in" anche con HOME corretto. Su Linux
  // (container, Task 27) l'OAuth legge ~/.claude/.credentials.json sotto HOME/
  // CLAUDE_CONFIG_DIR e non serve il Keychain, ma inoltrarli è innocuo.
  "USER",
  "LOGNAME",
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
    // Scarta le stringhe vuote: una var allowlistata ma vuota (es.
    // ANTHROPIC_API_KEY="" quando l'utente usa l'OAuth login) NON va inoltrata,
    // perche' ANTHROPIC_API_KEY="" che raggiunge il child claude puo' sabotare
    // un login OAuth valido. compose la omette gia' (niente default `:-`), ma
    // qui difendiamo comunque a valle.
    if (value !== undefined && value !== "" && allow(name)) env[name] = value;
  }
  // extraEnv è esplicito ma resta soggetto alla denylist.
  for (const [name, value] of Object.entries(extraEnv ?? {})) {
    if (!ENV_DENYLIST.has(name)) env[name] = value;
  }
  return env;
}

/**
 * Estrae un numero da un oggetto provando più nomi di chiave (i nomi dei
 * campi del CLI variano tra versioni: snake_case e camelCase). Restituisce
 * undefined se nessuna chiave è un numero finito.
 */
function pickNumber(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Costruisce AgentRunUsage dal JSON del CLI in modo DIFENSIVO: i nomi dei
 * campi possono variare per versione, quindi si prova sia snake_case che
 * camelCase e i campi mancanti diventano 0 (token) o undefined (costo). Se
 * non c'è alcun dato di consumo utile restituisce undefined — il run resta
 * valido, manca solo il dato. Non lancia mai.
 */
export function extractUsage(parsed: Record<string, unknown>): AgentRunUsage | undefined {
  const totalCostUsd = pickNumber(parsed, "total_cost_usd", "totalCostUsd");

  const modelUsage = asRecord(parsed["modelUsage"] ?? parsed["model_usage"]);
  const models: AgentModelUsage[] = [];
  if (modelUsage) {
    for (const [model, raw] of Object.entries(modelUsage)) {
      const entry = asRecord(raw);
      if (!entry) continue;
      models.push({
        model,
        inputTokens: pickNumber(entry, "inputTokens", "input_tokens") ?? 0,
        outputTokens: pickNumber(entry, "outputTokens", "output_tokens") ?? 0,
        cacheReadTokens:
          pickNumber(entry, "cacheReadInputTokens", "cache_read_input_tokens") ?? 0,
        ...((): { costUsd?: number } => {
          const costUsd = pickNumber(entry, "costUSD", "cost_usd", "costUsd");
          return costUsd !== undefined ? { costUsd } : {};
        })(),
      });
    }
  }

  if (models.length === 0 && totalCostUsd === undefined) return undefined;
  return { ...(totalCostUsd !== undefined ? { totalCostUsd } : {}), models };
}

/**
 * Interpreta lo stdout del CLI in modalità `--output-format json`. Difensivo:
 * se non è JSON valido restituisce `output` = stdout grezzo e usage undefined;
 * se `result` manca, `output` ricade sullo stdout grezzo ma usage viene
 * comunque estratto se presente. Non lancia mai.
 */
export function parseCliJson(stdout: string): { output: string; usage?: AgentRunUsage } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { output: stdout };
  }
  const record = asRecord(parsed);
  if (!record) return { output: stdout };
  const result = record["result"];
  const output = typeof result === "string" ? result : stdout;
  const usage = extractUsage(record);
  return usage !== undefined ? { output, usage } : { output };
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
      "json",
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
      const { all, stdout, exitCode } = await execa(this.claudePath, args, {
        cwd: opts.cwd,
        input: opts.prompt,
        timeout: opts.timeoutMs,
        // Al timeout: SIGTERM, poi SIGKILL dopo 5s se il processo non muore.
        forceKillAfterDelay: 5000,
        // extendEnv:false + env allowlist: il child NON eredita l'intero
        // process.env (niente segreti del master). Vedi docblock del modulo.
        extendEnv: false,
        env: buildAgentEnv(process.env, this.extraEnv),
        // stdout+stderr interleaved in `all`: usato come fallback grezzo (per
        // i timeout e gli exit non-zero). Il JSON dei consumi però va parsato
        // dal solo stdout: `all` mescola gli eventuali warning su stderr e ne
        // romperebbe il parse.
        all: true,
      });
      // Exit 0: stdout è (atteso) il JSON del CLI. parseCliJson è difensivo —
      // se il parse fallisce o `result` manca ricade sullo stdout grezzo,
      // usage resta undefined. Se stdout è vuoto si usa `all` come fallback.
      const cliStdout = stdout ?? "";
      const parsed = parseCliJson(cliStdout);
      const output = cliStdout === "" ? (all ?? "") : parsed.output;
      return {
        output,
        exitCode: exitCode ?? 0,
        ...(parsed.usage !== undefined ? { usage: parsed.usage } : {}),
      };
    } catch (error) {
      const e = error as {
        timedOut?: boolean;
        all?: string;
        stdout?: string;
        exitCode?: number;
        shortMessage?: string;
      };
      if (e.timedOut === true) {
        // Timeout: output parziale grezzo, nessun usage (il JSON è incompleto).
        throw new AgentTimeoutError(opts.timeoutMs, e.all ?? "");
      }
      if (typeof e.exitCode === "number") {
        // Exit non-zero: risultato, non eccezione. Si prova comunque a
        // estrarre usage se lo stdout è JSON, altrimenti si omette.
        const parsed = parseCliJson(e.stdout ?? "");
        return {
          output: e.all ?? "",
          exitCode: e.exitCode,
          ...(parsed.usage !== undefined ? { usage: parsed.usage } : {}),
        };
      }
      // Spawn fallito (binario mancante, permessi) o kill da segnale esterno.
      throw new AgentRunError(
        `Impossibile eseguire ${this.claudePath}: ${e.shortMessage ?? String(error)}`,
      );
    }
  }
}
