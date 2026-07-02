import { docGenerations, projects, repositories, type Db } from "@stubwise/db";
import { eq } from "drizzle-orm";
import type { AgentRunner } from "../../agent/runner.js";
import { notify, type DispatchFn } from "../../pipeline/notify.js";
import {
  loadProviderById,
  loadProviderChain,
  type ResolvedProvider,
} from "../../providers/chain.js";
import {
  claimNextNode,
  pauseGeneration,
  recordNodeCost,
  requeueNode,
  type ClaimedNode,
} from "../nodes.js";
import { runExplore, type RunExploreDeps } from "./explore-handler.js";
import { runSynthesize, type RunSynthesizeDeps } from "./synthesize-handler.js";
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

/**
 * Il provider BLOCCATO della generazione non è più risolvibile al run di un nodo
 * (disabilitato/cancellato/segreto non decifrabile dopo il seed). Lanciata da
 * `resolveProvider` per far FALLIRE la generazione invece di ripiegare su chain[0]:
 * il pin è una scelta esplicita dell'utente, non un suggerimento.
 */
class PinnedProviderUnavailableError extends Error {
  constructor(public providerId: string) {
    super("pinned_provider_unavailable");
    this.name = "PinnedProviderUnavailableError";
  }
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
  /** Caricatore della catena di provider AI (iniettabile nei test). Default:
   * loadProviderChain. La PRIMA voce è la credenziale usata dagli agenti del nodo. */
  loadProviderChainFn?: (db: Db, encryptionKey: Buffer) => Promise<ResolvedProvider[]>;
  /** Risolutore di UN provider per id (iniettabile nei test). Default:
   * loadProviderById. Usato quando la generazione ha un provider BLOCCATO
   * (`pinned_provider_id`): se ritorna null il nodo NON ripiega su chain[0]. */
  loadProviderByIdFn?: (
    db: Db,
    encryptionKey: Buffer,
    id: string,
  ) => Promise<ResolvedProvider | null>;
  /** Chiave AES-256 per la catena di provider (stessa del fix/orientamento). */
  encryptionKey: Buffer;
  /** URL pubblico dell'istanza (PUBLIC_URL, senza slash finali) per i link
   * delle notifiche; assente/vuoto = il link alla pagina Docs è il solo path. */
  publicUrl?: string;
  /** Dispatch delle notifiche (iniettabile nei test). Default: dispatchNotification. */
  dispatch?: DispatchFn;
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

  // Credenziale AI del nodo: senza pin la prima della catena (come orientamento/fix,
  // catena vuota → undefined = auth storica); con pin il provider BLOCCATO della
  // generazione. Se il pin non è più risolvibile (PinnedProviderUnavailableError) NON
  // ripieghiamo su chain[0]: facciamo FALLIRE la generazione (come il fail-on-restart) e
  // LASCIAMO il nodo (verrà marcato failed dal fail). L'utente ri-triggera.
  let provider: ResolvedProvider | undefined;
  try {
    provider = await resolveProvider(deps, node.generationId);
  } catch (error) {
    if (error instanceof PinnedProviderUnavailableError) {
      const reason =
        "provider bloccato non disponibile (disabilitato o cancellato): generazione annullata";
      try {
        const failed = await failGenerationOnRestart(db, node.generationId, reason);
        console.error(
          `[stubwise-worker] provider bloccato ${error.providerId} non risolvibile per la generazione ${node.generationId} (nodo ${node.id}, ${phase}): ` +
            (failed
              ? "generazione e nodi pendenti marcati failed — ri-triggerare con un provider valido"
              : "generazione già terminale, nessuna azione"),
        );
      } catch (failError) {
        console.error(
          `[stubwise-worker] fail della generazione ${node.generationId} per provider bloccato indisponibile fallito: ${describe(failError)} — i nodi tornano allo stale-requeue`,
        );
      }
      return;
    }
    // Errore inatteso nella risoluzione del provider (non il pin): loggato, il nodo
    // resta in lavorazione e verrà ripreso da requeueStaleNodes.
    console.error(
      `[stubwise-worker] risoluzione del provider per il nodo ${node.id} (${phase}) fallita: ${describe(error)}`,
    );
    return;
  }

