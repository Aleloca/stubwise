import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { graphJobs, repoGraphs, repositories } from "@stubwise/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/session.js";
import { apiError } from "../errors.js";
import { authErrorResponses, errorSchema, isUniqueViolation } from "./shared.js";

/** Sottodirectory in cui graphify scrive i suoi artefatti, dentro `<GRAPHS_DIR>/<repositoryId>/`. */
const GRAPHIFY_OUT_DIR = "graphify-out";

/** Nomi FISSI dei file serviti: nessun parametro filename arriva mai dal client. */
const GRAPH_JSON = "graph.json";
const GRAPH_REPORT = "GRAPH_REPORT.md";
const GRAPH_HTML = "graph.html";

/** Stati vivi di un job del grafo: sono quelli che il poller del worker claima. */
const ACTIVE_JOB_STATUSES = ["queued", "running"] as const;

/**
 * CSP della vista HTML del grafo. `sandbox allow-scripts` (senza
 * allow-same-origin) mette la pagina in un'origine opaca: gli script del grafo
 * girano, ma non vedono cookie né storage di Stubwise. `default-src 'none'`
 * chiude tutto il resto — incluse fetch/XHR/websocket — quindi la pagina non può
 * esfiltrare nulla.
 *
 * ⚠️ `script-src` include https://unpkg.com: il `graph.html` prodotto da
 * graphify (exporters/html.py) è quasi tutto inline (stili, dati e logica), MA
 * carica vis-network dalla CDN unpkg con `integrity` SRI e `crossorigin`. Senza
 * quell'host in whitelist la pagina si aprirebbe vuota. Il tag ha SRI, quindi la
 * CDN non può servire uno script diverso da quello atteso.
 */
const GRAPH_HTML_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline' https://unpkg.com",
  "img-src data:",
  // Framing consentito SOLO alla SPA stessa (l'<iframe> della tab Grafo).
  // Nei browser moderni frame-ancestors ha la precedenza sull'X-Frame-Options
  // che caddy imposta globalmente (DENY) — che comunque il Caddyfile ora
  // rimuove su questa route: senza questa direttiva l'iframe viene rifiutato.
  "frame-ancestors 'self'",
].join("; ");

/**
 * Campi "grafo assente": valgono sia quando la riga `repo_graphs` non esiste sia
 * dopo la riconciliazione di una riga `done` rimasta senza artefatti sul volume.
 */
const EMPTY_GRAPH_FIELDS = {
  status: "none",
  commitSha: null,
  nodeCount: null,
  edgeCount: null,
  communityCount: null,
  labeled: false,
  generatedAt: null,
  error: null,
} as const;

const repositoryParamsSchema = z.object({ id: z.uuid() });

const generateBodySchema = z.object({
  // Passa `--force` a graphify: rifà il grafo da zero invece che in incrementale.
  // Escape hatch manuale (il webhook del push non lo imposta mai).
  force: z.boolean().optional(),
});

/**
 * Stato del grafo di un repository per la UI. `status`/`error` descrivono la
 * BUILD (riga `repo_graphs`); `setupPrJobPending`/`setupPrError` descrivono la PR
 * di setup, che ha un ciclo di vita indipendente: un setup_pr fallito NON tocca
 * `repo_graphs` (il grafo resta `done`), perciò il suo errore ha un campo suo.
 */
const repoGraphStateSchema = z.object({
  /** Toggle `repositories.graph_enabled`: senza, nulla viene generato ai push. */
  enabled: z.boolean(),
  status: z.enum(["none", "queued", "running", "done", "failed"]),
  commitSha: z.string().nullable(),
  nodeCount: z.int().nullable(),
  edgeCount: z.int().nullable(),
  communityCount: z.int().nullable(),
  labeled: z.boolean(),
  generatedAt: z.iso.datetime().nullable(),
  setupPrUrl: z.string().nullable(),
  error: z.string().nullable(),
  /** Esiste un job `build` queued/running (la UI fa polling finché è true). */
  jobPending: z.boolean(),
  /** Esiste un job `setup_pr` queued/running. */
  setupPrJobPending: z.boolean(),
  /** Errore dell'ULTIMO job `setup_pr`, se è fallito; null se l'ultimo è andato a buon fine. */
  setupPrError: z.string().nullable(),
});

/** Opzioni del plugin: la radice del volume dei grafi (GRAPHS_DIR), montato read-only. */
export interface RepoGraphRoutesOptions {
  graphsDir: string;
}

/**
 * Route del knowledge graph di un repository, registrate sotto
 * /api/repositories (il `:id` dell'URL è il repositoryId, come per i file
 * d'ambiente). Lettura per ogni utente autenticato — stessa visibilità dei
 * repository, che non hanno ACL per progetto — scritture (generate, setup-pr)
 * solo admin.
 *
 * I contenuti (report, html, json) NON stanno in Postgres: il worker li scrive
 * sul volume condiviso `graphs`, che il server monta READ-ONLY. Ogni path è
 * composto da GRAPHS_DIR + un uuid validato da Zod + nomi di file FISSI: nessun
 * segmento arriva dal client, quindi il traversal è impossibile per costruzione.
 */
