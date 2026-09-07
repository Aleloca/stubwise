import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import type { AgentRunner, AgentRunResult } from "./runner.js";
import type { ResolvedProvider } from "../providers/chain.js";

/**
 * Helper CONDIVISI dei run "di solo testo" dell'agente.
 *
 * Prima della fase 5 questo pattern era triplicato: `textFromRun` nel report
 * giornaliero, `outputOrThrow` + `parseAgentJson` nell'intake e (di nuovo, con
 * un altro prefisso d'errore) nella stima del backlog. Sono run senza tool e
 * senza working tree: prompt dentro, testo fuori. Qui vive una sola copia.
 *
 * Contratto (identico a quello che i tre adottanti già avevano):
 * - `runner.run` RISOLVE anche su exit non-zero (è un risultato, non un
 *   errore): un exit ≠ 0 non produce MAI testo, perché un output parziale di
 *   un run crashato è peggio di nessun output;
 * - un output vuoto (o solo spazi) equivale a nessun output;
 * - le eccezioni del runner (timeout, spawn, limite) NON vengono ingoiate: chi
 *   chiama decide se sono best-effort (report, riassunti → catch e null) o
 *   fatali (intake, stima → il job va in retry).
 */

/** Turni massimi di default: un run di solo testo non ne usa di più. */
const DEFAULT_MAX_TURNS = 3;

export interface RunAgentTextOptions {
  /** Prompt completo (può contenere contenuto NON fidato). */
  prompt: string;
  /**
   * Working directory del run. Assente → una dir temporanea vuota creata qui e
   * rimossa alla fine: i run di solo testo non leggono il disco, ma il CLI una
   * cwd la vuole comunque.
   */
  cwd?: string;
  /** Modello (es. "haiku"); omesso = default del CLI. */
  model?: string;
  /** Credenziale del provider AI risolta dalla catena; omessa = env/OAuth. */
  provider?: ResolvedProvider;
  /** Timeout complessivo del run in millisecondi. */
  timeoutMs: number;
  /** Turni agentici massimi (default 3). */
  maxTurns?: number;
  /**
   * Permission mode del run. Default "plan" (sola analisi): è la modalità
   * giusta per un run che deve solo scrivere testo. L'intake e la stima del
   * backlog usano storicamente "default" e restano tali.
   */
  permissionMode?: "default" | "acceptEdits" | "plan";
}

/**
 * Esegue un run di solo testo e ne restituisce l'output trimmato, oppure null
 * se il run è uscito con exit ≠ 0 o non ha prodotto testo utile.
 */
export async function runAgentText(
  runner: AgentRunner,
  opts: RunAgentTextOptions,
): Promise<string | null> {
  const ownTmpDir = opts.cwd === undefined ? await mkdtemp(join(tmpdir(), "stubwise-agent-text-")) : null;
  const cwd = opts.cwd ?? ownTmpDir!;
  try {
    const result = await runner.run({
      cwd,
      prompt: opts.prompt,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      permissionMode: opts.permissionMode ?? "plan",
      maxTurns: opts.maxTurns ?? DEFAULT_MAX_TURNS,
      timeoutMs: opts.timeoutMs,
    });
    return textFromRun(result);
  } finally {
    if (ownTmpDir) await rm(ownTmpDir, { recursive: true, force: true });
  }
}

/**
 * Testo utile da un risultato di run: l'output trimmato se exit 0 e non vuoto,
 * altrimenti null. Estratto perché chi fa il run per conto proprio (con opzioni
 * che `runAgentText` non copre) possa comunque condividere la regola.
 */
export function textFromRun(result: AgentRunResult): string | null {
  if (result.exitCode !== 0) return null;
  const out = result.output.trim();
  return out.length > 0 ? out : null;
}

/**
 * Output grezzo di un run, o eccezione se exit ≠ 0. È la variante FATALE di
 * `textFromRun`, usata dai job che devono andare in retry invece di degradare
 * (intake e stima del backlog). `label` finisce nel messaggio d'errore e
 * identifica la fase (es. "intake (merge)").
 */
export function outputOrThrow(result: Pick<AgentRunResult, "output" | "exitCode">, label: string): string {
  if (result.exitCode !== 0) {
    throw new Error(`${label}: agente uscito con exit ${result.exitCode}`);
  }
  return result.output;
}

/**
 * Estrae e parsa l'oggetto JSON dall'output dell'agente, in modo DIFENSIVO:
 * tollera un fence ```json … ``` e un pre/postambolo attorno all'oggetto (fetta
 * tra la prima `{` e l'ultima `}`), poi valida contro `schema`. Null se non
 * parsabile o non conforme.
 */
export function parseAgentJson<T>(schema: z.ZodType<T>, raw: string): T | null {
  let text = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fence) text = fence[1]!.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  const result = schema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Tronca `text` a `maxChars` caratteri **senza spezzare una riga a metà** e
 * appende `marker` quando qualcosa è stato tolto. La prima riga è sempre
 * tenuta, anche se da sola supera il tetto: meglio un input parziale e
 * dichiarato che un prompt senza contenuto.
 */
export function capText(text: string, maxChars: number, marker: string): string {
  if (text.length <= maxChars) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (kept.length > 0 && used + line.length + 1 > maxChars) break;
    kept.push(line);
    used += line.length + 1; // +1 per il "\n" del join
  }
  if (kept.length === lines.length) return text;
  return `${kept.join("\n")}\n\n${marker}`;
}
