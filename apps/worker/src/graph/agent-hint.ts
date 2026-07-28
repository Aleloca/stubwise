import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * HINT del knowledge graph per i PROMPT degli agenti (fase 2a dell'integrazione
 * graphify): quando il repository ha un grafo costruito sul volume, i run
 * agente (fix, deep dive, sessioni di analisi) ricevono nel prompt il comando
 * per interrogarlo — più rapido e preciso del grep per le domande strutturali —
 * e nell'allowlist i pattern Bash read-only del CLI.
 *
 * Il path passato è quello del VOLUME (`GRAPHS_DIR`), sempre fresco (rigenerato
 * sul push), NON l'eventuale copia committata nel repo dalla PR di setup, che è
 * solo il bootstrap per i dev.
 *
 * SICUREZZA: i tre pattern coprono solo i sottocomandi read-only di
 * interrogazione (query/explain/path). Nel fix l'allowlist consente già di
 * eseguire i test del repo (esecuzione di codice arbitrario nel worktree),
 * quindi qui non si aggiunge capacità nuova; nei run plan-mode (deep dive,
 * sessioni) è la prima apertura Bash, limitata a letture del grafo.
 */
export const GRAPHIFY_AGENT_ALLOWED_TOOLS = [
  "Bash(graphify query:*)",
  "Bash(graphify explain:*)",
  "Bash(graphify path:*)",
];

/** Nome fisso della directory di output di graphify (contratto del CLI). */
const GRAPHIFY_OUT_DIR = "graphify-out";

/**
 * Path del graph.json del repository sul volume, o null se il grafo non è mai
 * stato costruito (toggle spento, build mai riuscita, o volume ricreato). Il
 * check è l'esistenza del file: è la stessa fonte di verità della UI.
 */
export function resolveRepoGraphJson(graphsDir: string, repositoryId: string): string | null {
  const path = join(graphsDir, repositoryId, GRAPHIFY_OUT_DIR, "graph.json");
  return existsSync(path) ? path : null;
}

/** Un grafo da presentare nel prompt: label solo nei progetti multi-repo. */
export interface GraphHintEntry {
  /** Nome del repository (mostrato solo se ci sono più grafi). */
  label?: string;
  /** Path assoluto del graph.json sul volume. */
  graphJsonPath: string;
}

/**
 * Blocco di prompt che presenta il grafo e i comandi di interrogazione.
 * Stringa vuota senza grafi (nessun rumore nel prompt). `lang` segue la lingua
 * del prompt CHIAMANTE (i prompt del fix sono in inglese, quelli del backlog in
 * italiano), non la lingua dei contenuti dell'istanza.
 */
export function renderGraphHint(entries: GraphHintEntry[], lang: "en" | "it"): string {
  if (entries.length === 0) return "";
  // Forma inline solo per l'entry singola SENZA label: una label presente va
  // sempre mostrata (progetto multi-repo con un solo grafo: l'agente deve
  // sapere di QUALE repo è il grafo).
  const single = entries.length === 1 && entries[0]!.label === undefined ? entries[0] : undefined;
  if (lang === "it") {
    const commands = [
      `- \`graphify query "<domanda>" --graph <path>\` — sottografo rilevante per una domanda`,
      `- \`graphify explain "<simbolo>" --graph <path>\` — tutte le relazioni di un simbolo`,
      `- \`graphify path "<A>" "<B>" --graph <path>\` — come due simboli sono collegati`,
    ].join("\n");
    const where = single
      ? `Il grafo è in \`${single.graphJsonPath}\` (usa quel path come \`--graph\`).`
      : `I grafi disponibili (usa il path come \`--graph\`):\n${entries
          .map((e) => `- ${e.label ?? "repo"}: \`${e.graphJsonPath}\``)
          .join("\n")}`;
    return `\n\nGRAFO DEL CODICE: è disponibile un knowledge graph già costruito del codice (simboli e relazioni chiamate/import/ereditarietà, con file:riga esatti). Per le domande STRUTTURALI ("chi chiama X?", "come sono collegati A e B?") interrogalo PRIMA di cercare col grep — è più rapido e preciso:\n${commands}\n${where}`;
  }
  const commands = [
    `- \`graphify query "<question>" --graph <path>\` — relevant subgraph for a question`,
    `- \`graphify explain "<symbol>" --graph <path>\` — every relationship of one symbol`,
    `- \`graphify path "<A>" "<B>" --graph <path>\` — how two symbols connect`,
  ].join("\n");
  const where = single
    ? `The graph lives at \`${single.graphJsonPath}\` (use that path as \`--graph\`).`
    : `Available graphs (use the path as \`--graph\`):\n${entries
        .map((e) => `- ${e.label ?? "repo"}: \`${e.graphJsonPath}\``)
        .join("\n")}`;
  return `\n\nCODE GRAPH: a pre-built knowledge graph of the code is available (symbols and their call/import/inheritance relationships, each with its exact file:line). For STRUCTURAL questions ("what calls X?", "how are A and B connected?") query it BEFORE grepping — it is faster and more precise:\n${commands}\n${where}`;
}
