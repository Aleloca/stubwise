import { docNodes, type Db } from "@stubwise/db";
import {
  buildExplorePrompt,
  dedupeChildren,
  parseExploreOutput,
  type ChildSpec as EngineChildSpec,
  type ExploreOutput,
} from "@stubwise/docs-engine";
import { eq, sql } from "drizzle-orm";
import type { AgentRunner } from "../../agent/runner.js";
import type { ResolvedProvider } from "../../providers/chain.js";
import {
  completeNode,
  createChildren,
  failNode,
  touchNode,
  writeExploreResult,
  type ChildSpec as NodeChildSpec,
  type DocNode,
} from "../nodes.js";

/**
 * EXPLORE HANDLER — esegue la FASE di esplorazione di un nodo del DAG (M5.3).
 *
 * Dato un nodo `exploring` (già reclamato da `claimNextNode`), l'handler:
 *  - costruisce il prompt di explore con il CONTESTO gerarchico (titolo/intro del
 *    padre + titoli degli antenati) preso da `doc_nodes`;
 *  - esegue l'agente in SOLA LETTURA (`permissionMode:"plan"`) nel worktree CONDIVISO
 *    della generazione, `parseExploreOutput` con UN retry su output invalido; se
 *    ancora invalido → `failNode` (che fa avanzare il join sul padre, niente deadlock);
 *  - su output valido scrive `body`+`source_paths` (`writeExploreResult`), poi
 *    DECIDE la decomposizione: `dedupeChildren` vs i path degli antenati (anti-ciclo),
 *    cap di profondità (`DOC_MAX_DEPTH`) e cap di nodi totali (`DOC_MAX_NODES`). I
 *    figli tenuti → `createChildren` (il padre va `awaiting_children`); nessun figlio
 *    (foglia o tutto tagliato) → `completeNode` (il nodo va `done` e il join avanza).
 *
 * WORKTREE: l'handler riceve `deps.worktreeDir` — la directory del worktree
 * CONDIVISO della generazione, aperto da M5a e tenuto vivo (in-process) dal loop di
 * dispatch (M7) per tutta la durata del DAG. NON è ricavabile dal nodo: M5a apre il
 * worktree con `mkdtemp` (path random non persistito). La scelta consistente con
 * l'invariante di M5a ("un solo worktree vivo per l'intera generazione") è iniettare
 * il `dir` come dipendenza, non re-aprirlo né persisterlo: il loop possiede l'handle
 * `GenerationWorktree` e ne passa il `dir` a explore/synthesize. L'agente usa `dir`
 * come `cwd` (read-only): nessun reader serve qui (l'agente legge il codice da sé).
 *
 * COSTO + HEARTBEAT: ogni run aggrega il costo (ritornato al chiamante per la M6) e
 * batte l'heartbeat (`touchNode`) così `requeueStaleNodes` non riprende un nodo vivo.
 */

export interface RunExploreDeps {
  db: Db;
  runner: AgentRunner;
  /** Directory del worktree CONDIVISO della generazione (cwd read-only dell'agente). */
  worktreeDir: string;
  /** Modello AI dell'agente di esplorazione (DOC_GENERATION_MODEL). */
  model: string;
  /** Timeout (ms) del run dell'agente (DOC_AGENT_TIMEOUT_MS). */
  agentTimeoutMs: number;
  /** Turni massimi del run dell'agente. */
  maxTurns: number;
  /** Profondità massima del DAG: a `depth+1 >= maxDepth` il nodo è foglia (DOC_MAX_DEPTH). */
  maxDepth: number;
  /** Tetto al numero totale di nodi della generazione (DOC_MAX_NODES). */
  maxNodes: number;
  /** Credenziale AI risolta dalla catena (prima voce); undefined = auth storica. */
  provider?: ResolvedProvider;
}

export type ExploreOutcome = "branch" | "leaf" | "failed";

/** Costo aggregato + esito di un explore (il costo è sommato nella generazione alla M6). */
export interface ExploreResult {
  outcome: ExploreOutcome;
  costUsd: number;
}

