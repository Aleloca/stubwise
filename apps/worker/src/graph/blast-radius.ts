import { t, type Language } from "@stubwise/i18n";

import { godNodeThreshold, loadGraph, normalizeGraphPath } from "./graph-data.js";

/**
 * BLAST RADIUS di una pull request sul knowledge graph (fase 2d graphify).
 *
 * Dai file toccati dal diff si calcola, sul `graph.json` del volume, quali
 * COMUNITÀ del codice la PR attraversa e quali simboli MOLTO CONNESSI (god
 * nodes) coinvolge. È un dato DETERMINISTICO, non allucinabile: finisce sia nel
 * prompt del reviewer (per orientarlo) sia — testuale — nel commento di review
 * pubblicato sulla PR.
 *
 * REGOLA D'ORO: la review non deve MAI peggiorare per colpa del grafo. Nessuna
 * funzione di questo modulo lancia: `computeBlastRadius` ritorna `null` a ogni
 * problema (file assente, JSON illeggibile, forma inattesa, nessun file del
 * diff nel grafo) e i due renderer ritornano stringa vuota su `null` o su un
 * calcolo vuoto — il chiamante non ha nulla da gestire.
 *
 * LETTURA DEL graph.json: delegata a `graph-data.ts` (parse tollerante, gradi,
 * soglia dei god node), condivisa con la mappa del grafo per l'orientamento dei
 * Docs (`docs-summary.ts`). Anche lì `loadGraph` è fail-open (null a ogni problema).
 *
 * NOTA: graphify mette nel grafo anche un nodo per ogni FILE (oltre ai simboli),
 * quindi un file molto importato può comparire tra i god node col proprio nome.
 * È segnale corretto (quel file è davvero un hub) e non vale la pena filtrarlo.
 */

/** Comunità del grafo attraversata dalla PR. */
export interface BlastRadiusCommunity {
  /** Nome della comunità (`community_name`) o ripiego `Community <n>`. */
  name: string;
  /** File DISTINTI toccati dentro la comunità. */
  filesTouched: number;
  /** Simboli toccati dentro la comunità. */
  nodesTouched: number;
}

/** Simbolo toccato con grado molto alto rispetto al resto del grafo. */
export interface BlastRadiusGodNode {
  label: string;
  /** Numero di archi incidenti (entranti + uscenti). */
  degree: number;
}

/** Risultato aggregato del calcolo (mai parziale: o c'è tutto o è `null`). */
export interface BlastRadius {
  /** Comunità attraversate, per simboli toccati decrescenti, già cappate. */
  communities: BlastRadiusCommunity[];
  /** God node toccati, per grado decrescente, già cappati. */
  godNodes: BlastRadiusGodNode[];
  /** Simboli del grafo toccati dalla PR. */
  nodesTouched: number;
  /** File del diff presenti nel grafo. */
  filesInGraph: number;
  /** File del diff assenti dal grafo (nuovi, non codice, esclusi dall'extract). */
  filesNotInGraph: number;
}

/** Tetti su quanto finisce nel prompt e nel commento (rumore vs segnale). */
export interface BlastRadiusCaps {
  maxCommunities?: number;
  maxGodNodes?: number;
}

export interface ComputeBlastRadiusInput {
  /** Path assoluto del graph.json sul volume (vedi `resolveRepoGraphJson`). */
  graphJsonPath: string;
  /** Path relativi alla radice del repo, tipicamente da `parseChangedFiles`. */
  changedFiles: string[];
  caps?: BlastRadiusCaps;
}

const DEFAULT_MAX_COMMUNITIES = 5;
const DEFAULT_MAX_GOD_NODES = 5;

/** Prefisso `diff --git ` di un header di file nel diff unificato di git. */
const DIFF_HEADER_PREFIX = "diff --git ";

/**
 * Rimuove le virgolette che git mette attorno ai path "speciali" (non ASCII,
 * con tab…) quando `core.quotePath` è attivo. Le sequenze di escape C interne
 * NON vengono decodificate: nel peggiore dei casi il path non combacia con
 * nessun nodo del grafo e finisce nel conteggio "fuori dal grafo" — degradare,
 * mai lanciare.
 */
