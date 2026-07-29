import { godNodeThreshold, loadGraph, type GraphNode } from "./graph-data.js";

/**
 * MAPPA DEL GRAFO PER L'ORIENTAMENTO DEI DOCS (fase 2c graphify).
 *
 * La generazione Docs spende run agente per ricostruire la mappa del repository che il
 * knowledge graph ha già, gratis e deterministica. `summarizeGraphForDocs` la rende in un
 * blocco compatto in INGLESE (la lingua dei prompt del motore docs) da iniettare nel
 * prompt di ORIENTAMENTO come IPOTESI di decomposizione:
 *  - le COMUNITÀ del grafo (le "aree" del codice), per dimensione decrescente, con il
 *    conteggio dei simboli, il numero di file e i file più rappresentativi (i
 *    `source_file` più frequenti della comunità);
 *  - i GOD NODE (simboli molto connessi) con grado e file — i punti da cui il sistema si
 *    capisce, e i candidati naturali a una pagina.
 *
 * FAIL-OPEN ASSOLUTO: la funzione non lancia MAI e ritorna `null` a ogni problema (file
 * assente, JSON corrotto, forma inattesa, grafo senza comunità né hub). Un `null` lascia
 * il prompt di orientamento BYTE-IDENTICO a quello di un repo senza grafo: la pipeline
 * Docs non deve mai peggiorare per colpa del grafo.
 *
 * DETERMINISMO: a parità di grafo la stringa è sempre la stessa (ordinamenti con
 * tie-break sul nome/label).
 *
 * NOTA: graphify mette nel grafo anche un nodo per ogni FILE (oltre ai simboli), quindi
 * un file molto importato può comparire tra i god node col proprio nome. È segnale
 * corretto (quel file è davvero un hub) e non vale la pena filtrarlo.
 */

/** Tetti su quanto della mappa finisce nel prompt (rumore vs segnale). */
export interface DocsGraphMapCaps {
  /** Comunità rese, per dimensione decrescente (default 15). */
  maxCommunities?: number;
  /** God node resi, per grado decrescente (default 10). */
  maxGodNodes?: number;
  /** File rappresentativi per comunità (default 5). */
  maxFilesPerCommunity?: number;
}

const DEFAULT_MAX_COMMUNITIES = 15;
const DEFAULT_MAX_GOD_NODES = 10;
const DEFAULT_MAX_FILES_PER_COMMUNITY = 5;

/** Aggregato di una comunità del grafo. */
interface CommunitySummary {
  name: string;
  /** Simboli della comunità. */
  nodes: number;
  /** File DISTINTI della comunità. */
  files: number;
  /** File più rappresentativi (i più frequenti), già cappati. */
  representativeFiles: string[];
}

/**
 * Aggrega i nodi per comunità: conteggi e file rappresentativi. I file sono ordinati per
 * FREQUENZA decrescente (quanti simboli della comunità vi stanno) con tie-break sul path,
 * così la scelta è deterministica e i file "portanti" dell'area vengono per primi.
 */
function summarizeCommunities(nodes: GraphNode[], maxFiles: number): CommunitySummary[] {
  const byCommunity = new Map<string, Map<string, number>>();
  for (const node of nodes) {
    if (node.community.length === 0) continue;
    const files = byCommunity.get(node.community) ?? new Map<string, number>();
    files.set(node.sourceFile, (files.get(node.sourceFile) ?? 0) + 1);
    byCommunity.set(node.community, files);
  }

  return [...byCommunity.entries()]
    .map(([name, files]) => {
      const nodeCount = [...files.values()].reduce((sum, n) => sum + n, 0);
      const representativeFiles = [...files.entries()]
        .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
        .slice(0, maxFiles)
        .map(([file]) => file);
      return { name, nodes: nodeCount, files: files.size, representativeFiles };
    })
    // Ordine deterministico anche a parità di conteggi (nome crescente).
    .sort((x, y) => y.nodes - x.nodes || y.files - x.files || x.name.localeCompare(y.name));
}

/** Simbolo molto connesso da presentare nella mappa. */
interface GodNodeSummary {
  label: string;
  degree: number;
  sourceFile: string;
}

/** I god node del grafo (grado ≥ soglia p95/pavimento), per grado decrescente. */
function summarizeGodNodes(
  nodes: GraphNode[],
  degrees: Map<string, number>,
): GodNodeSummary[] {
  const threshold = godNodeThreshold(nodes, degrees);
  return nodes
    .map((n) => ({ label: n.label, degree: degrees.get(n.id) ?? 0, sourceFile: n.sourceFile }))
    .filter((n) => n.degree >= threshold)
    .sort((x, y) => y.degree - x.degree || x.label.localeCompare(y.label));
}

/** `1 symbol` / `12 symbols`: la mappa la legge un modello, la grammatica conta. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Blocco "CODE GRAPH MAP" per il prompt di orientamento, o `null` se non c'è nulla da
 * dire (grafo illeggibile/vuoto, nessuna comunità e nessun hub). Vedi il docblock del
 * modulo: MAI lancia.
 */
export async function summarizeGraphForDocs(
  graphJsonPath: string,
  caps?: DocsGraphMapCaps,
): Promise<string | null> {
  try {
    const graph = await loadGraph(graphJsonPath);
    if (!graph) return null;

    const maxFiles = caps?.maxFilesPerCommunity ?? DEFAULT_MAX_FILES_PER_COMMUNITY;
    const communities = summarizeCommunities(graph.nodes, maxFiles).slice(
      0,
      caps?.maxCommunities ?? DEFAULT_MAX_COMMUNITIES,
    );
    const godNodes = summarizeGodNodes(graph.nodes, graph.degrees).slice(
      0,
      caps?.maxGodNodes ?? DEFAULT_MAX_GOD_NODES,
    );
    // Grafo senza comunità né hub: nessuna informazione utile, meglio niente blocco.
    if (communities.length === 0 && godNodes.length === 0) return null;

    const lines: string[] = [
      "CODE GRAPH MAP (deterministic, computed from the repository's pre-built code graph):",
    ];

    if (communities.length > 0) {
      lines.push(
        "",
        "Areas of the codebase (graph communities), largest first — name (symbols, files):",
        "representative files follow each area.",
      );
      for (const c of communities) {
        lines.push(
          `- ${c.name} (${plural(c.nodes, "symbol")}, ${plural(c.files, "file")}): ` +
            c.representativeFiles.join(", "),
        );
      }
    }

    if (godNodes.length > 0) {
      lines.push(
        "",
        "Most connected symbols (god nodes) — the hubs the system turns around:",
      );
      for (const n of godNodes) {
        lines.push(`- \`${n.label}\` (degree ${n.degree}) — ${n.sourceFile}`);
      }
    }

    lines.push(
      "",
      "This map is derived from the code graph, NOT from reading the repository: it is a",
      "lead to VERIFY against the actual files, never a fact to copy.",
    );
    return lines.join("\n");
  } catch {
    // Fail-open totale (difesa in profondità: loadGraph già non lancia).
    return null;
  }
}