/** Contesto gerarchico di un nodo: intro del padre + titoli degli antenati + path coperti. */
interface NodeContext {
  /** Body/intro del padre (per orientare l'agente). */
  parentContext: string;
  /** Titoli degli antenati, radice → padre. */
  ancestorTitles: string[];
  /** Tutti i source-path coperti dagli antenati (per l'anti-ciclo della dedup). */
  ancestorPaths: string[];
}

/**
 * Risale la catena dei padri del nodo (via `parentId`) raccogliendo, dal più vicino
 * alla radice: i TITOLI degli antenati (radice → padre, per il prompt) e i loro
 * SOURCE-PATH (per l'anti-ciclo di `dedupeChildren`). L'intro del prompt è il BODY del
 * padre diretto. È bounded dalla profondità del DAG (`DOC_MAX_DEPTH`): nessun ciclo
 * (il DAG è un albero per costruzione) ma un guard difensivo evita comunque loop
 * infiniti su dati corrotti.
 */
async function loadNodeContext(db: Db, node: DocNode): Promise<NodeContext> {
  const ancestorTitlesRev: string[] = [];
  const ancestorPaths: string[] = [];
  let parentContext = "";

  let currentParentId = node.parentId;
  const visited = new Set<string>([node.id]);
  let first = true;
  while (currentParentId && !visited.has(currentParentId)) {
    visited.add(currentParentId);
    const [parent] = await db
      .select({
        parentId: docNodes.parentId,
        title: docNodes.title,
        body: docNodes.body,
        sourcePaths: docNodes.sourcePaths,
      })
      .from(docNodes)
      .where(eq(docNodes.id, currentParentId));
    if (!parent) break;
    if (first) {
      parentContext = parent.body ?? "";
      first = false;
    }
    ancestorTitlesRev.push(parent.title);
    for (const p of (parent.sourcePaths as string[] | null) ?? []) ancestorPaths.push(p);
    currentParentId = parent.parentId;
  }

  // Raccolti dal padre alla radice: invertiti per dare l'ordine radice → padre.
  ancestorTitlesRev.reverse();
  return { parentContext, ancestorTitles: ancestorTitlesRev, ancestorPaths };
}

/**
 * Esegue l'agente di explore e ne parsa l'output, con UN retry su output invalido
 * (body/blocchi mancanti) prima del fallback. Ritorna l'output valido + il costo
 * aggregato, oppure `null` (entrambi i tentativi invalidi). Ogni run è read-only e
 * batte l'heartbeat al termine.
 */
async function runExploreAgent(
  deps: RunExploreDeps,
  node: DocNode,
  prompt: string,
): Promise<{ explore: ExploreOutput; costUsd: number } | null> {
  const providerOpt = deps.provider !== undefined ? { provider: deps.provider } : {};
  let costUsd = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await deps.runner.run({
      cwd: deps.worktreeDir,
      prompt,
      model: deps.model,
      permissionMode: "plan",
      maxTurns: deps.maxTurns,
      timeoutMs: deps.agentTimeoutMs,
      ...providerOpt,
    });
    costUsd += result.usage?.totalCostUsd ?? 0;
    await touchNode(deps.db, node.id);
    const parsed = parseExploreOutput(result.output);
    if (!("reason" in parsed)) return { explore: parsed, costUsd };
    // Output invalido (`reason`): si ritenta una volta, poi fallback (failNode).
  }
  return null;
}

/**
 * Conta i nodi già esistenti nella generazione del `node` (per il cap DOC_MAX_NODES).
 * Il budget residuo per i nuovi figli è `maxNodes - count`; se ≤ 0 nessun figlio è
 * creabile (il nodo diventa foglia).
 */
async function countGenerationNodes(db: Db, generationId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(docNodes)
    .where(eq(docNodes.generationId, generationId));
  return row?.count ?? 0;
}

/** Converte un ChildSpec del motore in uno spec di nodo (eredita l'albero del padre). */
function toNodeSpec(spec: EngineChildSpec, tree: DocNode["tree"]): NodeChildSpec {
  return {
    tree,
    title: spec.title,
    unitRef: spec.unitRef ?? null,
    ...(spec.sourcePaths ? { sourcePaths: spec.sourcePaths } : {}),
  };
}

