import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { LATEST_PLUGIN_VERSION } from "./plugin-version.js";
import type { ToolResult } from "./tools/types.js";

/**
 * Avvisi sull'installazione del plugin Claude Code «stubwise».
 *
 * Il plugin fissa la versione esatta del server che avvia
 * (`npx -y @stubwise/mcp@<versione>`), e plugin e server escono sempre con la
 * STESSA versione (gruppo `fixed` di Changesets): il plugin X avvia il server
 * X, che ha compilata `LATEST_PLUGIN_VERSION` = X. Da sola, quindi, la
 * costante non direbbe mai «c'è di meglio». Per questo all'avvio il server
 * chiede al registro npm la versione `latest` di `@stubwise/mcp` — che, per il
 * gruppo `fixed`, è anche l'ultima del plugin — con un tempo massimo breve e
 * senza mai fallire: se npm non risponde in tempo, o risponde male, si ripiega
 * sulla costante compilata. Tre casi, calcolati UNA volta per processo:
 *
 * 1. il plugin che ha avviato il server è più vecchio dell'ultimo rilasciato
 *    (`STUBWISE_PLUGIN_VERSION` < max(`LATEST_PLUGIN_VERSION`, latest su npm));
 * 2. il server è partito SENZA il plugin (variabile assente: un `.mcp.json` o
 *    un `claude mcp add` scritti a mano);
 * 3. c'è ancora la copia a mano di skill o comandi in `~/.claude/` (la vecchia
 *    guida li faceva scaricare con curl): due skill «stubwise» diverse si
 *    contraddicono, e i comandi copiati collidono con `/stubwise:*` del plugin.
 *
 * Gli avvisi vanno in coda alla PRIMA risposta di un tool della sessione, come
 * blocco di testo in più, e solo lì: un processo stdio = una sessione di
 * Claude Code. Mai un errore: il tool risponde comunque, e `isError` resta
 * quello che era. La domanda a npm parte all'avvio, quindi di solito ha già
 * risposto quando arriva il primo tool; nel caso peggiore la prima risposta
 * aspetta al massimo `NPM_TIMEOUT_MS`.
 */

/** Dove chiedere l'ultima versione pubblicata (il documento `latest`, piccolo). */
export const NPM_LATEST_URL = "https://registry.npmjs.org/@stubwise/mcp/latest";

/** Tempo massimo per la domanda a npm: oltre, vale la costante compilata. */
export const NPM_TIMEOUT_MS = 1500;

/** Comandi per aggiornare il plugin. `update` non esiste dentro una sessione. */
const UPDATE_COMMAND =
  "claude plugin marketplace update stubwise && claude plugin update stubwise@stubwise";

/** Comandi per installarlo (da terminale: `--sparse` è documentato per la CLI). */
const INSTALL_COMMAND =
  "claude plugin marketplace add Aleloca/stubwise --sparse .claude-plugin plugins && claude plugin install stubwise@stubwise";

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Confronta due versioni `x.y.z`. `null` quando una delle due non è in quella
 * forma: chi chiama non avvisa (meglio nessun avviso di uno falso).
 */
export function compareVersions(a: string, b: string): number | null {
  const ma = VERSION_RE.exec(a);
  const mb = VERSION_RE.exec(b);
  if (!ma || !mb) return null;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(ma[i]) - Number(mb[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Un valore d'ambiente «vero» o `undefined`. Vuoto e `${…}` letterale contano
 * come assenti: Claude Code passa così com'è una `${VAR}` non impostata.
 */
export function normalizeEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^\$\{[^}]*\}$/.test(trimmed)) return undefined;
  return trimmed;
}

/** La cartella di configurazione di Claude Code (`CLAUDE_CONFIG_DIR` o `~/.claude`). */
export function claudeConfigDir(
  env: Record<string, string | undefined>,
  home: string = homedir(),
): string {
  return normalizeEnvValue(env.CLAUDE_CONFIG_DIR) ?? join(home, ".claude");
}

/**
 * La versione `latest` di `@stubwise/mcp` sul registro npm, o `null` se non
 * arriva entro `timeoutMs` (errore di rete, risposta non 200, versione non
 * `x.y.z`). Non lancia mai.
 */
