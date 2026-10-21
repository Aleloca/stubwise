import { aiJobs, comments, projects, tickets, type Db } from "@stubwise/db";
import type { GitProvider } from "@stubwise/git";
import { t } from "@stubwise/i18n";
import { promotePendingForTicket } from "@stubwise/notifications";
import type { GitProviderKind, HeldReason } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelResolver } from "./agent/model-settings.js";
import type { AgentRunner } from "./agent/runner.js";
import type { MirrorManager } from "./git/mirrors.js";
import { runCorrection, type CorrectionDeps, type CorrectionOutcome } from "./pipeline/correction.js";
import { runFix, type FixDeps, type FixOutcome } from "./pipeline/fix.js";
import type { PublishFn } from "./pipeline/notify.js";
import { runTriage, type TriageOutcome } from "./pipeline/triage.js";
import type { ResolvedProvider } from "./providers/chain.js";
import { isQuotaWait, runWithProviders, type SelectDeps } from "./providers/select.js";
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
  /** Modello per operazione scelto dall'admin (design
   * 2026-10-21-modelli-e-consumi): triage, fix e correzione lo risolvono UNA
   * volta per job, prima della riga di log, così log e run nominano lo stesso
   * modello. È lo stesso resolver del TrackingAgentRunner (index.ts).
   * Assente (test) = i modelli dell'env qui sotto. */
  models?: ModelResolver;
  mirrors: MirrorManager;
  /** Chiave AES-256 per decifrare le credenziali dei progetti. */
  encryptionKey: Buffer;
  /** Iniettabile nei test (provider finto, niente HTTP). Copre sia il fix
   * (apertura PR) sia la correzione post-PR (stato della PR, status di commit,
   * commenti della PR, identità dell'account, permesso di un autore). */
  getProviderFn?: (
    kind: GitProviderKind,
  ) => Pick<
    GitProvider,
    | "openPullRequest"
    | "getPullRequestState"
    | "getPullRequestInfo"
    | "setCommitStatus"
    | "listPrComments"
    | "getAuthenticatedUserId"
    | "getCollaboratorPermission"
  >;
  /** Scelta dell'account (providers/select.ts), UNA per tutto il worker:
   * index.ts la costruisce e la passa anche ai poller. Nei test
   * `selectProvidersFn` sostituisce la scelta vera. */
  select: SelectDeps;
  /** URL pubblico dell'istanza (PUBLIC_URL), per i link nelle notifiche. Vuoto
   * = il link al ticket è il solo path. */
  publicUrl?: string;
  /** Publish delle notifiche iniettabile nei test. Default:
   * publishNotification (best-effort, non lancia mai). */
  publish?: PublishFn;
  /** Radice del volume dei knowledge graph (GRAPHS_DIR): passata al fix per il
   * blocco CODE GRAPH nei prompt (vedi graph/agent-hint.ts). */
  graphsDir?: string;
  /** Radice del volume dei plugin del registro d'istanza (PLUGINS_DIR): passata
   * al fix, che ci prepara la copia filtrata dei plugin abilitati sul progetto.
   * Assente = nessun plugin nei run (argv storico). */
  pluginsDir?: string;
  /** Override delle opzioni di triage (model/maxTurns/timeoutMs), più il
   * riassunto del fallimento (fase 7, Task 9: SUMMARIES_ENABLED/SUMMARY_MODEL,
   * lo stesso interruttore già usato dal riassunto del piano nel fix). */
  triage?: {
    model?: string;
    maxTurns?: number;
    timeoutMs?: number;
    summariesEnabled?: boolean;
    summaryModel?: string;
  };
  /** Override delle opzioni di fix (modelli, due fasi, timeout, allowedTools,
   * self-repair, tetto di domande). */
  fix?: {
    model?: string;
    twoPhase?: boolean;
    /** Tetto di domande `ask_user` per job (da AGENT_QUESTION_MAX_ROUNDS). */
    questionMaxRounds?: number;
    planModel?: string;
    executeModel?: string;
    planTimeoutMs?: number;
    maxTurns?: number;
    timeoutMs?: number;
    allowedTools?: string[];
    selfRepairMaxAttempts?: number;
    testTimeoutMs?: number;
    installTimeoutMs?: number;
    /** Riassunto "in breve" del piano (fase 5): SUMMARIES_ENABLED/SUMMARY_MODEL. */
    summariesEnabled?: boolean;
    summaryModel?: string;
  };
}

/** Esito di UN tentativo del job con una credenziale. */
interface JobRun {
  /** Il run ha esaurito QUESTA credenziale per un limite di rate/usage. */
  limited: boolean;
  /** Output dell'agente al limite (ora del reset per markProviderLimited). */
  limitText: string | null;
}