/**
 * Applica i cap alla child-list già deduplicata e DECIDE branch vs foglia:
 *  - DOC_MAX_DEPTH: se i figli starebbero a `depth+1 >= maxDepth`, il nodo è FOGLIA
 *    (figli proposti ignorati e loggati — mai un cap silenzioso);
 *  - DOC_MAX_NODES: i figli oltre il budget residuo della generazione vengono TAGLIATI
 *    (loggati). Budget ≤ 0 → nessun figlio.
 * Ritorna gli spec da creare (vuoto = foglia).
 */
async function applyCaps(
  deps: RunExploreDeps,
  node: DocNode,
  kept: EngineChildSpec[],
): Promise<EngineChildSpec[]> {
  if (kept.length === 0) return [];

  // Cap di profondità: i figli vivrebbero a depth+1; oltre il tetto → foglia.
  if (node.depth + 1 >= deps.maxDepth) {
    console.warn(
      `[docs] nodo ${node.id} a profondità ${node.depth}: raggiunto DOC_MAX_DEPTH=${deps.maxDepth}, ` +
        `${kept.length} figli proposti ignorati → foglia`,
    );
    return [];
  }

  // Cap di nodi totali: taglia i figli che sforerebbero il budget della generazione.
  const existing = await countGenerationNodes(deps.db, node.generationId);
  const budget = deps.maxNodes - existing;
  if (budget <= 0) {
    console.warn(
      `[docs] generazione ${node.generationId}: raggiunto DOC_MAX_NODES=${deps.maxNodes} ` +
        `(${existing} nodi), ${kept.length} figli del nodo ${node.id} ignorati → foglia`,
    );
    return [];
  }
  if (kept.length > budget) {
    console.warn(
      `[docs] generazione ${node.generationId}: DOC_MAX_NODES=${deps.maxNodes} (${existing} nodi), ` +
        `i figli del nodo ${node.id} tagliati da ${kept.length} a ${budget} per restare nel budget`,
    );
    return kept.slice(0, budget);
  }
  return kept;
}

/**
 * Esegue l'esplorazione del `node` (vedi docblock del modulo). Ritorna l'esito
 * (`branch`/`leaf`/`failed`) + il costo aggregato dei run. Il nodo dev'essere
 * `exploring` (reclamato): su perdita di ownership (un altro worker l'ha ripreso) le
 * scritture status-guarded di `writeExploreResult`/`completeNode` non toccano righe e
 * l'handler termina senza danni.
 */
export async function runExplore(deps: RunExploreDeps, node: DocNode): Promise<ExploreResult> {
  const { db } = deps;

  const ctx = await loadNodeContext(db, node);
  const prompt = buildExplorePrompt({
    tree: node.tree,
    unitRef: node.unitRef ?? "",
    title: node.title,
    parentContext: ctx.parentContext,
    ancestorTitles: ctx.ancestorTitles,
  });

  const run = await runExploreAgent(deps, node, prompt);
  if (!run) {
    await failNode(
      db,
      node.id,
      "output di esplorazione non valido (marcatori mancanti) dopo retry",
    );
    return { outcome: "failed", costUsd: 0 };
  }
  const { explore, costUsd } = run;

  // Persiste body + source_paths (status-guarded su `exploring`: se la ownership è
  // persa qui, non si creano figli orfani).
  const owns = await writeExploreResult(db, node.id, {
    body: explore.body,
    sourcePaths: explore.sourcePaths,
  });
  if (!owns) return { outcome: "failed", costUsd };

  // Anti-ciclo + dedup tra fratelli vs i path degli antenati.
  const { kept, dropped } = dedupeChildren(explore.children, ctx.ancestorPaths);
  if (dropped.length > 0) {
    console.warn(
      `[docs] nodo ${node.id}: ${dropped.length} figli scartati (path già coperto da un antenato): ` +
        dropped.map((c) => c.title).join(", "),
    );
  }

  // Cap di profondità e di nodi totali (loggati, mai silenziosi).
  const specs = await applyCaps(deps, node, kept);

  if (specs.length === 0) {
    // Foglia (nessun figlio, o tutto tagliato dai cap/dedup): chiude e fa il join.
    await completeNode(db, node.id);
    return { outcome: "leaf", costUsd };
  }

  await createChildren(
    db,
    node.id,
    specs.map((s) => toNodeSpec(s, node.tree)),
  );
  return { outcome: "branch", costUsd };
}
