import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import type { ResolvedProvider } from "../providers/chain.js";
import {
  AgentRunError,
  AgentTimeoutError,
  type AgentMcpConfig,
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
 * - Server MCP locali al run (`opts.mcpConfig`): serializzati in un file di
 *   configurazione EFFIMERO, passato con `--mcp-config <path>` +
 *   `--strict-mcp-config` e cancellato in un `finally`. Il file sta in una
 *   mkdtemp di sistema, NON nella cwd del run: la cwd è il worktree del repo
 *   target, dove un file estraneo rischierebbe di finire in un `git add` (lo
 *   stesso motivo per cui i `.env` per progetto sono esclusi da tutti i
 *   git add/status). Il CLI accetterebbe anche il JSON inline in argv, ma argv
 *   è leggibile da chiunque via `ps` per tutta la durata del processo e la
 *   config porta le env dei server MCP: stesso razionale del prompt su stdin.
 *   Quelle env NON passano dall'allowlist dell'env del CLI (che resta
 *   invariata): stanno nel file, e il CLI le applica al server che lancia —
 *   sopra l'env che il server eredita dal CLI stesso (già filtrato).
 * - Plugin del run (`opts.pluginDirs`) + `--setting-sources`: i plugin passano
 *   da `--plugin-dir`, ripetuto e session-scoped, mentre `--setting-sources ""`
 *   spegne le sorgenti di settings (plugin dell'utente, `.claude/skills` e
 *   `.mcp.json` della cwd). Le due cose vanno insieme: il senso è che
 *   l'insieme di skill e hook caricati sia DETERMINISTICO — plugin base +
 *   registro del progetto e nient'altro — invece di dipendere da cosa c'è
 *   sull'host o nel repo target. Senza queste opzioni l'argv è quello storico.
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

/** Var di auth del CLI claude per chiave API a consumo. */
const ANTHROPIC_API_KEY = "ANTHROPIC_API_KEY";
/** Var di auth del CLI claude per login a un account/abbonamento (Claude Max). */
const CLAUDE_CODE_OAUTH_TOKEN = "CLAUDE_CODE_OAUTH_TOKEN";

/**
 * Costruisce l'env del child a partire da un'allowlist di process.env più gli
 * extraEnv espliciti. La denylist ha la precedenza assoluta: un segreto del
 * master non passa per nessuna via.
 *
 * Iniezione della credenziale (`provider`): quando il worker ha selezionato una
 * credenziale dalla catena (vedi providers/chain.ts), la si inietta secondo il
 * `kind`, ESCLUDENDO la var di auth concorrente — anche se ereditata dal
 * container. È un requisito CRITICO: il CLI claude dà la PRECEDENZA a
 * ANTHROPIC_API_KEY sull'OAuth, quindi una API key ereditata dal container
 * sabota un account (kind "account"); per simmetria, su una API key da catena
 * (kind "api_key") togliamo un eventuale CLAUDE_CODE_OAUTH_TOKEN ereditato per
 * non avere due auth concorrenti. Senza `provider` il comportamento è invariato
 * (auth dall'env del container o dall'OAuth del volume).
 */
export function buildAgentEnv(
  parentEnv: NodeJS.ProcessEnv,
  extraEnv?: Record<string, string>,
  provider?: ResolvedProvider,
): Record<string, string> {
  // Var di auth da ESCLUDERE dall'ereditarietà del container in base al kind
  // della credenziale iniettata: quella concorrente va rimossa o vincerebbe
  // (API key > OAuth nel CLI claude). Senza provider non si esclude nulla.
  const excluded = new Set<string>();
  if (provider?.kind === "api_key") excluded.add(CLAUDE_CODE_OAUTH_TOKEN);
  else if (provider?.kind === "account") excluded.add(ANTHROPIC_API_KEY);

  const env: Record<string, string> = {};
  const allow = (name: string): boolean =>
    !ENV_DENYLIST.has(name) &&
    !excluded.has(name) &&
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
  // Credenziale dalla catena: iniettata per ULTIMA così vince su qualunque
  // valore ereditato dal container/extraEnv per la stessa var. La var
  // concorrente è già stata esclusa sopra (excluded), quindi non resta auth
  // doppia.
  if (provider) {
    if (provider.kind === "api_key") env[ANTHROPIC_API_KEY] = provider.secret;
    else env[CLAUDE_CODE_OAUTH_TOKEN] = provider.secret;
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

/**
 * Estrae una stringa non vuota da un oggetto provando più nomi di chiave
 * (snake_case e camelCase, come pickNumber). Undefined se nessuna chiave è una
 * stringa non vuota.
 */
function pickString(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
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
 * se non è JSON valido restituisce `output` = stdout grezzo e usage/sessionId
 * undefined; se `result` manca, `output` ricade sullo stdout grezzo ma usage e
 * sessionId vengono comunque estratti se presenti. Il `session_id` (anche
 * `sessionId` per robustezza tra versioni) serve al `--resume` della sessione di
 * analisi sul codice. Non lancia mai.
 */
export function parseCliJson(
  stdout: string,
): { output: string; usage?: AgentRunUsage; sessionId?: string } {
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
  const sessionId = pickString(record, "session_id", "sessionId");
  return {
    output,
    ...(usage !== undefined ? { usage } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

/**
 * Scrive il file di configurazione MCP del run dentro `dir` (una mkdtemp già
 * creata dal chiamante, che ne resta proprietario: così un fallimento QUI non
 * lascia la directory orfana). Restituisce il path da passare a `--mcp-config`.
 *
 * La forma del file è quella attesa dal CLI: `{ "mcpServers": { <nome>: {...} } }`
 * — verificato con `claude --mcp-config`, che rifiuta ogni altra forma con
 * "Invalid MCP configuration: mcpServers: Invalid input".
 */
async function writeMcpConfigFile(dir: string, config: AgentMcpConfig): Promise<string> {
  const path = join(dir, "mcp-config.json");
  await writeFile(path, JSON.stringify({ mcpServers: config.servers }), "utf8");
  return path;
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

    // Permission mode: default "acceptEdits" (comportamento storico del fix).
    // Il run di pianificazione passa "plan" (sola analisi, nessuna modifica).
    const permissionMode = opts.permissionMode ?? "acceptEdits";
    const args = [
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      permissionMode,
      "--max-turns",
      String(opts.maxTurns),
    ];
    // Ripresa di una sessione CLI esistente (sessione di analisi sul codice del
    // backlog): il modello ricarica il contesto e il prompt è solo il nuovo
    // turno. Lo id è generato dal CLI stesso (mai contenuto del ticket).
    if (opts.resumeSessionId !== undefined) {
      args.push("--resume", opts.resumeSessionId);
    }
    if (opts.model !== undefined) {
      args.push("--model", opts.model);
    }
    if (opts.allowedTools !== undefined && opts.allowedTools.length > 0) {
      // Sintassi CLI: `--allowedTools <tools...>` accetta più valori dopo il
      // flag (space-separated), es. --allowedTools "Bash(npm test:*)" "Read".
      args.push("--allowedTools", ...opts.allowedTools);
    }
    if (opts.disallowedTools !== undefined && opts.disallowedTools.length > 0) {
      // Stessa sintassi variadica di --allowedTools. Nei run con i plugin porta
      // le deny rule `Skill(<plugin>:<skill>)`: sono l'unico blocco effettivo
      // dell'esecuzione di una skill di plugin (vedi AgentRunOptions).
      args.push("--disallowedTools", ...opts.disallowedTools);
    }
    // Plugin del run: un --plugin-dir per directory, nell'ordine ricevuto (il
    // chiamante mette per primo il plugin base). Stessa guardia degli altri
    // flag a lista: assente o vuota → argv invariato.
    if (opts.pluginDirs !== undefined && opts.pluginDirs.length > 0) {
      for (const dir of opts.pluginDirs) {
        args.push("--plugin-dir", dir);
      }
    }
    // Sorgenti di settings: l'unico valore è la stringa vuota, e va passata
    // come ARGOMENTO A SÉ (`--setting-sources` seguito da ""), che è il modo
    // in cui il CLI accetta "nessuna sorgente". Omesso → nessun flag, così i
    // run che non usano i plugin restano identici a prima.
    if (opts.settingSources !== undefined) {
      args.push("--setting-sources", opts.settingSources);
    }
    // Server MCP locali a QUESTO run: file di config effimero fuori dalla cwd,
    // rimosso nel finally sotto qualunque esito (successo, exit non-zero,
    // timeout, spawn fallito). Config assente o senza server → argv invariato.
    let mcpConfigDir: string | undefined;
    if (opts.mcpConfig !== undefined && Object.keys(opts.mcpConfig.servers).length > 0) {
      try {
        // mkdtemp PRIMA e assegnata SUBITO: se la scrittura del file fallisce
        // (ENOSPC, tmp read-only, config non serializzabile) la directory è già
        // tracciata e il catch qui sotto la rimuove, senza lasciarla orfana.
        mcpConfigDir = await mkdtemp(join(tmpdir(), "stubwise-mcp-"));
        const configPath = await writeMcpConfigFile(mcpConfigDir, opts.mcpConfig);
        // --strict-mcp-config: usa SOLO i server di --mcp-config, ignorando ogni
        // altra configurazione MCP (utente, progetto, immagine). Isolamento e
        // riproducibilità: un run del worker non deve vedere server non suoi.
        args.push("--mcp-config", configPath, "--strict-mcp-config");
      } catch (error) {
        if (mcpConfigDir !== undefined) {
          await rm(mcpConfigDir, { recursive: true, force: true }).catch(() => undefined);
        }
        // L'agente non è mai partito: è la stessa categoria dei parametri non
        // validi e dello spawn fallito. Senza questa traduzione nel log del job
        // comparirebbe un errore fs nudo, senza dire cosa stava facendo il
        // worker. `cause` conserva l'errore originale per la diagnostica.
        throw new AgentRunError(
          `Impossibile scrivere la configurazione MCP del run: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }

    try {
      return await this.spawn(opts, args);
    } finally {
      if (mcpConfigDir !== undefined) {
        // Best-effort: un residuo in tmp non deve mai far fallire un run.
        await rm(mcpConfigDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  /**
   * Spawn del CLI e interpretazione dell'esito. Separato da run() perché
   * quest'ultimo deve poter garantire il cleanup del file di config MCP in un
   * `finally` senza annidare due try nello stesso corpo.
   */
  private async spawn(opts: AgentRunOptions, args: string[]): Promise<AgentRunResult> {
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
        env: buildAgentEnv(process.env, this.extraEnv, opts.provider),
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
        ...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}),
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
          ...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}),
        };
      }
      // Spawn fallito (binario mancante, permessi) o kill da segnale esterno.
      throw new AgentRunError(
        `Impossibile eseguire ${this.claudePath}: ${e.shortMessage ?? String(error)}`,
      );
    }
  }
}
