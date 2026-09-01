import { comments, projects, tickets, type Db } from "@stubwise/db";
import { t } from "@stubwise/i18n";
import type { HeldReason } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner } from "./agent/runner.js";
import type { MirrorManager } from "./git/mirrors.js";
import { runFix, type FixDeps, type FixOutcome } from "./pipeline/fix.js";
import type { PublishFn } from "./pipeline/notify.js";
import { runTriage, type TriageOutcome } from "./pipeline/triage.js";
import { loadProviderById, loadProviderChain, type ResolvedProvider } from "./providers/chain.js";
import { appendLog, failJob, holdJob, markFixing, setJobProvider, type AiJob } from "./queue.js";
import { getContentLanguage } from "./settings.js";

/**
 * Wiring della pipeline per runWorker: handler(job) = triage → (se "fixing")
 * fix. Il job arriva già reclamato (`triaging`); triage e fix lo chiudono o
 * lo fanno avanzare da soli (vedi runTriage/runFix).
 *
 * SERIALIZZAZIONE PER PROGETTO (Fase 3): runWorker gira con concurrency N, ma due job
 * dello STESSO progetto non devono mai sovrapporsi — un fix di progetto apre worktree su
 * TUTTI i repo del progetto (`withProjectWorktrees`), e l'ensureMirror di un secondo job
 * dello stesso progetto farebbe `fetch --prune` nel mirror condiviso di un repo,
 * cancellando il branch stubwise/* non ancora pushato del primo (limite documentato in
 * mirrors.ts). La chiave del serializer è quindi il projectId: ogni esecuzione viene
 * accodata a una catena di promise per projectId (in-process: l'assunzione di deployment
 * è un singolo processo worker, come per i lock di MirrorManager); job di progetti diversi
 * restano paralleli perché hanno catene indipendenti.
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
  /** Risolutore di UN provider per id (iniettabile nei test). Default:
   * loadProviderById da ./providers/chain.js. Usato dal provider AI di progetto
   * (modalità strict): ritorna null se disabilitato/cancellato/non decifrabile. */
  loadProviderByIdFn?: (db: Db, encryptionKey: Buffer, id: string) => Promise<ResolvedProvider | null>;
  /** URL pubblico dell'istanza (PUBLIC_URL), per i link nelle notifiche. Vuoto
   * = il link al ticket è il solo path. */
  publicUrl?: string;
  /** Publish delle notifiche iniettabile nei test. Default:
   * publishNotification (best-effort, non lancia mai). */
  publish?: PublishFn;
  /** Radice del volume dei knowledge graph (GRAPHS_DIR): passata al fix per il
   * blocco CODE GRAPH nei prompt (vedi graph/agent-hint.ts). */
  graphsDir?: string;
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
    installTimeoutMs?: number;
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
  notifyOpts: { publicUrl?: string; projectName: string; publish?: PublishFn },
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
    ...(deps.graphsDir !== undefined ? { graphsDir: deps.graphsDir } : {}),
    ...providerOpt,
    ...notifyOpts,
    ...deps.fix,
  };

  // Percorso di RIPRESA (ogni resume_mode): niente triage. Il job arriva
  // `triaging` (claimNextJob marca sempre così, anche i job di ripresa); lo
  // portiamo a `fixing` con markFixing — l'assunzione di runFix (job già
  // `fixing`) regge — e andiamo dritti al fix, che leggerà resumeMode/planText
  // per scegliere la modalità (full / plan-only / execute-only) e se sta
  // riprendendo una pianificazione. Nessuna tmpdir di triage: il fix crea il
  // proprio worktree dal mirror.
  //
  // `plan_continue` (ripresa da una risposta umana) è qui per lo stesso motivo
  // degli altri, e con un'urgenza in più: ri-triagiare un ticket su cui una
  // persona ha appena preso una decisione potrebbe classificarlo `skipped` o
  // `duplicate` e buttare via sia la risposta sia la sessione CLI da riprendere.
  if (job.resumeMode !== null) {
    const owned = await markFixing(deps.db, job.id);
    if (!owned) {
      await appendLog(deps.db, job.id, "[resume] ownership persa, mi fermo");
      return false;
    }
    const fixOutcome: FixOutcome = await runFix(fixDeps, job);
    // Solo "limit" chiede il failover sulla credenziale successiva. Gli esiti di
    // PARCHEGGIO — "awaiting_approval" e "awaiting_input" — non sono fallimenti:
    // il job è vivo, in attesa di un umano, e nessuno deve ritentarlo.
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
    // Come sopra: failover solo su "limit"; i parcheggi (piano da approvare,
    // domanda in attesa di risposta) tornano false.
    return fixOutcome === "limit";
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Mette il job in held con un messaggio (status-guarded, come holdJob). Se la
 * ownership è persa (job requeued e reclamato altrove) la transizione non
 * avviene: si logga best-effort. NON failed: il job va ritentato (avvio manuale
 * o re-run) dopo che la causa del hold è rientrata.
 */
async function holdJobWithReason(
  deps: HandlerDeps,
  job: AiJob,
  log: string,
  heldReason: HeldReason,
): Promise<void> {
  const held = await holdJob(deps.db, job.id, { log, heldReason });
  if (!held) {
    await appendLog(deps.db, job.id, "[stubwise] ownership persa dopo il hold");
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
  await holdJobWithReason(
    deps,
    job,
    "[stubwise] tutti i provider AI al limite di rate/usage → job in pausa (held), ritenta dopo il reset",
    "limit",
  );
}

async function processJob(
  deps: HandlerDeps,
  job: AiJob,
  projectName: string,
  ticketId: string,
  aiProviderId: string | null,
): Promise<void> {
  // Contesto delle notifiche comune a triage e fix (best-effort): URL pubblico
  // per il link, nome progetto per il messaggio, publish iniettabile nei test.
  const notifyOpts = {
    ...(deps.publicUrl !== undefined ? { publicUrl: deps.publicUrl } : {}),
    projectName,
    ...(deps.publish !== undefined ? { publish: deps.publish } : {}),
  };

  // PROVIDER AI DI PROGETTO (modalità STRICT): se il progetto ha un provider
  // assegnato si usa SOLO quello — niente catena, niente failover. Risolviamo la
  // singola credenziale; se non è disponibile (disabilitata/cancellata/segreto
  // non decifrabile) o tocca il limite, il job va in held e si ferma qui.
  if (aiProviderId !== null) {
    const loadById = deps.loadProviderByIdFn ?? loadProviderById;
    const provider = await loadById(deps.db, deps.encryptionKey, aiProviderId);
    if (provider === null) {
      // "other", NON "limit": un provider disabilitato/cancellato non si
      // sblocca col reset di un limite, serve un intervento umano.
      await holdJobWithReason(
        deps,
        job,
        "[stubwise] provider AI del progetto non disponibile (disabilitato/cancellato) → job in pausa, riprende dopo averlo riabilitato",
        "other",
      );
      return;
    }
    const limited = await runJobWithProvider(deps, job, notifyOpts, provider);
    if (limited) {
      await holdJobWithReason(
        deps,
        job,
        "[stubwise] provider AI del progetto al limite di rate/usage → job in pausa, ritenta dopo il reset",
        "limit",
      );
    }
    return;
  }

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

/**
 * Serializzatore per PROGETTO CONDIVISO fra tipi di job diversi (fix e
 * doc-generation): mantiene una catena di promise per projectId e accoda ogni
 * esecuzione alla coda del proprio progetto. È la stessa meccanica di
 * withRepoLock e dell'handler fix, estratta perché DEVE essere condivisa: un
 * doc-job e un fix-job dello STESSO progetto non devono mai sovrapporsi — un fix di
 * progetto apre worktree su TUTTI i repo del progetto e l'ensureMirror del secondo
 * job farebbe `fetch --prune` nel mirror condiviso di un repo, cancellando il
 * branch stubwise/* non ancora pushato del primo (limite documentato in mirrors.ts).
 * Routando entrambi gli handler attraverso lo STESSO serializer (stessa Map), job
 * dello stesso progetto serializzano anche fra tipi diversi; progetti diversi
 * restano paralleli (catene indipendenti).
 *
 * Assunzione di deployment: un singolo processo worker (come i lock di
 * MirrorManager). La concorrenza fra processi è esclusa a monte dal claim
 * atomico (`FOR UPDATE SKIP LOCKED`).
 */
export interface ProjectSerializer {
  /**
   * Accoda `task` alla catena di `projectId` e restituisce la promise della sua
   * esecuzione. La sezione get→set è SINCRONA (niente await in mezzo): due
   * chiamate concorrenti sullo stesso progetto vedono e allungano la stessa
   * catena.
   */
  run<T>(projectId: string, task: () => Promise<T>): Promise<T>;
}

/** Crea un ProjectSerializer con la sua Map interna di catene per progetto. */
export function createProjectSerializer(): ProjectSerializer {
  const chains = new Map<string, Promise<void>>();
  return {
    run<T>(projectId: string, task: () => Promise<T>): Promise<T> {
      const prev = chains.get(projectId) ?? Promise.resolve();
      const run = prev.then(task);
      // La catena memorizzata non rigetta mai: un job fallito non blocca i
      // successivi dello stesso progetto.
      const tail = run.then(
        () => undefined,
        () => undefined,
      );
      chains.set(projectId, tail);
      void tail.then(() => {
        if (chains.get(projectId) === tail) chains.delete(projectId);
      });
      return run;
    },
  };
}

/**
 * Crea l'handler fix per runWorker, con la serializzazione per progetto. Se
 * `serializer` è passato (da index.ts), la catena per-progetto è CONDIVISA con
 * l'handler doc-generation (vedi createProjectSerializer); altrimenti ne crea
 * uno proprio (retro-compat dei test che istanziano solo il fix).
 */
export function createHandler(
  deps: HandlerDeps,
  serializer: ProjectSerializer = createProjectSerializer(),
): (job: AiJob) => Promise<void> {
  return async function handler(job: AiJob): Promise<void> {
    // Risoluzione dal ticket (product-level in Fase 3, `tickets.projectId`):
    //  - projectId = chiave del serializer (il fix gira sull'intera cartella
    //    progetto, con un worktree per ogni repo);
    //  - nome del progetto per le notifiche;
    //  - aiProviderId del progetto: provider strict/failover risolto da qui.
    const [row] = await deps.db
      .select({
        projectId: tickets.projectId,
        projectName: projects.name,
        aiProviderId: projects.aiProviderId,
      })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(eq(tickets.id, job.ticketId));
    if (!row) {
      await failJob(deps.db, job.id, {
        log: `[stubwise] ticket ${job.ticketId} o progetto non trovato`,
        error: "ticket o progetto del job non trovato",
      });
      return;
    }

    return serializer.run(row.projectId, () =>
      processJob(deps, job, row.projectName, job.ticketId, row.aiProviderId),
    );
  };
}
