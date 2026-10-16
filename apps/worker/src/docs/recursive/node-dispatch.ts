import { docGenerations, projects, repositories, type Db } from "@stubwise/db";
import { eq } from "drizzle-orm";
import type { AgentRunner } from "../../agent/runner.js";
import { notify, type PublishFn } from "../../pipeline/notify.js";
import type { ResolvedProvider } from "../../providers/chain.js";
import {
  isQuotaWait,
  runWithProviders,
  type SelectDeps,
  type SelectInput,
} from "../../providers/select.js";
import {
  claimNextNode,
  pauseGeneration,
  recordNodeCost,
  requeueNode,
  resumedAsInteractive,
  THRESHOLD_PAUSE_REASON,
  type ClaimedNode,
} from "../nodes.js";
import { listAncestorsInWorktree } from "../generation-worktree.js";
import { runExplore, type ExploreResult, type RunExploreDeps } from "./explore-handler.js";
import { runProductPhase } from "./product-handler.js";
import {
  runSynthesize,
  type RunSynthesizeDeps,
  type SynthesizeResult,
} from "./synthesize-handler.js";
import {
  allRootsDone,
  failGenerationOnRestart,
  finalizeGeneration,
  type FinalizeGenerationDeps,
} from "./finalize.js";
import type { GenerationWorktreeRegistry } from "./registry.js";

/**
 * DISPATCH DEI JOB-NODO del DAG (M7.1).
 *
 * `dispatchNode` è il pezzo che fa girare il DAG end-to-end dentro `runWorker`:
 * reclama UN nodo claimabile (`claimNextNode`), risolve la `dir` del worktree
 * CONDIVISO della sua generazione dal registro in-processo, e lo dispatcha alla fase
 * giusta — `runExplore` (explore) o `runSynthesize` (synthesize) — iniettando
 * `worktreeDir`. Persiste il costo del nodo (per la M6) e poi rileva se la generazione
 * è ora INTERAMENTE chiusa (tutte le radici `done`) e, in quel caso, chiama
 * `finalizeGeneration` (M6) ESATTAMENTE UNA VOLTA e chiude/deregistra il worktree.
 *
 * FAIL-ON-RESTART (issue M2): se il worktree della generazione NON è nel registro
 * quando si reclama un suo nodo, un riavvio del worker ha perso l'handle in-memoria.
 * NON si riapre a HEAD (rischio di doc a commit misti): si fa FALLIRE la generazione
 * (`failGenerationOnRestart`) — generazione + nodi non-done + trigger → `failed` — e
 * l'utente ri-triggera. Una generazione interrotta da un riavvio fallisce pulitamente.
 *
 * PARALLELISMO: i job-nodo della STESSA generazione girano CONCORRENTEMENTE (il DAG
 * parallelizza), fino al budget di concorrenza del worker — NON passano dal
 * serializzatore per-progetto (che serializzerebbe i fix vs le generazioni, non i
 * nodi tra loro). I job-nodo LEGGONO soltanto dal worktree (nessuna scrittura git),
 * quindi non interferiscono. La mutua esclusione col FIX (invariante del mirror) è
 * garantita altrove: il registro espone `activeRepositoryIds()` e il loop NON reclama un
 * fix-job per un repository con una generazione attiva (vedi runWorker).
 *
 * FINALIZZAZIONE EXACTLY-ONCE: dopo che un nodo va `done`/`failed` (il join è già
 * avvenuto dentro l'handler), se TUTTE le radici della generazione sono `done` si
 * finalizza. Per evitare doppie finalizzazioni quando due nodi-radice si chiudono
 * quasi-contemporaneamente, il gate è il registro stesso: `registry.close()` rimuove
 * l'handle e la finalizzazione parte solo se l'handle era ancora presente (CAS
 * in-process sul `has`/`close`). Combinato con lo status-guard della generazione
 * (finalizeGeneration scrive `succeeded`/`failed` solo da `running`), il risultato è
 * una sola finalizzazione effettiva per generazione.
 */

/**
 * Reason della pausa per limite provider: UNA const per `pause_reason` nel DB
 * (pauseGeneration) e per il payload della notifica `docs.limit_paused`, così
 * i due non possono divergere.
 */
const LIMIT_PAUSE_REASON = "limite di rate/usage del provider AI";

