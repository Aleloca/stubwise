import type { Db } from "@stubwise/db";
import { execa } from "execa";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { appendLog } from "../queue.js";
import type { LoadedEnvFile } from "./env-files.js";
import { REPORT_FILENAME } from "./prompts.js";
import type { TestCommand } from "./test-command.js";

/**
 * Passi PER-REPO della pipeline che scrive codice — il fix e, dal ciclo di
 * correzione post-PR, la correzione — fra «worktree aperto» e «commit»: file
 * d'ambiente di test + install, esecuzione dei test, loop di self-repair,
 * lettura del report, commit con l'identità di Stubwise.
 *
 * Stavano come closure dentro `runFix` e sono stati estratti SENZA cambiarne
 * una riga di comportamento perché due pipeline che li copiassero avrebbero due
 * copie di due regole di sicurezza: l'esclusione dei file d'ambiente da OGNI
 * `git add`/`git status` (il safeguard anti-leak) e l'ambiente fisso su `"test"`
 * (l'invariante della fase 8, vedi `loadProjectEnvFiles`). Chi tocca uno di
 * questi passi lo tocca per entrambe.
 */

/** Output del comando di test (o di install) eseguito dal worker. */
export interface TestRunResult {
  exitCode: number;
  /** stdout + stderr combinati, troncato. */
  output: string;
}

/** Tetto per gli output dell'agente accodati al log del job. */
const LOG_OUTPUT_MAX_CHARS = 4000;

export function truncateForLog(output: string): string {
  return output.length > LOG_OUTPUT_MAX_CHARS
    ? `${output.slice(0, LOG_OUTPUT_MAX_CHARS)}\n[output troncato]`
    : output;
}

/**
 * Fase 8, Task 7: estrae i path da `git status --porcelain` (formato NON -z,
 * coerente col resto di questo file). Ogni riga è `XY path` — due caratteri
 * di stato, uno spazio, il path; una rinomina è `XY vecchio -> nuovo`, di cui
 * prendiamo solo il nuovo path (quello che esiste davvero nel diff). Best-
 * effort: alimenta solo l'euristica del rischio (Task 7), non una decisione
 * di sicurezza — un path che sfugge al parsing abbassa il rischio percepito,
 * mai lo confonde con un file diverso.
 */
function parsePorcelainPaths(status: string): string[] {
  return status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 3)
    .map((line) => {
      const rest = line.slice(3);
      const arrowIdx = rest.indexOf(" -> ");
      const path = arrowIdx === -1 ? rest : rest.slice(arrowIdx + 4);
      return path.replace(/^"(.*)"$/, "$1");
    });
}

/** L'agente ha terminato ma non ha prodotto nessuna modifica committabile. */
export class NoChangesError extends Error {
  readonly agentOutput: string;
  constructor(agentOutput: string) {
    super("nessuna modifica prodotta dall'agente");
    this.name = "NoChangesError";
    this.agentOutput = agentOutput;
  }
}

/**
 * Exit code non-zero dall'agente: scelta CONSERVATIVA, il job fallisce anche
 * se nel worktree c'è un diff plausibile. Un CLI morto male a metà lavoro può
 * lasciare modifiche incoerenti (fix a metà, test non eseguiti): meglio
 * nessuna PR che una PR inaffidabile. L'output finisce nel log per il debug.
 */
export class AgentExitError extends Error {
  readonly exitCode: number;
  readonly agentOutput: string;
  constructor(exitCode: number, agentOutput: string) {
    super(`agente terminato con exit ${exitCode}`);
    this.name = "AgentExitError";
    this.exitCode = exitCode;
    this.agentOutput = agentOutput;
  }
}

/**
 * I test del repo, eseguiti dal worker, restano ROSSI dopo tutti i RE-tentativi
 * del loop di self-repair: fallimento CONSERVATIVO, niente PR. Si preferisce
 * nessuna PR a una PR che non passa i test del progetto. Porta sia l'output dei
 * test (per il log) sia l'ultimo output dell'agente.
 */