function unquote(path: string): string {
  return path.length >= 2 && path.startsWith('"') && path.endsWith('"')
    ? path.slice(1, -1)
    : path;
}

/**
 * Path dei due lati di un header `diff --git a/<x> b/<y>`, o null se la riga
 * non ha la forma attesa.
 *
 * I path NON sono delimitati e possono contenere spazi: lo split si fa sul
 * separatore ` b/` (o ` "b/` nella forma quotata) scegliendo l'occorrenza che
 * rende i due lati UGUALI — il caso normale (modifica/aggiunta/cancellazione,
 * dove git ripete lo stesso path) — e ripiegando sulla prima occorrenza utile,
 * che è il caso del rename.
 */
function parseDiffHeader(line: string): { a: string; b: string } | null {
  const rest = line.slice(DIFF_HEADER_PREFIX.length);
  let fallback: { a: string; b: string } | null = null;
  for (let i = rest.indexOf(" "); i >= 0; i = rest.indexOf(" ", i + 1)) {
    const left = rest.slice(0, i);
    const right = rest.slice(i + 1);
    const a = unquote(left);
    const b = unquote(right);
    if (!a.startsWith("a/") || !b.startsWith("b/")) continue;
    const sides = { a: a.slice(2), b: b.slice(2) };
    if (sides.a === sides.b) return sides;
    fallback ??= sides;
  }
  return fallback;
}

/**
 * File toccati da un diff unificato, nell'ordine di apparizione e senza
 * duplicati. Legge SOLO gli header `diff --git` a inizio riga (le righe di
 * contenuto del diff hanno tutte un prefisso +/-/spazio, quindi un header
 * fabbricato dentro il codice non può ingannare il parser).
 *
 * Si prendono ENTRAMBI i lati dell'header (deduplicati): coincidono per
 * modifiche, aggiunte e cancellazioni, mentre su un RENAME il lato `a` è il
 * path vecchio — l'unico che il grafo conosce, essendo costruito sul branch di
 * destinazione. Il lato `b` di un file nuovo semplicemente non combacerà con
 * nessun nodo e conterà come "fuori dal grafo".
 */
export function parseChangedFiles(diff: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const line of diff.split("\n")) {
    if (!line.startsWith(DIFF_HEADER_PREFIX)) continue;
    const sides = parseDiffHeader(line);
    if (!sides) continue;
    for (const side of [sides.a, sides.b]) {
      const path = normalizeGraphPath(side);
      if (path.length === 0 || path === "/dev/null" || seen.has(path)) continue;
      seen.add(path);
      files.push(path);
    }
  }
  return files;
}

/**
 * Calcola il blast radius della PR. MAI lancia: `null` significa "niente da
 * dire" (grafo illeggibile, forma inattesa, grafo vuoto, nessun file cambiato)
 * e il chiamante prosegue come se il grafo non ci fosse.
 */
export async function computeBlastRadius(
  input: ComputeBlastRadiusInput,
): Promise<BlastRadius | null> {
  try {
    if (input.changedFiles.length === 0) return null;

    const graph = await loadGraph(input.graphJsonPath);
    if (!graph) return null;
    const { nodes, degrees } = graph;

    const changed = new Set(input.changedFiles.map(normalizeGraphPath));
    const touched = nodes.filter((n) => changed.has(n.sourceFile));
    const filesInGraph = new Set(touched.map((n) => n.sourceFile));

    // Comunità attraversate: simboli toccati e file DISTINTI per comunità.
    const byCommunity = new Map<string, { files: Set<string>; nodes: number }>();
    for (const node of touched) {
      if (node.community.length === 0) continue;
      const entry = byCommunity.get(node.community) ?? { files: new Set<string>(), nodes: 0 };
      entry.files.add(node.sourceFile);
      entry.nodes += 1;
      byCommunity.set(node.community, entry);
    }
    const caps = input.caps ?? {};
    const communities = [...byCommunity.entries()]
      .map(([name, entry]) => ({
        name,
        filesTouched: entry.files.size,
        nodesTouched: entry.nodes,
      }))
      // Ordine deterministico anche a parità di conteggi (nome crescente).
      .sort(
        (x, y) =>
          y.nodesTouched - x.nodesTouched ||
          y.filesTouched - x.filesTouched ||
          x.name.localeCompare(y.name),
      )
      .slice(0, caps.maxCommunities ?? DEFAULT_MAX_COMMUNITIES);

    const threshold = godNodeThreshold(nodes, degrees);
    const godNodes = touched
      .map((n) => ({ label: n.label, degree: degrees.get(n.id) ?? 0 }))
      .filter((n) => n.degree >= threshold)
      .sort((x, y) => y.degree - x.degree || x.label.localeCompare(y.label))
      .slice(0, caps.maxGodNodes ?? DEFAULT_MAX_GOD_NODES);

    return {
      communities,
      godNodes,
      nodesTouched: touched.length,
      filesInGraph: filesInGraph.size,
      filesNotInGraph: changed.size - filesInGraph.size,
    };
  } catch {
    // Fail-open totale: qualunque problema (I/O, JSON, forma) = nessun dato.
    return null;
  }
}