// La reason della pausa per la SOGLIA di sfondo vive accanto a pause/resume
// (la riconosce anche il resume poller): re-esportata qui per i chiamanti di prima.
export { THRESHOLD_PAUSE_REASON };

/**
 * La scelta dell'account per i nodi di UNA generazione: generazione completa =
 * lavoro di SFONDO (decisione del maintainer A-6), col pin della generazione
 * (scritto solo se è nata con «solo questo», vedi docs/handler.ts). Il
 * progetto si ricava dal repository della generazione. La fase product finale
 * fa eccezione: è interattiva (vedi productSelectInput). E una generazione che
 * il resume poller ha ripreso come interactive dopo una pausa per la soglia
 * oltre DOCS_BACKGROUND_PAUSE_MAX_HOURS (`stats.interactiveSince`, F2a) resta
 * interattiva fino alla fine: con lo sfondo ricadrebbe subito nella stessa
 * pausa per la soglia.
 */
async function selectInputFor(
  deps: Pick<DispatchNodeDeps, "db">,
  generationId: string,
): Promise<SelectInput> {
  const [row] = await deps.db
    .select({
      projectId: repositories.projectId,
      pinnedProviderId: docGenerations.pinnedProviderId,
      stats: docGenerations.stats,
    })
    .from(docGenerations)
    .innerJoin(repositories, eq(repositories.id, docGenerations.repositoryId))
    .where(eq(docGenerations.id, generationId));
  return {
    projectId: row?.projectId ?? null,
    workClass: resumedAsInteractive(row?.stats) ? "interactive" : "background",
    pinnedProviderId: row?.pinnedProviderId ?? null,
  };
}

export interface DispatchNodeDeps {
  db: Db;
  runner: AgentRunner;
  /** Registro in-processo dei worktree di generazione (handle + reopen-on-demand). */
  registry: GenerationWorktreeRegistry;
  /** Client di embedding per la finalizzazione (chunk + related). */
  finalize: Omit<FinalizeGenerationDeps, "db">;
  /** Modello AI degli agenti di explore/synthesize (DOC_GENERATION_MODEL). */
  model: string;
  /** Timeout (ms) di ogni run dell'agente (DOC_AGENT_TIMEOUT_MS). */
  agentTimeoutMs: number;
  /** Turni massimi di ogni run dell'agente. */
  maxTurns: number;
  /** Profondità massima del DAG (DOC_MAX_DEPTH). */
  maxDepth: number;
  /** Tetto al numero totale di nodi della generazione (DOC_MAX_NODES). */
  maxNodes: number;
  /**
   * Tetto al numero di pagine product create dalla FASE product (DOC_PRODUCT_MAX_PAGES;
   * default 12, 0 = fase spenta). Budget SEPARATO da `maxNodes`. La fase product gira in
   * `maybeFinalize` DOPO la chiusura dei due alberi interni e PRIMA della finalizzazione,
   * così i nodi product entrano nella finalize come gli altri.
   */
  maxProductPages: number;
  /** La scelta dell'account del worker (providers/select.ts), la stessa di ogni run. */
  select: SelectDeps;
  /**
   * Radice del volume dei knowledge graph (`GRAPHS_DIR`, fase 2c graphify), inoltrata
   * ai run di ESPLORAZIONE: col grafo il nodo può interrogarlo sulla propria area.
   * Assente (o repository senza grafo) → run di esplorazione identici a prima.
   */
  graphsDir?: string;
  /** URL pubblico dell'istanza (PUBLIC_URL, senza slash finali) per i link
   * delle notifiche; assente/vuoto = il link alla pagina Docs è il solo path. */
  publicUrl?: string;
  /** Publish delle notifiche (iniettabile nei test). Default: publishNotification. */
  publish?: PublishFn;
}

/**
 * RECLAMA un nodo claimabile e, se c'è, registra l'esecuzione via `track(work)` e
 * ritorna `true` APPENA fatto il claim — l'esecuzione (risoluzione del worktree +
 * explore/synthesize + join + eventuale finalizzazione) prosegue in BACKGROUND nella
 * promise passata a `track`, così il loop non si blocca sull'agente e può continuare a
 * reclamare nodi (che parallelizzano). Ritorna `false` (senza chiamare `track`) se la
 * coda nodi è vuota.
 *
 * Il background work è interamente best-effort: su QUALSIASI fallimento (worktree non
 * riapribile, agente, finalizzazione) NON lancia verso il loop — l'errore è loggato e
 * il nodo, già `exploring`/`synthesizing` dal claim, verrà ripreso da
 * `requeueStaleNodes`. Un blip transitorio non uccide il dispatch né perde il nodo.
 */
