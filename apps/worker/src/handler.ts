import { comments, projects, tickets, type Db } from "@stubwise/db";
import { t } from "@stubwise/i18n";
import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner } from "./agent/runner.js";
import type { MirrorManager } from "./git/mirrors.js";
import { runFix, type FixDeps, type FixOutcome } from "./pipeline/fix.js";
import type { DispatchFn } from "./pipeline/notify.js";
import { runTriage, type TriageOutcome } from "./pipeline/triage.js";
import { loadProviderChain, type ResolvedProvider } from "./providers/chain.js";
import { appendLog, failJob, holdJob, markFixing, setJobProvider, type AiJob } from "./queue.js";
import { getContentLanguage } from "./settings.js";

/**
 * Wiring della pipeline per runWorker: handler(job) = triage → (se "fixing")
 * fix. Il job arriva già reclamato (`triaging`); triage e fix lo chiudono o
 * lo fanno avanzare da soli (vedi runTriage/runFix).
 *
 * SERIALIZZAZIONE PER PROGETTO: runWorker gira con concurrency 2, ma due job
 * dello STESSO progetto non devono mai sovrapporsi — l'ensureMirror del
 * secondo farebbe `fetch --prune` nel mirror condiviso e cancellerebbe il
 * branch stubwise/* non ancora pushato del primo (limite documentato in
 * mirrors.ts). Qui ogni esecuzione viene accodata a una catena di promise
 * per projectId (in-process: l'assunzione di deployment è un singolo
 * processo worker, come per i lock di MirrorManager); job di progetti
 * diversi restano paralleli perché hanno catene indipendenti.
 */
export interface HandlerDeps {
  db: Db;
  runner: AgentRunner;
  mirrors: MirrorManager;
  /** Chiave AES-256 per decifrare le credenziali dei progetti. */
  encryptionKey: Buffer;
  /** Iniettabile nei test (provider finto, niente HTTP). */
  getProviderFn?: FixDeps["getProviderFn"];
  /** Caricatore della catena di provider AI (iniettabile nei test). Default:
   * loadProviderChain da ./providers/chain.js. Restituisce le credenziali
   * abilitate ordinate per position, già decifrate. */
  loadProviderChainFn?: (db: Db, encryptionKey: Buffer) => Promise<ResolvedProvider[]>;
  /** URL pubblico dell'istanza (PUBLIC_URL), per i link nelle notifiche. Vuoto
   * = il link al ticket è il solo path. */
  publicUrl?: string;
  /** Dispatch delle notifiche iniettabile nei test. Default:
   * dispatchNotification (best-effort, non lancia mai). */
  dispatch?: DispatchFn;
  /** Override delle opzioni di triage (model/maxTurns/timeoutMs). */
  triage?: { model?: string; maxTurns?: number; timeoutMs?: number };
  /** Override delle opzioni di fix (modelli, due fasi, timeout, allowedTools,
   * self-repair). */
  fix?: {
    model?: string;
    twoPhase?: boolean;
    planModel?: string;
    executeModel?: string;
    planTimeoutMs?: number;
    maxTurns?: number;
    timeoutMs?: number;
    allowedTools?: string[];
    selfRepairMaxAttempts?: number;
    testTimeoutMs?: number;
  };
}

/**
 * Esegue il job (triage → fix, o il ramo di ripresa) con UNA credenziale.
 * Restituisce true se il run ha esaurito QUESTA credenziale per un LIMITE di
 * rate/usage (esito "limit" da triage/fix): in quel caso il job NON è stato
 * chiuso e il chiamante può ritentare con la credenziale successiva. Per
 * qualunque altro esito (success/failed/held/awaiting) restituisce false: il
 * job è stato gestito come oggi (chiuso o fatto avanzare dalla pipeline) e NON
 * va ritentato.
 *
 * `provider` undefined = catena vuota: un solo tentativo con l'auth storica.
 */