/** true se il calcolo non ha toccato nulla del grafo: niente da mostrare. */
function isEmpty(radius: BlastRadius | null): radius is null {
  return radius === null || radius.nodesTouched === 0;
}

/**
 * Blocco per il PROMPT del reviewer, in INGLESE come il resto di
 * `buildReviewPrompt`. Stringa vuota se non c'è nulla da dire (nessun rumore
 * nel prompt). Senza newline in testa o in coda: il chiamante compone.
 */
export function renderBlastRadiusPromptBlock(radius: BlastRadius | null): string {
  if (isEmpty(radius)) return "";
  const lines = [
    `## Code graph impact (deterministic, computed from the code graph — not from the diff)`,
    `- Files touched: ${radius.filesInGraph} in the graph, ${radius.filesNotInGraph} outside it — symbols touched: ${radius.nodesTouched}`,
  ];
  if (radius.communities.length > 0) {
    lines.push(
      `- Areas (graph communities) crossed: ${radius.communities
        .map((c) => `${c.name} (files: ${c.filesTouched}, symbols: ${c.nodesTouched})`)
        .join(", ")}`,
    );
  }
  if (radius.godNodes.length > 0) {
    lines.push(
      `- Highly connected symbols touched (god nodes): ${radius.godNodes
        .map((n) => `\`${n.label}\` (degree ${n.degree})`)
        .join(", ")}`,
    );
  }
  lines.push(
    `Use it to judge how far the change reaches: many areas or a god node mean a wide blast radius, so check the callers with the graph commands above.`,
  );
  return lines.join("\n");
}

/**
 * Sezione "Impatto sul codice" per il commento PUBBLICATO (ticket e PR).
 * Tradotta nella lingua dei contenuti d'istanza via `@stubwise/i18n`, come il
 * resto dei testi pubblicati dalla review (verdetto, corpo del ticket).
 * Stringa vuota se non c'è nulla da dire: la sezione va omessa, non vuota.
 */
export function renderBlastRadiusSection(lang: Language, radius: BlastRadius | null): string {
  if (isEmpty(radius)) return "";
  const lines = [
    t(lang, "comment.reviewImpact.title"),
    `- ${t(lang, "comment.reviewImpact.files", {
      inGraph: radius.filesInGraph,
      outside: radius.filesNotInGraph,
      nodes: radius.nodesTouched,
    })}`,
  ];
  if (radius.communities.length > 0) {
    lines.push(
      `- ${t(lang, "comment.reviewImpact.communities", {
        list: radius.communities
          .map((c) =>
            t(lang, "comment.reviewImpact.communityEntry", {
              name: c.name,
              files: c.filesTouched,
              nodes: c.nodesTouched,
            }),
          )
          .join(", "),
      })}`,
    );
  }
  if (radius.godNodes.length > 0) {
    lines.push(
      `- ${t(lang, "comment.reviewImpact.godNodes", {
        list: radius.godNodes
          .map((n) =>
            t(lang, "comment.reviewImpact.godNodeEntry", { label: n.label, degree: n.degree }),
          )
          .join(", "),
      })}`,
    );
  }
  return lines.join("\n");
}