export async function dispatchNode(
  deps: DispatchNodeDeps,
  track: (work: Promise<void>) => void,
): Promise<boolean> {
  const { db } = deps;

  let claimed: ClaimedNode | null;
  try {
    claimed = await claimNextNode(db);
  } catch (error) {
    console.error(`[stubwise-worker] claim del nodo fallito: ${describe(error)}`);
    return false;
  }
  if (!claimed) return false;

  // Reclamato: registra l'esecuzione in background e ritorna subito true.
  track(runClaimedNode(deps, claimed));
  return true;
}

/**
 * Esegue un nodo già reclamato: risolve il worktree, dispatcha alla fase
 * (explore/synthesize) e — a DAG completo — finalizza la generazione. Non lancia mai
 * (best-effort, vedi dispatchNode): ogni fallimento è loggato e lascia il nodo allo
 * stale-requeue.
 */
async function runClaimedNode(deps: DispatchNodeDeps, claimed: ClaimedNode): Promise<void> {
  const { db, registry } = deps;
  const { node, phase } = claimed;

  // Risolve la `dir` del worktree CONDIVISO della generazione dal registro in-processo.
  // Il worktree esiste SOLO se l'orientamento di QUESTA generazione gira ancora in questo
  // processo: il nodo esiste, quindi l'orientamento AVEVA aperto un worktree.
  const worktreeDir = registry.getWorktreeDir(node.generationId);
  if (worktreeDir === null) {
    // FAIL-ON-RESTART (issue M2): il worktree non è registrato → un riavvio del worker
    // ha perso l'handle in-memoria. NON riapro a HEAD (rischio di documentazione a
    // commit misti): faccio FALLIRE la generazione + i suoi nodi non-done + il trigger,
    // e LASCIO questo nodo (verrà marcato failed dal fail). L'utente ri-triggera.
    const reason = "generazione interrotta da un riavvio del worker: ri-triggerare la generazione";
    try {
      const failed = await failGenerationOnRestart(db, node.generationId, reason);
      console.error(
        `[stubwise-worker] worktree della generazione ${node.generationId} perso al riavvio (nodo ${node.id}, ${phase}): ` +
          (failed
            ? "generazione e nodi pendenti marcati failed — ri-triggerare"
            : "generazione già terminale, nessuna azione"),
      );
    } catch (error) {
      console.error(
        `[stubwise-worker] fail-on-restart della generazione ${node.generationId} fallito: ${describe(error)} — i nodi tornano allo stale-requeue`,
      );
    }
    return;
  }

  // SCELTA DELL'ACCOUNT (providers/select.ts, la stessa di ogni run `claude`):
  // sfondo, col pin della generazione se è nata con «solo questo». Un run al
  // LIMITE non ha effetti osservabili (l'handler non scrive nulla prima di
  // restituire l'esito-limite): l'account è marcato fino all'ora letta dal
  // testo e lo STESSO nodo riprova col candidato successivo. Il costo somma
  // tutti i tentativi (il run al limite è stato comunque pagato).
  let costUsd = 0;
  let outcome: "ok" | "limit" = "ok";
  let pauseReason = LIMIT_PAUSE_REASON;
  try {
    const input = await selectInputFor(deps, node.generationId);
    const run = await runWithProviders(
      deps.select,
      input,
      async (provider) => {
        const r = await runPhase(deps, node, phase, worktreeDir, provider);
        costUsd += r.costUsd;
        return r;
      },
      (r) => (r.outcome === "limit" ? r.limitText : null),
    );
    if (run.kind === "legacy_limited") {
      outcome = "limit";
    } else if (run.kind === "unavailable") {
      // Senza margine (tutti al limite, o oltre la soglia settimanale per lo
      // sfondo): la generazione va in pausa come al limite e riprende col
      // resume poller. «Solo questo» non risolvibile o nessun segreto
      // decifrabile: la generazione fallisce (serve un intervento umano).
      if (!isQuotaWait(run.reason)) {
        await failForUnavailableProvider(deps, node, phase, run.reason);
        return;
      }
      outcome = "limit";
      if (run.reason === "all_over_threshold") pauseReason = THRESHOLD_PAUSE_REASON;
    }
  } catch (error) {
    // Un throw inatteso dell'handler (oltre i suoi percorsi best-effort): loggato. Il
    // nodo resta in lavorazione e verrà ripreso da requeueStaleNodes.
    console.error(
      `[stubwise-worker] handler del nodo ${node.id} (${phase}) fallito: ${describe(error)}`,
    );
    return;
  }

  // Persiste il costo del nodo (Σ dei run dell'agente di questo nodo) così la
  // finalizzazione (M6) lo somma in doc_generations.cost. Anche sul ramo LIMIT: il
  // run parziale è comunque stato pagato e va contato. Best-effort: un fallimento
  // qui non deve impedire la finalizzazione (al più il costo aggregato è sottostimato).
  try {
    await recordNodeCost(db, node.id, costUsd);
  } catch (error) {
    console.error(
      `[stubwise-worker] persistenza del costo del nodo ${node.id} fallita: ${describe(error)}`,
    );
  }

  if (outcome === "limit") {
    // Pausa a livello di GENERAZIONE: il nodo torna claimabile (pending) ma
    // il claim salta le generazioni paused — un solo segnale ferma il DAG.
    // Ordine: prima il requeue del nodo, poi la pausa (se il processo muore
    // in mezzo, un nodo pending su generazione running è semplicemente
    // rieseguito). La ripresa è del resume poller (o del pulsante admin).
    // Best-effort come il resto del background work: su un errore DB il nodo
    // resta in lavorazione e torna allo stale-requeue.
    try {
      await requeueNode(db, node.id);
      const paused = await pauseGeneration(db, node.generationId, pauseReason);
      if (paused) {
        console.error(
          `[stubwise-worker] docs: generazione ${node.generationId} in pausa per ${pauseReason === LIMIT_PAUSE_REASON ? "limite provider" : "soglia settimanale di sfondo (può durare fino al reset)"}`,
        );
        // Notifica best-effort: il momento in cui l'operatore può voler agire
        // (piano, credenziali). projectName/repositoryName/docsUrl da una select.
        await notifyLimitPaused(deps, node.repositoryId, pauseReason);
      }
    } catch (error) {
      console.error(
        `[stubwise-worker] requeue/pausa per limite del nodo ${node.id} fallita: ${describe(error)} — il nodo torna allo stale-requeue`,
      );
    }
    return;
  }

  // Il nodo è ora `done`/`failed` (l'handler ha già fatto il join sul padre). Se
  // l'intero DAG è chiuso (tutte le radici `done`), finalizza ESATTAMENTE UNA VOLTA.
  await maybeFinalize(deps, node.generationId);
}

