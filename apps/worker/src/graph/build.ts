import { decrypt, gitAccounts, repoGraphs, repositories, type Db, type GraphJob } from "@stubwise/db";
import { eq, sql } from "drizzle-orm";
import { join } from "node:path";
import { z } from "zod";
import type { MirrorManager, MirrorProject } from "../git/mirrors.js";
import type { GraphifyRunner } from "./graphify-cli.js";
import { failGraphJob } from "./queue.js";

/**
 * RUNNER della build del knowledge graph di un repository (job `graph_jobs`
 * kind `build`, già reclamato dal poller).
 *
 * Sequenza, tutta dentro UN worktree read-only a HEAD del default branch:
 *  1. `repo_graphs` → `running` (upsert: la riga può non esistere ancora).
 *  2. `graphify extract <worktree> --code-only [--force]` — estrazione locale
 *     via tree-sitter, nessuna chiamata LLM. Fallimento = build fallita.
 *  3. clustering + report: `cluster-only <worktree> --backend=claude-cli`
 *     (nomi delle comunità con l'abbonamento del claude CLI) e, se fallisce o
 *     se il labeling è disabilitato, `cluster-only <worktree> --no-label`
 *     (placeholder "Community N", ma GRAPH_REPORT.md c'è comunque).
 *  4. `export html` — rigenera graph.html dal grafo appena scritto.
 *  5. `repo_graphs` → `done` con sha, contatori, `labeled`, `generated_at`.
 *
 * COSA È BLOCCANTE E COSA NO: solo l'extract (e il worktree) fanno fallire la
 * build. Clustering ed export producono artefatti ACCESSORI (report, nomi delle
 * comunità, html): se falliscono il grafo estratto resta valido e interrogabile,
 * quindi si logga un warning e si prosegue — fallire l'intera build per il
 * labeling significherebbe non avere nemmeno graph.json.
 *
 * DIVISIONE COL CHIAMANTE (poller, Task 4): il runner chiude il job SOLO in caso
 * di fallimento (`failGraphJob`, che è anche l'unico modo di riflettere l'errore
 * su `repo_graphs`) e restituisce `false`. Sul successo restituisce `true`
 * lasciando la chiusura al chiamante (`completeGraphJob`), che la fa in modo
 * uniforme per tutti i kind. Entrambe le transizioni sono status-guarded su
 * `running`: un job riaccodato dal recovery nel frattempo non viene sovrascritto.
 *
 * NOTA output: `GRAPHIFY_OUT` è assoluto (`<GRAPHS_DIR>/<repositoryId>/
 * graphify-out`), quindi graphify scrive sul VOLUME condiviso e non nel
 * worktree — che resta pulito e viene smontato subito dopo. Il worktree è
 * effimero anche per la cache incrementale: il manifest di graphify usa path
 * relativi ri-ancorati, quindi la dir temporanea non la invalida.
 */

/** Nome fisso della directory di output di graphify (contratto del CLI). */
const GRAPHIFY_OUT_DIR = "graphify-out";

