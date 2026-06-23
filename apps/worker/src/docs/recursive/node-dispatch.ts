import { type Db } from "@stubwise/db";
import type { AgentRunner } from "../../agent/runner.js";
import { loadProviderChain, type ResolvedProvider } from "../../providers/chain.js";
import { claimNextNode, type ClaimedNode } from "../nodes.js";
import { runExplore, type RunExploreDeps } from "./explore-handler.js";
import { runSynthesize, type RunSynthesizeDeps } from "./synthesize-handler.js";
import { allRootsDone, finalizeGeneration, type FinalizeGenerationDeps } from "./finalize.js";
import type { GenerationWorktreeRegistry } from "./registry.js";

/**
 * DISPATCH DEI JOB-NODO del DAG (M7.1).
 *
 * `dispatchNode` è il pezzo che fa girare il DAG end-to-end dentro `runWorker`:
 * reclama UN nodo claimabile (`claimNextNode`), risolve la `dir` del worktree
 * CONDIVISO della sua generazione (dal registro in-processo, o lo riapre on-demand
 * dopo un riavvio), e lo dispatcha alla fase giusta — `runExplore` (explore) o
 * `runSynthesize` (synthesize) — iniettando `worktreeDir`. Poi rileva se la
 * generazione è ora INTERAMENTE chiusa (tutte le radici `done`) e, in quel caso,
 * chiama `finalizeGeneration` (M6) ESATTAMENTE UNA VOLTA e chiude/deregistra il
 * worktree.
 *
 * PARALLELISMO: i job-nodo della STESSA generazione girano CONCORRENTEMENTE (il DAG
 * parallelizza), fino al budget di concorrenza del worker — NON passano dal
 * serializzatore per-progetto (che serializzerebbe i fix vs le generazioni, non i
 * nodi tra loro). I job-nodo LEGGONO soltanto dal worktree (nessuna scrittura git),
 * quindi non interferiscono. La mutua esclusione col FIX (invariante del mirror) è
 * garantita altrove: il registro espone `activeProjectIds()` e il loop NON reclama un
 * fix-job per un progetto con una generazione attiva (vedi runWorker).
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
  /** Chiave AES-256 per la catena di provider (stessa del fix/orientamento). */
  encryptionKey: Buffer;
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

  // Risolve la `dir` del worktree della generazione (registrato dall'orientamento, o
  // riaperto on-demand dopo un riavvio del worker).
  let worktreeDir: string;
  try {
    worktreeDir = await registry.ensureWorktreeDir(db, node.generationId);
  } catch (error) {
    // Il worktree non è (ri)apribile: lascio il nodo `exploring`/`synthesizing` allo
    // stale-requeue invece di fallirlo (potrebbe essere un blip del mirror/credenziali).
    console.error(
      `[stubwise-worker] worktree della generazione ${node.generationId} non risolvibile per il nodo ${node.id} (${phase}): ${describe(error)} — il nodo tornerà claimabile via requeueStaleNodes`,
    );
    return;
  }

  // Credenziale AI: la prima della catena (come orientamento/fix). Catena vuota →
  // undefined = auth storica.
  const provider = await resolveProvider(deps);

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
      await runExplore(exploreDeps, node);
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
      await runSynthesize(synthDeps, node);
    }
  } catch (error) {
    // Un throw inatteso dell'handler (oltre i suoi percorsi best-effort): loggato. Il
    // nodo resta in lavorazione e verrà ripreso da requeueStaleNodes.
    console.error(
      `[stubwise-worker] handler del nodo ${node.id} (${phase}) fallito: ${describe(error)}`,
    );
    return;
  }

  // Il nodo è ora `done`/`failed` (l'handler ha già fatto il join sul padre). Se
  // l'intero DAG è chiuso (tutte le radici `done`), finalizza ESATTAMENTE UNA VOLTA.
  await maybeFinalize(deps, node.generationId);
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

/** Risolve la prima credenziale della catena AI (best-effort): undefined = auth storica. */
async function resolveProvider(deps: DispatchNodeDeps): Promise<ResolvedProvider | undefined> {
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
