import {
  agentQuestions,
  automationRules,
  comments,
  decrypt,
  gitAccounts,
  instanceSettings,
  monthlyCostUsd,
  projects,
  repositories,
  ticketCostUsd,
  ticketRepositories,
  tickets,
  type Db,
} from "@stubwise/db";
import { getProvider, type GitProvider } from "@stubwise/git";
import { t } from "@stubwise/i18n";
import type { GitProviderKind } from "@stubwise/shared";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { execa } from "execa";
import { existsSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  AgentRunError,
  AgentTimeoutError,
  type AgentRunner,
  type AgentRunResult,
  type AgentRunUsage,
} from "../agent/runner.js";
import { mirrorSlug, MirrorManager, type MirrorProject } from "../git/mirrors.js";
import { GRAPHIFY_AGENT_ALLOWED_TOOLS, resolveRepoGraphJson } from "../graph/agent-hint.js";
import type { ResolvedProvider } from "../providers/chain.js";
import { isLimitError, ProviderLimitError } from "../providers/limit.js";
import {
  appendLog,
  completeJob,
  failJob,
  holdJob,
  parkForInput,
  parkForPlanApproval,
  recordAgentRun,
  touchJob,
  type AiJob,
} from "../queue.js";
import { getContentLanguage } from "../settings.js";
import {
  ASK_USER_FILENAME,
  ASK_USER_MCP_SERVER_KEY,
  ASK_USER_TOOL_PATTERN,
  DEFAULT_AGENT_QUESTION_MAX_ROUNDS,
  askUserServerPath,
  planParentDir,
  readAskUserQuestion,
  type AskUserPayload,
} from "./ask-user.js";
import { notify, ticketUrl, type NotifyDeps } from "./notify.js";
import {
  buildFixExecutePrompt,
  buildFixPlanPrompt,
  buildFixPrompt,
  buildFixRepairPrompt,
  REPORT_FILENAME,
  toSingleLine,
} from "./prompts.js";
import { resolveInstallCommand } from "./install-command.js";
import { resolveTestCommand, type TestCommand } from "./test-command.js";
import {
  loadProjectEnvFiles,
  materializeEnvFiles,
  type LoadedEnvFile,
} from "./env-files.js";

/**
 * Fase 2 della pipeline: il fix, PER PROGETTO (Fase 3). Il job è già in stato
 * `fixing` (markFixing dal triage). L'agente lavora alla RADICE di una cartella
 * progetto che contiene un worktree per OGNI repo del progetto (sottocartelle,
 * come in un monorepo), tutti sul branch `stubwise/ticket-<numero>` (numero di
 * progetto). L'agente decide da sé quali repo toccare; il worker (NON l'agente)
 * committa i repo modificati con autore `Stubwise AI <ai@stubwise>`, pusha il
 * branch e apre UNA PR per repo modificato (report come corpo), inserisce una riga
 * `ticket_repositories` per ciascuna e porta il ticket in `in_review`. Un progetto
 * a 1 repo degrada naturalmente al comportamento storico (una PR, una riga).
 *
 * SERIALIZZAZIONE PER PROGETTO (requisito review): runFix non si difende da un
 * secondo runFix CONCORRENTE sullo stesso progetto — il `fetch --prune` di
 * ensureMirror cancellerebbe i ref stubwise/* non ancora pushati dell'altro job
 * (vedi docblock di mirrors.ts). runFix è progettato per essere chiamato
 * SERIALMENTE per progetto: è il wiring del worker (handler.ts) a garantirlo con
 * una catena di promise per projectId; progetti diversi procedono in parallelo
 * senza rischi (mirror e ref indipendenti).
 *
 * Permessi dell'agente (requisito review): in headless `--permission-mode
 * acceptEdits` consente le modifiche ai file ma NEGA Bash, mentre il prompt
 * di fix chiede di ESEGUIRE i test esistenti. Per questo si passa
 * `allowedTools` al runner con i pattern dei comandi di test più comuni
 * (default qui sotto, configurabile via deps): tutto il resto di Bash resta
 * negato, l'agente non può fare `git push` né altro.
 */

/** Tool extra consentiti all'agente di fix oltre ad acceptEdits: SOLO i
 * comandi di test più comuni. Configurabile via FixDeps.allowedTools. */
export const DEFAULT_FIX_ALLOWED_TOOLS = [
  "Bash(npm test:*)",
  "Bash(npm run test:*)",
  "Bash(pnpm test:*)",
  "Bash(pnpm run test:*)",
  "Bash(npx vitest:*)",
  "Bash(npx jest:*)",
];

/** Timeout di default del fix (30'): la fase lunga. Esportato per l'invariante
 * di staleness verificata all'avvio del worker (vedi index.ts). */
export const DEFAULT_FIX_TIMEOUT_MS = 1_800_000;

/** Timeout di default del run di PIANIFICAZIONE (10'): sola analisi, più corto
 * del fix. Esportato per l'invariante di staleness (vedi index.ts), che con il
 * fix in due fasi conta plan + execute invece di 2× execute. */
export const DEFAULT_FIX_PLAN_TIMEOUT_MS = 600_000;

/** Turni di default del run di pianificazione: meno del fix (sola analisi). */
const DEFAULT_PLAN_MAX_TURNS = 40;

/** RE-tentativi di default del loop di self-repair (Task 5): dopo il run di
 * esecuzione iniziale, fino a N riparazioni con feedback dei test. 0 =
 * disattivato. Esportato per l'invariante di staleness (vedi index.ts). */
export const DEFAULT_SELF_REPAIR_MAX_ATTEMPTS = 2;

/** Timeout di default di OGNI esecuzione del comando di test nel self-repair
 * (5'). Esportato per l'invariante di staleness (vedi index.ts). */
export const DEFAULT_SELF_REPAIR_TEST_TIMEOUT_MS = 300_000;

/** Timeout di default dell'install delle dipendenze nel worktree (10'):
 * l'install di un repo grande può essere lento. Tenuto in sync con
 * `installTimeoutMs` del WorkerConfig (vedi invariante di staleness). */
export const DEFAULT_INSTALL_TIMEOUT_MS = 600_000;

/** Output del comando di test eseguito dal worker. */
export interface TestRunResult {
  exitCode: number;
  /** stdout + stderr combinati, troncato. */
  output: string;
}

/** Tetto per l'output del comando di test (stdout+stderr) catturato: i runner
 * possono produrre log enormi; per la riparazione e il log bastano i primi
 * caratteri. */
const TEST_RUN_OUTPUT_MAX_CHARS = 16_000;

/**
 * Esegue un comando nel worktree catturandone l'output (helper condivisa dai
 * default iniettabili di FixDeps per test e install). Un exit non-zero NON è un
 * errore (reject:false): per i test è il segnale che sono rossi, per l'install
 * è un dato che il chiamante logga e con cui prosegue; in entrambi i casi è il
 * chiamante a decidere. stdout+stderr combinati e troncati a
 * TEST_RUN_OUTPUT_MAX_CHARS per non gonfiare prompt/log. Eredita l'env del
 * worker (NON l'env ristretto dell'agente): l'install ha bisogno dell'ambiente
 * reale del container (PATH, registri, ecc.).
 *
 * UNICA eccezione: NODE_ENV viene NEUTRALIZZATO per il sottoprocesso. L'immagine
 * runtime del worker ha NODE_ENV=production (apps/worker/Dockerfile), giusto per
 * il worker stesso; ma install e test del repo TARGET devono girare come un
 * normale checkout di CI. Sotto NODE_ENV=production tutti i package manager
 * OMETTONO le devDependencies (npm ci/install, pnpm == --prod, yarn): i runner di
 * test (vitest/jest) SONO devDependencies, quindi l'install riuscirebbe ma il
 * binario di test mancherebbe (exit 127 "vitest: not found"). execa ha
 * extendEnv:true di default (eredita process.env); passare NODE_ENV: undefined
 * RIMUOVE la chiave per il figlio (verificato dal test: il figlio vede UNSET),
 * lasciando intatto il resto dell'env reale del container. */
