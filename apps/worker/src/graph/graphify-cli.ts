import { execa } from "execa";
import { buildAgentEnv } from "../agent/claude-cli.js";

/**
 * WRAPPER SPAWN del CLI `graphify` (pacchetto Python `graphifyy`), l'unico punto
 * del worker che esegue davvero il binario: il runner della build
 * (`graph/build.ts`) riceve questa funzione INIETTATA e nei test la sostituisce
 * con un fake — nessun test tocca il CLI reale.
 *
 * Scelte deliberate (modello: `runCommandCaptured` in pipeline/fix.ts):
 * - Exit non-zero NON è un'eccezione (`reject: false`): è un risultato che il
 *   chiamante interpreta. Per l'extract è un fallimento della build, per il
 *   labeling è solo il segnale di passare al fallback `--no-label`.
 * - stdout+stderr COMBINATI e troncati: l'output di graphify su un monorepo è
 *   lungo migliaia di righe, ma il chiamante ne usa solo la riga di riepilogo
 *   (`wrote …: N nodes, M edges, K communities`) e il testo dell'errore.
 * - Timeout e spawn fallito (binario assente) restano risultati, non eccezioni:
 *   `exitCode` non-zero + il motivo nell'output, così il messaggio d'errore
 *   persistito su `repo_graphs` dice cosa è successo.
 *
 * ENV — perché si riusa `buildAgentEnv` dei run agente: il labeling delle
 * comunità (`cluster-only --backend=claude-cli`) fa spawnare A GRAPHIFY il
 * binario `claude` EREDITANDO il proprio env (subprocess.run senza `env`), e
 * l'auth del CLI claude vive in PATH/HOME/USER (Keychain su macOS,
 * ~/.claude/.credentials.json in container) più le var `ANTHROPIC_*`/`CLAUDE_*`.
 * Passando lo stesso env allowlistato dei run agente il labeling si autentica
 * esattamente come loro, e in più graphify — che gira sul codice del repo
 * target — NON vede i segreti del master (ENCRYPTION_KEY, DATABASE_URL,
 * SESSION_SECRET sono nella denylist di buildAgentEnv).
 */

/** Tetto dell'output catturato (stesso ordine di grandezza dei log di test/fix). */
export const GRAPHIFY_OUTPUT_MAX_CHARS = 16_000;

/** Prefisso delle var di configurazione del CLI graphify inoltrate dall'env del
 * worker (es. GRAPHIFY_CLAUDE_CLI_MODEL): namespace del tool, mai segreti di
 * Stubwise — stesso razionale dei prefissi ANTHROPIC_/CLAUDE_ dei run agente. */
const GRAPHIFY_ENV_PREFIX = "GRAPHIFY_";

export interface GraphifyRunOptions {
  /** Argomenti del CLI (es. ["extract", dir, "--code-only"]). */
  args: string[];
  /** Working directory del processo (di norma il worktree del mirror). */
  cwd: string;
  /** Var extra esplicite, in particolare GRAPHIFY_OUT (directory di output). */
  extraEnv?: Record<string, string>;
  /** Timeout dell'invocazione in ms (da GRAPH_BUILD_TIMEOUT_MINUTES). */
  timeoutMs: number;
}

export interface GraphifyRunResult {
  /** 0 = successo. Timeout e spawn fallito danno un exit non-zero, non un throw. */
  exitCode: number;
  /** stdout + stderr combinati e troncati a GRAPHIFY_OUTPUT_MAX_CHARS. */
  output: string;
}

/**
 * Firma del runner iniettabile: `build.ts` dipende SOLO da questo tipo, mai dal
 * modulo concreto (nei test è un fake che registra le invocazioni).
 */
export type GraphifyRunner = (opts: GraphifyRunOptions) => Promise<GraphifyRunResult>;

/** Tronca l'output al tetto segnalandolo esplicitamente. */
function truncate(output: string): string {
  return output.length > GRAPHIFY_OUTPUT_MAX_CHARS
    ? `${output.slice(0, GRAPHIFY_OUTPUT_MAX_CHARS)}\n[output troncato]`
    : output;
}

/**
 * Var `GRAPHIFY_*` dell'env del worker: l'allowlist di buildAgentEnv non le
 * conosce, quindi si inoltrano esplicitamente come extraEnv. Le var passate dal
 * chiamante (GRAPHIFY_OUT) hanno la precedenza: sono la configurazione del job,
 * non dell'operatore.
 */
function graphifyEnvFrom(parentEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (name.startsWith(GRAPHIFY_ENV_PREFIX) && value !== undefined && value !== "") {
      env[name] = value;
    }
  }
  return env;
}

/**
 * Costruisce il runner reale sul binario dato (`GRAPHIFY_BIN`: nome in PATH o
 * path assoluto). Vedi il commento di modulo per il contratto di errori e per
 * l'env passato al child.
 */
export function createGraphifyRunner(bin: string): GraphifyRunner {
  return async ({ args, cwd, extraEnv, timeoutMs }) => {
    const env = buildAgentEnv(process.env, {
      ...graphifyEnvFrom(process.env),
      ...extraEnv,
    });
    const result = await execa(bin, args, {
      cwd,
      timeout: timeoutMs,
      reject: false,
      all: true,
      // Al timeout: SIGTERM, poi SIGKILL dopo 5s (come i run agente).
      forceKillAfterDelay: 5000,
      // extendEnv:false + allowlist: vedi il commento di modulo (segreti del
      // master fuori, auth del claude CLI dentro).
      extendEnv: false,
      env,
    });
    const combined = result.all ?? `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    // Timeout e spawn fallito non lasciano output utile: senza il motivo
    // esplicito l'errore salvato su repo_graphs sarebbe una stringa vuota.
    const reason = result.timedOut
      ? `[graphify ucciso dopo ${timeoutMs} ms di timeout]`
      : combined.trim().length === 0 && result.failed
        ? `[graphify non eseguibile: ${result.shortMessage ?? "errore di spawn"}]`
        : "";
    const output = reason === "" ? combined : `${combined}\n${reason}`.trim();
    return { exitCode: result.exitCode ?? 1, output: truncate(output) };
  };
}
