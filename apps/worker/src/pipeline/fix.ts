import {
  automationRules,
  comments,
  decrypt,
  gitAccounts,
  instanceSettings,
  monthlyCostUsd,
  projects,
  ticketCostUsd,
  tickets,
  type Db,
} from "@stubwise/db";
import { getProvider, type GitProvider } from "@stubwise/git";
import { t } from "@stubwise/i18n";
import type { GitProviderKind } from "@stubwise/shared";
import { and, desc, eq } from "drizzle-orm";
import { execa } from "execa";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  AgentRunError,
  AgentTimeoutError,
  type AgentRunner,
  type AgentRunUsage,
} from "../agent/runner.js";
import { MirrorManager, type MirrorProject } from "../git/mirrors.js";
import {
  appendLog,
  completeJob,
  failJob,
  holdJob,
  parkForPlanApproval,
  recordAgentRun,
  touchJob,
  type AiJob,
} from "../queue.js";
import { getContentLanguage } from "../settings.js";
import { notify, ticketUrl, type NotifyDeps } from "./notify.js";
import {
  buildFixExecutePrompt,
  buildFixPlanPrompt,
  buildFixPrompt,
  buildFixRepairPrompt,
  REPORT_FILENAME,
  toSingleLine,
} from "./prompts.js";
import { resolveTestCommand, type TestCommand } from "./test-command.js";

/**
 * Fase 2 della pipeline: il fix. Il job è già in stato `fixing` (markFixing
 * dal triage). L'agente lavora in un worktree effimero sul branch
 * `stubwise/ticket-<numero>`; il worker (NON l'agente) committa con autore
 * `Stubwise AI <ai@stubwise>`, pusha il branch e apre la PR con il report
 * come corpo, poi commenta il ticket e lo porta in `in_review`.
 *
 * SERIALIZZAZIONE PER PROGETTO (requisito review): runFix non si difende da
 * un secondo runFix CONCORRENTE sullo stesso progetto — il `fetch --prune`
 * di ensureMirror cancellerebbe i ref stubwise/* non ancora pushati dell'altro
 * job (vedi docblock di mirrors.ts). runFix è progettato per essere chiamato
 * SERIALMENTE per progetto: è il wiring del worker (handler.ts) a garantirlo
 * con una catena di promise per projectId; progetti diversi procedono in
 * parallelo senza rischi (mirror e ref indipendenti).
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
 * Esegue il comando di test nel worktree (default iniettabile di FixDeps). Un
 * exit non-zero NON è un errore: è il segnale che i test sono rossi (reject:
 * false). stdout+stderr combinati e troncati per non gonfiare prompt/log. */
