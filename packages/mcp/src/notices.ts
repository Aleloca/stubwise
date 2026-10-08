import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { LATEST_PLUGIN_VERSION } from "./plugin-version.js";
import type { ToolResult } from "./tools/types.js";

/**
 * Avvisi sull'installazione del plugin Claude Code «stubwise».
 *
 * Il server MCP è l'unico pezzo dell'integrazione che si aggiorna sempre da
 * solo (`npx -y @stubwise/mcp` prende l'ultima versione), quindi è lui a dire
 * all'utente quando skill e comandi sono indietro. Tre casi, calcolati UNA
 * volta all'avvio del processo:
 *
 * 1. il plugin che ha avviato il server è più vecchio dell'ultimo rilasciato
 *    (`STUBWISE_PLUGIN_VERSION` < `LATEST_PLUGIN_VERSION`);
 * 2. il server è partito SENZA il plugin (variabile assente: un `.mcp.json` o
 *    un `claude mcp add` scritti a mano);
 * 3. c'è ancora la copia a mano di skill o comandi in `~/.claude/` (la vecchia
 *    guida li faceva scaricare con curl): due skill «stubwise» diverse si
 *    contraddicono, e i comandi copiati collidono con `/stubwise:*` del plugin.
 *
 * Gli avvisi vanno in coda alla PRIMA risposta di un tool della sessione, come
 * blocco di testo in più, e solo lì: un processo stdio = una sessione di
 * Claude Code. Mai un errore: il tool risponde comunque, e `isError` resta
 * quello che era.
 */

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
  /** Ultima versione rilasciata del plugin (compilata dentro il pacchetto). */
  latest: string;
  /** Percorsi delle copie a mano trovate. */
  manualCopies: string[];
}

/** Il testo degli avvisi per questa sessione (vuoto se non c'è niente da dire). */
export function buildNotices({ pluginVersion, latest, manualCopies }: NoticeInputs): string[] {
  const notices: string[] = [];

  if (pluginVersion === undefined) {
    notices.push(
      "Questo server MCP è stato avviato senza il plugin Claude Code «stubwise», " +
        "quindi skill e comandi /stubwise:* non si aggiornano da soli. Per installarlo, da terminale: " +
        `\`${INSTALL_COMMAND}\`; poi togli la voce \`stubwise\` dal tuo \`.mcp.json\` ` +
        "(o `claude mcp remove stubwise` se l'avevi aggiunta con `claude mcp add`) e riavvia Claude Code.",
    );
  } else {
    const cmp = compareVersions(pluginVersion, latest);
    if (cmp !== null && cmp < 0) {
      notices.push(
        `È disponibile una versione nuova del plugin Claude Code «stubwise» (${pluginVersion} → ${latest}). ` +
          `Per aggiornarlo, da terminale: \`${UPDATE_COMMAND}\`, poi riavvia Claude Code.`,
      );
    }
  }

  if (manualCopies.length > 0) {
    notices.push(
      `C'è ancora una copia a mano di skill o comandi Stubwise (${manualCopies.join(", ")}): ` +
        "il plugin porta i suoi, e le copie vecchie li contraddicono. Cancellala con " +
        `\`rm -rf ${manualCopies.join(" ")}\` e riavvia Claude Code.`,
    );
  }

  return notices;
}

/** Gli avvisi della sessione, consegnati una sola volta. */
export class SessionNotice {
  private text: string | null;

  constructor(notices: string[]) {
    this.text =
      notices.length === 0
        ? null
        : ["Nota Stubwise per l'utente (riferiscila):", ...notices.map((n) => `- ${n}`)].join("\n");
  }

  /** Il testo la prima volta, poi `null`. */
  take(): string | null {
    const text = this.text;
    this.text = null;
    return text;
  }
}

/** Aggiunge l'avviso (se c'è ancora) in coda alla risposta, senza toccarne l'esito. */
export function appendNotice(result: ToolResult, notice: SessionNotice | undefined): ToolResult {
  const text = notice?.take();
  if (!text) return result;
  return { ...result, content: [...result.content, { type: "text", text }] };
}

/** Gli avvisi di questo processo, letti dall'ambiente e dal filesystem. */
export function sessionNoticeFromEnvironment(
  env: Record<string, string | undefined>,
): SessionNotice {
  return new SessionNotice(
    buildNotices({
      pluginVersion: normalizeEnvValue(env.STUBWISE_PLUGIN_VERSION),
      latest: LATEST_PLUGIN_VERSION,
      manualCopies: findManualCopies(claudeConfigDir(env)),
    }),
  );
}
