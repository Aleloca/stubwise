import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AgentRunner,
  AgentRunOptions,
  AgentRunResult,
  AgentRunUsage,
} from "./runner.js";

/**
 * AgentRunner finto per i test della pipeline: niente CLI, niente quota,
 * niente modello. Ad ogni run() applica le fileChanges configurate nel cwd
 * (simulando il "diff" che l'agente reale produrrebbe nel worktree) e
 * restituisce un risultato fisso o calcolato da `script`. Tutte le chiamate
 * vengono registrate in `calls` così i test possono asserire sui prompt.
 */

export interface FakeAgentRunnerOptions {
  /**
   * Se presente, calcola il risultato per ogni chiamata (può essere sync o
   * async). Ha la precedenza su output/exitCode fissi.
   */
  script?: (opts: AgentRunOptions) => Promise<AgentRunResult> | AgentRunResult;
  /**
   * File da scrivere ad ogni run(): path RELATIVI al cwd → contenuto.
   * Le directory intermedie vengono create (mkdir -p).
   */
  fileChanges?: Record<string, string>;
  /** Output fisso restituito quando `script` non è definito. */
  output?: string;
  /** Exit code fisso restituito quando `script` non è definito. */
  exitCode?: number;
  /**
   * Consumi fissi restituiti quando `script` non è definito. Default
   * undefined (nessun dato di consumo), così i test che non se ne curano non
   * registrano righe. I test della pipeline che asseriscono la registrazione
   * dei consumi lo valorizzano esplicitamente.
   */
  usage?: AgentRunUsage;
}

export class FakeAgentRunner implements AgentRunner {
  /** Tutte le opzioni passate a run(), in ordine di chiamata. */
  readonly calls: AgentRunOptions[] = [];

  private readonly script: FakeAgentRunnerOptions["script"];
  private readonly fileChanges: Record<string, string>;
  private readonly output: string;
  private readonly exitCode: number;
  private readonly usage: AgentRunUsage | undefined;

  constructor(options: FakeAgentRunnerOptions = {}) {
    this.script = options.script;
    this.fileChanges = options.fileChanges ?? {};
    this.output = options.output ?? "FAKE OK";
    this.exitCode = options.exitCode ?? 0;
    this.usage = options.usage;
  }

  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    this.calls.push(opts);
    for (const [relativePath, content] of Object.entries(this.fileChanges)) {
      const filePath = join(opts.cwd, relativePath);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
    }
    if (this.script) {
      return await this.script(opts);
    }
    return {
      output: this.output,
      exitCode: this.exitCode,
      ...(this.usage !== undefined ? { usage: this.usage } : {}),
    };
  }
}