export class SelfRepairFailedError extends Error {
  readonly testOutput: string;
  readonly agentOutput: string;
  constructor(testOutput: string, agentOutput: string) {
    super("i test del repo restano rossi dopo i tentativi di riparazione");
    this.name = "SelfRepairFailedError";
    this.testOutput = testOutput;
    this.agentOutput = agentOutput;
  }
}

/**
 * Tetto di costo del ticket sforato DENTRO il loop di self-repair (Task 6):
 * prima di ri-tentare una riparazione la spesa stimata del ticket ha superato
 * `automation_rules.max_cost_usd`. NON è un fallimento: esce dalla callback
 * del worktree e nel catch di `runFix` — e, dal ciclo di correzione post-PR,
 * di `runCorrection` — porta al percorso budget-held (holdJob + commento +
 * notifica, `holdForBudget` di job-outcomes.ts), MAI a failJob: nella
 * correzione la riga `pr_corrections` resta `queued`, il job verrà ripreso.
 * Lo scope è sempre "ticket" (il tetto mensile è controllato solo prima del
 * run, fuori dal loop).
 */
export class BudgetExceededError extends Error {
  readonly scope: "ticket" | "monthly";
  readonly limitUsd: number;
  readonly spentUsd: number;
  constructor(scope: "ticket" | "monthly", limitUsd: number, spentUsd: number) {
    super(`budget di costo superato (${scope}): spesi ${spentUsd} sul limite di ${limitUsd}`);
    this.name = "BudgetExceededError";
    this.scope = scope;
    this.limitUsd = limitUsd;
    this.spentUsd = spentUsd;
  }
}

/** git nel worktree: comandi locali (add/commit/status), niente auth. */
export async function gitIn(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execa("git", args, { cwd: dir, timeout: 120_000 });
  return stdout;
}

/** Il sottoinsieme del repo preparato che serve ai passi per-repo. */
export interface RepoStepsRepo {
  repositoryId: string;
  name: string;
  installCommand: string | null;
  testCommand: string | null;
}

/**
 * Stato PER-REPO: ogni repo del progetto ha il proprio worktree (sottocartella
 * della cartella del run), i propri file d'ambiente materializzati (la tabella
 * env è scoped per repositoryId), il proprio pathspec di esclusione anti-leak e
 * la propria mappa env per install/test. `prepared` porta tutto ciò che il
 * chiamante ha già risolto (per il fix anche il MirrorProject).
 */
export interface RepoState<R extends RepoStepsRepo = RepoStepsRepo> {
  prepared: R;
  dir: string;
  /** Esclusione dei file env materializzati da OGNI git add/status del suo
   * worktree (SAFEGUARD anti-leak). Vuoto = nessun env. */
  envExcludePathspecs: string[];
  /** Mappa env del repo da iniettare in install/test (mai loggata). */
  envProcessEnv: Record<string, string>;
  /**
   * Fase 8, Task 7: i path modificati in QUESTO repo secondo l'ultimo
   * `git status --porcelain` (stageAndDetectChanged li scrive qui) —
   * l'input del calcolo del rischio. Vuoto finché non è ancora stato
   * rilevato un diff.
   */
  changedFiles: string[];
}

export function newRepoState<R extends RepoStepsRepo>(prepared: R, dir: string): RepoState<R> {
  return { prepared, dir, envExcludePathspecs: [], envProcessEnv: {}, changedFiles: [] };
}

/** Dipendenze (già risolte ai default dal chiamante) dei passi per-repo. */
export interface RepoStepsDeps {
  db: Db;
  jobId: string;
  encryptionKey: Buffer;
  /** Prefisso delle righe di log del job: `[fix]` o `[correction]`. */
  logPrefix: string;
  loadEnvFilesFn: (
    db: Db,
    repositoryId: string,
    encryptionKey: Buffer,
    environment: "test",
  ) => Promise<LoadedEnvFile[]>;
  materializeEnvFilesFn: (
    dir: string,
    files: LoadedEnvFile[],
  ) => Promise<{ writtenPaths: string[]; env: Record<string, string> }>;
  resolveInstallCommandFn: (
    project: { installCommand: string | null },
    dir: string,
  ) => Promise<TestCommand | null>;
  runInstallCommand: (
    cmd: TestCommand,
    dir: string,
    timeoutMs: number,
    extraEnv?: Record<string, string>,
  ) => Promise<TestRunResult>;
  installTimeoutMs: number;
  resolveTestCommandFn: (
    project: { testCommand: string | null },
    dir: string,
  ) => Promise<TestCommand | null>;
  runTestCommand: (
    cmd: TestCommand,
    dir: string,
    timeoutMs: number,
    extraEnv?: Record<string, string>,
  ) => Promise<TestRunResult>;
  testTimeoutMs: number;
}