const NOT_LIMITED: JobRun = { limited: false, limitText: null };

function jobRunOf(outcome: FixOutcome | TriageOutcome | CorrectionOutcome): JobRun {
  return typeof outcome === "object" && outcome.kind === "limit"
    ? { limited: true, limitText: outcome.text }
    : NOT_LIMITED;
}

/**
 * Esegue il job (triage → fix, o il ramo di ripresa) con UNA credenziale.
 * `limited` è true se il run ha esaurito QUESTA credenziale per un LIMITE di
 * rate/usage (esito `{ kind: "limit" }` da triage/fix/correzione): in quel caso
 * il job NON è stato chiuso e runWithProviders ritenta con la credenziale
 * successiva, dopo aver marcato questa al limite fino all'ora letta da
 * `limitText`. Per qualunque altro esito (success/failed/held/awaiting) il job
 * è stato gestito come oggi (chiuso o fatto avanzare dalla pipeline) e NON va
 * ritentato.
 *
 * `provider` undefined = nessun provider abilitato: un solo tentativo con
 * l'auth storica.
 */
async function runJobWithProvider(
  deps: HandlerDeps,
  job: AiJob,
  notifyOpts: { publicUrl?: string; projectName: string; publish?: PublishFn },
  provider: ResolvedProvider | undefined,
): Promise<JobRun> {
  // Registra la credenziale TENTATA su ai_jobs.provider_id (best-effort): se il
  // run fallisce per limite e si fa failover, sarà sovrascritta dal tentativo
  // successivo, così provider_id riflette sempre l'ultima credenziale usata.
  if (provider) await setJobProvider(deps.db, job.id, provider.id);
  const providerOpt = provider !== undefined ? { provider } : {};

  // Dipendenze comuni a fix e correzione: stesso runner, stessi mirror, stessa
  // credenziale del provider AI, stessi modelli/timeout/self-repair.
  const commonDeps = {
    db: deps.db,
    runner: deps.runner,
    mirrors: deps.mirrors,
    encryptionKey: deps.encryptionKey,
    ...(deps.models !== undefined ? { models: deps.models } : {}),
    ...(deps.graphsDir !== undefined ? { graphsDir: deps.graphsDir } : {}),
    ...(deps.pluginsDir !== undefined ? { pluginsDir: deps.pluginsDir } : {}),
    ...providerOpt,
    ...notifyOpts,
    ...deps.fix,
  };
  const providerFnOpt = deps.getProviderFn ? { getProviderFn: deps.getProviderFn } : {};
  const fixDeps: FixDeps = { ...commonDeps, ...providerFnOpt };
  const correctionDeps: CorrectionDeps = { ...commonDeps, ...providerFnOpt };

  // CORREZIONE POST-PR: un job con `correction_id` non è un fix. Il ramo sta
  // PRIMA di quello di ripresa e non passa MAI dal triage né da `resolveFixMode`:
  // un job di correzione riusato da un rilancio può portare un `resume_mode`
  // qualunque, e lì dentro degraderebbe a un fix dal default branch (che
  // pusherebbe un branch divergente sulla PR). È `runCorrection` a decidere se
  // c'è ancora qualcosa da fare (correzione `queued`) o se chiudere il job come
  // saltato.
  //
  // Solo "limit" chiede il failover, come per runFix: il chiamante (processJob)
  // fa lo STESSO percorso del fix — credenziale successiva della scelta, oppure
  // held a scelta esaurita. La correzione non sceglie nessun provider AI da
  // sé: lo riceve da qui. Tutti gli altri esiti
  // (pushed, no_changes, failed, held, skipped, lost) sono già gestiti da
  // runCorrection e non vanno ritentati.
  if (job.correctionId !== null) {
    const owned = await markFixing(deps.db, job.id);
    if (!owned) {
      await appendLog(deps.db, job.id, "[correction] ownership persa, mi fermo");
      return NOT_LIMITED;
    }
    return jobRunOf(await runCorrection(correctionDeps, job));
  }

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
  //
  // Il test è un CATCH-ALL (`!== null`) e non un elenco di valori: saltare il
  // triage è il default giusto per QUALUNQUE ripresa, e un valore nuovo
  // dell'enum non deve poter finire per sbaglio nel percorso standard. Il
  // rovescio è che qui non si accorge di nulla: chi aggiunge un valore a
  // `resume_mode` deve aggiungere il suo ramo in `resolveFixMode`
  // (pipeline/fix.ts), altrimenti il job degrada a `full` in SILENZIO.
  if (job.resumeMode !== null) {
    const owned = await markFixing(deps.db, job.id);
    if (!owned) {
      await appendLog(deps.db, job.id, "[resume] ownership persa, mi fermo");
      return NOT_LIMITED;
    }
    // Solo "limit" chiede il failover sulla credenziale successiva. Gli esiti di
    // PARCHEGGIO — "awaiting_approval" e "awaiting_input" — non sono fallimenti:
    // il job è vivo, in attesa di un umano, e nessuno deve ritentarlo.
    return jobRunOf(await runFix(fixDeps, job));
  }

  // Percorso STANDARD: triage → (se "fixing") fix.
  // Il triage non tocca il repo: il suo cwd è una tmpdir vuota e innocua,
  // creata per-job e rimossa comunque vada.
  const workDir = await mkdtemp(join(tmpdir(), "stubwise-triage-"));
  try {
    const triageOutcome: TriageOutcome = await runTriage(
      {
        db: deps.db,
        runner: deps.runner,
        workDir,
        ...(deps.models !== undefined ? { models: deps.models } : {}),
        ...providerOpt,
        ...notifyOpts,
        ...deps.triage,
      },
      job,
    );
    // Limite durante il triage: il job non è chiuso, failover. Qualunque altro
    // esito che non sia "fixing" è terminale (skip/duplicate/held/failed):
    // gestito dal triage, niente fix, niente failover.
    if (triageOutcome !== "fixing") return jobRunOf(triageOutcome);
    // Come sopra: failover solo su "limit"; i parcheggi (piano da approvare,
    // domanda in attesa di risposta) non sono limiti.
    return jobRunOf(await runFix(fixDeps, job));
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
 * Mette il job in held quando TUTTI gli account candidati sono al limite di
 * rate/usage (già prima del run o durante), o quando il tentativo con l'auth
 * storica del container è finito al limite. Riusa il pattern budget-held del fix: commento AI di
 * sistema sul ticket + transizione holdJob (status-guarded). NON failed: il job
 * va ritentato dopo il reset del limite (avvio manuale o re-run). Best-effort
 * sul commento (transazione) e sul log se la ownership è persa.
 *
 * Con «solo questo» (provider del progetto ESCLUSIVO, regola A-1: vale solo
 * con un id valorizzato) il commento non dice «tutti i provider»: gli altri
 * abbonamenti possono essere liberi, è l'account del progetto a essere al
 * limite — e il lavoro riparte da solo al suo reset.
 */
async function holdAllProvidersLimited(
  deps: HandlerDeps,
  job: AiJob,
  ticketId: string,
  projectId: string,
): Promise<void> {
  const lang = await getContentLanguage(deps.db);
  const [project] = await deps.db
    .select({ id: projects.aiProviderId, exclusive: projects.aiProviderExclusive })
    .from(projects)
    .where(eq(projects.id, projectId));
  const exclusive = project?.exclusive === true && project.id != null;
  await deps.db.transaction(async (tx) => {
    await tx.insert(comments).values({
      ticketId,
      authorType: "ai",
      body: t(lang, exclusive ? "comment.providerExclusiveLimitHeld" : "comment.providersLimitHeld"),
    });
  });
  await holdJobWithReason(
    deps,
    job,
    exclusive
      ? "[stubwise] account del progetto («solo questo») al limite di rate/usage → job in pausa (held), riprende da solo dopo il reset"
      : "[stubwise] tutti i provider AI al limite di rate/usage → job in pausa (held), ritenta dopo il reset",
    "limit",
  );
}

async function processJob(
  deps: HandlerDeps,
  job: AiJob,
  projectName: string,
  ticketId: string,
  projectId: string,
): Promise<void> {
  // Contesto delle notifiche comune a triage e fix (best-effort): URL pubblico
  // per il link, nome progetto per il messaggio, publish iniettabile nei test.
  const notifyOpts = {
    ...(deps.publicUrl !== undefined ? { publicUrl: deps.publicUrl } : {}),
    projectName,
    ...(deps.publish !== undefined ? { publish: deps.publish } : {}),
  };

  // SCELTA DELL'ACCOUNT (providers/select.ts, la stessa di ogni run `claude`
  // del worker): il provider del progetto è PREFERITO (con «solo questo» è
  // l'unico), poi gli abbonamenti abilitati per position; la chiave API entra
  // solo se è quella del progetto o se l'istanza non ha abbonamenti; gli
  // account già al limite non si provano. FAILOVER: un run che finisce al
  // LIMITE (prima di qualunque effetto osservabile — niente PR a metà) marca
  // l'account fino all'ora del reset letta dal testo e si ritenta lo STESSO
  // job col candidato successivo. Un esito NON-limite è terminale. Nessun
  // provider abilitato → un solo tentativo con l'auth storica. I segreti non
  // si loggano.
  const run = await runWithProviders(
    deps.select,
    { projectId, workClass: "interactive" },
    (provider) => runJobWithProvider(deps, job, notifyOpts, provider),
    (r) => r.limitText,
    {
      // Una riga di log del job per ogni PASSAGGIO alla credenziale successiva
      // (l'ultimo candidato al limite non passa a nessuno: lo dice il hold).
      onLimited: async (_provider, index, total) => {
        if (index < total) {
          await appendLog(
            deps.db,
            job.id,
            `[stubwise] provider ${index}/${total} al limite: failover alla credenziale successiva`,
          );
        }
      },
    },
  );

  if (run.kind === "done") return;
  if (run.kind === "legacy_limited" || isQuotaWait(run.reason)) {
    // Tutti al limite (già prima del run o durante), oppure auth storica al
    // limite (prima restava `fixing` fino allo stale): held `limit`, la ripresa
    // automatica lo riaccoda quando torna margine.
    await holdAllProvidersLimited(deps, job, ticketId, projectId);
    return;
  }
  // "other", NON "limit": un provider disabilitato/cancellato o un segreto non
  // decifrabile non si sblocca col reset di un limite, serve un intervento umano.
  await holdJobWithReason(
    deps,
    job,
    run.reason === "exclusive_unavailable"
      ? "[stubwise] provider AI del progetto non disponibile (disabilitato/cancellato) → job in pausa, riprende dopo averlo riabilitato"
      : "[stubwise] nessun provider AI utilizzabile (segreti non decifrabili) → job in pausa, riprende dopo aver sistemato le credenziali",
    "other",
  );
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
 * La stessa assunzione regge `requeueWaitingReviews` (review/poller.ts) e il
 * relay degli interventi (`SessionInputRelay`, sessions/relay.ts: l'unico
 * registro degli stdin vivi): con un worker multi-processo vanno rivisti insieme.
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
 * Dopo un job NON di correzione chiuso senza aprire PR (`failed`/`skipped`):
 * le richieste di correzione rimaste `pending` sulle PR del ticket partono ora
 * (`promotePendingForTicket` di `@stubwise/notifications`, mai una copia qui).
 * Un "Request changes" arrivato mentre il fix era in volo è stato salvato
 * `pending`: se il fix apre la PR la promozione la fa il fix stesso (C7), la
 * correzione gestisce da sé la sua coda (runCorrection); resta solo il caso che
 * nessuno dei due vede — la dozzina di `return "failed"` di runFix e i job
 * saltati dal triage — e l'unico punto che li vede tutti è questo.
 *
 * FUORI da ogni transazione e DOPO la chiusura del job: dentro, o prima,
 * `hasJobInFlight` vedrebbe questo job e la pending non partirebbe.
 * Best-effort: un errore finisce nel log del job, e la pending la riprende il
 * tick periodico (promoteStalePendings in runWorker).
 *
 * Se `processJob` LANCIA, qui non si arriva: runJob marca il job `failed` e la
 * promozione non parte da questo punto — la pending la riprende il tick
 * periodico di runWorker entro circa 60 s (`requeueEveryMs`).
 *
 * Le due guardie qui sotto (job non di correzione, stato `failed`/`skipped`)
 * sono OTTIMIZZAZIONI, per non fare query inutili: la guardia VERA sta sotto
 * lock in `promotePendingCorrection` (una `queued` sulla PR o un job che blocca
 * il ticket → niente promozione), quindi chiamare la promozione a torto non
 * farebbe partire niente di sbagliato.
 */
async function promotePendingAfterJob(db: Db, job: AiJob): Promise<void> {
  if (job.correctionId !== null) return;
  try {
    const [row] = await db.select({ status: aiJobs.status }).from(aiJobs).where(eq(aiJobs.id, job.id));
    if (row?.status !== "failed" && row?.status !== "skipped") return;
    const promoted = await promotePendingForTicket(db, job.ticketId);
    for (const id of promoted) {
      await appendLog(db, job.id, `[stubwise] richiesta di correzione in attesa avviata (${id})`).catch(() => {});
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await appendLog(
      db,
      job.id,
      `[stubwise] promozione delle richieste di correzione in attesa fallita (${message}): la riprende il tick`,
    ).catch(() => {});
    console.error(
      `[stubwise-worker] correction: promozione delle richieste in attesa dopo il job ${job.id} fallita (${message})`,
    );
  }
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
    //  - projectId anche per la scelta dell'account (provider del progetto).
    const [row] = await deps.db
      .select({
        projectId: tickets.projectId,
        projectName: projects.name,
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

    return serializer.run(row.projectId, async () => {
      await processJob(deps, job, row.projectName, job.ticketId, row.projectId);
      await promotePendingAfterJob(deps.db, job);
    });
  };
}