async function runCommandCaptured(
  cmd: TestCommand,
  dir: string,
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
): Promise<TestRunResult> {
  const result = await execa(cmd.cmd, cmd.args, {
    cwd: dir,
    timeout: timeoutMs,
    reject: false,
    all: true,
    // Le variabili d'ambiente del progetto (extraEnv) sono iniettate per
    // install/test; NODE_ENV resta PER ULTIMO così la neutralizzazione (vedi
    // sopra) non è sovrascrivibile dalle var utente.
    env: { ...extraEnv, NODE_ENV: undefined },
  });
  const combined = result.all ?? `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const output =
    combined.length > TEST_RUN_OUTPUT_MAX_CHARS
      ? `${combined.slice(0, TEST_RUN_OUTPUT_MAX_CHARS)}\n[output troncato]`
      : combined;
  return { exitCode: result.exitCode ?? 1, output };
}

/**
 * Esegue il comando di test nel worktree (default iniettabile di FixDeps). Un
 * exit non-zero NON è un errore: è il segnale che i test sono rossi (reject:
 * false). Delega a runCommandCaptured (stdout+stderr combinati e troncati). */
async function defaultRunTestCommand(
  cmd: TestCommand,
  dir: string,
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
): Promise<TestRunResult> {
  return runCommandCaptured(cmd, dir, timeoutMs, extraEnv);
}

/**
 * Esegue l'install delle dipendenze nel worktree (default iniettabile di
 * FixDeps), speculare a defaultRunTestCommand. Un exit non-zero NON è un errore
 * (reject:false): è un dato che il chiamante logga e con cui prosegue comunque.
 * Delega a runCommandCaptured, che eredita l'env del worker (NON l'env ristretto
 * dell'agente: l'install ha bisogno dell'ambiente reale del container) e tronca
 * l'output per non gonfiare il log. */
export async function defaultRunInstallCommand(
  cmd: TestCommand,
  dir: string,
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
): Promise<TestRunResult> {
  return runCommandCaptured(cmd, dir, timeoutMs, extraEnv);
}

export interface FixDeps extends NotifyDeps {
  db: Db;
  runner: AgentRunner;
  mirrors: MirrorManager;
  /** Chiave AES-256 per decifrare projects.encryptedCredentials. */
  encryptionKey: Buffer;
  /** Iniettabile nei test: provider FINTO senza HTTP. Default: getProvider. */
  getProviderFn?: (kind: GitProviderKind) => Pick<GitProvider, "openPullRequest">;
  /** Modello per il fix monolitico (FIX_TWO_PHASE=false); omesso = default del
   * CLI. Nel percorso a due fasi i modelli sono planModel/executeModel. */
  model?: string;
  /** Fix in DUE FASI: pianificazione (planModel, read-only) + esecuzione
   * (executeModel). Default true. */
  twoPhase?: boolean;
  /** Modello del run di pianificazione (forte, read-only; default "opus"). */
  planModel?: string;
  /** Modello del run di esecuzione (economico; default "sonnet"). */
  executeModel?: string;
  /** Timeout del run di pianificazione (default 10 minuti). */
  planTimeoutMs?: number;
  /** Turni agentici massimi del run di esecuzione/fix (default 80). */
  maxTurns?: number;
  /** Timeout complessivo del run di esecuzione/fix (default 30 minuti). */
  timeoutMs?: number;
  /** Override dei tool extra consentiti (default DEFAULT_FIX_ALLOWED_TOOLS). */
  allowedTools?: string[];
  /** Radice del volume dei knowledge graph (GRAPHS_DIR): quando presente, i
   * repo con un grafo costruito ricevono nel prompt il blocco CODE GRAPH e
   * nell'allowlist i comandi read-only di graphify. Assente nei test legacy. */
  graphsDir?: string;
  /** Intervallo dell'heartbeat in ms (default HEARTBEAT_INTERVAL_MS).
   * Iniettabile nei test per verificare il bump senza attendere 60s. */
  heartbeatIntervalMs?: number;
  /** Loop di self-repair: RE-tentativi massimi dopo il run di esecuzione
   * iniziale (default 2; 0 = disattivato). Vedi DEFAULT_SELF_REPAIR_MAX_ATTEMPTS. */
  selfRepairMaxAttempts?: number;
  /** Timeout di ogni esecuzione del comando di test nel self-repair (default
   * 300000 = 5'). */
  testTimeoutMs?: number;
  /** Risolve il comando di test del repo nel worktree (iniettabile nei test).
   * Default: resolveTestCommand da ./test-command.js. */
  resolveTestCommandFn?: (
    project: { testCommand: string | null },
    dir: string,
  ) => Promise<TestCommand | null>;
  /** Esegue il comando di test nel worktree (iniettabile nei test). Default:
   * spawn con execa (reject:false). extraEnv = variabili d'ambiente del progetto
   * iniettate nel sottoprocesso (NODE_ENV resta neutralizzato). */
  runTestCommand?: (
    cmd: TestCommand,
    dir: string,
    timeoutMs: number,
    extraEnv?: Record<string, string>,
  ) => Promise<TestRunResult>;
  /** Risolve il comando di install del repo nel worktree (iniettabile nei
   * test). Default: resolveInstallCommand da ./install-command.js. */
  resolveInstallCommandFn?: (
    project: { installCommand: string | null },
    dir: string,
  ) => Promise<TestCommand | null>;
  /** Esegue l'install delle dipendenze nel worktree (iniettabile nei test).
   * Default: spawn con execa (reject:false). extraEnv = variabili d'ambiente del
   * progetto iniettate nel sottoprocesso (NODE_ENV resta neutralizzato). */
  runInstallCommand?: (
    cmd: TestCommand,
    dir: string,
    timeoutMs: number,
    extraEnv?: Record<string, string>,
  ) => Promise<TestRunResult>;
  /** Timeout dell'install delle dipendenze (default 600000 = 10'). */
  installTimeoutMs?: number;
  /** Carica i file d'ambiente del repository decifrati (iniettabile nei test).
   * Default: loadProjectEnvFiles da ./env-files.js. */
  loadEnvFilesFn?: (
    db: Db,
    repositoryId: string,
    encryptionKey: Buffer,
  ) => Promise<LoadedEnvFile[]>;
  /** Materializza i file d'ambiente nel worktree e costruisce la mappa env
   * (iniettabile nei test). Default: materializeEnvFiles da ./env-files.js. */
  materializeEnvFilesFn?: (
    dir: string,
    files: LoadedEnvFile[],
  ) => Promise<{ writtenPaths: string[]; env: Record<string, string> }>;
  /** Costo USD storico già registrato per il ticket (iniettabile nei test;
   * default ticketCostUsd da @stubwise/db). Usato dai controlli di budget. */
  ticketCostUsdFn?: (db: Db, ticketId: string) => Promise<number>;
  /** Costo USD del mese corrente d'istanza (iniettabile nei test; default
   * monthlyCostUsd da @stubwise/db). Usato dal controllo di budget mensile. */
  monthlyCostUsdFn?: (db: Db) => Promise<number>;
  /** Credenziale del provider AI selezionata per il job (catena, prima voce):
   * passata a ogni runner.run (plan/execute/repair) per l'iniezione dell'auth.
   * Assente = auth storica (env del container / OAuth del volume). */
  provider?: ResolvedProvider;
  /** Entry del server MCP `ask_user` da lanciare con `node` (iniettabile nei
   * test). Default: risolta accanto al modulo (vedi ./ask-user.ts). Se il file
   * non esiste il tool viene DISATTIVATO con una riga nel log del job. */
  askUserServerPath?: string;
  /** Tetto di round di domanda per job (default 5, vedi ./ask-user.ts). */
  questionMaxRounds?: number;
}

export type FixOutcome =
  | "pr_opened"
  | "failed"
  | "awaiting_approval"
  /** La pianificazione si è fermata su una domanda all'umano: il job è
   * parcheggiato in `awaiting_input` (NON chiuso) e riprenderà dalla risposta.
   * Come "awaiting_approval" per il chiamante: nessun failover, niente retry. */
  | "awaiting_input"
  | "held"
  /** Il provider AI ha risposto con un limite di rate/usage PRIMA di qualunque
   * effetto osservabile (push/PR): il job NON è stato chiuso (niente failJob),
   * il chiamante (handler.ts) farà failover sulla credenziale successiva o
   * metterà il job in held se la catena è esaurita. */
  | "limit";

/** Modalità di esecuzione del fix, risolta PRIMA di toccare il repo. */
type FixMode = "full" | "plan-only" | "execute-only";

/** Riga `tickets` (campi usati per risolvere la modalità). */
type Ticket = typeof tickets.$inferSelect;

/**
 * Risolve la modalità del fix dal job e dalle regole di automazione del tipo
 * del ticket:
 * - `execute-only`: il piano è già stato approvato (resumeMode="execute" con un
 *   planText): si salta la pianificazione e si esegue direttamente dal piano.
 * - `plan-only`: il job porta il gate `plan_approval_required` (è stato chiesto
 *   da un operatore, vedi sotto) OPPURE per il tipo del ticket è impostata una
 *   soglia di approvazione del piano (`plan_approval_min_effort`) e l'effort
 *   stimato la raggiunge: si pianifica e ci si ferma in attesa dell'ok umano.
 * - `full`: comportamento storico (plan + execute in fila).
 *
 * NOTA: il gate di approvazione del piano è ORTOGONALE a `manualTrigger`. Un
 * avvio a mano NON aggira l'approvazione: un fix rischioso (effort alto, o
 * chiesto da un operatore) deve comunque proporre un piano e attendere l'ok
 * umano prima di toccare il codice.
 */
async function resolveFixMode(db: Db, job: AiJob, ticket: Ticket): Promise<FixMode> {
  if (job.resumeMode === "execute" && job.planText) return "execute-only";
  // Job lanciato da un utente `member` (operatore): il server ha acceso
  // `planApprovalRequired` perché il piano va approvato da un maintainer,
  // QUALUNQUE sia l'effort del ticket e la soglia del tipo. Sta DOPO il ramo
  // execute-only di proposito: se il job arriva con resumeMode="execute" e un
  // planText è perché quel piano è GIÀ passato dall'approvazione del
  // maintainer (resolvePlan), e ri-pianificare sarebbe un ciclo infinito.
  if (job.planApprovalRequired) return "plan-only";
  const [rule] = await db
    .select({ minEffort: automationRules.planApprovalMinEffort })
    .from(automationRules)
    .where(eq(automationRules.type, ticket.type));
  const minEffort = rule?.minEffort ?? null;
  if (minEffort !== null && ticket.effort !== null && ticket.effort >= minEffort) {
    return "plan-only";
  }
  return "full";
}

/** Tetto per gli output dell'agente accodati al log del job. */
const LOG_OUTPUT_MAX_CHARS = 4000;

/** Tetto per il titolo del ticket dentro titolo PR / messaggio di commit. */
const TITLE_MAX_CHARS = 200;

/**
 * Intervallo dell'heartbeat durante il run dell'agente. Il fix può durare fino
 * a 30' (DEFAULT_FIX_TIMEOUT_MS) ma non scrive nel log mentre l'agente lavora:
 * senza heartbeat requeueStale lo crederebbe orfano e lo riporterebbe in coda,
 * generando una PR DUPLICATA sullo stesso progetto. Un touchJob ogni 60s tiene
 * fresco lastActivityAt; 60s è << della soglia di staleness (≥ 30 min), così
 * un job davvero stuck (interval morto col processo) viene comunque recuperato. */
const HEARTBEAT_INTERVAL_MS = 60_000;

function truncateForLog(output: string): string {
  return output.length > LOG_OUTPUT_MAX_CHARS
    ? `${output.slice(0, LOG_OUTPUT_MAX_CHARS)}\n[output troncato]`
    : output;
}

/** L'agente ha terminato ma non ha prodotto nessuna modifica committabile. */
class NoChangesError extends Error {
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
class AgentExitError extends Error {
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
class SelfRepairFailedError extends Error {
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
 * `automation_rules.max_cost_usd`. NON è un fallimento: esce da withWorktree e
 * nel catch di runFix porta al percorso budget-held (holdJob + commento +
 * notifica), MAI a failJob. Lo scope è sempre "ticket" (il tetto mensile è
 * controllato solo pre-fix, fuori dal loop).
 */
class BudgetExceededError extends Error {
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

/** Forma attesa delle credenziali git decifrate (vedi routes/projects.ts). */
const credentialsSchema = z.object({
  username: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  token: z.string().min(1),
});

/** git nel worktree: comandi locali (add/commit/status), niente auth. */
async function gitIn(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execa("git", args, { cwd: dir, timeout: 120_000 });
  return stdout;
}

/**
 * Esegue la fase di fix del job (già `fixing`). Il job viene SEMPRE chiuso
 * qui dentro (completeJob/failJob); se la ownership è persa al momento della
 * chiusura non si sovrascrive nulla (solo una riga di log in append).
 * DA CHIAMARE serialmente per progetto: vedi docblock del modulo.
 */
export async function runFix(deps: FixDeps, job: AiJob): Promise<FixOutcome> {
  const { db, runner, mirrors } = deps;
  const maxTurns = deps.maxTurns ?? 80;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_FIX_TIMEOUT_MS;
  const allowedTools = deps.allowedTools ?? DEFAULT_FIX_ALLOWED_TOOLS;
  const getProviderFn = deps.getProviderFn ?? getProvider;
  const twoPhase = deps.twoPhase ?? true;
  const planModel = deps.planModel ?? "opus";
  const executeModel = deps.executeModel ?? "sonnet";
  const planTimeoutMs = deps.planTimeoutMs ?? DEFAULT_FIX_PLAN_TIMEOUT_MS;
  const selfRepairMaxAttempts = deps.selfRepairMaxAttempts ?? DEFAULT_SELF_REPAIR_MAX_ATTEMPTS;
  const testTimeoutMs = deps.testTimeoutMs ?? DEFAULT_SELF_REPAIR_TEST_TIMEOUT_MS;
  const resolveTestCommandFn = deps.resolveTestCommandFn ?? resolveTestCommand;
  const runTestCommand = deps.runTestCommand ?? defaultRunTestCommand;
  const resolveInstallCommandFn = deps.resolveInstallCommandFn ?? resolveInstallCommand;
  const runInstallCommand = deps.runInstallCommand ?? defaultRunInstallCommand;
  const installTimeoutMs = deps.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  const loadEnvFilesFn = deps.loadEnvFilesFn ?? loadProjectEnvFiles;
  const materializeEnvFilesFn = deps.materializeEnvFilesFn ?? materializeEnvFiles;
  const ticketCostUsdFn = deps.ticketCostUsdFn ?? ticketCostUsd;
  const monthlyCostUsdFn = deps.monthlyCostUsdFn ?? monthlyCostUsd;
  // Credenziale del provider per QUESTO job: spread in ogni runner.run così
  // l'auth è iniettata per kind (vedi buildAgentEnv). Assente = auth storica.
  const providerOpt = deps.provider !== undefined ? { provider: deps.provider } : {};

  // Lingua dei contenuti generati (report nel prompt + commenti AI sul ticket),
  // risolta UNA VOLTA per job: tutti i prompt e i `t(lang, ...)` di seguito la
  // condividono, così il fix parla una sola lingua anche se l'impostazione
  // d'istanza cambia a metà.
  const lang = await getContentLanguage(db);

  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, job.ticketId));
  if (!ticket) {
    await failJob(db, job.id, {
      log: `[fix] ticket ${job.ticketId} non trovato`,
      error: "ticket del job non trovato",
    });
    return "failed";
  }
  // Carica il PROGETTO del ticket (nome, per le notifiche) e TUTTI i suoi
  // repository con l'account git collegato: il fix (Fase 3) gira sull'intera
  // cartella progetto, con un worktree per ogni repo del progetto. Le credenziali
  // vivono sull'account (riutilizzabile tra repository), non sul repo.
  const [projectRow] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, ticket.projectId));
  if (!projectRow) {
    await failJob(db, job.id, {
      log: `[fix] progetto ${ticket.projectId} del ticket non trovato`,
      error: "progetto del ticket non trovato",
    });
    return "failed";
  }
  const projectName = projectRow.name;
  const repoRows = await db
    .select({ repository: repositories, account: gitAccounts })
    .from(repositories)
    .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
    .where(eq(repositories.projectId, ticket.projectId))
    .orderBy(asc(repositories.slug));
  // Un fix richiede almeno un repository nel progetto: senza repo non c'è nulla
  // su cui lavorare. Non dovrebbe accadere (un progetto operativo ha ≥ 1 repo).
  if (repoRows.length === 0) {
    await failJob(db, job.id, {
      log: `[fix] il progetto ${ticket.projectId} non ha repository: impossibile eseguire il fix`,
      error: "progetto senza repository",
    });
    return "failed";
  }
  // Contesto comune alle notifiche di QUESTA fase (best-effort, post-commit).
  const notifyDeps: NotifyDeps = {
    ...(deps.publicUrl !== undefined ? { publicUrl: deps.publicUrl } : {}),
    projectName,
    ...(deps.publish !== undefined ? { publish: deps.publish } : {}),
  };
  const url = ticketUrl(deps.publicUrl, ticket.id);
  /** Riferimenti comuni a TUTTE le notifiche di questa fase: il fix conosce
   * progetto, ticket e job del run, e li porta su ogni evento. */
  const notifyRefs = { projectId: ticket.projectId, ticketId: ticket.id, jobId: job.id };
  /** Notifica job.failed best-effort dopo il failJob (lo stato è già committato). */
  const notifyFailed = (error: string): Promise<void> =>
    notify(
      notifyDeps,
      db,
      {
        kind: "job.failed",
        ticketNumber: ticket.number,
        ticketTitle: ticket.title,
        projectName,
        error,
        ticketUrl: url,
      },
      notifyRefs,
    );

  /**
   * Percorso budget-held (Task 6): il job ha sforato un tetto di spesa e va
   * messo in pausa, NON fallito. Riusa la transizione holdJob (status-guarded),
   * lascia un commento AI che spiega lo sforamento e notifica job.budget_held.
   * Modellato sul gate auto-fix del triage (commento + holdJob + notify). Le
   * cifre nel commento sono arrotondate a 4 decimali per leggibilità; lo scope
   * è tradotto con le chiavi notify.scope* condivise con la notifica. */
  const fmtUsd = (n: number): string => n.toFixed(4);
  const budgetHeld = async (
    scope: "ticket" | "monthly",
    limitUsd: number,
    spentUsd: number,
  ): Promise<FixOutcome> => {
    const scopeLabel = t(lang, scope === "monthly" ? "notify.scopeMonthly" : "notify.scopeTicket");
    await db.transaction(async (tx) => {
      await tx.insert(comments).values({
        ticketId: ticket.id,
        authorType: "ai",
        body: t(lang, "comment.budgetHeld", {
          scope: scopeLabel,
          limit: fmtUsd(limitUsd),
          spent: fmtUsd(spentUsd),
        }),
      });
    });
    const held = await holdJob(db, job.id, {
      log: `[fix] budget di costo superato (${scope}): spesi $${fmtUsd(spentUsd)} sul limite di $${fmtUsd(limitUsd)} → job in pausa (held), avvio manuale per forzare`,
      // "budget": tetto di spesa superato, decisione umana (il resume poller
      // dei limiti NON lo riaccoda).
      heldReason: "budget",
    });
    if (!held) {
      await appendLog(db, job.id, "[fix] ownership persa dopo il hold per budget");
    }
    await notify(
      notifyDeps,
      db,
      {
        kind: "job.budget_held",
        ticketNumber: ticket.number,
        ticketTitle: ticket.title,
        projectName,
        scope,
        limitUsd,
        spentUsd,
        ticketUrl: url,
      },
      notifyRefs,
    );
    return "held";
  };

  // Configurazione dei tetti di spesa (Task 6), caricata SOLO se il job non è
  // avviato manualmente: un avvio a mano scavalca entrambi i controlli (un
  // umano ha già deciso di spendere). `maxCostUsd` serve anche al check
  // in-loop del self-repair, perciò resta in scope fuori dal pre-fix check.
  // I valori numeric di Postgres arrivano come stringa: Number() li converte.
  let maxCostUsd: number | null = null;
  // Costo storico del ticket (run già registrati), letto una volta per il check
  // in-loop del self-repair. È la base a cui si aggiunge la stima dei costi del
  // run corrente (fixUsages, non ancora persistiti) prima di ogni riparazione.
  let ticketCostBaseline = 0;
  if (!job.manualTrigger) {
    const [budgetRule] = await db
      .select({ maxCostUsd: automationRules.maxCostUsd })
      .from(automationRules)
      .where(eq(automationRules.type, ticket.type));
    maxCostUsd =
      budgetRule?.maxCostUsd != null && budgetRule.maxCostUsd !== ""
        ? Number(budgetRule.maxCostUsd)
        : null;
    const [settings] = await db
      .select({ monthlyBudgetUsd: instanceSettings.monthlyBudgetUsd })
      .from(instanceSettings)
      .where(eq(instanceSettings.id, 1));
    const monthlyBudgetUsd =
      settings?.monthlyBudgetUsd != null && settings.monthlyBudgetUsd !== ""
        ? Number(settings.monthlyBudgetUsd)
        : null;

    // PRE-FIX CHECK: prima di toccare il repo. Mensile prima del ticket: un
    // tetto d'istanza sforato blocca a prescindere dal singolo ticket.
    const monthlySpent = await monthlyCostUsdFn(db);
    if (monthlyBudgetUsd != null && monthlySpent >= monthlyBudgetUsd) {
      return budgetHeld("monthly", monthlyBudgetUsd, monthlySpent);
    }
    const ticketSpent = await ticketCostUsdFn(db, ticket.id);
    ticketCostBaseline = ticketSpent;
    if (maxCostUsd != null && ticketSpent >= maxCostUsd) {
      return budgetHeld("ticket", maxCostUsd, ticketSpent);
    }
  }

  // Prepara OGNI repository del progetto: decifra le credenziali del suo account
  // git e costruisce il MirrorProject. Un fallimento qui (chiave sbagliata,
  // payload manomesso, JSON inatteso su un repo) è un errore di configurazione,
  // non dell'agente: messaggio esplicito (nomina il repo), MAI il payload.
  // `repositoryId`/`installCommand`/`testCommand` restano per-repo per la
  // materializzazione env, l'install e il self-repair mirati alla sottocartella.
  interface PreparedRepo {
    repositoryId: string;
    name: string;
    installCommand: string | null;
    testCommand: string | null;
    mirrorProject: MirrorProject;
  }
  const preparedRepos: PreparedRepo[] = [];
  for (const { repository, account } of repoRows) {
    let credentials: z.infer<typeof credentialsSchema>;
    try {
      credentials = credentialsSchema.parse(
        JSON.parse(decrypt(account.encryptedCredentials, deps.encryptionKey)),
      );
    } catch {
      await failJob(db, job.id, {
        log: `[fix] impossibile decifrare le credenziali dell'account git del repository '${repository.name}' (ENCRYPTION_KEY errata o payload non valido)`,
        error: "credenziali dell'account git non decifrabili",
      });
      return "failed";
    }
    preparedRepos.push({
      repositoryId: repository.id,
      name: repository.name,
      installCommand: repository.installCommand,
      testCommand: repository.testCommand,
      mirrorProject: {
        provider: repository.provider,
        repoUrl: repository.repoUrl,
        defaultBranch: repository.defaultBranch,
        credentials,
      },
    });
  }
  // Sottocartella deterministica di ogni repo dentro la cartella progetto: la
  // stessa che withProjectWorktrees usa (mirrorSlug del repoUrl). Ci serve per
  // costruire la cornice del prompt (elenco dei repo) e, dentro la callback, per
  // ritrovare la `dir` di ciascun worktree via il suo project. La mappa è
  // repoUrl → prepared, così la callback riabbina worktree ↔ repo preparato.
  const repoByUrl = new Map(preparedRepos.map((r) => [r.mirrorProject.repoUrl, r]));
  // Etichette dei repo per il prompt (sottocartella + nome leggibile). Con un solo
  // repo renderProjectReposBlock ritorna comunque vuoto → cornice classica.
  const promptRepos = preparedRepos.map((r) => {
    // Grafo del repo sul volume (fase 2a graphify): quando esiste, il prompt
    // riceve il blocco CODE GRAPH e l'allowlist i comandi di interrogazione.
    const graphJsonPath =
      deps.graphsDir !== undefined
        ? resolveRepoGraphJson(deps.graphsDir, r.repositoryId)
        : null;
    return {
      dir: mirrorSlug(r.mirrorProject.repoUrl),
      name: r.name,
      ...(graphJsonPath !== null ? { graphJsonPath } : {}),
    };
  });
  // Allowlist dei run: i comandi read-only di graphify si aggiungono SOLO se
  // almeno un repo ha un grafo (i pattern non citati nel prompt sono rumore).
  const hasCodeGraph = promptRepos.some((r) => r.graphJsonPath !== undefined);
  const executeAllowedTools = hasCodeGraph
    ? [...allowedTools, ...GRAPHIFY_AGENT_ALLOWED_TOOLS]
    : allowedTools;
  // I run di PIANIFICAZIONE sono read-only e oggi senza Bash: si apre SOLO
  // graphify (niente comandi di test in plan mode). Il tool ask_user si
  // aggiunge più sotto, quando è davvero disponibile.
  const planGraphTools = hasCodeGraph ? GRAPHIFY_AGENT_ALLOWED_TOOLS : [];
  const branch = `stubwise/ticket-${ticket.number}`;
  const titleLine = toSingleLine(ticket.title, TITLE_MAX_CHARS);
  const prTitle = `fix: ${titleLine} (#${ticket.number})`;

  // Modalità del fix risolta PRIMA di toccare il repo: decide se pianificare e
  // basta (plan-only), riprendere dal piano approvato (execute-only) o fare
  // tutto in fila (full). Vedi resolveFixMode per il gate di approvazione.
  const fixMode = await resolveFixMode(db, job, ticket);

  await appendLog(
    db,
    job.id,
    `[fix] avviato per il ticket #${ticket.number} (branch ${branch}, modalità ${fixMode}` +
      `${twoPhase ? `, plan ${planModel} + execute ${executeModel}` : `, fase singola`})`,
  );

  // Indicazioni del team: i commenti UTENTE lasciati sul ticket (gli ultimi
  // ~10, dal più recente) entrano nei prompt di fix come input NON fidato.
  // Solo authorType 'user': i commenti AI (col piano) e gli avvisi di sistema
  // non sono indicazioni del team.
  const teamCommentRows = await db
    .select({ body: comments.body })
    .from(comments)
    .where(and(eq(comments.ticketId, ticket.id), eq(comments.authorType, "user")))
    .orderBy(desc(comments.createdAt))
    .limit(10);
  const teamComments = teamCommentRows.map((r) => r.body);

  // --- PIANIFICAZIONE INTERATTIVA (tool ask_user) ---------------------------
  // Un run di pianificazione c'è in plan-only e nella fase 1 del flusso a due
  // fasi; in execute-only (piano già approvato) e a fase singola no. Solo quei
  // run possono fermarsi su una domanda, e solo loro pagano la cornice qui
  // sotto: parent dir deterministica, server MCP, blocco di prompt.
  const hasPlanRun = fixMode === "plan-only" || (fixMode !== "execute-only" && twoPhase);
  // Entry del server MCP: risolta accanto al modulo (dist in produzione). Se
  // manca — sviluppo con tsx, build parziale — il tool NON si configura: un
  // server MCP fantasma fallirebbe in SILENZIO (l'agente non troverebbe il tool
  // e produrrebbe comunque un piano), quindi lo diciamo nel log del job.
  const askUserEntry = deps.askUserServerPath ?? askUserServerPath();
  const askUserEnabled = hasPlanRun && existsSync(askUserEntry);
  if (hasPlanRun && !askUserEnabled) {
    await appendLog(
      db,
      job.id,
      `[fix] tool ask_user non disponibile (entry '${askUserEntry}' assente): la pianificazione non potrà fare domande`,
    );
  }
  // Round della PROSSIMA domanda: le domande già poste su questo job (di
  // qualunque round e già risposte o meno) più uno. Serve sia al tool (che
  // oltre il tetto smette di registrare) sia alla riga `agent_questions`.
  const [askedSoFar] = await db
    .select({ value: count() })
    .from(agentQuestions)
    .where(eq(agentQuestions.jobId, job.id));
  const questionRound = (askedSoFar?.value ?? 0) + 1;
  const questionMaxRounds = deps.questionMaxRounds ?? DEFAULT_AGENT_QUESTION_MAX_ROUNDS;
  // Parent dir DETERMINISTICA per i run di pianificazione: la ripresa dalla
  // risposta (`--resume`) deve ritrovare la stessa cwd. withProjectWorktrees la
  // ripulisce a ogni ingresso, quindi il file-bridge di un round precedente non
  // può bloccare quello successivo. Gli altri percorsi restano su mkdtemp.
  // È per-JOB, quindi due job diversi non collidono mai; due runFix CONCORRENTI
  // sullo STESSO job si calpesterebbero, ma è già escluso a monte (claim +
  // transizioni status-guarded) e sarebbe comunque fatale sul mirror condiviso,
  // dir temporanea o no (vedi il docblock di serializzazione del modulo).
  const worktreeOptions = hasPlanRun ? { parentDir: planParentDir(job.id) } : {};
  const askUserFile = join(planParentDir(job.id), ASK_USER_FILENAME);
  // Server MCP locale al run + il suo tool in allowlist (abilitare il server non
  // basta). I parametri del bridge viaggiano SOLO nell'env del server MCP: l'env
  // del CLI è una allowlist con denylist assoluta sui segreti e non va allargata.
  const askUserOpt = askUserEnabled
    ? {
        mcpConfig: {
          servers: {
            [ASK_USER_MCP_SERVER_KEY]: {
              // process.execPath, non "node": è il node che sta già girando,
              // senza dipendere da come è fatto il PATH del processo figlio.
              command: process.execPath,
              args: [askUserEntry],
              env: {
                ASK_USER_FILE: askUserFile,
                ASK_USER_ROUND: String(questionRound),
                ASK_USER_MAX_ROUNDS: String(questionMaxRounds),
              },
            },
          },
        },
      }
    : {};
  const planAskUserPromptOpt = askUserEnabled
    ? { askUser: { round: questionRound, maxRounds: questionMaxRounds } }
    : {};
  // Allowlist dei run di pianificazione: graphify (se c'è un grafo) + il tool
  // ask_user (se il server MCP è configurato). Vuota → nessuna opzione, come
  // prima.
  const planTools = [...planGraphTools, ...(askUserEnabled ? [ASK_USER_TOOL_PATTERN] : [])];
  const planAllowedToolsOpt = planTools.length > 0 ? { allowedTools: planTools } : {};

  // Un repo effettivamente MODIFICATO dall'agente e già pushato: raccoglie ciò che
  // serve, FUORI dalla callback, per aprire la PR e inserire la riga
  // `ticket_repositories`. Il push avviene DENTRO la callback (il ref vive nel
  // mirror e sparisce all'uscita da withProjectWorktrees).
  interface ChangedRepo {
    repositoryId: string;
    name: string;
    mirrorProject: MirrorProject;
  }
  // Esito della callback withProjectWorktrees, discriminato sulla modalità: in
  // plan-only la callback produce SOLO il piano (niente report/commit/push); in
  // full/execute-only produce il fix eseguito (report + output dell'agente + i
  // repo modificati, uno per PR).
  type WorktreeResult =
    | { kind: "executed"; report: string | null; agentOutput: string; changedRepos: ChangedRepo[] }
    | { kind: "planned"; planText: string }
    /** La pianificazione si è fermata su una domanda: il payload è già stato
     * rivalidato, `cliSessionId` è la sessione CLI da riprendere (assente se il
     * run non l'ha esposta, es. timeout → la ripresa userà il fallback). */
    | { kind: "question"; payload: AskUserPayload; cliSessionId?: string };
  let worktreeResult: WorktreeResult;
  // Consumi dei run dell'agente: ogni run (plan ed execute, o l'unico run nella
  // modalità a fase singola) registra la PROPRIA riga sotto phase 'fix' così i
  // costi dei due modelli restano separati. Si accumulano qui e si registrano
  // DOPO la chiusura del worktree (best-effort, fuori dal percorso critico).
  const fixUsages: Array<AgentRunUsage | undefined> = [];
  // Registra tutti i consumi accumulati: una chiamata a recordAgentRun per
  // run (best-effort, non fa mai fallire il job).
  const recordAllUsages = async (): Promise<void> => {
    for (const usage of fixUsages) {
      await recordAgentRun(db, { jobId: job.id, phase: "fix", usage });
    }
  };
  /**
   * Legge il file-bridge dopo un run di pianificazione riuscito e, se c'è una
   * domanda valida, la trasforma nell'esito `question`.
   *
   * Due decisioni di comportamento, entrambe conservative:
   * - file MALFORMATO (JSON rotto, schema violato) → si logga e si prosegue col
   *   piano: un file corrotto non deve buttare via un run altrimenti riuscito;
   * - domanda + testo del piano nello STESSO turno → vince la DOMANDA. Il
   *   modello ha ignorato l'istruzione "termina il turno ORA": il suo piano è
   *   stato scritto senza la risposta che stava chiedendo, quindi è proprio il
   *   piano da non tenere. Il testo scartato resta nel log.
   */
  const captureQuestion = async (result: AgentRunResult): Promise<WorktreeResult | null> => {
    if (!askUserEnabled) return null;
    const read = await readAskUserQuestion(askUserFile);
    if (read.kind === "absent") return null;
    if (read.kind === "malformed") {
      await appendLog(
        db,
        job.id,
        `[fix] domanda dell'agente ignorata, file-bridge non valido (${read.reason}): proseguo con il piano`,
      ).catch(() => {
        // Log best-effort.
      });
      return null;
    }
    if (result.output.trim() !== "") {
      await appendLog(
        db,
        job.id,
        "[fix] l'agente ha registrato una domanda E prodotto testo nello stesso turno: vince la domanda, il testo del turno viene scartato\n" +
          truncateForLog(result.output),
      ).catch(() => {
        // Log best-effort.
      });
    }
    return {
      kind: "question",
      payload: read.payload,
      ...(result.sessionId !== undefined ? { cliSessionId: result.sessionId } : {}),
    };
  };
  try {
    worktreeResult = await mirrors.withProjectWorktrees(
      preparedRepos.map((r) => r.mirrorProject),
      branch,
      async ({ parentDir, worktrees }): Promise<WorktreeResult> => {
        // Heartbeat: il fix può durare a lungo (plan + execute) senza scrivere
        // nel log. Senza questo touchJob periodico, requeueStale crederebbe il
        // job orfano e ne aprirebbe un duplicato. L'interval avvolge il/i run
        // (anche il solo plan run in plan-only) ed è cancellato in finally.
        const heartbeat = setInterval(() => {
          void touchJob(db, job.id).catch(() => {
            // Un bump fallito (DB transitorio) non deve uccidere il fix: il
            // prossimo battito riproverà.
          });
        }, deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
        // unref: l'heartbeat da solo non deve tenere vivo l'event loop.
        heartbeat.unref();
        let output: string;
        let exitCode: number;
        // Stato PER-REPO: ogni repo del progetto ha il proprio worktree
        // (sottocartella di parentDir), i propri file d'ambiente materializzati (la
        // tabella env è scoped per repositoryId), il proprio pathspec di esclusione
        // anti-leak e la propria mappa env per install/test. `prepared` riabbina il
        // worktree al repo preparato (credenziali/comandi) via il repoUrl.
        interface RepoState {
          prepared: PreparedRepo;
          dir: string;
          /** Esclusione dei file env materializzati da OGNI git add/status del suo
           * worktree (SAFEGUARD anti-leak). Vuoto = nessun env. */
          envExcludePathspecs: string[];
          /** Mappa env del repo da iniettare in install/test (mai loggata). */
          envProcessEnv: Record<string, string>;
        }
        const repoStates: RepoState[] = worktrees.map(({ project: mp, dir }) => {
          const prepared = repoByUrl.get(mp.repoUrl);
          if (!prepared) {
            // Non dovrebbe accadere: withProjectWorktrees monta esattamente i repo
            // che gli passiamo. Un mismatch è un errore di programmazione.
            throw new Error(`worktree senza repo preparato per ${mp.repoUrl}`);
          }
          return { prepared, dir, envExcludePathspecs: [], envProcessEnv: {} };
        });
        try {
          // FILE D'AMBIENTE + INSTALL, PER OGNI REPO, PRIMA dell'agente. SALTATI in
          // plan-only (read-only). Ogni repo materializza i suoi env-file nel PROPRIO
          // worktree e installa le sue dipendenze lì. Tutto BEST-EFFORT: un errore
          // su un repo si logga e non blocca gli altri né il fix. I valori env non
          // vengono MAI loggati (solo il conteggio dei file).
          if (fixMode !== "plan-only") {
            for (const state of repoStates) {
              const repoName = state.prepared.name;
              try {
                const files = await loadEnvFilesFn(
                  db,
                  state.prepared.repositoryId,
                  deps.encryptionKey,
                );
                const { writtenPaths, env } = await materializeEnvFilesFn(state.dir, files);
                state.envProcessEnv = env;
                state.envExcludePathspecs = writtenPaths.map((p) => `:(exclude)${p}`);
                if (writtenPaths.length > 0) {
                  await appendLog(
                    db,
                    job.id,
                    `[fix] '${repoName}': file d'ambiente materializzati (${writtenPaths.length} file)`,
                  ).catch(() => {
                    // Log best-effort.
                  });
                }
              } catch (envErr) {
                const message = envErr instanceof Error ? envErr.message : String(envErr);
                await appendLog(
                  db,
                  job.id,
                  `[fix] '${repoName}': file d'ambiente: errore inatteso (proseguo senza): ${message}`,
                ).catch(() => {
                  // Log best-effort.
                });
              }
              // INSTALL delle dipendenze del repo (se ha un comando risolvibile):
              // popola node_modules per i test del self-repair. Un install fallito
              // (exit non-zero) è un DATO, non un throw: si logga e si prosegue.
              // L'install eredita l'env del worker (NON l'env ristretto dell'agente)
              // con NODE_ENV neutralizzato (le devDeps servono ai runner di test).
              try {
                const installCmd = await resolveInstallCommandFn(
                  { installCommand: state.prepared.installCommand },
                  state.dir,
                );
                if (installCmd) {
                  await appendLog(
                    db,
                    job.id,
                    `[fix] '${repoName}': install dipendenze (${installCmd.cmd} ${installCmd.args.join(" ")})…`,
                  ).catch(() => {
                    // Log best-effort.
                  });
                  const install = await runInstallCommand(
                    installCmd,
                    state.dir,
                    installTimeoutMs,
                    state.envProcessEnv,
                  );
                  await appendLog(
                    db,
                    job.id,
                    install.exitCode === 0
                      ? `[fix] '${repoName}': install dipendenze: ok`
                      : `[fix] '${repoName}': install dipendenze: fallito (exit ${install.exitCode})\n${install.output}`,
                  ).catch(() => {
                    // Log best-effort.
                  });
                }
              } catch (installErr) {
                const message = installErr instanceof Error ? installErr.message : String(installErr);
                await appendLog(
                  db,
                  job.id,
                  `[fix] '${repoName}': install dipendenze: errore inatteso: ${message}`,
                ).catch(() => {
                  // Log best-effort.
                });
              }
            }
          }
          // PLAN-ONLY: solo il run di pianificazione (Opus, sola lettura) SULLA
          // RADICE del progetto. Si cattura il piano, NON si esegue il fix, NON si
          // committa/pusha. Il plan run gira QUI perché l'agente deve esplorare i
          // repo reali (tutti, come sottocartelle di parentDir).
          if (fixMode === "plan-only") {
            const planResult = await runner.run({
              cwd: parentDir,
              prompt: buildFixPlanPrompt(
                { ticket, teamComments, repos: promptRepos, ...planAskUserPromptOpt },
                lang,
              ),
              model: planModel,
              permissionMode: "plan",
              maxTurns: DEFAULT_PLAN_MAX_TURNS,
              timeoutMs: planTimeoutMs,
              ...planAllowedToolsOpt,
              ...askUserOpt,
              ...providerOpt,
            });
            fixUsages.push(planResult.usage);
            // LIMITE di rate/usage (best-effort), PRIMA di qualunque effetto: la
            // pianificazione è read-only, nessun push/PR ancora. Failover.
            if (isLimitError(planResult)) throw new ProviderLimitError(planResult.output);
            // Un exit non-zero della pianificazione è un fallimento del fix
            // (gestito nel catch → failJob): niente parcheggio, niente piano.
            if (planResult.exitCode !== 0) {
              throw new AgentExitError(planResult.exitCode, planResult.output);
            }
            // Domanda all'umano: vince sul piano, il fix si ferma qui (il
            // parcheggio avviene FUORI, a worktree già smontati).
            const question = await captureQuestion(planResult);
            if (question) return question;
            return { kind: "planned", planText: planResult.output };
          }

          // FASE 1 — pianificazione (full + twoPhase): modello forte in sola
          // lettura (permission-mode "plan") sulla RADICE del progetto. In
          // execute-only si SALTA: il piano è già stato approvato (job.planText).
          let executePrompt: string;
          if (fixMode === "execute-only") {
            // job.planText è garantito non-null/non-vuoto da resolveFixMode.
            executePrompt = buildFixExecutePrompt(
              { ticket, plan: job.planText!, teamComments, repos: promptRepos },
              lang,
            );
          } else if (twoPhase) {
            const planResult = await runner.run({
              cwd: parentDir,
              prompt: buildFixPlanPrompt(
                { ticket, teamComments, repos: promptRepos, ...planAskUserPromptOpt },
                lang,
              ),
              model: planModel,
              permissionMode: "plan",
              maxTurns: DEFAULT_PLAN_MAX_TURNS,
              timeoutMs: planTimeoutMs,
              ...planAllowedToolsOpt,
              ...askUserOpt,
              ...providerOpt,
            });
            fixUsages.push(planResult.usage);
            // LIMITE di rate/usage (best-effort): la pianificazione è read-only,
            // nessun effetto osservabile ancora (push/PR a valle). Failover.
            if (isLimitError(planResult)) throw new ProviderLimitError(planResult.output);
            // Un exit non-zero della pianificazione è trattato come gli altri
            // fallimenti del fix: niente esecuzione, niente PR (vedi catch).
            if (planResult.exitCode !== 0) {
              throw new AgentExitError(planResult.exitCode, planResult.output);
            }
            // Domanda all'umano: si esce PRIMA di eseguire (niente commit,
            // niente PR); il fix riprenderà dalla risposta.
            const question = await captureQuestion(planResult);
            if (question) return question;
            executePrompt = buildFixExecutePrompt(
              { ticket, plan: planResult.output, teamComments, repos: promptRepos },
              lang,
            );
          } else {
            // Fase singola (FIX_TWO_PHASE=false): un solo run con il prompt
            // monolitico storico, come prima dell'introduzione delle due fasi.
            executePrompt = buildFixPrompt({ ticket, teamComments, repos: promptRepos }, lang);
          }

          // FASE 2 — esecuzione: modello economico, acceptEdits + allowedTools di
          // test, turni/timeout pieni, SULLA RADICE del progetto. Implementa il fix
          // e scrive il report (nella radice del progetto). In execute-only il piano
          // è già stato approvato: si usa executeModel.
          const result = await runner.run({
            cwd: parentDir,
            prompt: executePrompt,
            ...(twoPhase || fixMode === "execute-only"
              ? { model: executeModel }
              : deps.model !== undefined
                ? { model: deps.model }
                : {}),
            permissionMode: "acceptEdits",
            maxTurns,
            timeoutMs,
            allowedTools: executeAllowedTools,
            ...providerOpt,
          });
          output = result.output;
          exitCode = result.exitCode;
          // Catturato anche su exit non-zero (il CLI riporta usage comunque):
          // registrato dopo la chiusura del worktree, qualunque sia l'esito.
          fixUsages.push(result.usage);

          // LIMITE di rate/usage (best-effort): qui non è ancora stato fatto né
          // git add né commit né push — nessun effetto osservabile. Failover
          // sicuro (niente PR duplicate). Il check è PRIMA dell'AgentExitError.
          if (isLimitError(result)) throw new ProviderLimitError(output);

          if (exitCode !== 0) throw new AgentExitError(exitCode, output);

          // Il report è il corpo delle PR e NON deve MAI finire nei commit. Sta
          // nella RADICE del progetto (parentDir), FUORI dai worktree dei repo:
          // `git add` dentro un worktree non lo raggiunge mai. Letto e rimosso DOPO
          // che i test sono verdi (l'agente può riscriverlo nelle riparazioni). Se
          // è una DIRECTORY (output malformato) lo trattiamo come mancante.
          const reportPath = join(parentDir, REPORT_FILENAME);
          const readAndRemoveReport = async (): Promise<string | null> => {
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
          };

          // Stage di TUTTI i worktree (escludendo report + env), poi ritorna quali
          // repo hanno effettivamente un diff. È il "il repo ha modifiche?" del
          // multi-repo: si guarda `git status --porcelain` in OGNI sottocartella,
          // scontando i file env materializzati e l'eventuale report (che comunque
          // vive fuori dai worktree). Il report è escluso per igiene, come oggi.
          const stageAndDetectChanged = async (): Promise<RepoState[]> => {
            const changed: RepoState[] = [];
            for (const state of repoStates) {
              await gitIn(state.dir, [
                "add",
                "-A",
                "--",
                ".",
                `:(exclude)${REPORT_FILENAME}`,
                ...state.envExcludePathspecs,
              ]);
              const status = await gitIn(state.dir, [
                "status",
                "--porcelain",
                "--",
                ".",
                `:(exclude)${REPORT_FILENAME}`,
                ...state.envExcludePathspecs,
              ]);
              if (status.trim() !== "") changed.push(state);
            }
            return changed;
          };

          // LOOP di self-repair (Task 5), esteso al multi-repo: il WORKER esegue da
          // sé i test dei repo MODIFICATI (quelli con un comando di test risolvibile)
          // e, finché QUALCUNO è rosso, reinvoca l'agente sulla radice con l'output
          // del fallimento, fino a selfRepairMaxAttempts riparazioni. Solo con TUTTI
          // i test verdi si procede a commit/push. Con self-repair disattivato
          // (maxAttempts 0) si salta il loop e si committa direttamente.
          // Esegue i test dei repo modificati che hanno un comando RISOLVIBILE (via
          // resolveTestCommandFn, come il caso a 1 repo di oggi: la risoluzione, non
          // la sola colonna DB, decide). Ritorna l'esito aggregato: `redOutput`
          // non-null = almeno un repo rosso (col suo output, prefissato dal nome);
          // null = tutti verdi O nessun repo con test risolvibile (→ commit diretto).
          const runRepoTests = async (
            changed: RepoState[],
          ): Promise<{ redOutput: string | null }> => {
            for (const state of changed) {
              const testCmd = await resolveTestCommandFn(
                { testCommand: state.prepared.testCommand },
                state.dir,
              );
              if (!testCmd) continue;
              const test = await runTestCommand(
                testCmd,
                state.dir,
                testTimeoutMs,
                state.envProcessEnv,
              );
              await appendLog(
                db,
                job.id,
                `[fix] '${state.prepared.name}': test ${test.exitCode === 0 ? "verdi" : `rossi (exit ${test.exitCode})`}`,
              ).catch(() => {
                // Log best-effort.
              });
              if (test.exitCode !== 0) {
                return { redOutput: `[${state.prepared.name}]\n${test.output}` };
              }
            }
            return { redOutput: null };
          };

          let changedRepoStates: RepoState[];
          if (selfRepairMaxAttempts > 0) {
            for (let attempt = 0; ; attempt++) {
              const changed = await stageAndDetectChanged();
              // Nessun repo modificato → NoChangesError (come oggi il caso a 1 repo).
              if (changed.length === 0) throw new NoChangesError(output);

              const { redOutput } = await runRepoTests(changed);
              await appendLog(
                db,
                job.id,
                `[fix] self-repair tentativo ${attempt}: ${redOutput === null ? "tutti i test verdi" : "test rossi"}`,
              ).catch(() => {
                // Log best-effort.
              });
              if (redOutput === null) {
                changedRepoStates = changed;
                break; // Tutti verdi → commit/push.
              }
              if (attempt >= selfRepairMaxAttempts) {
                throw new SelfRepairFailedError(redOutput, output);
              }
              // CHECK BUDGET-TICKET in-loop (Task 6): stessa logica di oggi, prima di
              // spendere su una ri-riparazione. Esce da withProjectWorktrees con
              // BudgetExceededError → percorso budget-held (NON failJob).
              if (!job.manualTrigger && maxCostUsd != null) {
                const runCost = fixUsages.reduce((sum, u) => sum + (u?.totalCostUsd ?? 0), 0);
                const estimated = ticketCostBaseline + runCost;
                if (estimated >= maxCostUsd) {
                  throw new BudgetExceededError("ticket", maxCostUsd, estimated);
                }
              }
              const repair = await runner.run({
                cwd: parentDir,
                prompt: buildFixRepairPrompt(
                  { ticket, teamComments, testOutput: redOutput },
                  lang,
                ),
                model: executeModel,
                permissionMode: "acceptEdits",
                maxTurns,
                timeoutMs,
                allowedTools,
                ...providerOpt,
              });
              fixUsages.push(repair.usage);
              // LIMITE di rate/usage (best-effort): PRIMA del commit/push finale.
              if (isLimitError(repair)) throw new ProviderLimitError(repair.output);
              if (repair.exitCode !== 0) throw new AgentExitError(repair.exitCode, repair.output);
              output = repair.output; // Aggiorna l'output dell'agente per report/log.
            }
          } else {
            // Nessun comando di test risolvibile (o self-repair disattivato): stage +
            // detect una sola volta, come oggi il flusso senza self-repair.
            changedRepoStates = await stageAndDetectChanged();
            if (changedRepoStates.length === 0) throw new NoChangesError(output);
          }

          // Test verdi (o nessun test): legge+rimuove il report e committa+pusha
          // OGNI repo modificato. Un commit per repo (autore Stubwise AI), poi il
          // push del branch sul rispettivo mirror. Il ref del branch vive nel mirror
          // e sparisce all'uscita da withProjectWorktrees, quindi il push è QUI.
          const reportContent = await readAndRemoveReport();
          const changedRepos: ChangedRepo[] = [];
          for (const state of changedRepoStates) {
            await gitIn(state.dir, ["add", "-A", "--", ".", ...state.envExcludePathspecs]);
            await gitIn(state.dir, [
              "-c",
              "user.name=Stubwise AI",
              "-c",
              "user.email=ai@stubwise",
              "commit",
              "-m",
              `${prTitle}\n\nTicket #${ticket.number} — fix automatico di Stubwise AI`,
            ]);
            await mirrors.pushBranch(state.prepared.mirrorProject, branch);
            changedRepos.push({
              repositoryId: state.prepared.repositoryId,
              name: state.prepared.name,
              mirrorProject: state.prepared.mirrorProject,
            });
          }
          return { kind: "executed", report: reportContent, agentOutput: output, changedRepos };
        } finally {
          // L'heartbeat avvolge TUTTO il lavoro nei worktree: plan, esecuzione,
          // loop di self-repair (ri-esecuzioni dell'agente + run dei test),
          // commit e push. Cancellato qui, qualunque sia l'esito (return/throw).
          clearInterval(heartbeat);
        }
      },
      worktreeOptions,
    );
  } catch (err) {
    // Qualunque sia l'errore, il worktree è già stato rimosso da withWorktree.
    // Consumi dei run di fix (best-effort): se l'agente ha prodotto usage prima
    // di fallire (es. plan riuscito ma execute in errore, nessuna modifica) li
    // registriamo comunque — il lavoro AI è stato speso anche se il job fallisce.
    await recordAllUsages();
    if (err instanceof ProviderLimitError) {
      // LIMITE di rate/usage: NON è un fallimento e NON ci sono effetti
      // osservabili (il limite scatta sempre PRIMA di push/PR — vedi i check
      // dopo ogni runner.run). Il job NON viene chiuso: si torna "limit" così
      // handler.ts fa failover sulla credenziale successiva o, se la catena è
      // esaurita, mette il job in held. Una riga di log per la diagnosi (mai il
      // segreto). I consumi del run sono già stati registrati sopra.
      await appendLog(db, job.id, "[fix] provider AI al limite di rate/usage: failover");
      return "limit";
    }
    if (err instanceof BudgetExceededError) {
      // Budget-ticket sforato durante il self-repair: NON è un fallimento. Il
      // worktree è già rimosso; ora (fuori da withWorktree) si applica il
      // percorso budget-held — holdJob + commento + notifica — invece di
      // failJob/notifyFailed. I consumi del run sono già stati registrati sopra.
      return budgetHeld(err.scope, err.limitUsd, err.spentUsd);
    }
    if (err instanceof NoChangesError) {
      await failJob(db, job.id, {
        log: `[fix] output agente:\n${truncateForLog(err.agentOutput)}\n[fix] nessuna modifica prodotta: niente PR`,
        error: err.message,
      });
      await notifyFailed(err.message);
      return "failed";
    }
    if (err instanceof AgentExitError) {
      await failJob(db, job.id, {
        log: `[fix] output agente (exit ${err.exitCode}):\n${truncateForLog(err.agentOutput)}\n[fix] exit non-zero: per prudenza nessuna PR anche se ci fossero modifiche`,
        error: err.message,
      });
      await notifyFailed(err.message);
      return "failed";
    }
    if (err instanceof SelfRepairFailedError) {
      // Fallimento conservativo: i test del repo restano rossi dopo i tentativi
      // di riparazione → niente PR. L'output dei test (troncato) e l'ultimo
      // output dell'agente finiscono nel log per il debug.
      await failJob(db, job.id, {
        log:
          `[fix] output agente:\n${truncateForLog(err.agentOutput)}\n` +
          `[fix] test ancora falliti dopo ${selfRepairMaxAttempts} tentativi di riparazione:\n${truncateForLog(err.testOutput)}\n` +
          `[fix] test rossi: per prudenza nessuna PR`,
        error: err.message,
      });
      await notifyFailed(err.message);
      return "failed";
    }
    if (err instanceof AgentTimeoutError) {
      const message = `fix interrotto per timeout dopo ${err.timeoutMs}ms`;
      await failJob(db, job.id, {
        log: `[fix] output parziale prima del timeout:\n${truncateForLog(err.partialOutput)}`,
        error: message,
      });
      await notifyFailed(message);
      return "failed";
    }
    if (err instanceof AgentRunError) {
      await failJob(db, job.id, {
        log: `[fix] agente non eseguibile: ${err.message}`,
        error: err.message,
      });
      await notifyFailed(err.message);
      return "failed";
    }
    // Errori git/mirror (GitCommandError redige già i segreti) o imprevisti.
    const message = err instanceof Error ? err.message : String(err);
    await failJob(db, job.id, { log: `[fix] errore: ${message}`, error: message });
    await notifyFailed(message);
    return "failed";
  }

  // Run riusciti: registra i consumi di TUTTI i run (best-effort) prima di
  // proseguire. Non fa mai fallire il job. Vale sia per plan-only sia per
  // l'esecuzione.
  await recordAllUsages();

  // DOMANDA ALL'UMANO: la pianificazione si è fermata su un bivio. I worktree
  // sono già smontati (siamo fuori da withProjectWorktrees, come per il
  // parcheggio del piano), quindi l'attesa non tiene aperto nulla sul disco né
  // sul mirror.
  //
  // Ordine: (1) transazione domanda + commento, (2) parcheggio, (3) notifica.
  // In transazione stanno le due SCRITTURE DI CONTENUTO: la riga
  // `agent_questions` — che è l'ancora su cui si risponde — e il commento AI che
  // la rende visibile nel feed del ticket. O ci sono entrambi o nessuno: un
  // commento "l'AI ha una domanda" senza la riga su cui rispondere sarebbe un
  // vicolo cieco. Il parcheggio resta FUORI (è status-guarded e deve poter dire
  // "ownership persa" senza abortire le scritture, come parkForPlanApproval) e
  // la notifica pure — best-effort, e va emessa DOPO che lo stato è committato.
  //
  // L'indice unico parziale ammette UNA sola domanda aperta per job: se il round
  // precedente non fosse stato chiuso l'insert violerebbe il vincolo. Non deve
  // poter accadere (si arriva qui solo da un job in lavorazione, e la ripresa
  // passa da una risposta), ma se accade il job FALLISCE con l'errore in chiaro
  // invece di restare `fixing` per sempre.
  if (worktreeResult.kind === "question") {
    const { payload } = worktreeResult;
    const optionLines = payload.options
      .map((option, index) => {
        const consequence = option.consequence ? ` — ${option.consequence}` : "";
        const recommended =
          payload.recommendedIndex === index
            ? ` _(${t(lang, "comment.agentQuestionRecommended")})_`
            : "";
        return `${index + 1}. **${option.label}**${consequence}${recommended}`;
      })
      .join("\n");
    let questionId: string;
    try {
      questionId = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(agentQuestions)
          .values({
            jobId: job.id,
            ticketId: ticket.id,
            round: questionRound,
            question: payload.question,
            options: payload.options,
            recommendedIndex: payload.recommendedIndex ?? null,
            allowFreeText: payload.allowFreeText,
          })
          .returning({ id: agentQuestions.id });
        if (!row) throw new Error("insert della domanda non ha restituito la riga");
        await tx.insert(comments).values({
          ticketId: ticket.id,
          authorType: "ai",
          body:
            `${t(lang, "comment.agentQuestion", { round: String(questionRound) })}\n\n` +
            `${payload.question}\n\n${optionLines}`,
        });
        return row.id;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await failJob(db, job.id, {
        log: `[fix] impossibile registrare la domanda dell'agente (round ${questionRound}): ${message}`,
        error: `registrazione della domanda fallita: ${message}`,
      });
      await notifyFailed(`registrazione della domanda fallita: ${message}`);
      return "failed";
    }
    const parked = await parkForInput(db, job.id, {
      cliSessionId: worktreeResult.cliSessionId ?? null,
      log:
        `[fix] domanda registrata (round ${questionRound}), job in attesa di risposta` +
        (worktreeResult.cliSessionId === undefined
          ? " (nessuna sessione CLI da riprendere: la ripresa ripianificherà da zero)"
          : ""),
    });
    if (!parked) {
      // Ownership persa: la domanda e il commento restano veri (sono contenuto
      // del ticket); solo una riga di log, nessun overwrite dello stato.
      await appendLog(db, job.id, "[fix] ownership persa dopo la registrazione della domanda");
    }
    await notify(
      notifyDeps,
      db,
      {
        kind: "job.awaiting_input",
        ticketNumber: ticket.number,
        ticketTitle: ticket.title,
        projectName,
        ticketUrl: url,
        questionId,
        round: questionRound,
        question: payload.question,
        options: payload.options,
        ...(payload.recommendedIndex !== undefined
          ? { recommendedIndex: payload.recommendedIndex }
          : {}),
        allowFreeText: payload.allowFreeText,
      },
      notifyRefs,
    );
    return "awaiting_input";
  }

  // PLAN-ONLY: la pianificazione è andata a buon fine. Niente PR: si persiste
  // il piano (commento AI + ticket in_progress), si parcheggia il job in
  // awaiting_plan_approval (NON terminale) e si notifica la richiesta di
  // revisione. La ripresa avverrà con un job resumeMode="execute" (execute-only).
  if (worktreeResult.kind === "planned") {
    const { planText } = worktreeResult;
    await db.transaction(async (tx) => {
      await tx.insert(comments).values({
        ticketId: ticket.id,
        authorType: "ai",
        body: `${t(lang, "comment.planProposed")}\n\n${planText}`,
      });
      await tx.update(tickets).set({ status: "in_progress" }).where(eq(tickets.id, ticket.id));
    });
    const parked = await parkForPlanApproval(db, job.id, {
      planText,
      log: "[fix] piano pronto, in attesa di approvazione",
    });
    if (!parked) {
      // Ownership persa dopo la pianificazione: il commento e lo stato del
      // ticket sono comunque veri; solo una riga di log, niente overwrite.
      await appendLog(db, job.id, "[fix] ownership persa dopo la pianificazione");
    }
    await notify(
      notifyDeps,
      db,
      {
        kind: "job.plan_review",
        ticketNumber: ticket.number,
        ticketTitle: ticket.title,
        projectName,
        ticketUrl: url,
      },
      notifyRefs,
    );
    return "awaiting_approval";
  }

  const { report, agentOutput, changedRepos } = worktreeResult;
  const logLines: string[] = [`[fix] output agente:\n${truncateForLog(agentOutput)}`];
  let reportBody: string;
  if (report === null) {
    // Documentato: un diff valido senza report ha comunque valore — si apre
    // la PR con un corpo di cortesia e si lascia traccia nel log.
    reportBody = t(lang, "comment.reportMissing", { filename: REPORT_FILENAME });
    logLines.push(
      `[fix] attenzione: ${REPORT_FILENAME} non trovato, PR aperte con body di fallback`,
    );
  } else {
    reportBody = report.trim();
  }
  const prBody = `${reportBody}\n\n---\n${t(lang, "comment.reportFooter", { number: ticket.number })}`;

  // APERTURA PR MULTIPLA (Fase 3): una PR per OGNI repo modificato, ciascuna via il
  // provider di QUEL repo. Ogni PR aperta produce una riga `ticket_repositories`
  // (branch/prUrl/prState=open) — la fonte di verità dello stato per-repo. Il push
  // è già avvenuto dentro la callback; qui apriamo le PR sull'upstream reale. Un
  // fallimento su un repo è terminale `failed` (i push sono già atterrati): il log
  // nomina branch/upstream per il recupero manuale. `ticket_repositories` viene
  // popolata mano a mano: le righe dei repo già andati a buon fine restano (utili a
  // capire quali PR esistono già in caso di re-run manuale).
  const openedPrs: { name: string; prUrl: string }[] = [];
  for (const repo of changedRepos) {
    let prUrl: string;
    try {
      ({ url: prUrl } = await getProviderFn(repo.mirrorProject.provider).openPullRequest(
        repo.mirrorProject,
        { branch, title: prTitle, body: prBody },
      ));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await failJob(db, job.id, {
        log:
          `${logLines.join("\n")}\n` +
          `[fix] '${repo.name}': branch '${branch}' pushato su ${repo.mirrorProject.repoUrl} ma apertura PR fallita: ${message}\n` +
          `[fix] recupero manuale: elimina il branch '${branch}' sull'upstream (es. git push ${repo.mirrorProject.repoUrl} --delete ${branch}) ` +
          `prima di aprire la PR a mano o ri-accodare il job (un re-run riparte da un branch pulito).` +
          (openedPrs.length > 0
            ? `\n[fix] PR già aperte su questo ticket: ${openedPrs.map((p) => `${p.name} ${p.prUrl}`).join(", ")}`
            : ""),
        error: `apertura PR fallita (${repo.name}): ${message}`,
      });
      await notifyFailed(`apertura PR fallita (${repo.name}): ${message}`);
      return "failed";
    }
    // Riga per-repo: branch + PR + stato open. UPSERT sul vincolo (ticketId,
    // repositoryId) così un re-run del fix aggiorna la riga invece di duplicarla.
    await db
      .insert(ticketRepositories)
      .values({ ticketId: ticket.id, repositoryId: repo.repositoryId, branch, prUrl, prState: "open" })
      .onConflictDoUpdate({
        target: [ticketRepositories.ticketId, ticketRepositories.repositoryId],
        set: { branch, prUrl, prState: "open" },
      });
    openedPrs.push({ name: repo.name, prUrl });
    logLines.push(`[fix] '${repo.name}': PR aperta: ${prUrl}`);
  }

  // PR primaria (retro-compatibilità di ai_jobs.prUrl e delle notifiche): la prima
  // aperta. La fonte di verità delle PR resta `ticket_repositories`.
  const primaryPrUrl = openedPrs[0]!.prUrl;
  // Riepilogo delle PR per il commento AI: una riga per repo con il link.
  const prSummary = openedPrs.map((p) => `- ${p.name}: ${p.prUrl}`).join("\n");

  // Commento AI + transizione in_review nella stessa transazione: o il ticket
  // risulta in review CON i link alle PR, o niente. `comment.fixReady` cita la PR
  // primaria; se le PR sono più d'una elenchiamo tutte le sottostanti.
  await db.transaction(async (tx) => {
    await tx.insert(comments).values({
      ticketId: ticket.id,
      authorType: "ai",
      body:
        `${t(lang, "comment.fixReady", { url: primaryPrUrl })}\n\n` +
        (openedPrs.length > 1 ? `${prSummary}\n\n` : "") +
        reportBody,
    });
    await tx.update(tickets).set({ status: "in_review" }).where(eq(tickets.id, ticket.id));
  });

  const closed = await completeJob(db, job.id, {
    status: "pr_opened",
    log: logLines.join("\n"),
    prUrl: primaryPrUrl,
  });
  if (!closed) {
    // Ownership persa proprio alla fine: le PR esistono e il commento pure
    // (informazione vera comunque); solo una riga di log, niente overwrite.
    await appendLog(db, job.id, `[fix] ownership persa dopo l'apertura delle PR (${openedPrs.length})`);
  }

  // Notifica job.pr_opened best-effort, DOPO la chiusura del job (stato committato).
  // Cita la PR primaria (payload invariato); il dettaglio per-repo è sul ticket.
  await notify(
    notifyDeps,
    db,
    {
      kind: "job.pr_opened",
      ticketNumber: ticket.number,
      ticketTitle: ticket.title,
      projectName,
      prUrl: primaryPrUrl,
      ticketUrl: url,
      costUsd: null,
    },
    notifyRefs,
  );
  return "pr_opened";
}
