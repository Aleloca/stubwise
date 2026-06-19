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
  /**
   * Attesa AGGIUNTIVA dopo la comparsa del prompt principale, PRIMA di scrivere
   * /usage: dà tempo alla TUI di diventare davvero interattiva (l'animazione
   * "Welcome back!" può scartare l'input arrivato troppo presto). Default 800ms.
   */
  settleDelayMs?: number;
  /**
   * Attesa tra la scrittura di "/usage" e quella dell'invio "\r" (invio diviso):
   * evita che il submit parta prima che il comando sia digitato/riconosciuto.
   * Default 300ms.
   */
  submitDelayMs?: number;
  /**
   * Tetto MASSIMO d'attesa del pannello dell'uso dopo l'invio. Entro questo
   * limite si fa polling del buffer per il marker di output; appena compare si
   * finisce subito (early-exit). Default 8000ms.
   */
  renderDelayMs?: number;
  /** Intervallo di polling del buffer in attesa del pannello. Default 300ms. */
  pollMs?: number;
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
/**
 * Settle PRIMA dell'invio: dopo che il prompt principale è comparso, la TUI può
 * ancora star renderizzando l'animazione iniziale e scartare l'input. Attendiamo
 * un attimo perché diventi davvero interattiva. ~800ms è prudente.
 */
const DEFAULT_SETTLE_DELAY_MS = 800;
/**
 * Invio DIVISO: scriviamo "/usage", attendiamo questo delay, poi scriviamo "\r".
 * Così il submit non parte prima che il comando sia stato digitato/riconosciuto.
 */
const DEFAULT_SUBMIT_DELAY_MS = 300;
/**
 * TETTO d'attesa del pannello dopo l'invio. Entro questo limite si fa polling
 * del buffer per USAGE_OUTPUT_RE e si finisce appena il pannello compare. Alzato
 * a ~8000ms perché ora è un tetto (early-exit sul marker), non un'attesa fissa.
 *
 * Aritmetica del budget totale con i DEFAULT (usati dal poller), ben sotto il
 * timeoutMs di default (30000ms):
 *   ready 2500 + settle 800 + submit 300 + render/poll fino a 8000 ≈ 11.6s < 30s.
 * Anche col retry (riemissione a metà tetto) il tetto d'attesa resta 8000ms.
 */
const DEFAULT_RENDER_DELAY_MS = 8000;
/** Intervallo di polling del buffer in attesa del pannello. */
const DEFAULT_POLL_MS = 300;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Marcatore di pannello /usage COMPLETO: la sezione settimanale "all models" è
 * l'ULTIMA a renderizzare, quindi una "% used" dopo di essa garantisce che
 * anche "Current session" sia già presente. Allineato a parseUsageDeterministic
 * (che pretende entrambe le sezioni): evita l'early-exit su render parziale e i
 * falsi positivi da banner ("resets"/"% used" sciolti). Quando matcha nel buffer
 * (ANSI strippato) il pannello è completo e coerente col parser: finiamo subito
 * (early-exit), senza attendere il tetto renderDelayMs.
 */
const USAGE_OUTPUT_RE = /current week\s*\(all models\)[\s\S]*?\d{1,3}\s*%\s*used/i;

/** Comando della TUI che apre il pannello dell'uso. */
const USAGE_CMD = "/usage";

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

/**
 * Marcatore del TRUST DIALOG ("Quick safety check: is this a project you
 * trust?") che Claude Code mostra alla prima apertura di una cartella. Con un
 * account valido questo è il prompt che bloccava il PTY in produzione: come per
 * il wizard del tema, il default ("Yes, I trust this folder") si accetta con un
 * Invio. Lo trattiamo quindi come un passaggio di navigazione da superare.
 */
const TRUST_MARKER_RE = /trust this folder|do you trust|safety check|is this a project you/i;

/**
 * Marcatore di "PROMPT PRONTO": la TUI è arrivata al prompt interattivo
 * principale (la barra di stato "? for shortcuts"). È il segnale definitivo che
 * possiamo inviare /usage SUBITO, senza sprecare altri Invii: ha priorità
 * (short-circuit) su qualsiasi altro marcatore ancora presente nel buffer.
 *
 * FRAGILITÀ: dipende dalla stringa EN della status bar di Claude Code
 * ("? for shortcuts"). Se venisse localizzata o cambiata, ricadremmo sul
 * fallback per esaurimento del cap — comportamento sicuro, solo più lento.
 */
const PROMPT_READY_RE = /\? for shortcuts/i;

/**
 * Passi massimi di navigazione (Invio o sola ATTESA) prima di forzare /usage. Il
 * cap copre trust + tema + margine e garantisce comunque l'invio di /usage anche
 * se non riconosciamo lo stato della TUI (es. TUI ancora in caricamento).
 */
const MAX_NAV_STEPS = 5;
/**
 * Attesa tra un passo di navigazione e il successivo. Tenuta breve perché ora
 * il loop può eseguire fino a MAX_NAV_STEPS passi anche solo per ATTENDERE
 * (TUI in caricamento, nessun marcatore ancora): il totale (passi × delay) deve
 * restare ben sotto il timeoutMs tipico, così /usage viene comunque inviato in
 * tempo. 150ms × 5 = 750ms di budget di navigazione: sufficiente per la TUI
 * reale e abbondantemente sotto il timeout di default (30s).
 */