export async function repoGraphRoutes(
  instance: FastifyInstance,
  opts: RepoGraphRoutesOptions,
): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const { graphsDir } = opts;

  /** Path assoluto di un artefatto del repository sul volume. */
  function artifactPath(repositoryId: string, name: string): string {
    return join(graphsDir, repositoryId, GRAPHIFY_OUT_DIR, name);
  }

  /** true se il path esiste ed è un file regolare. Qualsiasi errore = assente. */
  async function isFile(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  }

  /** Guard di esistenza del repository: proietta solo ciò che serve alle route. */
  async function findRepository(id: string) {
    const [row] = await app.db
      .select({ id: repositories.id, graphEnabled: repositories.graphEnabled })
      .from(repositories)
      .where(eq(repositories.id, id));
    return row;
  }

  /** Set dei `kind` con un job vivo (queued/running) sul repository. */
  async function activeJobKinds(repositoryId: string): Promise<Set<string>> {
    const rows = await app.db
      .select({ kind: graphJobs.kind })
      .from(graphJobs)
      .where(
        and(
          eq(graphJobs.repositoryId, repositoryId),
          inArray(graphJobs.status, [...ACTIVE_JOB_STATUSES]),
        ),
      );
    return new Set(rows.map((r) => r.kind));
  }

  /**
   * Accoda un job del grafo, rispondendo 409 se ne esiste già uno attivo dello
   * stesso kind. Il controllo preventivo copre il caso normale; l'indice unico
   * parziale `graph_jobs_active_unique` copre la corsa fra due richieste
   * simultanee (la seconda viola l'unique e viene tradotta nello stesso 409).
   */
  async function enqueue(
    reply: FastifyReply,
    repositoryId: string,
    kind: "build" | "setup_pr",
    force: boolean,
  ): Promise<FastifyReply> {
    if ((await activeJobKinds(repositoryId)).has(kind)) {
      return apiError(reply, 409, "graph_job_pending", "A graph job is already queued or running");
    }
    try {
      // notBefore omesso (null): il job è claimabile al prossimo tick del poller.
      // Il debounce con not_before è del webhook push, non dell'azione manuale.
      await app.db.insert(graphJobs).values({ repositoryId, kind, force });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return apiError(reply, 409, "graph_job_pending", "A graph job is already queued or running");
      }
      throw error;
    }
    return reply.code(202).send({ queued: true as const });
  }

  /**
   * Stato del grafo. RICONCILIAZIONE: se la riga dice `done` ma `graph.json` non
   * c'è più (volume ricreato, es. `docker compose down -v`), si risponde `none` E
   * si riporta la riga a `none` — altrimenti la UI offrirebbe report/html/json
   * inesistenti e nessuno rigenererebbe mai. `setupPrUrl` NON viene azzerato: la
   * PR eventualmente aperta esiste ancora sul provider, indipendentemente dal volume.
   */
  app.get(
    "/:id/graph",
    {
      preHandler: requireAuth,
      schema: {
        params: repositoryParamsSchema,
        response: { 200: repoGraphStateSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const repository = await findRepository(id);
      if (!repository) return apiError(reply, 404, "repository_not_found", "Repository not found");

      const [graph] = await app.db
        .select()
        .from(repoGraphs)
        .where(eq(repoGraphs.repositoryId, id));

      const activeKinds = await activeJobKinds(id);
      // Ultimo job setup_pr (qualunque stato): se è fallito il suo errore è
      // quello da mostrare, se è andato bene l'errore precedente non serve più.
      const [lastSetupPr] = await app.db
        .select({ status: graphJobs.status, error: graphJobs.error })
        .from(graphJobs)
        .where(and(eq(graphJobs.repositoryId, id), eq(graphJobs.kind, "setup_pr")))
        .orderBy(desc(graphJobs.createdAt))
        .limit(1);

      const common = {
        enabled: repository.graphEnabled,
        setupPrUrl: graph?.setupPrUrl ?? null,
        jobPending: activeKinds.has("build"),
        setupPrJobPending: activeKinds.has("setup_pr"),
        setupPrError: lastSetupPr?.status === "failed" ? (lastSetupPr.error ?? null) : null,
      };

      // Nessuna riga: grafo mai costruito.
      if (!graph) return { ...common, ...EMPTY_GRAPH_FIELDS };

      if (graph.status === "done" && !(await isFile(artifactPath(id, GRAPH_JSON)))) {
        // `updatedAt` esplicito: la colonna non è auto-mantenuta dal DB.
        await app.db
          .update(repoGraphs)
          .set({ ...EMPTY_GRAPH_FIELDS, updatedAt: new Date() })
          .where(eq(repoGraphs.repositoryId, id));
        return { ...common, ...EMPTY_GRAPH_FIELDS };
      }

      return {
        ...common,
        status: graph.status,
        commitSha: graph.commitSha,
        nodeCount: graph.nodeCount,
        edgeCount: graph.edgeCount,
        communityCount: graph.communityCount,
        labeled: graph.labeled,
        generatedAt: graph.generatedAt?.toISOString() ?? null,
        error: graph.error,
      };
    },
  );

  /** Rigenerazione manuale del grafo (admin). Richiede il toggle acceso. */
  app.post(
    "/:id/graph/generate",
    {
      preHandler: requireAdmin,
      schema: {
        params: repositoryParamsSchema,
        body: generateBodySchema,
        response: {
          202: z.object({ queued: z.literal(true) }),
          404: errorSchema,
          409: errorSchema,
          412: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const repository = await findRepository(id);
      if (!repository) return apiError(reply, 404, "repository_not_found", "Repository not found");
      if (!repository.graphEnabled) {
        // 412 (non 409): la richiesta è impossibile finché non cambia una
        // precondizione del repository (il toggle), non finché non finisce
        // qualcos'altro. Il 409 resta riservato al job già in coda.
        return apiError(reply, 412, "graph_disabled", "Graph generation is disabled for this repository");
      }
      return enqueue(reply, id, "build", request.body.force === true);
    },
  );

  /** PR di setup della configurazione graphify sul repository (admin). Serve un grafo `done`. */
  app.post(
    "/:id/graph/setup-pr",
    {
      preHandler: requireAdmin,
      schema: {
        params: repositoryParamsSchema,
        response: {
          202: z.object({ queued: z.literal(true) }),
          404: errorSchema,
          409: errorSchema,
          412: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const repository = await findRepository(id);
      if (!repository) return apiError(reply, 404, "repository_not_found", "Repository not found");

      const [graph] = await app.db
        .select({ status: repoGraphs.status })
        .from(repoGraphs)
        .where(eq(repoGraphs.repositoryId, id));
      if (graph?.status !== "done") {
        // La PR copia gli artefatti dal volume nel repo: senza un grafo
        // completo non c'è nulla da committare.
        return apiError(reply, 412, "graph_not_ready", "The repository graph is not ready");
      }
      return enqueue(reply, id, "setup_pr", false);
    },
  );

  /**
   * Report delle comunità (markdown) prodotto da graphify. File piccolo: si
   * legge in streaming come gli altri, con il Content-Type esplicito.
   */
  app.get(
    "/:id/graph/report",
    {
      preHandler: requireAuth,
      schema: {
        params: repositoryParamsSchema,
        response: { 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      return sendArtifact(reply, artifactPath(request.params.id, GRAPH_REPORT), {
        "Content-Type": "text/markdown; charset=utf-8",
      });
    },
  );

  /**
   * Vista interattiva del grafo, servita così com'è dal volume e pensata per
   * stare in un `<iframe sandbox>` della SPA: nessun X-Frame-Options, ma una CSP
   * stretta ({@link GRAPH_HTML_CSP}).
   */
  app.get(
    "/:id/graph/html",
    {
      preHandler: requireAuth,
      schema: {
        params: repositoryParamsSchema,
        response: { 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      return sendArtifact(reply, artifactPath(request.params.id, GRAPH_HTML), {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": GRAPH_HTML_CSP,
      });
    },
  );

  /** Download del grafo grezzo (può pesare MB, quindi streaming e mai in memoria). */
  app.get(
    "/:id/graph/json",
    {
      preHandler: requireAuth,
      schema: {
        params: repositoryParamsSchema,
        response: { 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      return sendArtifact(reply, artifactPath(request.params.id, GRAPH_JSON), {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${GRAPH_JSON}"`,
      });
    },
  );

  /**
   * Invia un artefatto del volume in streaming (createReadStream: graph.json e
   * graph.html possono pesare megabyte, non vanno bufferizzati), o 404 se il file
   * non c'è — caso normale, non un errore: il grafo può non essere mai stato
   * generato o il volume essere stato ricreato.
   */
  async function sendArtifact(
    reply: FastifyReply,
    path: string,
    headers: Record<string, string>,
  ): Promise<FastifyReply> {
    if (!(await isFile(path))) {
      return apiError(reply, 404, "graph_artifact_not_found", "Graph artifact not found");
    }
    for (const [name, value] of Object.entries(headers)) reply.header(name, value);
    // Nessuno schema di risposta 200 dichiarato = nessuna serializzazione: lo
    // stream passa intatto. Il type provider Zod tipizza `send` sull'unione degli
    // schemi dichiarati (solo errori), quindi lo stream va inviato aggirandolo
    // (stesso pattern dell'export zip dei Docs).
    return reply.send(createReadStream(path) as unknown as never);
  }
}
