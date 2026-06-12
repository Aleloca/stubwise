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
  /**
   * Coda di risultati SCRIPTATI per chiamate successive: la prima run()
   * restituisce results[0], la seconda results[1], ecc. Pensata per il fix in
   * due fasi (plan poi execute), dove ogni run deve poter restituire output e
   * usage diversi. Ha la precedenza su output/exitCode/usage fissi; quando la
   * coda è esaurita si ricade sui valori fissi. `script`, se presente, ha la
   * precedenza su tutto. Le fileChanges vengono comunque applicate ad ogni run.
   */
  results?: AgentRunResult[];
}

export class FakeAgentRunner implements AgentRunner {
  /** Tutte le opzioni passate a run(), in ordine di chiamata. */
  readonly calls: AgentRunOptions[] = [];

  private readonly script: FakeAgentRunnerOptions["script"];
  private readonly fileChanges: Record<string, string>;
  private readonly output: string;
  private readonly exitCode: number;
  private readonly usage: AgentRunUsage | undefined;
  private readonly results: AgentRunResult[];
  /** Indice della prossima voce di `results` da restituire. */
  private resultIndex = 0;

  constructor(options: FakeAgentRunnerOptions = {}) {
    this.script = options.script;
    this.fileChanges = options.fileChanges ?? {};
    this.output = options.output ?? "FAKE OK";
    this.exitCode = options.exitCode ?? 0;
    this.usage = options.usage;
    this.results = options.results ?? [];
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
    // Coda scriptata: una voce per chiamata, in ordine. Esaurita → valori fissi.
    if (this.resultIndex < this.results.length) {
      const result = this.results[this.resultIndex];
      this.resultIndex++;
      if (result) return result;
    }
    return {
      output: this.output,
      exitCode: this.exitCode,
      ...(this.usage !== undefined ? { usage: this.usage } : {}),
    };
  }
}