/** Riga di log best-effort (col prefisso della pipeline): un log perso non deve
 * mai far fallire il run. */
async function log(steps: RepoStepsDeps, line: string): Promise<void> {
  await appendLog(steps.db, steps.jobId, `${steps.logPrefix} ${line}`).catch(() => {
    // Log best-effort.
  });
}

/**
 * FILE D'AMBIENTE + INSTALL, PER OGNI REPO, PRIMA dell'agente. Ogni repo
 * materializza i suoi env-file nel PROPRIO worktree e installa le sue
 * dipendenze lì. Tutto BEST-EFFORT: un errore su un repo si logga e non blocca
 * gli altri né il run. I valori env non vengono MAI loggati (solo il conteggio
 * dei file). L'ambiente è `"test"` e nient'altro (l'invariante della fase 8).
 */
export async function materializeEnvAndInstall<R extends RepoStepsRepo>(
  steps: RepoStepsDeps,
  states: RepoState<R>[],
): Promise<void> {
  for (const state of states) {
    const repoName = state.prepared.name;
    try {
      const files = await steps.loadEnvFilesFn(
        steps.db,
        state.prepared.repositoryId,
        steps.encryptionKey,
        "test",
      );
      const { writtenPaths, env } = await steps.materializeEnvFilesFn(state.dir, files);
      state.envProcessEnv = env;
      state.envExcludePathspecs = writtenPaths.map((p) => `:(exclude)${p}`);
      if (writtenPaths.length > 0) {
        await log(steps, `'${repoName}': file d'ambiente materializzati (${writtenPaths.length} file)`);
      }
    } catch (envErr) {
      const message = envErr instanceof Error ? envErr.message : String(envErr);
      await log(steps, `'${repoName}': file d'ambiente: errore inatteso (proseguo senza): ${message}`);
    }
    // INSTALL delle dipendenze del repo (se ha un comando risolvibile):
    // popola node_modules per i test del self-repair. Un install fallito
    // (exit non-zero) è un DATO, non un throw: si logga e si prosegue.
    // L'install eredita l'env del worker (NON l'env ristretto dell'agente)
    // con NODE_ENV neutralizzato (le devDeps servono ai runner di test).
    try {
      const installCmd = await steps.resolveInstallCommandFn(
        { installCommand: state.prepared.installCommand },
        state.dir,
      );
      if (installCmd) {
        await log(
          steps,
          `'${repoName}': install dipendenze (${installCmd.cmd} ${installCmd.args.join(" ")})…`,
        );
        const install = await steps.runInstallCommand(
          installCmd,
          state.dir,
          steps.installTimeoutMs,
          state.envProcessEnv,
        );
        await log(
          steps,
          install.exitCode === 0
            ? `'${repoName}': install dipendenze: ok`
            : `'${repoName}': install dipendenze: fallito (exit ${install.exitCode})\n${install.output}`,
        );
      }
    } catch (installErr) {
      const message = installErr instanceof Error ? installErr.message : String(installErr);
      await log(steps, `'${repoName}': install dipendenze: errore inatteso: ${message}`);
    }
  }
}

/**
 * Esclusione del report da OGNI `git add`/`status` di un worktree. Il report
 * va scritto nella radice della cartella del run, FUORI dai worktree; ma un
 * agente può scriverlo per errore dentro il repo, anche in una sottocartella o
 * con un nome suo (`stubwise_report.md`, `STUBWISE_REPORT-final.md`). Il
 * pathspec copre `STUBWISE_REPORT*` a ogni profondità (`glob`: `**\/` vale anche
 * per zero cartelle) senza distinguere maiuscole (`icase`). Nessun altro file è
 * escluso: `MY_STUBWISE_REPORT.md` entra come ogni file normale.
 */