  let costUsd = 0;
  let outcome: "ok" | "limit" = "ok";
  try {
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
        ...(provider !== undefined ? { provider } : {}),
      };
      const r = await runExplore(exploreDeps, node);
      costUsd = r.costUsd;
      if (r.outcome === "limit") outcome = "limit";
    } else {
      const synthDeps: RunSynthesizeDeps = {
        db,
        runner: deps.runner,
        worktreeDir,
        model: deps.model,
        agentTimeoutMs: deps.agentTimeoutMs,
        maxTurns: deps.maxTurns,
        ...(provider !== undefined ? { provider } : {}),
      };
      const r = await runSynthesize(synthDeps, node);
      costUsd = r.costUsd;
      if (r.outcome === "limit") outcome = "limit";
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
      const paused = await pauseGeneration(db, node.generationId, LIMIT_PAUSE_REASON);
      if (paused) {
        console.error(
          `[stubwise-worker] docs: generazione ${node.generationId} in pausa per limite provider`,
        );
        // Notifica best-effort: il momento in cui l'operatore può voler agire
        // (piano, credenziali). projectName/repositoryName/docsUrl da una select.
        await notifyLimitPaused(deps, node.repositoryId);
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
 * Notifica best-effort `docs.limit_paused` (l'UNICO evento senza ticket): emessa
 * DOPO che la pausa è committata, così riflette realtà persistita. Nome del
 * repository e del progetto da una select (repositories → projects); il link è
 * la pagina Docs del repository della SPA (`/docs/:repositoryId`). Mai lancia:
 * una notifica mancata non deve alterare l'esito del ramo limit (il wrapper
 * `notify` inghiotte già, qui si difende anche la select).
 */
async function notifyLimitPaused(deps: DispatchNodeDeps, repositoryId: string): Promise<void> {
  const { db } = deps;
  try {
    const [row] = await db
      .select({ repositoryName: repositories.name, projectName: projects.name })
      .from(repositories)
      .innerJoin(projects, eq(projects.id, repositories.projectId))
      .where(eq(repositories.id, repositoryId));
    if (!row) return;
    const base = (deps.publicUrl ?? "").replace(/\/+$/, "");
    await notify(
      { ...(deps.dispatch !== undefined ? { dispatch: deps.dispatch } : {}) },
      db,
      {
        kind: "docs.limit_paused",
        projectName: row.projectName,
        repositoryName: row.repositoryName,
        docsUrl: `${base}/docs/${repositoryId}`,
        reason: LIMIT_PAUSE_REASON,
      },
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

  let outcome: "succeeded" | "failed";
  try {
    outcome = await finalizeGeneration({ db, ...deps.finalize }, generationId);
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

/**
 * Risolve la credenziale AI per i nodi della generazione `generationId`.
 *  - Generazione con `pinned_provider_id` (provider BLOCCATO): risolve SOLO quel
 *    provider. Se non è risolvibile (disabilitato/cancellato/segreto non decifrabile →
 *    loadProviderById = null) lancia `PinnedProviderUnavailableError`: il chiamante fa
 *    fallire la generazione, MAI fallback su chain[0] (il pin è esplicito).
 *  - Generazione senza pin: comportamento ATTUALE — la prima credenziale della catena
 *    (best-effort: un errore di caricamento → undefined = auth storica).
 */
async function resolveProvider(
  deps: DispatchNodeDeps,
  generationId: string,
): Promise<ResolvedProvider | undefined> {
  const [gen] = await deps.db
    .select({ pinnedProviderId: docGenerations.pinnedProviderId })
    .from(docGenerations)
    .where(eq(docGenerations.id, generationId));

  if (gen?.pinnedProviderId) {
    const loadById = deps.loadProviderByIdFn ?? loadProviderById;
    const pinned = await loadById(deps.db, deps.encryptionKey, gen.pinnedProviderId);
    // Pin non più risolvibile: NIENTE chain[0]. Lancia → il chiamante fa fallire la generazione.
    if (!pinned) throw new PinnedProviderUnavailableError(gen.pinnedProviderId);
    return pinned;
  }

  const loadChain = deps.loadProviderChainFn ?? loadProviderChain;
  try {
    const chain = await loadChain(deps.db, deps.encryptionKey);
    return chain[0];
  } catch {
    return undefined;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
