import { repoGraphs, repositories, type Db } from "@stubwise/db";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { GraphMcpClient } from "./client.js";
import { extractSnippets, type Snippet } from "./snippets.js";
import { parseSubgraphNodes } from "./subgraph.js";

/**
 * Retrieval strutturale dal knowledge graph per le chat interne (fase 2b).
 *
 * Mette in fila i pezzi già testati singolarmente — client MCP (client.ts),
 * parser del sottografo (subgraph.ts), estrattore di snippet (snippets.ts) — e
 * produce UN blocco di testo da appendere al system prompt delle chat, accanto
 * ai chunk documentali recuperati da pgvector.
 *
 * REGOLA D'ORO della fase 2b: **la chat non deve MAI peggiorare per colpa del
 * grafo**. Nessuna funzione di questo modulo lancia: feature spenta, repository
 * senza grafo, graphify irraggiungibile, mirror illeggibile o eccezione
 * imprevista valgono tutti `null`, e il chiamante prosegue con la chat di oggi.
 */

/** Logger minimale in stile pino (vedi GraphMcpLogger in client.ts). */
export interface GraphContextLogger {
  debug(obj: unknown, msg?: string): void;
}

/** Sottoinsieme della config del server che serve al retrieval dal grafo. */
export interface GraphChatConfig {
  /** Budget di token del sottografo chiesto a `query_graph`. */
  graphChatTokenBudget: number;
  /** Tetto complessivo dei caratteri di codice allegati. */
  graphChatSnippetMaxChars: number;
  /** Massimo numero di nodi del sottografo da cui estrarre snippet. */
  graphChatSnippetNodes: number;
  /** Radice dei mirror git bare montata sul server. */
  mirrorsDir: string;
}

export interface GraphContextDeps {
  db: Db;
  /** Client MCP verso graphify, oppure `null` se la feature è spenta (`GRAPHIFY_MCP_URL` vuota). */
  client: GraphMcpClient | null;
  config: GraphChatConfig;
  logger: GraphContextLogger;
}

/**
 * La parte di {@link GraphContextDeps} che vive per l'INTERO processo (client
 * MCP e tetti di config), decorata sull'app Fastify come `app.graphChat`. Le
 * route la completano con `db` e il logger della richiesta:
 * `{ db: app.db, logger: request.log, ...app.graphChat }`.
 */
export interface GraphChatRuntime {
  client: GraphMcpClient | null;
  config: GraphChatConfig;
}

/**
 * Radice dei grafi **dentro il container `graphify`**, dove è montato il volume
 * condiviso `graphs`. NON è un path del server (che monta lo stesso volume, ma
 * il suo `GRAPHS_DIR` serve a servire gli artefatti via HTTP e potrebbe
 * divergere): `project_path` viene risolto da graphify sul SUO filesystem,
 * quindi è una costante del protocollo tra i due container, non configurazione.
 */
const GRAPHIFY_PROJECT_ROOT = "/graphs";

/** `project_path` del grafo di un repository, come lo vede graphify. */
function graphProjectPath(repositoryId: string): string {
  return `${GRAPHIFY_PROJECT_ROOT}/${repositoryId}`;
}

/** Righe di istruzione al modello, premesse al blocco. */
const INSTRUCTIONS = [
  "Per le domande STRUTTURALI sul codice (chi chiama cosa, dove è definito X, come sono collegati A e B) usa la sezione qui sotto, estratta dal knowledge graph del codice: quando affermi qualcosa sul codice CITA SEMPRE il riferimento nella forma `percorso/del/file.ts:riga`.",
  "Per le domande funzionali o di prodotto restano prioritarie le pagine di documentazione recuperate sopra.",
];

/**
 * Fence markdown abbastanza lungo da contenere il codice dato: un sorgente che
 * contiene già ``` (markdown, docstring, template) chiuderebbe il blocco in
 * anticipo e sfalserebbe tutto il prompt.
 */