/** Log minimo richiesto dal runner (stessa forma di BacklogLogger). */
export interface GraphLogger {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface GraphBuildDeps {
  db: Db;
  /** Mirror manager condiviso: HEAD del default branch + worktree effimero. */
  mirrors: Pick<MirrorManager, "resolveDefaultBranchHead" | "withWorktreeAtSha">;
  /** Runner del CLI graphify (iniettato: nei test è un fake). */
  graphify: GraphifyRunner;
  logger: GraphLogger;
  /** Chiave AES-256 per decifrare le credenziali git del repository. */
  encryptionKey: Buffer;
  /** Radice del volume condiviso dei grafi (GRAPHS_DIR). */
  graphsDir: string;
  /** Labeling delle comunità col backend claude-cli (GRAPH_LABEL_ENABLED). */
  labelEnabled: boolean;
  /** Timeout (ms) di ogni invocazione del CLI. */
  timeoutMs: number;
}

/** Contatori del grafo estratti dal riepilogo dell'extract. */
export interface GraphCounts {
  nodes: number;
  edges: number;
  communities: number | null;
}

/** Forma attesa delle credenziali git decifrate (mirror di backlog/deep-dive.ts). */
const credentialsSchema = z.object({
  username: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  token: z.string().min(1),
});

/**
 * Riga di riepilogo di `graphify extract` (v0.9.28):
 *   `[graphify extract] wrote /…/graph.json: 5701 nodes, 11463 edges, 263 communities`
 * La regex NON è ancorata al path (cambia a ogni repo) né al prefisso del CLI, e
 * il pezzo `communities` è opzionale: col percorso `--no-cluster` graphify stampa
 * la stessa riga senza comunità. Si prende l'ULTIMA occorrenza: se il CLI
 * aggiungesse righe simili prima del riepilogo, quella finale è il totale.
 */
const EXTRACT_COUNTS_RE = /(\d[\d,]*)\s+nodes,\s*(\d[\d,]*)\s+edges(?:,\s*(\d[\d,]*)\s+communities)?/gi;

/** Numero con eventuali separatori delle migliaia → intero. */
function toInt(raw: string): number {
  return Number.parseInt(raw.replace(/,/g, ""), 10);
}

/**
 * Estrae i contatori dal riepilogo dell'extract. Null se la riga non c'è (una
 * versione del CLI che cambia il formato NON deve far fallire una build
 * riuscita: si perde solo il dato mostrato in UI). Funzione pura.
 */
export function parseExtractCounts(output: string): GraphCounts | null {
  const matches = [...output.matchAll(EXTRACT_COUNTS_RE)];
  const last = matches.at(-1);
  if (!last) return null;
  return {
    nodes: toInt(last[1]!),
    edges: toInt(last[2]!),
    communities: last[3] !== undefined ? toInt(last[3]) : null,
  };
}

/**
 * Carica il MirrorProject del repository (credenziali git decifrate). Repository
 * inesistente o credenziali illeggibili → throw: la build fallisce con un errore
 * leggibile in UI (nessun retry applicativo, il job è terminale).
 */
async function loadMirrorProject(deps: GraphBuildDeps, repositoryId: string): Promise<MirrorProject> {
  const [row] = await deps.db
    .select({ repository: repositories, account: gitAccounts })
    .from(repositories)
    .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
    .where(eq(repositories.id, repositoryId));
  if (!row) throw new Error(`repository ${repositoryId} inesistente`);
  let credentials: z.infer<typeof credentialsSchema>;
  try {
    credentials = credentialsSchema.parse(
      JSON.parse(decrypt(row.account.encryptedCredentials, deps.encryptionKey)),
    );
  } catch {
    throw new Error(`credenziali git del repository ${repositoryId} non decifrabili`);
  }
  return {
    provider: row.repository.provider,
    repoUrl: row.repository.repoUrl,
    defaultBranch: row.repository.defaultBranch,
    credentials,
  };
}

/**
 * Porta la riga di stato del grafo a `running` azzerando l'errore precedente
 * (una rigenerazione riparte pulita). UPSERT: la riga può non esistere ancora.
 * `updated_at` esplicito — su `repo_graphs` non c'è alcun trigger.
 */
async function markRunning(db: Db, repositoryId: string): Promise<void> {
  await db
    .insert(repoGraphs)
    .values({ repositoryId, status: "running", error: null })
    .onConflictDoUpdate({
      target: repoGraphs.repositoryId,
      set: { status: "running", error: null, updatedAt: sql`now()` },
    });
}

/**
 * Scrive l'esito riuscito: sha del commit estratto, contatori (null se il
 * riepilogo non era parsabile), `labeled` e `generated_at`. UPSERT come
 * markRunning, `updated_at` esplicito.
 */
async function markDone(
  db: Db,
  repositoryId: string,
  commitSha: string,
  counts: GraphCounts | null,
  labeled: boolean,
): Promise<void> {
  const values = {
    status: "done" as const,
    commitSha,
    nodeCount: counts?.nodes ?? null,
    edgeCount: counts?.edges ?? null,
    communityCount: counts?.communities ?? null,
    labeled,
    error: null,
  };
  await db
    .insert(repoGraphs)
    .values({ repositoryId, ...values, generatedAt: sql`now()` })
    .onConflictDoUpdate({
      target: repoGraphs.repositoryId,
      set: { ...values, generatedAt: sql`now()`, updatedAt: sql`now()` },
    });
}

/**
 * Estrazione del grafo. Unico passo BLOCCANTE: un exit non-zero fa fallire la
 * build (l'output catturato finisce nell'errore, già troncato dal runner e poi
 * da failGraphJob). `--force` solo quando il job lo richiede (push con
 * cancellazioni: senza, lo shrink-guard di graphify rifiuterebbe la scrittura).
 */
async function runExtract(
  deps: GraphBuildDeps,
  job: GraphJob,
  worktreeDir: string,
  outDir: string,
): Promise<GraphCounts | null> {
  const args = ["extract", worktreeDir, "--code-only"];
  if (job.force) args.push("--force");
  const result = await deps.graphify({
    args,
    cwd: worktreeDir,
    extraEnv: { GRAPHIFY_OUT: outDir },
    timeoutMs: deps.timeoutMs,
  });
  if (result.exitCode !== 0) {
    throw new Error(`graphify extract uscito con exit ${result.exitCode}: ${result.output}`);
  }
  const counts = parseExtractCounts(result.output);
  if (!counts) {
    deps.logger.warn(
      { jobId: job.id, repositoryId: job.repositoryId },
      "[graph] riepilogo dell'extract non parsabile: contatori non salvati",
    );
  }
  return counts;
}

/**
 * Clustering + GRAPH_REPORT.md. Con il labeling attivo prova prima il backend
 * `claude-cli` (nomi veri delle comunità); se fallisce ripiega su `--no-label`
 * per avere comunque il report. Restituisce `labeled` = true SOLO se il labeling
 * col backend è andato a buon fine. Mai bloccante: vedi il commento di modulo.
 */
async function runClustering(
  deps: GraphBuildDeps,
  job: GraphJob,
  worktreeDir: string,
  outDir: string,
): Promise<boolean> {
  const run = (extra: string): Promise<{ exitCode: number; output: string }> =>
    deps.graphify({
      args: ["cluster-only", worktreeDir, extra],
      cwd: worktreeDir,
      extraEnv: { GRAPHIFY_OUT: outDir },
      timeoutMs: deps.timeoutMs,
    });

  if (deps.labelEnabled) {
    const labeled = await run("--backend=claude-cli");
    if (labeled.exitCode === 0) return true;
    deps.logger.warn(
      { jobId: job.id, repositoryId: job.repositoryId, output: labeled.output },
      "[graph] labeling delle comunità fallito: ripiego su --no-label",
    );
  }
  const plain = await run("--no-label");
  if (plain.exitCode !== 0) {
    deps.logger.warn(
      { jobId: job.id, repositoryId: job.repositoryId, output: plain.output },
      "[graph] clustering fallito: il grafo resta valido ma senza report aggiornato",
    );
  }
  return false;
}

/**
 * Rigenera `graph.html` dal grafo sul volume (`export html` legge da
 * GRAPHIFY_OUT). Accessorio: un fallimento lascia il grafo valido, la tab Grafo
 * mostrerà solo report e metadati.
 */
async function runExportHtml(
  deps: GraphBuildDeps,
  job: GraphJob,
  worktreeDir: string,
  outDir: string,
): Promise<void> {
  const result = await deps.graphify({
    args: ["export", "html"],
    cwd: worktreeDir,
    extraEnv: { GRAPHIFY_OUT: outDir },
    timeoutMs: deps.timeoutMs,
  });
  if (result.exitCode !== 0) {
    deps.logger.warn(
      { jobId: job.id, repositoryId: job.repositoryId, output: result.output },
      "[graph] export html fallito: graph.html non aggiornato",
    );
  }
}

/**
 * Esegue la build del grafo del repository del job. Vedi il commento di modulo
 * per sequenza, cosa è bloccante e divisione col chiamante.
 *
 * @returns true = build riuscita, il chiamante chiude il job con
 * `completeGraphJob`; false = fallita e GIÀ chiusa `failed` dal runner
 * (`repo_graphs` compreso).
 */
export async function runGraphBuild(deps: GraphBuildDeps, job: GraphJob): Promise<boolean> {
  // Path costruito da GRAPHS_DIR + repositoryId (uuid dal DB): nessun segmento
  // arbitrario, nessun traversal possibile.
  const outDir = join(deps.graphsDir, job.repositoryId, GRAPHIFY_OUT_DIR);
  try {
    await markRunning(deps.db, job.repositoryId);
    const project = await loadMirrorProject(deps, job.repositoryId);
    // Sha di HEAD del default branch + worktree DETACHED su quello sha: read-only
    // (nessun branch creato) e smontato in finally da withWorktreeAtSha, anche se
    // l'estrazione lancia.
    const headSha = await deps.mirrors.resolveDefaultBranchHead(project);
    const { counts, labeled } = await deps.mirrors.withWorktreeAtSha(project, headSha, async (dir) => {
      const extracted = await runExtract(deps, job, dir, outDir);
      const isLabeled = await runClustering(deps, job, dir, outDir);
      await runExportHtml(deps, job, dir, outDir);
      return { counts: extracted, labeled: isLabeled };
    });
    await markDone(deps.db, job.repositoryId, headSha, counts, labeled);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.error(
      { jobId: job.id, repositoryId: job.repositoryId, error: message },
      "[graph] build del grafo fallita",
    );
    await failGraphJob(deps.db, job.id, message);
    return false;
  }
}
