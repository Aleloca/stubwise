/**
 * Parser del sottografo restituito da `query_graph` (graphify).
 *
 * L'output è testo pensato per un LLM, non un formato serializzato: header del
 * traversal, eventuale avviso di troncamento, righe `NODE` e righe `EDGE`. A
 * noi servono solo le ancore `file:riga` dei nodi, nell'ORDINE in cui graphify
 * le elenca (i seed della domanda vengono per primi = più rilevanti), per
 * decidere quali estratti di codice allegare al prompt.
 *
 * Forma reale di una riga (0.9.28):
 *   `NODE streamChatResponse() [src=apps/server/src/routes/docs-chat-core.ts loc=L106 community=5]`
 *
 * Il parser è volutamente TOLLERANTE: attributi in più, in meno o in ordine
 * diverso non devono farlo inciampare, e qualunque riga che non combacia viene
 * semplicemente ignorata (fail-open: il sottografo resta comunque nel prompt,
 * al massimo si perdono degli snippet).
 */

/** Ancora `file:riga` di un nodo del sottografo. */
export interface SubgraphNode {
  /** Nome del simbolo così come lo chiama graphify (es. `streamChatResponse()`). */
  label: string;
  /** Percorso relativo alla radice del repository. */
  path: string;
  /** Riga di definizione (1-based). */
  line: number;
}

/**
 * Distanza minima tra due nodi dello stesso file: sotto questa soglia le
 * finestre di codice si sovrapporrebbero quasi del tutto, quindi il secondo
 * nodo è considerato un quasi-duplicato e scartato.
 */
const MIN_LINE_DISTANCE = 10;

const NODE_LINE = /^NODE\s+(\S.*?)\s+\[(.*)\]\s*$/;
const SRC_ATTR = /(?:^|\s)src=(\S+)/;
const LOC_ATTR = /(?:^|\s)loc=L(\d+)(?:\s|$)/;

/** Ultimo segmento del path, con e senza estensione. */
function basenames(path: string): [string, string] {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return [base, dot > 0 ? base.slice(0, dot) : base];
}

/**
 * `true` per i nodi-FILE di graphify, che rappresentano il file intero e non un
 * simbolo: convenzionalmente hanno `loc=L1` e label uguale al basename del path
 * (con o senza estensione). Un estratto delle prime righe di un file non
 * aggiunge nulla di utile al prompt.
 */
function isFileNode(label: string, path: string, line: number): boolean {
  if (line !== 1) return false;
  const [withExt, withoutExt] = basenames(path);
  return label === withExt || label === withoutExt;
}

/**
 * Estrae le ancore dei nodi dal testo del sottografo, preservandone l'ordine.
 * Scarta: righe non-NODE, nodi senza `src` o senza `loc` numerica, nodi-file e
 * quasi-duplicati (stesso file, riga a meno di {@link MIN_LINE_DISTANCE} da una
 * già presa).
 */
export function parseSubgraphNodes(text: string): SubgraphNode[] {
  const nodes: SubgraphNode[] = [];
  /** Righe già prese, per file: serve solo al filtro dei quasi-duplicati. */
  const takenByPath = new Map<string, number[]>();

  for (const rawLine of text.split("\n")) {
    const match = NODE_LINE.exec(rawLine);
    if (!match) continue;
    const label = match[1];
    const attrs = match[2];
    if (label === undefined || attrs === undefined) continue;

    const src = SRC_ATTR.exec(attrs)?.[1];
    const loc = LOC_ATTR.exec(attrs)?.[1];
    if (!src || !loc) continue;

    const line = Number.parseInt(loc, 10);
    if (!Number.isFinite(line) || line < 1) continue;
    if (isFileNode(label, src, line)) continue;

    const taken = takenByPath.get(src) ?? [];
    if (taken.some((other) => Math.abs(other - line) < MIN_LINE_DISTANCE)) continue;

    taken.push(line);
    takenByPath.set(src, taken);
    nodes.push({ label, path: src, line });
  }

  return nodes;
}
