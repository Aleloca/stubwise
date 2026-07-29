import { readFile } from "node:fs/promises";

/**
 * LETTURA CONDIVISA del `graph.json` di graphify (node-link NetworkX).
 *
 * Estratto da `blast-radius.ts` quando un secondo consumatore (la mappa del grafo per
 * l'orientamento dei Docs, `docs-summary.ts`) ha avuto bisogno degli stessi mattoni:
 * parse tollerante dei nodi, gradi dagli archi e soglia dei god node. Il comportamento è
 * IDENTICO a quello che aveva blast-radius (nessuna aspettativa dei suoi test è cambiata).
 *
 * FORMA DEL FILE (graphify 0.9.28): `nodes` con `id`/`label`/`source_file`/`community`/
 * `community_name`, archi in `links` con `source`/`target` (id dei nodi). Il parse è
 * TOLLERANTE: ogni nodo o arco che non ha la forma attesa viene ignorato, non fa fallire
 * il calcolo.
 *
 * REGOLA D'ORO comune ai consumatori: il grafo non deve MAI peggiorare la funzione che
 * lo usa. `loadGraph` ritorna `null` a ogni problema (file assente, JSON illeggibile,
 * forma inattesa, grafo senza nodi validi) e NON lancia mai.
 *
 * NIENTE CACHE (YAGNI): i consumatori sono rari (una review, un orientamento) e un grafo
 * da qualche MB si parsa in meno di un secondo. Il file letto è quello del VOLUME (sempre
 * fresco, rigenerato sul push), non l'eventuale copia committata nel repo.
 */

/** Nodo del grafo ridotto a ciò che serve ai consumatori (già validato). */
export interface GraphNode {
  id: string;
  label: string;
  sourceFile: string;
  /** Nome della comunità (`community_name`), ripiego `Community <n>`, "" se assente. */
  community: string;
}

/** Grafo caricato: nodi validi + grado (archi incidenti) per id. */
export interface LoadedGraph {
  nodes: GraphNode[];
  degrees: Map<string, number>;
}

/**
 * Percentile del grado oltre il quale un nodo è "molto connesso" e PAVIMENTO
 * assoluto della soglia. Il pavimento serve ai grafi piccoli o poco densi, dove
 * il p95 può valere 1 o 2: senza di esso qualunque simbolo con due archi
 * sembrerebbe un hub. Soglia = max(p95 dei gradi di TUTTI i nodi, pavimento).
 */
const GOD_NODE_PERCENTILE = 0.95;
const GOD_NODE_MIN_DEGREE = 10;

/** Normalizza un path del diff/grafo per il confronto (solo `./` iniziale). */
export function normalizeGraphPath(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

/** Nodo valido → forma ridotta; qualunque scarto → null (nodo ignorato). */
export function toGraphNode(raw: unknown): GraphNode | null {
  if (typeof raw !== "object" || raw === null) return null;
  const node = raw as Record<string, unknown>;
  const { id, label, source_file: sourceFile } = node;
  if (typeof id !== "string" || typeof label !== "string" || typeof sourceFile !== "string") {
    return null;
  }
  const name = node["community_name"];
  const number = node["community"];
  const community =
    typeof name === "string" && name.length > 0
      ? name
      : typeof number === "number" || typeof number === "string"
        ? `Community ${number}`
        : "";
  return { id, label, sourceFile: normalizeGraphPath(sourceFile), community };
}

/** Grado (archi incidenti) per id di nodo. Archi malformati ignorati. */
export function degreesByNodeId(links: unknown[]): Map<string, number> {
  const degrees = new Map<string, number>();
  for (const raw of links) {
    if (typeof raw !== "object" || raw === null) continue;
    const link = raw as Record<string, unknown>;
    for (const end of [link["source"], link["target"]]) {
      if (typeof end !== "string") continue;
      degrees.set(end, (degrees.get(end) ?? 0) + 1);
    }
  }
  return degrees;
}

/**
 * Soglia dei god node: p95 dei gradi di TUTTI i nodi del grafo, con pavimento
 * {@link GOD_NODE_MIN_DEGREE}. Il percentile è calcolato col metodo del
 * "nearest rank" su indice 0-based (nessuna interpolazione: i gradi sono
 * interi e la soglia serve solo a separare gli hub dal resto).
 */
export function godNodeThreshold(nodes: GraphNode[], degrees: Map<string, number>): number {
  const sorted = nodes.map((n) => degrees.get(n.id) ?? 0).sort((a, b) => a - b);
  const index = Math.floor(GOD_NODE_PERCENTILE * (sorted.length - 1));
  return Math.max(sorted[index] ?? 0, GOD_NODE_MIN_DEGREE);
}

/**
 * Carica il `graph.json` del volume e ne estrae nodi validi + gradi. MAI lancia:
 * `null` significa "nessun grafo utilizzabile" (file assente, JSON illeggibile, forma
 * inattesa, nessun nodo valido) e il chiamante prosegue come se il grafo non ci fosse.
 */
export async function loadGraph(graphJsonPath: string): Promise<LoadedGraph | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(graphJsonPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const graph = parsed as Record<string, unknown>;
    if (!Array.isArray(graph["nodes"])) return null;
    const nodes = (graph["nodes"] as unknown[])
      .map(toGraphNode)
      .filter((n): n is GraphNode => n !== null);
    if (nodes.length === 0) return null;
    const degrees = degreesByNodeId(Array.isArray(graph["links"]) ? graph["links"] : []);
    return { nodes, degrees };
  } catch {
    // Fail-open totale: qualunque problema (I/O, JSON, forma) = nessun grafo.
    return null;
  }
}