/**
 * La scelta della FASE product: come i nodi (progetto, pin della generazione) ma
 * `interactive` — è l'ultimo passo di una generazione già pagata, e la soglia
 * settimanale dello sfondo la farebbe saltare proprio quando il resto è fatto
 * (decisione del maintainer, 15 ott 2026). Se nemmeno così c'è un account, il
 * salto resta dichiarato in `stats.productSkipped`.
 */
export async function productSelectInput(
  deps: Pick<DispatchNodeDeps, "db">,
  generationId: string,
): Promise<SelectInput> {
  return { ...(await selectInputFor(deps, generationId)), workClass: "interactive" };
}

/** Esegue la fase del nodo (explore/synthesize) con `provider` (undefined = auth storica). */
async function runPhase(
  deps: DispatchNodeDeps,
  node: ClaimedNode["node"],
  phase: ClaimedNode["phase"],
  worktreeDir: string,
  provider: ResolvedProvider | undefined,
): Promise<ExploreResult | SynthesizeResult> {
  const { db } = deps;
  if (phase === "explore") {
    const exploreDeps: RunExploreDeps = {
      db,
      runner: deps.runner,
      worktreeDir,
      model: deps.model,
      agentTimeoutMs: deps.agentTimeoutMs,
      maxTurns: deps.maxTurns,
      maxDepth: deps.maxDepth,
      maxNodes: deps.maxNodes,
      ...(deps.graphsDir !== undefined ? { graphsDir: deps.graphsDir } : {}),
      ...(provider !== undefined ? { provider } : {}),
    };
    return runExplore(exploreDeps, node);
  }
  const synthDeps: RunSynthesizeDeps = {
    db,
    runner: deps.runner,
    worktreeDir,
    model: deps.model,
    agentTimeoutMs: deps.agentTimeoutMs,
    maxTurns: deps.maxTurns,
    ...(provider !== undefined ? { provider } : {}),
  };
  return runSynthesize(synthDeps, node);
}