export const REPORT_EXCLUDE_PATHSPEC = `:(exclude,icase,glob)**/${REPORT_FILENAME.replace(/\.md$/, "")}*`;

/**
 * Stage di TUTTI i worktree (escludendo report + env), poi ritorna quali
 * repo hanno effettivamente un diff. È il "il repo ha modifiche?" del
 * multi-repo: si guarda `git status --porcelain` in OGNI sottocartella,
 * scontando i file env materializzati e l'eventuale report (che comunque
 * vive fuori dai worktree). Il report è escluso per igiene.
 */
async function stageAndDetectChanged<R extends RepoStepsRepo>(
  states: RepoState<R>[],
): Promise<RepoState<R>[]> {
  const changed: RepoState<R>[] = [];
  for (const state of states) {
    await gitIn(state.dir, [
      "add",
      "-A",
      "--",
      ".",
      REPORT_EXCLUDE_PATHSPEC,
      ...state.envExcludePathspecs,
    ]);
    const status = await gitIn(state.dir, [
      "status",
      "--porcelain",
      "--",
      ".",
      REPORT_EXCLUDE_PATHSPEC,
      ...state.envExcludePathspecs,
    ]);
    if (status.trim() !== "") {
      state.changedFiles = parsePorcelainPaths(status);
      changed.push(state);
    }
  }
  return changed;
}

/**
 * Esegue i test dei repo modificati che hanno un comando RISOLVIBILE (via
 * resolveTestCommandFn: la risoluzione, non la sola colonna DB, decide).
 * Ritorna l'esito aggregato: `redOutput` non-null = almeno un repo rosso (col
 * suo output, prefissato dal nome); null = tutti verdi O nessun repo con test
 * risolvibile (→ commit diretto).
 */
async function runRepoTests<R extends RepoStepsRepo>(
  steps: RepoStepsDeps,
  changed: RepoState<R>[],
): Promise<{
  redOutput: string | null;
  // Fase 8, Task 6: costruita man mano — "passed"/"skipped" per i
  // repo già superati in QUESTO giro; vuota/parziale se il giro si
  // ferma su un rosso (scartata dal chiamante in quel caso, si
  // riparte da capo al prossimo tentativo).
  statuses: Map<string, "passed" | "skipped">;
}> {
  const statuses = new Map<string, "passed" | "skipped">();
  for (const state of changed) {
    const testCmd = await steps.resolveTestCommandFn(
      { testCommand: state.prepared.testCommand },
      state.dir,
    );
    if (!testCmd) {
      statuses.set(state.prepared.repositoryId, "skipped");
      continue;
    }
    const test = await steps.runTestCommand(
      testCmd,
      state.dir,
      steps.testTimeoutMs,
      state.envProcessEnv,
    );
    await log(
      steps,
      `'${state.prepared.name}': test ${test.exitCode === 0 ? "verdi" : `rossi (exit ${test.exitCode})`}`,
    );
    if (test.exitCode !== 0) {
      return { redOutput: `[${state.prepared.name}]\n${test.output}`, statuses };
    }
    statuses.set(state.prepared.repositoryId, "passed");
  }
  return { redOutput: null, statuses };
}

/** Input del loop di self-repair. */
export interface SelfRepairLoopInput<R extends RepoStepsRepo> {
  states: RepoState<R>[];
  /** RE-tentativi massimi (0 = niente loop: stage una volta, test non eseguiti). */
  maxAttempts: number;
  /** Output del run di esecuzione iniziale (per NoChangesError e il report). */
  initialOutput: string;
  /** Chiamato (e ATTESO) PRIMA di ogni riparazione: può lanciare, anche in
   * modo asincrono, BudgetExceededError — la riparazione allora non parte. */
  beforeRepair: () => void | Promise<void>;
  /** Lancia la riparazione con l'output dei test rossi; torna il nuovo output
   * dell'agente. Limite/exit non-zero li gestisce lei, lanciando. */
  repair: (redOutput: string) => Promise<string>;
}

