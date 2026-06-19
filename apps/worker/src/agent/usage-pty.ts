import type { ResolvedProvider } from "../providers/chain.js";
import { buildAgentEnv } from "./claude-cli.js";

/**
 * Cattura dell'output del comando `/usage` della TUI di claude tramite uno
 * pseudo-terminale (PTY). `/usage` è una TUI interattiva: NON è disponibile in
 * modalità headless (`-p`), quindi serve allocare un PTY, far partire `claude`
 * interattivo, attendere che la TUI sia pronta, scrivere "/usage" + invio,
 * attendere il render e catturare lo schermo.
 *
 * `/usage` è una LETTURA GRATUITA: non consuma token dell'abbonamento.
 *
 * Tutto è BEST-EFFORT: questo modulo NON deve MAI far crashare il worker. Ogni
 * errore (spawn fallito, PTY che si blocca, timeout) si risolve ritornando
 * l'output catturato finora (possibilmente vuoto), mai un'eccezione.
 *
 * Design per la TESTABILITÀ: lo spawn del PTY è dietro un'interfaccia iniettabile
 * (`PtySpawner` / `PtyProcess`). I test passano un fake e non spawnano MAI
 * `claude` reale. Lo spawner reale (node-pty) è caricato in modo LAZY solo
 * quando serve, così l'addon nativo non viene importato durante i test.
 */

/** Sottoinsieme di un'istanza PTY che ci serve (compatibile con node-pty IPty). */
export interface PtyProcess {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  kill(signal?: string): void;
}

/** Fake per i test: estende PtyProcess con introspezione. */
export interface FakePty extends PtyProcess {
  writes: string[];
  killed: boolean;
}

export interface PtySpawnOptions {
  cwd: string;
  env: Record<string, string>;
}

/** Funzione che alloca un PTY ed esegue `file args`. */
export type PtySpawner = (
  file: string,
  args: string[],
  opts: PtySpawnOptions,
) => PtyProcess;

export interface CaptureUsageOptions {
  /** Spawner del PTY. Default: node-pty (lazy). I test ne passano uno fake. */
  spawner?: PtySpawner;
  /** Path/nome del binario claude. Default "claude". */
  claudePath?: string;
  /** cwd del processo. Default: cwd del worker. */
  cwd?: string;
  /** Attesa prima di inviare /usage (la TUI deve essere pronta). Default 2500ms. */
  readyDelayMs?: number;
  /** Attesa dopo /usage per far renderizzare il pannello. Default 2500ms. */
  renderDelayMs?: number;
  /** Timeout complessivo: oltre, il processo è ucciso. Default 30000ms. */
  timeoutMs?: number;
}

const DEFAULT_READY_DELAY_MS = 2500;
const DEFAULT_RENDER_DELAY_MS = 2500;
const DEFAULT_TIMEOUT_MS = 30_000;

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

/**
 * Rimuove le sequenze di escape ANSI (colori, movimenti cursore, clear) da una
 * stringa, lasciando il solo testo. La TUI ne produce in abbondanza.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * Spawner reale basato su node-pty, caricato in modo LAZY: l'import dinamico
 * evita di toccare l'addon nativo finché non serve davvero (i test usano un
 * fake e non passano mai per qui). Restituisce una factory PtySpawner.
 */
async function loadNodePtySpawner(): Promise<PtySpawner> {
  const pty = await import("node-pty");
  return (file, args, opts) =>
    pty.spawn(file, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: opts.cwd,
      env: opts.env,
    });
}

/**
 * Avvia `claude` interattivo in un PTY, attende la TUI, invia `/usage` + invio,
 * attende il render, cattura l'output (ripulito dagli ANSI) e chiude il
 * processo. Inietta la credenziale `account` riusando buildAgentEnv (Task 3):
 * per un account si imposta CLAUDE_CODE_OAUTH_TOKEN e si esclude
 * ANTHROPIC_API_KEY ereditata, così l'auth è quella dell'abbonamento giusto.
 *
 * BEST-EFFORT TOTALE: qualunque errore → ritorna l'output catturato finora
 * (eventualmente ""), mai un'eccezione. Il segreto non viene MAI loggato.
 */
export async function captureUsageOutput(
  provider: ResolvedProvider,
  opts: CaptureUsageOptions = {},
): Promise<string> {
  const readyDelayMs = opts.readyDelayMs ?? DEFAULT_READY_DELAY_MS;
  const renderDelayMs = opts.renderDelayMs ?? DEFAULT_RENDER_DELAY_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const claudePath = opts.claudePath ?? "claude";
  const cwd = opts.cwd ?? process.cwd();

  let spawner: PtySpawner;
  try {
    spawner = opts.spawner ?? (await loadNodePtySpawner());
  } catch {
    // node-pty non caricabile (addon mancante/non eseguibile): best-effort.
    return "";
  }

  // Env del child: stessa logica del runner (allowlist + iniezione per kind).
  // extendEnv:false è implicito qui — passiamo solo l'env costruito.
  const env = buildAgentEnv(process.env, undefined, provider);

  return new Promise<string>((resolve) => {
    let buffer = "";
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    let proc: PtyProcess | undefined;

    const cleanup = (): void => {
      for (const t of timers) clearTimeout(t);
      try {
        proc?.kill();
      } catch {
        // ignora: il processo potrebbe essere già morto.
      }
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(stripAnsi(buffer));
    };

    try {
      proc = spawner(claudePath, [], { cwd, env });
    } catch {
      // Spawn fallito: best-effort, niente output.
      resolve("");
      return;
    }

    proc.onData((data) => {
      buffer += data;
    });
    proc.onExit(() => {
      finish();
    });

    // Hard timeout: oltre, uccidi e ritorna il parziale.
    timers.push(setTimeout(finish, timeoutMs));

    // Dopo che la TUI è (probabilmente) pronta, invia /usage + invio; poi
    // attendi il render e chiudi inviando /quit (e comunque kill al cleanup).
    timers.push(
      setTimeout(() => {
        if (settled) return;
        try {
          proc?.write("/usage\r");
        } catch {
          // ignora: se la write fallisce, ci penserà il timeout.
        }
        timers.push(
          setTimeout(() => {
            // Render atteso: chiudi pulito. finish() farà comunque il kill.
            finish();
          }, renderDelayMs),
        );
      }, readyDelayMs),
    );
  });
}
