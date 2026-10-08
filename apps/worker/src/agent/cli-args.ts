// apps/worker/src/agent/cli-args.ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunError, type AgentMcpConfig, type AgentRunOptions } from "./runner.js";

/**
 * argv del CLI `claude`, condiviso dal runner storico (ClaudeCliRunner,
 * `--output-format json`) e da quello in streaming (StreamingClaudeRunner).
 * Estratto da `claude-cli.ts` senza cambi di comportamento: il razionale dei
 * singoli flag è nel docblock di quel modulo.
 */

/** Formato dell'output del CLI: json (storico) o stream (sessioni dal vivo). */
export type CliFormat = "json" | "stream";

export function validateRunOptions(opts: AgentRunOptions): void {
  // Validazione PRIMA dello spawn: un valore assurdo qui è un bug del
  // chiamante, non un esito dell'agente.
  if (!Number.isInteger(opts.maxTurns) || opts.maxTurns <= 0) {
    throw new AgentRunError(`maxTurns non valido: ${opts.maxTurns} (atteso intero > 0)`);
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new AgentRunError(`timeoutMs non valido: ${opts.timeoutMs} (atteso > 0)`);
  }
}

/**
 * argv del CLI. Con `format: "json"` è IDENTICO a quello storico (i test di
 * claude-cli.test.ts lo verificano); con `"stream"` cambia solo la coppia di
 * formato, il resto (permessi, MCP, plugin, resume) resta uguale. In nessuno
 * dei due il prompt sta in argv: viaggia su stdin.
 */
export function buildCliArgs(opts: AgentRunOptions, format: CliFormat): string[] {
  // Permission mode: default "acceptEdits" (comportamento storico del fix).
  // Il run di pianificazione passa "plan" (sola analisi, nessuna modifica).
  const permissionMode = opts.permissionMode ?? "acceptEdits";
  const args =
    format === "json"
      ? ["-p", "--output-format", "json"]
      : [
          "-p",
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
        ];
  args.push("--permission-mode", permissionMode, "--max-turns", String(opts.maxTurns));
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
  return args;
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

/**
 * Aggiunge `--mcp-config <file effimero> --strict-mcp-config` se il run ha
 * server MCP, esegue `fn` e rimuove il file in ogni caso.
 */
export async function withMcpConfig<T>(
  opts: AgentRunOptions,
  args: string[],
  fn: (args: string[]) => Promise<T>,
): Promise<T> {
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
      args = [...args, "--mcp-config", configPath, "--strict-mcp-config"];
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
    return await fn(args);
  } finally {
    if (mcpConfigDir !== undefined) {
      // Best-effort: un residuo in tmp non deve mai far fallire un run.
      await rm(mcpConfigDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