function fenceFor(code: string): string {
  let longest = 0;
  for (const run of code.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Compone il blocco da appendere al system prompt: istruzioni, sottografo
 * verbatim (è già testo pensato per un LLM) e, se ce ne sono, gli estratti di
 * codice con l'ancora `path:Lstart-Lend` che il modello deve citare. Il commit
 * compare in forma corta nell'intestazione: dice al modello (e all'utente) a
 * quale istantanea del codice si riferisce la struttura.
 */
export function buildGraphContextBlock(
  subgraphText: string,
  snippets: Snippet[],
  commitSha: string,
): string {
  const parts = [
    ...INSTRUCTIONS,
    "",
    `--- STRUTTURA DEL CODICE (knowledge graph al commit ${commitSha.slice(0, 7)}) ---`,
    subgraphText,
  ];

  if (snippets.length > 0) {
    parts.push("--- ESTRATTI DAL CODICE ---");
    for (const snippet of snippets) {
      const fence = fenceFor(snippet.code);
      parts.push(
        [
          `### ${snippet.path}:L${snippet.startLine}-L${snippet.endLine}`,
          fence,
          snippet.code,
          fence,
        ].join("\n"),
      );
    }
  }

  return parts.join("\n");
}

/**
 * Appende il blocco del grafo al system prompt di una chat, se c'è.
 *
 * L'ORDINE è vincolante: le istruzioni del blocco rimandano alla
 * "documentazione recuperata sopra", quindi il grafo va SEMPRE dopo il contesto
 * documentale. Con `null` (feature spenta, grafo assente, graphify giù) il
 * system torna identico byte per byte a quello di prima della fase 2b.
 */
export function appendGraphContext(system: string, block: string | null): string {
  return block === null ? system : `${system}\n\n${block}`;
}

/** Riga di gating: quel che serve per interrogare il grafo di un repository. */
interface GraphableRepo {
  id: string;
  name: string;
  repoUrl: string;
  commitSha: string;
}

/**
 * Interroga il grafo di UN repository già validato e ne compone il blocco.
 * Fail-open: qualunque intoppo (query a vuoto, mirror illeggibile, eccezione)
 * vale `null`.
 */
async function blockForRepo(
  deps: GraphContextDeps,
  client: GraphMcpClient,
  repo: GraphableRepo,
  question: string,
  tokenBudget: number,
): Promise<string | null> {
  try {
    const subgraph = await client.queryGraph({
      projectPath: graphProjectPath(repo.id),
      question,
      tokenBudget,
    });
    if (!subgraph) return null;

    const snippets = await extractSnippets({
      mirrorsDir: deps.config.mirrorsDir,
      repoUrl: repo.repoUrl,
      commitSha: repo.commitSha,
      nodes: parseSubgraphNodes(subgraph),
      maxNodes: deps.config.graphChatSnippetNodes,
      maxTotalChars: deps.config.graphChatSnippetMaxChars,
      logger: deps.logger,
    });

    return buildGraphContextBlock(subgraph, snippets, repo.commitSha);
  } catch (err) {
    deps.logger.debug(
      { err, repositoryId: repo.id },
      "[graph-chat] retrieval dal grafo fallito: la chat prosegue senza",
    );
    return null;
  }
}

/**
 * Condizioni di gating, identiche per la variante repo e quella di progetto:
 * toggle `graphEnabled` acceso, ultima build `done` e commit noto (senza sha
 * non si saprebbe quale versione del codice leggere dal mirror).
 */
const READY_FOR_RETRIEVAL = and(
  eq(repositories.graphEnabled, true),
  eq(repoGraphs.status, "done"),
  isNotNull(repoGraphs.commitSha),
);

/** Colonne selezionate dal join repositories+repo_graphs. */
const GRAPHABLE_COLUMNS = {
  id: repositories.id,
  name: repositories.name,
  repoUrl: repositories.repoUrl,
  commitSha: repoGraphs.commitSha,
};

/**
 * Blocco di contesto dal grafo di un singolo repository, oppure `null` se la
 * feature è spenta, il repository non ha un grafo pronto o qualcosa è andato
 * storto.
 */
export async function retrieveGraphContext(
  deps: GraphContextDeps,
  { repositoryId, question }: { repositoryId: string; question: string },
): Promise<string | null> {
  const { client } = deps;
  if (!client) return null;

  try {
    const [row] = await deps.db
      .select(GRAPHABLE_COLUMNS)
      .from(repositories)
      .innerJoin(repoGraphs, eq(repoGraphs.repositoryId, repositories.id))
      .where(and(eq(repositories.id, repositoryId), READY_FOR_RETRIEVAL))
      .limit(1);
    // `commitSha` è nullable nello schema: il filtro SQL lo esclude già, il
    // controllo qui è solo per il tipo.
    if (!row?.commitSha) return null;

    return await blockForRepo(
      deps,
      client,
      { ...row, commitSha: row.commitSha },
      question,
      deps.config.graphChatTokenBudget,
    );
  } catch (err) {
    deps.logger.debug({ err, repositoryId }, "[graph-chat] retrieval dal grafo fallito");
    return null;
  }
}

/**
 * Variante per la chat di progetto: interroga in PARALLELO i grafi di tutti i
 * repository abilitati del progetto, dividendo il budget di token per il loro
 * numero (il prompt complessivo resta della stessa taglia della chat per-repo),
 * e concatena i blocchi ottenuti in ordine di nome del repository — ordine
 * stabile, così due chat sulla stessa domanda producono lo stesso prompt.
 *
 * Ogni ramo è indipendente: il repository il cui grafo manca o fallisce sparisce
 * dal contesto senza toccare gli altri.
 *
 * NOTA sul circuit breaker del client (Task 3): N query parallele fallite
 * contano N errori CONSECUTIVI, quindi con 3+ repository giù insieme il
 * circuito può aprirsi in un giro solo. È accettato: se graphify non risponde a
 * tre query di fila, sospendere il retrieval per qualche minuto è esattamente
 * il comportamento voluto.
 */
export async function retrieveGraphContextForProject(
  deps: GraphContextDeps,
  { projectId, question }: { projectId: string; question: string },
): Promise<string | null> {
  const { client } = deps;
  if (!client) return null;

  try {
    const rows = await deps.db
      .select(GRAPHABLE_COLUMNS)
      .from(repositories)
      .innerJoin(repoGraphs, eq(repoGraphs.repositoryId, repositories.id))
      .where(and(eq(repositories.projectId, projectId), READY_FOR_RETRIEVAL))
      // `id` come secondo criterio: due repository possono avere lo stesso nome.
      .orderBy(asc(repositories.name), asc(repositories.id));
    const repos = rows.filter((row): row is GraphableRepo => row.commitSha !== null);
    if (repos.length === 0) return null;

    const tokenBudget = Math.max(1, Math.floor(deps.config.graphChatTokenBudget / repos.length));
    const blocks = await Promise.all(
      repos.map(async (repo) => {
        const block = await blockForRepo(deps, client, repo, question, tokenBudget);
        return block === null ? null : `=== Repository "${repo.name}" ===\n${block}`;
      }),
    );

    const present = blocks.filter((block): block is string => block !== null);
    return present.length > 0 ? present.join("\n\n") : null;
  } catch (err) {
    deps.logger.debug({ err, projectId }, "[graph-chat] retrieval dal grafo di progetto fallito");
    return null;
  }
}
