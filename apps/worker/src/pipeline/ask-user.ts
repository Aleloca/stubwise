import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentMcpConfig } from "../agent/runner.js";
import {
  ASK_USER_SERVER_NAME,
  ASK_USER_TOOL_NAME,
  askUserSchema,
  type AskUserPayload,
} from "../ask-user-mcp/server.js";

/**
 * Lato WORKER del bridge su file del tool `ask_user` (l'altro lato è
 * `../ask-user-mcp/`, che gira dentro il processo `claude` CLI).
 *
 * Il figlio non ha accesso al DB (allowlist dell'env con denylist assoluta su
 * DATABASE_URL): scrive la domanda come JSON in un file della cartella del run;
 * qui la rileggiamo e la RIVALIDIAMO con lo stesso schema zod del tool — non ci
 * si fida mai del contenuto di un file scritto da un processo modello-guidato.
 */

/**
 * Nome del file-bridge nella RADICE della cartella progetto del run (accanto a
 * STUBWISE_REPORT.md, quindi FUORI dai worktree dei repo: nessun `git add`
 * dentro un worktree può raggiungerlo, non finirà mai in un commit).
 */
export const ASK_USER_FILENAME = ".stubwise-question.json";

/** Pattern da mettere in `allowedTools` per abilitare davvero il tool. */
export const ASK_USER_TOOL_PATTERN = `mcp__${ASK_USER_SERVER_NAME}__${ASK_USER_TOOL_NAME}`;

/** Chiave del server nella `mcpConfig` del run (deve combaciare col pattern). */
export const ASK_USER_MCP_SERVER_KEY = ASK_USER_SERVER_NAME;

/**
 * Tetto di round di domanda per job usato finché la env dedicata non esiste
 * (`AGENT_QUESTION_MAX_ROUNDS`, fase di rifinitura): oltre questo numero il tool
 * non registra più nulla e istruisce il modello a decidere da sé. Iniettabile
 * dal chiamante (FixDeps.questionMaxRounds).
 */
export const DEFAULT_AGENT_QUESTION_MAX_ROUNDS = 5;

/** Directory di questo modulo: `dist/pipeline` in produzione, `src/pipeline` nei test. */
const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * Path dell'entry del server MCP da lanciare (`node <path>`).
 *
 * Risolto RELATIVAMENTE a questo modulo, non da una cwd o da una env: `tsc`
 * riproduce sotto `dist/` l'albero di `src/`, quindi `dist/pipeline/ask-user.js`
 * ha sempre `dist/ask-user-mcp/index.js` come sorella. Nell'immagine del worker
 * (`WORKDIR /app`, `CMD node dist/index.js`, `pnpm deploy` che copia il dist e
 * le dipendenze di produzione) diventa `/app/dist/ask-user-mcp/index.js`, con
 * `@modelcontextprotocol/sdk` risolvibile da `/app/node_modules`.
 *
 * In sviluppo (`tsx watch src/index.ts`) e nei test il `.js` NON esiste: accanto
 * c'è il `.ts`, che `node` non eseguirebbe. È voluto — il chiamante verifica
 * l'esistenza del file e, se manca, DISATTIVA il tool lasciando una riga nel log
 * del job invece di configurare un server MCP fantasma (il fallimento peggiore
 * sarebbe silenzioso: un agente che non può chiedere e nessuno che se ne accorge).
 */
export function askUserServerPath(): string {
  return join(moduleDir, "..", "ask-user-mcp", "index.js");
}

/**
 * Parent dir DETERMINISTICA dei run di pianificazione di un job. Deterministica
 * perché la ripresa (`--resume`) deve ritrovare la stessa cwd della sessione
 * CLI da continuare; `withProjectWorktrees` la ripulisce a ogni ingresso, così
 * il file-bridge di un round precedente non blocca il round successivo.
 */
export function planParentDir(jobId: string): string {
  return join(tmpdir(), `stubwise-plan-${jobId}`);
}

/**
 * Payload della domanda, ri-esportato dal lato tool: chi lo consuma (il fix)
 * non deve conoscere il modulo del server MCP, ed è LO STESSO tipo dello schema
 * usato per la rivalidazione (nessuna definizione gemella che può divergere).
 */
export type { AskUserPayload };

/** Parametri per cablare il tool `ask_user` su un run di pianificazione. */
export interface AskUserRunConfigInput {
  /** Job del run: determina la parent dir e quindi il path del file-bridge. */
  jobId: string;
  /** Entry del server MCP da lanciare con `node` (già risolta dal chiamante). */
  serverPath: string;
  /** Round della PROSSIMA domanda, 1-based. */
  round: number;
  /** Tetto di round per job (oltre, il tool non registra più nulla). */
  maxRounds: number;
}