/**
 * La scelta è vuota per un motivo che il reset di un limite non risolve:
 * «solo questo» su un provider disabilitato o sparito, o nessun segreto
 * decifrabile. NON si ripiega su un altro account (il pin è una scelta
 * esplicita): si fa FALLIRE la generazione (come il fail-on-restart) e si
 * LASCIA il nodo (verrà marcato failed dal fail). L'utente ri-triggera.
 */
async function failForUnavailableProvider(
  deps: DispatchNodeDeps,
  node: ClaimedNode["node"],
  phase: ClaimedNode["phase"],
  reason: string,
): Promise<void> {
  const message =
    reason === "exclusive_unavailable"
      ? "provider bloccato non disponibile (disabilitato o cancellato): generazione annullata"
      : "nessun provider AI utilizzabile (segreti non decifrabili): generazione annullata";
  try {
    const failed = await failGenerationOnRestart(deps.db, node.generationId, message);
    console.error(
      `[stubwise-worker] nessun account per la generazione ${node.generationId} (nodo ${node.id}, ${phase}, ${reason}): ` +
        (failed
          ? "generazione e nodi pendenti marcati failed — ri-triggerare con un provider valido"
          : "generazione già terminale, nessuna azione"),
    );
  } catch (failError) {
    console.error(
      `[stubwise-worker] fail della generazione ${node.generationId} senza account fallito: ${describe(failError)} — i nodi tornano allo stale-requeue`,
    );
  }
}

/**
 * Notifica best-effort `docs.limit_paused` (l'UNICO evento senza ticket): emessa
 * DOPO che la pausa è committata, così riflette realtà persistita. Nome del
 * repository e del progetto da una select (repositories → projects); il link è
 * la pagina Docs del repository della SPA (`/docs/:repositoryId`). Mai lancia:
 * una notifica mancata non deve alterare l'esito del ramo limit (il wrapper
 * `notify` inghiotte già, qui si difende anche la select).
 */
async function notifyLimitPaused(
  deps: DispatchNodeDeps,
  repositoryId: string,
  reason: string,
): Promise<void> {
  const { db } = deps;
  try {
    const [row] = await db
      .select({
        repositoryName: repositories.name,
        projectName: projects.name,
        projectId: projects.id,
      })
      .from(repositories)
      .innerJoin(projects, eq(projects.id, repositories.projectId))
      .where(eq(repositories.id, repositoryId));
    if (!row) return;
    const base = (deps.publicUrl ?? "").replace(/\/+$/, "");
    await notify(
      { ...(deps.publish !== undefined ? { publish: deps.publish } : {}) },
      db,
      {
        kind: "docs.limit_paused",
        projectName: row.projectName,
        repositoryName: row.repositoryName,
        docsUrl: `${base}/docs/${repositoryId}`,
        reason,
      },
      // Nessun ticket né job dietro una generazione Docs: l'unica ancora è il
      // progetto del repository (la stessa select che dà i nomi).
      { projectId: row.projectId },
    );
  } catch (error) {
    console.error(
      `[stubwise-worker] notifica docs.limit_paused per il repository ${repositoryId} fallita: ${describe(error)}`,
    );
  }
}

/**
 * Se tutte le radici della generazione sono `done`, finalizza UNA VOLTA SOLA e chiude
 * il worktree. EXACTLY-ONCE: si controlla `allRootsDone`; se il DAG è chiuso si tenta
 * il CAS in-process `claimForFinalize` (rimuove sincronamente l'handle e lo ritorna).
 * Solo il chiamante che OTTIENE l'handle (≠ null) procede; due nodi-radice che si
 * chiudono insieme e vedono entrambi `allRootsDone === true` competono sul CAS e solo
 * uno vince. In più finalizeGeneration è status-guarded sulla generazione `running`
 * (seconda difesa). Il worktree è chiuso DOPO il ritorno della M6 (che non lo tocca):
 * a quel punto tutti i nodi sono done/failed e nessun job-nodo lo legge più.
 */