async function defaultRunTestCommand(
  cmd: TestCommand,
  dir: string,
  timeoutMs: number,
): Promise<TestRunResult> {
  const result = await execa(cmd.cmd, cmd.args, {
    cwd: dir,
    timeout: timeoutMs,
    reject: false,
    all: true,
  });
  const combined = result.all ?? `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const output =
    combined.length > TEST_RUN_OUTPUT_MAX_CHARS
      ? `${combined.slice(0, TEST_RUN_OUTPUT_MAX_CHARS)}\n[output troncato]`
      : combined;
  return { exitCode: result.exitCode ?? 1, output };
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
   * spawn con execa (reject:false). */
  runTestCommand?: (cmd: TestCommand, dir: string, timeoutMs: number) => Promise<TestRunResult>;
  /** Costo USD storico già registrato per il ticket (iniettabile nei test;
   * default ticketCostUsd da @stubwise/db). Usato dai controlli di budget. */
  ticketCostUsdFn?: (db: Db, ticketId: string) => Promise<number>;
  /** Costo USD del mese corrente d'istanza (iniettabile nei test; default
   * monthlyCostUsd da @stubwise/db). Usato dal controllo di budget mensile. */
  monthlyCostUsdFn?: (db: Db) => Promise<number>;
}

export type FixOutcome = "pr_opened" | "failed" | "awaiting_approval" | "held";

/** Modalità di esecuzione del fix, risolta PRIMA di toccare il repo. */
type FixMode = "full" | "plan-only" | "execute-only";

/** Riga `tickets` (campi usati per risolvere la modalità). */
type Ticket = typeof tickets.$inferSelect;

/**
 * Risolve la modalità del fix dal job e dalle regole di automazione del tipo
 * del ticket:
 * - `execute-only`: il piano è già stato approvato (resumeMode="execute" con un
 *   planText): si salta la pianificazione e si esegue direttamente dal piano.
 * - `plan-only`: per il tipo del ticket è impostata una soglia di approvazione
 *   del piano (`plan_approval_min_effort`) e l'effort stimato la raggiunge: si
 *   pianifica e ci si ferma in attesa dell'approvazione umana.
 * - `full`: comportamento storico (plan + execute in fila).
 *
 * NOTA: il gate di approvazione del piano è ORTOGONALE a `manualTrigger`. Un
 * avvio a mano NON aggira l'approvazione: un fix rischioso (effort alto) deve
 * comunque proporre un piano e attendere l'ok umano prima di toccare il codice.
 */
async function resolveFixMode(db: Db, job: AiJob, ticket: Ticket): Promise<FixMode> {
  if (job.resumeMode === "execute" && job.planText) return "execute-only";
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
  const ticketCostUsdFn = deps.ticketCostUsdFn ?? ticketCostUsd;
  const monthlyCostUsdFn = deps.monthlyCostUsdFn ?? monthlyCostUsd;

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
  // Carica il progetto E l'account git collegato in un colpo solo: le
  // credenziali vivono ora sull'account (riutilizzabile tra progetti), non più
  // sul progetto. Il provider usato è quello denormalizzato sul progetto.
  const [row] = await db
    .select({ project: projects, account: gitAccounts })
    .from(projects)
    .innerJoin(gitAccounts, eq(projects.gitAccountId, gitAccounts.id))
    .where(eq(projects.id, ticket.projectId));
  if (!row) {
    await failJob(db, job.id, {
      log: `[fix] progetto ${ticket.projectId} o account git collegato non trovato`,
      error: "progetto del ticket non trovato",
    });
    return "failed";
  }
  const { project, account } = row;
  // Contesto comune alle notifiche di QUESTA fase (best-effort, post-commit).
  const notifyDeps: NotifyDeps = {
    ...(deps.publicUrl !== undefined ? { publicUrl: deps.publicUrl } : {}),
    projectName: project.name,
    ...(deps.dispatch !== undefined ? { dispatch: deps.dispatch } : {}),
  };
  const url = ticketUrl(deps.publicUrl, ticket.id);
  /** Notifica job.failed best-effort dopo il failJob (lo stato è già committato). */
  const notifyFailed = (error: string): Promise<void> =>
    notify(notifyDeps, db, {
      kind: "job.failed",
      ticketNumber: ticket.number,
      ticketTitle: ticket.title,
      projectName: project.name,
      error,
      ticketUrl: url,
    });

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
    });
    if (!held) {
      await appendLog(db, job.id, "[fix] ownership persa dopo il hold per budget");
    }
    await notify(notifyDeps, db, {
      kind: "job.budget_held",
      ticketNumber: ticket.number,
      ticketTitle: ticket.title,
      projectName: project.name,
      scope,
      limitUsd,
      spentUsd,
      ticketUrl: url,
    });
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

  // Credenziali: decifratura + parse PRIMA di toccare il repo, dall'ACCOUNT
  // collegato. Un fallimento qui (chiave sbagliata, payload manomesso, JSON
  // inatteso) è un errore di configurazione, non dell'agente: messaggio
  // esplicito, MAI il payload.
  let credentials: z.infer<typeof credentialsSchema>;
  try {
    credentials = credentialsSchema.parse(
      JSON.parse(decrypt(account.encryptedCredentials, deps.encryptionKey)),
    );
  } catch {
    await failJob(db, job.id, {
      log: "[fix] impossibile decifrare le credenziali dell'account git (ENCRYPTION_KEY errata o payload non valido)",
      error: "credenziali dell'account git non decifrabili",
    });
    return "failed";
  }

  const mirrorProject: MirrorProject = {
    provider: project.provider,
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
    credentials,
  };
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

  // Esito della callback withWorktree, discriminato sulla modalità: in
  // plan-only la callback produce SOLO il piano (niente report/commit/push); in
  // full/execute-only produce il fix eseguito (report + output dell'agente).
  type WorktreeResult =
    | { kind: "executed"; report: string | null; agentOutput: string }
    | { kind: "planned"; planText: string };
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
  try {
    worktreeResult = await mirrors.withWorktree(
      mirrorProject,
      branch,
      async (dir): Promise<WorktreeResult> => {
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
        try {
          // PLAN-ONLY: solo il run di pianificazione (Opus, sola lettura). Si
          // cattura il piano, NON si esegue il fix, NON si committa/pusha. Il
          // plan run gira QUI perché l'agente deve esplorare il repo reale.
          if (fixMode === "plan-only") {
            const planResult = await runner.run({
              cwd: dir,
              prompt: buildFixPlanPrompt({ ticket, teamComments }, lang),
              model: planModel,
              permissionMode: "plan",
              maxTurns: DEFAULT_PLAN_MAX_TURNS,
              timeoutMs: planTimeoutMs,
            });
            fixUsages.push(planResult.usage);
            // Un exit non-zero della pianificazione è un fallimento del fix
            // (gestito nel catch → failJob): niente parcheggio, niente piano.
            if (planResult.exitCode !== 0) {
              throw new AgentExitError(planResult.exitCode, planResult.output);
            }
            return { kind: "planned", planText: planResult.output };
          }

          // FASE 1 — pianificazione (full + twoPhase): modello forte in sola
          // lettura (permission-mode "plan"), nessun allowedTools di test,
          // turni/timeout ridotti. In execute-only si SALTA: il piano è già
          // stato approvato (job.planText) e va riusato verbatim.
          let executePrompt: string;
          if (fixMode === "execute-only") {
            // job.planText è garantito non-null/non-vuoto da resolveFixMode.
            executePrompt = buildFixExecutePrompt(
              {
                ticket,
                plan: job.planText!,
                teamComments,
              },
              lang,
            );
          } else if (twoPhase) {
            const planResult = await runner.run({
              cwd: dir,
              prompt: buildFixPlanPrompt({ ticket, teamComments }, lang),
              model: planModel,
              permissionMode: "plan",
              maxTurns: DEFAULT_PLAN_MAX_TURNS,
              timeoutMs: planTimeoutMs,
            });
            fixUsages.push(planResult.usage);
            // Un exit non-zero della pianificazione è trattato come gli altri
            // fallimenti del fix: niente esecuzione, niente PR (vedi catch).
            if (planResult.exitCode !== 0) {
              throw new AgentExitError(planResult.exitCode, planResult.output);
            }
            executePrompt = buildFixExecutePrompt(
              {
                ticket,
                plan: planResult.output,
                teamComments,
              },
              lang,
            );
          } else {
            // Fase singola (FIX_TWO_PHASE=false): un solo run con il prompt
            // monolitico storico, come prima dell'introduzione delle due fasi.
            executePrompt = buildFixPrompt({ ticket, teamComments }, lang);
          }

          // FASE 2 — esecuzione: modello economico, acceptEdits + allowedTools di
          // test, turni/timeout pieni. Implementa il fix e scrive il report. In
          // execute-only il piano è già stato approvato: si usa executeModel
          // (c'è sempre un piano, quindi è di fatto la fase di esecuzione).
          const result = await runner.run({
            cwd: dir,
            prompt: executePrompt,
            ...(twoPhase || fixMode === "execute-only"
              ? { model: executeModel }
              : deps.model !== undefined
                ? { model: deps.model }
                : {}),
            permissionMode: "acceptEdits",
            maxTurns,
            timeoutMs,
            allowedTools,
          });
          output = result.output;
          exitCode = result.exitCode;
          // Catturato anche su exit non-zero (il CLI riporta usage comunque):
          // registrato dopo la chiusura del worktree, qualunque sia l'esito.
          fixUsages.push(result.usage);

          if (exitCode !== 0) throw new AgentExitError(exitCode, output);

          // Il report è il corpo della PR e NON deve MAI finire nel commit. Letto e
          // rimosso DOPO che i test sono verdi (l'agente può riscriverlo nei
          // tentativi di riparazione). Se è stato creato come DIRECTORY (output
          // malformato), lo trattiamo come report mancante e lo rimuoviamo
          // ricorsivamente, così non finisce comunque nel commit.
          const reportPath = join(dir, REPORT_FILENAME);
          const readAndRemoveReport = async (): Promise<string | null> => {
            try {
              const info = await stat(reportPath);
              if (info.isDirectory()) {
                await rm(reportPath, { recursive: true, force: true });
                return null; // Malformato: fallback + esclusione dal commit.
              }
              const content = await readFile(reportPath, "utf8");
              await rm(reportPath);
              return content;
            } catch {
              return null; // Mancante: si decide fuori (fallback, il fix ha valore).
            }
          };

          // LOOP di self-repair (Task 5): se il repo ha un comando di test
          // risolvibile e i RE-tentativi sono abilitati, il WORKER esegue da sé i
          // test nel worktree e, finché restano rossi, reinvoca l'agente con
          // l'output del fallimento, fino a selfRepairMaxAttempts riparazioni; solo
          // con test verdi si procede a report/commit/push. Senza un comando di
          // test risolvibile (o con maxAttempts 0) NON si entra nel loop e il
          // flusso resta IDENTICO a prima (git add -A → status → commit).
          const testCmd = await resolveTestCommandFn({ testCommand: project.testCommand }, dir);
          if (testCmd && selfRepairMaxAttempts > 0) {
            for (let attempt = 0; ; attempt++) {
              // Diff vuoto come oggi (NoChangesError), ma ESCLUDENDO il report: lo
              // si stage tutto tranne STUBWISE_REPORT.md, così il report non può
              // mascherare un diff altrimenti vuoto né finire nel commit.
              await gitIn(dir, ["add", "-A", "--", ".", `:(exclude)${REPORT_FILENAME}`]);
              const status = await gitIn(dir, [
                "status",
                "--porcelain",
                "--",
                ".",
                `:(exclude)${REPORT_FILENAME}`,
              ]);
              if (status.trim() === "") throw new NoChangesError(output);

              const test = await runTestCommand(testCmd, dir, testTimeoutMs);
              await appendLog(
                db,
                job.id,
                `[fix] self-repair tentativo ${attempt}: test ${test.exitCode === 0 ? "verdi" : `rossi (exit ${test.exitCode})`}`,
              ).catch(() => {
                // Log best-effort: non deve far fallire il fix.
              });
              if (test.exitCode === 0) break; // VERDI → report/commit/push.
              if (attempt >= selfRepairMaxAttempts) {
                throw new SelfRepairFailedError(test.output, output);
              }
              // CHECK BUDGET-TICKET in-loop (Task 6): prima di spendere su una
              // RI-riparazione, se il job non è manuale e c'è un tetto di costo,
              // stima la spesa del ticket = storico (ticketCostBaseline) + somma
              // dei costUsd dei run di QUESTO run (fixUsages, non ancora
              // persistiti). Se la stima ha già raggiunto il tetto NON si
              // ri-tenta: si lancia BudgetExceededError, che esce da withWorktree
              // e nel catch porta al percorso budget-held (NON failJob). Stima:
              // lo storico è preciso, fixUsages è il run corrente in memoria.
              if (!job.manualTrigger && maxCostUsd != null) {
                const runCost = fixUsages.reduce((sum, u) => sum + (u?.totalCostUsd ?? 0), 0);
                const estimated = ticketCostBaseline + runCost;
                if (estimated >= maxCostUsd) {
                  throw new BudgetExceededError("ticket", maxCostUsd, estimated);
                }
              }
              const repair = await runner.run({
                cwd: dir,
                prompt: buildFixRepairPrompt(
                  { ticket, teamComments, testOutput: test.output },
                  lang,
                ),
                model: executeModel,
                permissionMode: "acceptEdits",
                maxTurns,
                timeoutMs,
                allowedTools,
              });
              fixUsages.push(repair.usage);
              if (repair.exitCode !== 0) throw new AgentExitError(repair.exitCode, repair.output);
              output = repair.output; // Aggiorna l'output dell'agente per report/log.
            }

            // Test verdi: ora si legge+rimuove il report e si committa il solo fix
            // (il report è già escluso dallo stage del loop e ora anche da disco).
            const reportContent = await readAndRemoveReport();
            await gitIn(dir, ["add", "-A"]);
            await gitIn(dir, [
              "-c",
              "user.name=Stubwise AI",
              "-c",
              "user.email=ai@stubwise",
              "commit",
              "-m",
              `${prTitle}\n\nTicket #${ticket.number} — fix automatico di Stubwise AI`,
            ]);
            await mirrors.pushBranch(mirrorProject, branch);
            return { kind: "executed", report: reportContent, agentOutput: output };
          }

          // Nessun comando di test risolvibile (o self-repair disattivato): flusso
          // IDENTICO a prima — report letto/rimosso PRIMA di `git add -A`.
          const reportContent = await readAndRemoveReport();
          await gitIn(dir, ["add", "-A"]);
          const status = await gitIn(dir, ["status", "--porcelain"]);
          if (status.trim() === "") throw new NoChangesError(output);

          // Autore esplicito per-invocazione: nessuna config git globale richiesta
          // nel container del worker, e il commit è attribuito all'AI.
          await gitIn(dir, [
            "-c",
            "user.name=Stubwise AI",
            "-c",
            "user.email=ai@stubwise",
            "commit",
            "-m",
            `${prTitle}\n\nTicket #${ticket.number} — fix automatico di Stubwise AI`,
          ]);
          // Push DENTRO la callback: il branch ref vive nel mirror e viene
          // cancellato all'uscita da withWorktree (vedi mirrors.ts).
          await mirrors.pushBranch(mirrorProject, branch);
          return { kind: "executed", report: reportContent, agentOutput: output };
        } finally {
          // L'heartbeat avvolge TUTTO il lavoro nel worktree: plan, esecuzione,
          // loop di self-repair (ri-esecuzioni dell'agente + run dei test),
          // commit e push. Cancellato qui, qualunque sia l'esito (return/throw).
          clearInterval(heartbeat);
        }
      },
    );
  } catch (err) {
    // Qualunque sia l'errore, il worktree è già stato rimosso da withWorktree.
    // Consumi dei run di fix (best-effort): se l'agente ha prodotto usage prima
    // di fallire (es. plan riuscito ma execute in errore, nessuna modifica) li
    // registriamo comunque — il lavoro AI è stato speso anche se il job fallisce.
    await recordAllUsages();
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
    await notify(notifyDeps, db, {
      kind: "job.plan_review",
      ticketNumber: ticket.number,
      ticketTitle: ticket.title,
      projectName: project.name,
      ticketUrl: url,
    });
    return "awaiting_approval";
  }

  const { report, agentOutput } = worktreeResult;
  const logLines: string[] = [`[fix] output agente:\n${truncateForLog(agentOutput)}`];
  let reportBody: string;
  if (report === null) {
    // Documentato: un diff valido senza report ha comunque valore — si apre
    // la PR con un corpo di cortesia e si lascia traccia nel log.
    reportBody = t(lang, "comment.reportMissing", { filename: REPORT_FILENAME });
    logLines.push(
      `[fix] attenzione: ${REPORT_FILENAME} non trovato, PR aperta con body di fallback`,
    );
  } else {
    reportBody = report.trim();
  }

  let prUrl: string;
  try {
    ({ url: prUrl } = await getProviderFn(project.provider).openPullRequest(mirrorProject, {
      branch,
      title: prTitle,
      body: `${reportBody}\n\n---\n${t(lang, "comment.reportFooter", { number: ticket.number })}`,
    }));
  } catch (err) {
    // LIMITE NOTO (nessun retry automatico): il push è già atterrato sul
    // remote ma l'apertura PR è fallita → il branch resta orfano e il job è
    // terminale `failed`. Un re-run rifarebbe il push sullo STESSO branch e
    // potrebbe fallire (ref già esistente o non-fast-forward): il recupero
    // manuale è cancellare il branch sull'upstream e poi aprire la PR a mano
    // o ri-accodare il job. Il log nomina branch e upstream per renderlo
    // azionabile senza dover indovinare i nomi.
    const message = err instanceof Error ? err.message : String(err);
    await failJob(db, job.id, {
      log:
        `${logLines.join("\n")}\n` +
        `[fix] branch '${branch}' pushato su ${project.repoUrl} ma apertura PR fallita: ${message}\n` +
        `[fix] recupero manuale: elimina il branch '${branch}' sull'upstream (es. git push ${project.repoUrl} --delete ${branch}) ` +
        `prima di aprire la PR a mano o ri-accodare il job (un re-run riparte da un branch pulito).`,
      error: `apertura PR fallita: ${message}`,
    });
    await notifyFailed(`apertura PR fallita: ${message}`);
    return "failed";
  }

  // Commento AI + transizione in_review nella stessa transazione: o il
  // ticket risulta in review CON il link alla PR, o niente.
  await db.transaction(async (tx) => {
    await tx.insert(comments).values({
      ticketId: ticket.id,
      authorType: "ai",
      body: `${t(lang, "comment.fixReady", { url: prUrl })}\n\n${reportBody}`,
    });
    await tx.update(tickets).set({ status: "in_review" }).where(eq(tickets.id, ticket.id));
  });

  logLines.push(`[fix] PR aperta: ${prUrl}`);
  const closed = await completeJob(db, job.id, {
    status: "pr_opened",
    log: logLines.join("\n"),
    prUrl,
  });
  if (!closed) {
    // Ownership persa proprio alla fine: la PR esiste e il commento pure
    // (informazione vera comunque); solo una riga di log, niente overwrite.
    await appendLog(db, job.id, `[fix] ownership persa dopo l'apertura della PR ${prUrl}`);
  }

  // Notifica job.pr_opened best-effort, DOPO la chiusura del job (stato
  // committato). costUsd: null per v1 (il costo aggregato è ricavabile altrove).
  await notify(notifyDeps, db, {
    kind: "job.pr_opened",
    ticketNumber: ticket.number,
    ticketTitle: ticket.title,
    projectName: project.name,
    prUrl,
    ticketUrl: url,
    costUsd: null,
  });
  return "pr_opened";
}
