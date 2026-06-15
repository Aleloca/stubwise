import { comments, decrypt, gitAccounts, projects, tickets, type Db } from "@stubwise/db";
import { getProvider, type GitProvider } from "@stubwise/git";
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
  recordAgentRun,
  touchJob,
  type AiJob,
} from "../queue.js";
import { notify, ticketUrl, type NotifyDeps } from "./notify.js";
import {
  buildFixExecutePrompt,
  buildFixPlanPrompt,
  buildFixPrompt,
  REPORT_FILENAME,
  toSingleLine,
} from "./prompts.js";

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
}

export type FixOutcome = "pr_opened" | "failed";

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

  // Credenziali: decifratura + parse PRIMA di toccare il repo, dall'ACCOUNT
  // collegato. Un fallimento qui (chiave sbagliata, payload manomesso, JSON
  // inatteso) è un errore di configurazione, non dell'agente: messaggio
  // esplicito, MAI il payload.
  let credentials: z.infer<typeof credentialsSchema>;
  try {
    credentials = credentialsSchema.parse(JSON.parse(decrypt(account.encryptedCredentials, deps.encryptionKey)));
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

  await appendLog(
    db,
    job.id,
    `[fix] avviato per il ticket #${ticket.number} (branch ${branch}` +
      `${twoPhase ? `, due fasi: plan ${planModel} + execute ${executeModel}` : `, fase singola`})`,
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

  let report: string | null;
  let agentOutput: string;
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
    ({ report, agentOutput } = await mirrors.withWorktree(mirrorProject, branch, async (dir) => {
      // Heartbeat: il fix può durare a lungo (plan + execute) senza scrivere
      // nel log. Senza questo touchJob periodico, requeueStale crederebbe il
      // job orfano e ne aprirebbe un duplicato. L'interval avvolge ENTRAMBI i
      // run ed è cancellato in finally.
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
        // FASE 1 — pianificazione (opzionale): modello forte in sola lettura
        // (permission-mode "plan"), nessun allowedTools di test, turni/timeout
        // ridotti. Produce un piano che guida l'esecuzione. Consumi registrati
        // a parte (riga 'fix' del planModel).
        let executePrompt: string;
        if (twoPhase) {
          const planResult = await runner.run({
            cwd: dir,
            prompt: buildFixPlanPrompt({ ticket, teamComments }),
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
          executePrompt = buildFixExecutePrompt({
            ticket,
            plan: planResult.output,
            teamComments,
          });
        } else {
          // Fase singola (FIX_TWO_PHASE=false): un solo run con il prompt
          // monolitico storico, come prima dell'introduzione delle due fasi.
          executePrompt = buildFixPrompt({ ticket, teamComments });
        }

        // FASE 2 — esecuzione: modello economico, acceptEdits + allowedTools di
        // test, turni/timeout pieni. Implementa il fix e scrive il report.
        const result = await runner.run({
          cwd: dir,
          prompt: executePrompt,
          ...(twoPhase
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
      } finally {
        clearInterval(heartbeat);
      }
      if (exitCode !== 0) throw new AgentExitError(exitCode, output);

      // Il report è il corpo della PR e NON deve finire nel commit: letto e
      // rimosso PRIMA di `git add -A`. Se l'agente ha creato STUBWISE_REPORT.md
      // come DIRECTORY (output malformato), lo trattiamo come report mancante
      // e lo rimuoviamo ricorsivamente, così non finisce comunque nel commit.
      const reportPath = join(dir, REPORT_FILENAME);
      let reportContent: string | null = null;
      try {
        const info = await stat(reportPath);
        if (info.isDirectory()) {
          reportContent = null; // Malformato: fallback + esclusione dal commit.
          await rm(reportPath, { recursive: true, force: true });
        } else {
          reportContent = await readFile(reportPath, "utf8");
          await rm(reportPath);
        }
      } catch {
        reportContent = null; // Mancante: si decide fuori (fallback, il fix ha valore).
      }

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
      return { report: reportContent, agentOutput: output };
    }));
  } catch (err) {
    // Qualunque sia l'errore, il worktree è già stato rimosso da withWorktree.
    // Consumi dei run di fix (best-effort): se l'agente ha prodotto usage prima
    // di fallire (es. plan riuscito ma execute in errore, nessuna modifica) li
    // registriamo comunque — il lavoro AI è stato speso anche se il job fallisce.
    await recordAllUsages();
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

  // Run di fix riusciti: registra i consumi di TUTTI i run (best-effort) prima
  // di proseguire con commit/PR. Non fa mai fallire il job.
  await recordAllUsages();

  const logLines: string[] = [`[fix] output agente:\n${truncateForLog(agentOutput)}`];
  let reportBody: string;
  if (report === null) {
    // Documentato: un diff valido senza report ha comunque valore — si apre
    // la PR con un corpo di cortesia e si lascia traccia nel log.
    reportBody = `Il report non è stato generato dall'agente (${REPORT_FILENAME} mancante). Esaminare il diff della PR.`;
    logLines.push(`[fix] attenzione: ${REPORT_FILENAME} non trovato, PR aperta con body di fallback`);
  } else {
    reportBody = report.trim();
  }

  let prUrl: string;
  try {
    ({ url: prUrl } = await getProviderFn(project.provider).openPullRequest(mirrorProject, {
      branch,
      title: prTitle,
      body: `${reportBody}\n\n---\nGenerato automaticamente da Stubwise AI per il ticket #${ticket.number}.`,
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
      body: `Fix automatico pronto: ${prUrl}\n\n${reportBody}`,
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