async function maybeFinalize(deps: DispatchNodeDeps, generationId: string): Promise<void> {
  const { db, registry } = deps;

  // Solo le generazioni con un worktree ancora vivo (registrato) sono finalizzabili da
  // questo path: se l'handle non c'è più, un altro dispatch ha già finalizzato/chiuso.
  if (!registry.has(generationId)) return;

  let done: boolean;
  try {
    done = await allRootsDone(db, generationId);
  } catch (error) {
    console.error(
      `[stubwise-worker] controllo allRootsDone della generazione ${generationId} fallito: ${describe(error)}`,
    );
    return;
  }
  if (!done) return;

  // CAS exactly-once: solo il vincitore ottiene l'handle e finalizza.
  const worktree = registry.claimForFinalize(generationId);
  if (!worktree) return;

  // FASE PRODUCT (Fase B): il vincitore del CAS — l'unico con il worktree ancora vivo e la
  // garanzia di girare una sola volta per generazione — genera le verticali product PRIMA
  // della finalizzazione, così i nodi product (tree='product', `done`, body valorizzato)
  // entrano nella finalize come gli altri (proiettati/embeddati/contati). È interamente
  // best-effort e additiva: brief assente / zero superfici pubbliche / budget 0 → salto
  // pulito, generazione invariata; un fallimento non deve MAI impedire la finalizzazione.
  // Le esclusioni del verificatore segreti (Fase C) prodotte dalla fase product: la fase
  // gira PRIMA della finalize, che sovrascrive `doc_generations.stats`; quindi le esclusioni
  // NON possono essere scritte dalla fase product e vanno INOLTRATE alla finalize, che le
  // compone nelle stats definitive. Vuoto se la fase product fallisce/è disattiva.
  let productExclusions: Awaited<ReturnType<typeof runProductPhase>>["productExclusions"] = [];
  // Fase product interrotta per mancanza di account: finisce nelle stats della
  // generazione (`productSkipped`), così una generazione `succeeded` senza le
  // pagine product dice perché. NON si mette in pausa: il DAG interno è chiuso e
  // non resterebbero nodi claimabili da cui riprendere (fail-on-restart).
  let productSkipped: Awaited<ReturnType<typeof runProductPhase>>["skipped"];
  try {
    // Ogni run della fase sceglie il suo account e al limite passa al successivo
    // (runWithProviders dentro la fase). Classe INTERATTIVA (decisione del
    // maintainer): la fase finale usa gli account fino al limite vero, non fino
    // alla soglia settimanale dello sfondo.
    const productResult = await runProductPhase(
      {
        db,
        runner: deps.runner,
        worktreeDir: worktree.dir,
        model: deps.model,
        agentTimeoutMs: deps.agentTimeoutMs,
        maxTurns: deps.maxTurns,
        maxProductPages: deps.maxProductPages,
        select: { deps: deps.select, input: await productSelectInput(deps, generationId) },
      },
      generationId,
    );
    productExclusions = productResult.productExclusions;
    productSkipped = productResult.skipped;
  } catch (error) {
    console.error(
      `[stubwise-worker] fase product della generazione ${generationId} fallita (best-effort): ${describe(error)}`,
    );
  }

  let outcome: "succeeded" | "failed";
  try {
    outcome = await finalizeGeneration(
      // D32/R4: ascendenza esatta dal worktree della generazione, ancora aperto qui.
      { db, ...deps.finalize, ancestry: (sha, since) => listAncestorsInWorktree(worktree.dir, sha, since) },
      generationId,
      productExclusions,
      productSkipped,
    );
  } catch (error) {
    console.error(
      `[stubwise-worker] finalizzazione della generazione ${generationId} fallita: ${describe(error)}`,
    );
    outcome = "failed";
  }
  await worktree.close().catch(() => {});
  console.error(
    `[stubwise-worker] generazione ${generationId} finalizzata (${outcome}), worktree chiuso e deregistrato`,
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