const WIZARD_STEP_DELAY_MS = 150;

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
  const settleDelayMs = opts.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS;
  const submitDelayMs = opts.submitDelayMs ?? DEFAULT_SUBMIT_DELAY_MS;
  const renderDelayMs = opts.renderDelayMs ?? DEFAULT_RENDER_DELAY_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const claudePath = opts.claudePath ?? "claude";
  // cwd NEUTRO STABILE: usare process.cwd() (la dir dell'app) faceva scattare il
  // trust dialog a ogni poll. Puntiamo invece alla dir di config del worker
  // (/home/worker/.claude in container, montata su volume): una volta accettato
  // il trust per quella dir, Claude lo ricorda tra un poll e l'altro e il dialog
  // non riappare. Lo spawner fake dei test ignora comunque il cwd.
  const cwd = opts.cwd ?? resolveClaudeConfigPaths(process.env).dir;

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

    /**
     * Scrive il comando /usage con INVIO DIVISO (best-effort): prima "/usage",
     * poi — dopo submitDelayMs — il "\r". Separando il submit dal comando si
     * evita che l'invio parta prima che la TUI abbia digerito il testo.
     */
    const writeUsageCommand = (): void => {
      try {
        proc?.write(USAGE_CMD);
      } catch {
        // ignora: se la write fallisce, ci penserà il polling/timeout.
      }
      timers.push(
        setTimeout(() => {
          if (settled) return;
          try {
            proc?.write("\r");
          } catch {
            // ignora: best-effort.
          }
        }, submitDelayMs),
      );
    };

    /**
     * Invia /usage e ATTENDE IL PANNELLO. Idempotente (guardia usageSent).
     * Flusso:
     *  1) SETTLE: attende settleDelayMs perché la TUI sia interattiva, POI scrive
     *     /usage (invio diviso).
     *  2) POLLING: ogni pollMs controlla il buffer per USAGE_OUTPUT_RE; appena
     *     compare → finish() (cattura riuscita, early-exit).
     *  3) RETRY UNICO: a metà del tetto (renderDelayMs/2), se il pannello non è
     *     comparso, reinvia /usage UNA volta (il primo invio può essere caduto).
     *  4) TETTO: raggiunto renderDelayMs senza pannello → finish() col parziale.
     */
    const sendUsage = (): void => {
      if (settled || usageSent) return;
      usageSent = true;

      timers.push(
        setTimeout(() => {
          if (settled) return;
          writeUsageCommand();

          let retried = false;
          const deadline = Date.now() + renderDelayMs;
          const retryAt = Date.now() + renderDelayMs / 2;

          const poll = (): void => {
            if (settled) return;
            // Il marker è testato PRIMA del retry: se il pannello completo è già
            // nel buffer non si reinvia /usage (early-exit, niente doppio invio).
            if (USAGE_OUTPUT_RE.test(stripAnsi(buffer))) {
              // Pannello completo comparso: cattura riuscita, esci subito.
              finish();
              return;
            }
            const now = Date.now();
            if (!retried && now >= retryAt) {
              // Un solo retry: il primo invio potrebbe essere caduto. Con tetti
              // piccoli (test) retry e deadline possono coincidere nello stesso
              // giro: innocuo (write best-effort).
              retried = true;
              writeUsageCommand();
            }
            if (now >= deadline) {
              // Tetto raggiunto senza pannello: chiudi col parziale.
              finish();
              return;
            }
            timers.push(setTimeout(poll, pollMs));
          };

          timers.push(setTimeout(poll, pollMs));
        }, settleDelayMs),
      );
    };

    /**
     * RETE B (difensiva): naviga GENERICAMENTE i prompt che la TUI può mostrare
     * prima di arrivare al prompt principale (trust dialog, wizard del tema, …)
     * fino a poter inviare /usage. È un loop a step (cap MAX_NAV_STEPS) sul
     * buffer accumulato. Ordine di valutazione (la priorità conta: il buffer
     * cresce e i marcatori passati restano "veri", quindi i short-circuit vanno
     * prima):
     *  - "select login method" → NON siamo autenticati: premere Invio non aiuta,
     *    esci subito inviando /usage (il parser fallirà → snapshot diagnostico,
     *    nessun hang);
     *  - "? for shortcuts" → la TUI è al prompt principale: invia /usage subito,
     *    senza sprecare altri Invii;
     *  - marcatore di wizard/tema O trust dialog (e step disponibili) → accetta
     *    il default con un Invio e riprova dopo un attimo;
     *  - nessun marcatore riconosciuto (e step disponibili) → la TUI sta
     *    probabilmente ancora caricando: attendi e riprova;
     *  - tetto raggiunto → fallback: invia /usage comunque.
     */
    const navigateWizard = (steps: number): void => {
      if (settled) return;

      if (LOGIN_METHOD_RE.test(buffer)) {
        // Non autenticato: niente da fare se non catturare e uscire presto.
        sendUsage();
        return;
      }

      if (PROMPT_READY_RE.test(buffer)) {
        // Prompt principale pronto: invia /usage senza ulteriori Invii.
        sendUsage();
        return;
      }

      if (steps < MAX_NAV_STEPS) {
        if (WIZARD_MARKER_RE.test(buffer) || TRUST_MARKER_RE.test(buffer)) {
          // Prompt di scelta (tema/trust): accetta il default con un Invio.
          try {
            proc?.write("\r");
          } catch {
            // ignora: se la write fallisce, il giro successivo o il timeout chiude.
          }
        }
        // Sia che abbiamo inviato Invio sia che non riconosciamo ancora nulla
        // (TUI in caricamento): attendi e riprova.
        timers.push(
          setTimeout(() => {
            navigateWizard(steps + 1);
          }, WIZARD_STEP_DELAY_MS),
        );
        return;
      }

      // Tetto raggiunto: fallback finale, invia /usage comunque.
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