/**
 * LOOP di self-repair (Task 5), esteso al multi-repo: il WORKER esegue da sé i
 * test dei repo MODIFICATI (quelli con un comando di test risolvibile) e,
 * finché QUALCUNO è rosso, reinvoca l'agente con l'output del fallimento, fino
 * a `maxAttempts` riparazioni. Solo con TUTTI i test verdi si procede a
 * commit/push. Nessun repo modificato → NoChangesError; rossi dopo l'ultimo
 * tentativo → SelfRepairFailedError. Con self-repair disattivato (maxAttempts
 * 0) si salta il loop: stage + detect una volta sola, e ogni repo risulta
 * "skipped" (nessun test è girato: la distinzione passed/skipped è il punto
 * della fase 8, Task 6).
 */
export async function runSelfRepairLoop<R extends RepoStepsRepo>(
  steps: RepoStepsDeps,
  input: SelfRepairLoopInput<R>,
): Promise<{
  changed: RepoState<R>[];
  testStatusByRepo: Map<string, "passed" | "skipped">;
  output: string;
}> {
  let output = input.initialOutput;
  if (input.maxAttempts > 0) {
    for (let attempt = 0; ; attempt++) {
      const changed = await stageAndDetectChanged(input.states);
      // Nessun repo modificato → NoChangesError (come oggi il caso a 1 repo).
      if (changed.length === 0) throw new NoChangesError(output);

      const { redOutput, statuses } = await runRepoTests(steps, changed);
      await log(
        steps,
        `self-repair tentativo ${attempt}: ${redOutput === null ? "tutti i test verdi" : "test rossi"}`,
      );
      // Tutti verdi → commit/push.
      if (redOutput === null) return { changed, testStatusByRepo: statuses, output };
      if (attempt >= input.maxAttempts) {
        throw new SelfRepairFailedError(redOutput, output);
      }
      await input.beforeRepair();
      output = await input.repair(redOutput); // Aggiorna l'output dell'agente per report/log.
    }
  }
  // Nessun comando di test risolvibile (o self-repair disattivato): stage +
  // detect una sola volta, come il flusso senza self-repair.
  const changed = await stageAndDetectChanged(input.states);
  if (changed.length === 0) throw new NoChangesError(output);
  return {
    changed,
    // Nessun test è girato per nessuno di questi repo: tutti "skipped",
    // non "passed" — la distinzione è il punto del Task 6.
    testStatusByRepo: new Map(
      changed.map((state) => [state.prepared.repositoryId, "skipped" as const]),
    ),
    output,
  };
}

/**
 * Il report è il corpo delle PR e NON deve MAI finire nei commit. Sta nella
 * RADICE del run (parentDir), FUORI dai worktree dei repo: `git add` dentro un
 * worktree non lo raggiunge mai. Va letto e rimosso DOPO che i test sono verdi
 * (l'agente può riscriverlo nelle riparazioni). Se è una DIRECTORY (output
 * malformato) lo trattiamo come mancante; mancante → null, decide il chiamante.
 */
export async function readAndRemoveReport(parentDir: string): Promise<string | null> {
  const reportPath = join(parentDir, REPORT_FILENAME);
  try {
    const info = await stat(reportPath);
    if (info.isDirectory()) {
      await rm(reportPath, { recursive: true, force: true });
      return null; // Malformato: fallback.
    }
    const content = await readFile(reportPath, "utf8");
    await rm(reportPath);
    return content;
  } catch {
    return null; // Mancante: si decide fuori (fallback, il fix ha valore).
  }
}

/** Commit del worktree con l'identità di Stubwise (autore Stubwise AI), env
 * materializzati esclusi dal `git add` (SAFEGUARD anti-leak) e report escluso
 * (`REPORT_EXCLUDE_PATHSPEC`): il commit non dipende dal fatto che il chiamante
 * abbia già fatto lo stage con `stageAndDetectChanged`. */
export async function commitAsStubwise<R extends RepoStepsRepo>(
  state: RepoState<R>,
  message: string,
): Promise<void> {
  await gitIn(state.dir, ["add", "-A", "--", ".", REPORT_EXCLUDE_PATHSPEC, ...state.envExcludePathspecs]);
  await gitIn(state.dir, [
    "-c",
    "user.name=Stubwise AI",
    "-c",
    "user.email=ai@stubwise",
    "commit",
    "-m",
    message,
  ]);
}