/**
 * Tutto ciò che un run di pianificazione deve sapere del tool `ask_user`, in
 * pezzi già pronti da spreddare nelle opzioni del run e del prompt.
 *
 * Esiste per tenere `runFix` alla stessa altitudine dei suoi rami: il cablaggio
 * del tool (esistenza dell'entry, dir deterministica, config MCP, allowlist,
 * blocco di prompt) è UNA decisione sola e sta in un posto solo, invece di
 * cinque `const` intrecciate in mezzo alla preparazione dei repo.
 */
export interface AskUserRunConfig {
  /**
   * Il tool è davvero utilizzabile: l'entry del server MCP ESISTE. Falso in
   * sviluppo (`tsx`, nessun `dist`) o con un'immagine buildata a metà — il
   * chiamante lo dice nel log del job, perché un server MCP fantasma
   * fallirebbe in silenzio.
   */
  enabled: boolean;
  /** Entry del server MCP considerata (utile al messaggio di log). */
  serverPath: string;
  /** Parent dir DETERMINISTICA del run (la ripresa `--resume` la ritrova). */
  parentDir: string;
  /** File-bridge nella radice della parent dir: il worker lo rilegge a fine run. */
  filePath: string;
  /** Opzioni di `withProjectWorktrees`: la dir deterministica, sempre. */
  worktreeOptions: { parentDir: string };
  /** Da spreddare nelle opzioni del run: `mcpConfig`, o niente se disattivato. */
  mcpOpt: { mcpConfig: AgentMcpConfig } | Record<string, never>;
  /** Da spreddare nell'input del prompt di piano: `askUser`, o niente. */
  promptOpt: { askUser: { round: number; maxRounds: number } } | Record<string, never>;
  /** Pattern del tool da aggiungere all'allowlist del run (vuoto se disattivato). */
  tools: string[];
}

/**
 * Cabla il tool `ask_user` su un run di pianificazione. Da chiamare SOLO quando
 * il run ha davvero una fase di piano: in `execute-only` e a fase singola
 * nessuno può fare domande, e la dir deterministica non serve.
 *
 * La dir deterministica viene restituita SEMPRE (anche a tool disattivato):
 * dipende dal fatto che ci sia una fase di piano, non dal tool — la ripresa la
 * usa comunque, e tenerla condizionata al tool renderebbe la cwd del run
 * dipendente dalla presenza di un file nell'immagine.
 *
 * I parametri del bridge viaggiano SOLO nell'env del server MCP: l'env del CLI
 * è una allowlist con denylist assoluta sui segreti e non va allargata.
 */
export function buildAskUserRunConfig(input: AskUserRunConfigInput): AskUserRunConfig {
  const { jobId, serverPath, round, maxRounds } = input;
  const parentDir = planParentDir(jobId);
  const filePath = join(parentDir, ASK_USER_FILENAME);
  const enabled = existsSync(serverPath);
  return {
    enabled,
    serverPath,
    parentDir,
    filePath,
    worktreeOptions: { parentDir },
    mcpOpt: enabled
      ? {
          mcpConfig: {
            servers: {
              [ASK_USER_MCP_SERVER_KEY]: {
                // process.execPath, non "node": è il node che sta già girando,
                // senza dipendere da come è fatto il PATH del processo figlio.
                command: process.execPath,
                args: [serverPath],
                env: {
                  ASK_USER_FILE: filePath,
                  ASK_USER_ROUND: String(round),
                  ASK_USER_MAX_ROUNDS: String(maxRounds),
                },
              },
            },
          },
        }
      : {},
    promptOpt: enabled ? { askUser: { round, maxRounds } } : {},
    tools: enabled ? [ASK_USER_TOOL_PATTERN] : [],
  };
}

/** Esito della lettura del file-bridge. */
export type AskUserFileResult =
  /** Nessun file: l'agente non ha fatto domande (il caso normale). */
  | { kind: "absent" }
  /** Domanda valida, già rivalidata con lo schema del tool. */
  | { kind: "question"; payload: AskUserPayload }
  /** File presente ma inservibile: il run prosegue come se non ci fosse. */
  | { kind: "malformed"; reason: string };

/**
 * Legge e rivalida il file-bridge. Non lancia MAI: un file corrotto (JSON
 * troncato, payload manomesso, schema violato) non deve far fallire un run di
 * pianificazione altrimenti riuscito — torna `malformed` e il chiamante lo
 * logga e prosegue con il piano.
 *
 * Legge il PATH ESATTO, senza scandire la directory: il tool pubblica il file
 * con un `link` da un temporaneo `.<uuid>.ask-user.tmp` che vive per pochi
 * millisecondi NELLA STESSA cartella, e una scansione potrebbe incrociarlo.
 */
export async function readAskUserQuestion(filePath: string): Promise<AskUserFileResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "malformed", reason: `lettura fallita: ${message}` };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "malformed", reason: `JSON non parsabile: ${message}` };
  }

  const parsed = askUserSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(radice)"}: ${issue.message}`)
      .join("; ");
    return { kind: "malformed", reason: `schema violato: ${issues}` };
  }
  return { kind: "question", payload: parsed.data };
}