async function runJobWithProvider(
  deps: HandlerDeps,
  job: AiJob,
  notifyOpts: { publicUrl?: string; projectName: string; dispatch?: DispatchFn },
  provider: ResolvedProvider | undefined,
): Promise<boolean> {
  // Registra la credenziale TENTATA su ai_jobs.provider_id (best-effort): se il
  // run fallisce per limite e si fa failover, sarà sovrascritta dal tentativo
  // successivo, così provider_id riflette sempre l'ultima credenziale usata.
  if (provider) await setJobProvider(deps.db, job.id, provider.id);
  const providerOpt = provider !== undefined ? { provider } : {};

  const fixDeps: FixDeps = {
    db: deps.db,
    runner: deps.runner,
    mirrors: deps.mirrors,
    encryptionKey: deps.encryptionKey,
    ...(deps.getProviderFn ? { getProviderFn: deps.getProviderFn } : {}),
    ...providerOpt,
    ...notifyOpts,
    ...deps.fix,
  };

  // Percorso di RIPRESA (resume_mode "fix" | "execute"): niente triage. Il job
  // arriva `triaging` (claimNextJob marca sempre così, anche i job di ripresa);
  // lo portiamo a `fixing` con markFixing — l'assunzione di runFix (job già
  // `fixing`) regge — e andiamo dritti al fix, che leggerà resumeMode/planText
  // per scegliere la modalità (full / plan-only / execute-only). Nessuna tmpdir
  // di triage: il fix crea il proprio worktree dal mirror.
  if (job.resumeMode === "fix" || job.resumeMode === "execute") {
    const owned = await markFixing(deps.db, job.id);
    if (!owned) {
      await appendLog(deps.db, job.id, "[resume] ownership persa, mi fermo");
      return false;
    }
    const fixOutcome: FixOutcome = await runFix(fixDeps, job);
    return fixOutcome === "limit";
  }

  // Percorso STANDARD: triage → (se "fixing") fix.
  // Il triage non tocca il repo: il suo cwd è una tmpdir vuota e innocua,
  // creata per-job e rimossa comunque vada.
  const workDir = await mkdtemp(join(tmpdir(), "stubwise-triage-"));
  try {
    const triageOutcome: TriageOutcome = await runTriage(
      { db: deps.db, runner: deps.runner, workDir, ...providerOpt, ...notifyOpts, ...deps.triage },
      job,
    );
    // Limite durante il triage: il job non è chiuso, failover.
    if (triageOutcome === "limit") return true;
    // Qualunque altro esito che non sia "fixing" è terminale (skip/duplicate/
    // held/failed): gestito dal triage, niente fix, niente failover.
    if (triageOutcome !== "fixing") return false;
    const fixOutcome: FixOutcome = await runFix(fixDeps, job);
    return fixOutcome === "limit";
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Mette il job in held quando TUTTE le credenziali della catena hanno toccato
 * il limite di rate/usage. Riusa il pattern budget-held del fix: commento AI di
 * sistema sul ticket + transizione holdJob (status-guarded). NON failed: il job
 * va ritentato dopo il reset del limite (avvio manuale o re-run). Best-effort
 * sul commento (transazione) e sul log se la ownership è persa.
 */
async function holdAllProvidersLimited(
  deps: HandlerDeps,
  job: AiJob,
  ticketId: string,
): Promise<void> {
  const lang = await getContentLanguage(deps.db);
  await deps.db.transaction(async (tx) => {
    await tx.insert(comments).values({
      ticketId,
      authorType: "ai",
      body: t(lang, "comment.providersLimitHeld"),
    });
  });
  const held = await holdJob(deps.db, job.id, {
    log: "[stubwise] tutti i provider AI al limite di rate/usage → job in pausa (held), ritenta dopo il reset",
  });
  if (!held) {
    await appendLog(deps.db, job.id, "[stubwise] ownership persa dopo il hold per limite provider");
  }
}

async function processJob(
  deps: HandlerDeps,
  job: AiJob,
  projectName: string,
  ticketId: string,
): Promise<void> {
  // Contesto delle notifiche comune a triage e fix (best-effort): URL pubblico
  // per il link, nome progetto per il messaggio, dispatch iniettabile nei test.
  const notifyOpts = {
    ...(deps.publicUrl !== undefined ? { publicUrl: deps.publicUrl } : {}),
    projectName,
    ...(deps.dispatch !== undefined ? { dispatch: deps.dispatch } : {}),
  };

  // Catena dei provider AI abilitati (ordinati per position). FAILOVER: si prova
  // la prima credenziale; se il run si esaurisce per LIMITE di rate/usage (esito
  // "limit", PRIMA di qualunque effetto osservabile — niente PR a metà) si passa
  // alla successiva e si ritenta lo STESSO job. Un esito NON-limite (success o
  // failed/self-repair) è terminale: niente failover, l'errore è gestito come
  // oggi. Esaurite TUTTE le credenziali per limite → held (non failed).
  // Catena vuota → un solo tentativo con l'auth storica (env del container /
  // OAuth del volume), nessun failover. I segreti non si loggano.
  const loadChain = deps.loadProviderChainFn ?? loadProviderChain;
  const chain = await loadChain(deps.db, deps.encryptionKey);

  // Catena vuota: un solo tentativo, nessun provider, retro-compat.
  if (chain.length === 0) {
    await runJobWithProvider(deps, job, notifyOpts, undefined);
    return;
  }

  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i]!;
    const limited = await runJobWithProvider(deps, job, notifyOpts, provider);
    if (!limited) return; // Successo o fallimento NON-limite: terminato.
    // Limite su questa credenziale: prova la successiva, se c'è.
    if (i < chain.length - 1) {
      await appendLog(
        deps.db,
        job.id,
        `[stubwise] provider ${i + 1}/${chain.length} al limite: failover alla credenziale successiva`,
      );
    }
  }

  // Tutte le credenziali della catena hanno toccato il limite: held.
  await holdAllProvidersLimited(deps, job, ticketId);
}

/** Crea l'handler per runWorker, con la serializzazione per progetto. */
export function createHandler(deps: HandlerDeps): (job: AiJob) => Promise<void> {
  /** Catena di promise per projectId: stessa meccanica di withRepoLock. */
  const chains = new Map<string, Promise<void>>();

  return async function handler(job: AiJob): Promise<void> {
    // projectId per la serializzazione + nome del progetto per le notifiche,
    // in un'unica join.
    const [row] = await deps.db
      .select({ projectId: tickets.projectId, projectName: projects.name })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(eq(tickets.id, job.ticketId));
    if (!row) {
      await failJob(deps.db, job.id, {
        log: `[stubwise] ticket ${job.ticketId} non trovato`,
        error: "ticket del job non trovato",
      });
      return;
    }

    // Sezione SINCRONA (niente await tra get e set): due handler concorrenti
    // sullo stesso progetto vedono e allungano la stessa catena.
    const prev = chains.get(row.projectId) ?? Promise.resolve();
    const run = prev.then(() => processJob(deps, job, row.projectName, job.ticketId));
    // La catena memorizzata non rigetta mai: un job fallito non blocca i
    // successivi dello stesso progetto.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    chains.set(row.projectId, tail);
    void tail.then(() => {
      if (chains.get(row.projectId) === tail) chains.delete(row.projectId);
    });
    return run;
  };
}
