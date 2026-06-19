import { readFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
  /**
   * Se false, salta la pre-inizializzazione della config Claude (scrittura di
   * `.claude.json`). Utile nei test che non vogliono toccare il filesystem.
   * Default true.
   */
  preConfig?: boolean;
}

const DEFAULT_READY_DELAY_MS = 2500;
const DEFAULT_RENDER_DELAY_MS = 2500;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Marcatori (case-insensitive) che indicano la presenza di un passaggio del
 * WIZARD DI ONBOARDING della TUI di claude — quello che intercetta il PTY in
 * una config "fresca". Se l'output ne contiene uno, inviamo un Invio per
 * accettare il default preselezionato e proseguire. La "login method" è un caso
 * speciale: significa che NON siamo autenticati e non c'è modo di andare oltre
 * (vedi LOGIN_METHOD_RE), quindi NON la includiamo qui.
 */
const WIZARD_MARKER_RE = /choose the text style|dark mode|light mode|select theme/i;

/**
 * Marcatore della scelta del metodo di login: appare SOLO quando il token OAuth
 * non è valido / assente. In quel caso premere Invio non porta a nulla di utile
 * (apre un flusso di login interattivo), quindi usciamo presto restituendo
 * l'output catturato: il parser fallirà e produrrà uno snapshot diagnostico
 * (rawText), già gestito a valle dal poller. NON si resta bloccati.
 */
const LOGIN_METHOD_RE = /select login method|claude account with subscription/i;

/** Numero massimo di "Invio" inviati per superare i passaggi del wizard. */
const MAX_WIZARD_STEPS = 3;
/** Attesa tra un Invio di navigazione del wizard e il successivo. */
const WIZARD_STEP_DELAY_MS = 400;

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
 * Percorso del file di stato a livello utente di Claude Code. In v2.x lo stato
 * dell'onboarding vive in `.claude.json`: NON dentro CLAUDE_CONFIG_DIR (lì ci
 * sono cache/sessioni/credenziali), ma alla RADICE della config — cioè
 * `${CLAUDE_CONFIG_DIR}/.claude.json` se CLAUDE_CONFIG_DIR è impostata
 * (verificato: i container del worker la impostano a /home/worker/.claude),
 * altrimenti `${HOME}/.claude.json`. Restituisce sia la dir che il file così il
 * chiamante può creare la dir prima di scrivere.
 */
export function resolveClaudeConfigPaths(env: NodeJS.ProcessEnv = process.env): {
  dir: string;
  file: string;
} {
  const dir = env["CLAUDE_CONFIG_DIR"] ?? join(env["HOME"] ?? homedir(), ".claude");
  return { dir, file: join(dir, ".claude.json") };
}

/**
 * Chiavi di stato che PLAUSIBILMENTE saltano il wizard di onboarding/tema della
 * TUI di Claude Code. ATTENZIONE: sono chiavi NON UFFICIALI / non documentate
 * (interne al CLI, viste in `.claude.json` reali della v2.x). Possono cambiare
 * tra versioni: per questo sono BEST-EFFORT. La rete di sicurezza vera è la
 * navigazione difensiva del wizard nel PTY (vedi captureUsageOutput) e, in
 * ultima istanza, lo snapshot diagnostico del poller. Scriviamo:
 *  - hasCompletedOnboarding: true  → salta il flusso di onboarding;
 *  - hasViewedOnboarding: true     → variante difensiva (alcune versioni);
 *  - theme: "dark"                 → preimposta il tema (salta il menu temi).
 */
const ONBOARDING_DEFAULTS: Record<string, unknown> = {
  hasCompletedOnboarding: true,
  hasViewedOnboarding: true,
  theme: "dark",
};

/**
 * Pre-inizializza (BEST-EFFORT, MERGE IDEMPOTENTE) il file di stato di Claude
 * Code così che il wizard di onboarding/tema NON compaia quando il poller lancia
 * `claude` in PTY su una config "fresca". Legge il JSON esistente se c'è e
 * aggiunge SOLO le chiavi MANCANTI (non sovrascrive valori già impostati
 * dall'utente). Qualunque errore (FS, JSON corrotto) viene ignorato: questa è
 * solo la prima delle due reti — il PTY sa comunque navigare un wizard residuo.
 *
 * Non lancia MAI.
 */
export async function ensureClaudeOnboardingConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    const { dir, file } = resolveClaudeConfigPaths(env);

    let current: Record<string, unknown> = {};
    try {
      const raw = await readFile(file, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      }
    } catch {
      // File assente o JSON non valido: si parte da un oggetto vuoto.
    }

    // Merge idempotente: aggiungi solo le chiavi non ancora presenti.
    let changed = false;
    for (const [key, value] of Object.entries(ONBOARDING_DEFAULTS)) {
      if (!(key in current)) {
        current[key] = value;
        changed = true;
      }
    }
    if (!changed) return;

    await mkdir(dir, { recursive: true });
    await writeFile(file, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort totale: mai propagare. Il PTY ha la rete di sicurezza.
  }
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

  // RETE A (best-effort): pre-inizializza la config così che il wizard di
  // onboarding/tema non compaia. Non lancia mai; il PTY ha comunque la rete B.
  if (opts.preConfig !== false) {
    await ensureClaudeOnboardingConfig();
  }

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

    let usageSent = false;

    /** Invia /usage, attende il render e chiude. Idempotente. */
    const sendUsage = (): void => {
      if (settled || usageSent) return;
      usageSent = true;
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
    };

    /**
     * RETE B (difensiva): supera un eventuale wizard di onboarding/tema residuo
     * prima di inviare /usage. Guarda l'output accumulato:
     *  - se contiene "select login method" → NON siamo autenticati: premere
     *    Invio non aiuta, esci subito inviando /usage (il parser fallirà →
     *    snapshot diagnostico, nessun hang);
     *  - se contiene un marcatore di wizard e non abbiamo esaurito i tentativi
     *    → invia un Invio per accettare il default e riprova dopo un attimo;
     *  - altrimenti il wizard è (probabilmente) superato → invia /usage.
     */
    const navigateWizard = (steps: number): void => {
      if (settled) return;

      if (LOGIN_METHOD_RE.test(buffer)) {
        // Non autenticato: niente da fare se non catturare e uscire presto.
        sendUsage();
        return;
      }

      if (WIZARD_MARKER_RE.test(buffer) && steps < MAX_WIZARD_STEPS) {
        try {
          proc?.write("\r");
        } catch {
          // ignora: se la write fallisce, il giro successivo o il timeout chiude.
        }
        timers.push(
          setTimeout(() => {
            navigateWizard(steps + 1);
          }, WIZARD_STEP_DELAY_MS),
        );
        return;
      }

      // Nessun marcatore (o tetto raggiunto): procedi con /usage.
      sendUsage();
    };

    // Dopo che la TUI è (probabilmente) pronta, naviga l'eventuale wizard e
    // invia /usage; poi attendi il render e chiudi (e comunque kill al cleanup).
    timers.push(
      setTimeout(() => {
        navigateWizard(0);
      }, readyDelayMs),
    );
  });
}