export async function fetchNpmLatestVersion(
  fetchImpl: typeof fetch,
  timeoutMs: number = NPM_TIMEOUT_MS,
): Promise<string | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // La corsa col timer copre anche un `fetch` che ignorasse il segnale.
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  const lookup = (async (): Promise<string | null> => {
    try {
      const res = await fetchImpl(NPM_LATEST_URL, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { version?: unknown };
      return typeof body.version === "string" && VERSION_RE.test(body.version)
        ? body.version
        : null;
    } catch {
      return null;
    }
  })();
  try {
    return await Promise.race([lookup, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** La più alta fra la versione compilata e quella di npm (se leggibile). */
export function newestVersion(compiled: string, fromNpm: string | null): string {
  if (fromNpm === null) return compiled;
  const cmp = compareVersions(fromNpm, compiled);
  return cmp !== null && cmp > 0 ? fromNpm : compiled;
}

/** Le copie a mano di skill e comandi ancora presenti, da cancellare. */
export function findManualCopies(
  configDir: string,
  exists: (path: string) => boolean = existsSync,
): string[] {
  const copies: string[] = [];
  const skillDir = join(configDir, "skills", "stubwise");
  if (exists(join(skillDir, "SKILL.md"))) copies.push(skillDir);
  const commandsDir = join(configDir, "commands", "stubwise");
  if (exists(commandsDir)) copies.push(commandsDir);
  return copies;
}

export interface NoticeInputs {
  /** `STUBWISE_PLUGIN_VERSION` già normalizzata; `undefined` = senza plugin. */
  pluginVersion: string | undefined;
  /** Ultima versione rilasciata del plugin (la compilata o, se più alta, quella di npm). */
  latest: string;
  /** Percorsi delle copie a mano trovate. */
  manualCopies: string[];
}

/** Il testo degli avvisi per questa sessione (vuoto se non c'è niente da dire). */
export function buildNotices({ pluginVersion, latest, manualCopies }: NoticeInputs): string[] {
  const notices: string[] = [];

  if (pluginVersion === undefined) {
    notices.push(
      "Stubwise funziona, ma non è installato come plugin di Claude Code, quindi non si aggiornerà da solo. " +
        "Il modo più semplice è rifare la configurazione dalla sezione «Claude Code» nelle impostazioni di Stubwise, " +
        "che ti dà un comando pronto da incollare nel Terminale. Se sei pratico di terminale: " +
        `\`${INSTALL_COMMAND}\`, poi togli la voce \`stubwise\` dal tuo \`.mcp.json\` ` +
        "(o `claude mcp remove stubwise` se l'avevi aggiunta così) e riavvia Claude Code.",
    );
  } else {
    const cmp = compareVersions(pluginVersion, latest);
    if (cmp !== null && cmp < 0) {
      notices.push(
        `C'è una versione nuova del plugin di Stubwise per Claude Code (${pluginVersion} → ${latest}). ` +
          "Per aggiornarlo: apri Stubwise, vai in Impostazioni → Claude Code, crea il comando e incollalo una volta nel Terminale, " +
          "poi riavvia Claude Code. Quel comando accende anche l'aggiornamento automatico, così le prossime versioni arrivano da sole. " +
          "Crea un token nuovo: quello vecchio («Claude Code») puoi revocarlo in Impostazioni → Token di accesso. " +
          `In alternativa, per chi è pratico di terminale: \`${UPDATE_COMMAND}\`, poi riavvia Claude Code. ` +
          "Se non te la senti, chiedi a chi ti ha dato l'accesso a Stubwise.",
      );
    }
  }

  if (manualCopies.length > 0) {
    notices.push(
      `Sul computer c'è ancora una vecchia copia delle istruzioni di Stubwise, in queste cartelle: ${manualCopies.join(", ")}. ` +
        "Il plugin porta già le sue e le copie vecchie le contraddicono: cancellale (va bene anche dal Finder o da Esplora file) " +
        "e riavvia Claude Code. Se vuoi, Claude può cancellarle per te: basta chiederlo.",
    );
  }

  return notices;
}

/**
 * Gli avvisi della sessione, consegnati una sola volta. Possono essere ancora
 * da calcolare (la domanda a npm): il primo `take` li aspetta, gli altri —
 * anche concorrenti — ricevono `null` subito. Un calcolo fallito vale «nessun
 * avviso», mai un errore.
 */
export class SessionNotice {
  private pending: Promise<string[]> | null;

  constructor(notices: string[] | Promise<string[]>) {
    this.pending = Promise.resolve(notices);
  }

  /** Il testo la prima volta, poi `null`. */
  async take(): Promise<string | null> {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return null;
    let notices: string[];
    try {
      notices = await pending;
    } catch {
      return null;
    }
    if (notices.length === 0) return null;
    return [
      "Nota Stubwise per l'utente (riferiscila con parole semplici):",
      ...notices.map((n) => `- ${n}`),
    ].join("\n");
  }
}

/** Aggiunge l'avviso (se c'è ancora) in coda alla risposta, senza toccarne l'esito. */
export async function appendNotice(
  result: ToolResult,
  notice: SessionNotice | undefined,
): Promise<ToolResult> {
  const text = await notice?.take();
  if (!text) return result;
  return { ...result, content: [...result.content, { type: "text", text }] };
}

/**
 * Gli avvisi di questo processo, letti dall'ambiente, dal filesystem e (solo
 * se il server è partito dal plugin) dal registro npm. La domanda a npm parte
 * SUBITO, qui: va chiamata all'avvio, non al primo tool.
 */
export function sessionNoticeFromEnvironment(
  env: Record<string, string | undefined>,
  deps: { fetch?: typeof fetch; timeoutMs?: number } = {},
): SessionNotice {
  const pluginVersion = normalizeEnvValue(env.STUBWISE_PLUGIN_VERSION);
  const manualCopies = findManualCopies(claudeConfigDir(env));
  if (pluginVersion === undefined) {
    // Senza plugin l'avviso non dipende dalla versione: niente rete.
    return new SessionNotice(
      buildNotices({ pluginVersion, latest: LATEST_PLUGIN_VERSION, manualCopies }),
    );
  }
  const latest = fetchNpmLatestVersion(deps.fetch ?? fetch, deps.timeoutMs).then((fromNpm) =>
    newestVersion(LATEST_PLUGIN_VERSION, fromNpm),
  );
  return new SessionNotice(
    latest.then((version) => buildNotices({ pluginVersion, latest: version, manualCopies })),
  );
}
