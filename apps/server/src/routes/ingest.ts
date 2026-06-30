import fastifyCors from "@fastify/cors";
import { ingestBatchSchema } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { repositories } from "@stubwise/db";
import { processEvents } from "../ingest/processor.js";
import { keysMatch, publicUrlOrUndefined } from "../ingest/shared.js";
import { errorSchema } from "./shared.js";
import type { RateLimitConfig } from "./shared.js";
import { apiError } from "../errors.js";

export interface IngestRoutesOptions {
  /** Limite di richieste per chiave di ingestion (default 300/min). */
  rateLimit: RateLimitConfig;
}

/**
 * Endpoint pubblico di ingestion per gli SDK: POST /ingest/:slug.
 *
 * È l'unica superficie chiamata cross-origin dal browser, quindi CORS è
 * registrato QUI, dentro lo scope incapsulato del plugin: le altre route
 * non ricevono alcun header CORS.
 *
 * Autenticazione: header X-Stubwise-Key confrontato (tempo costante) con la
 * ingestionKey del progetto individuato dallo slug. Slug sconosciuto e
 * chiave errata producono la stessa risposta 401: niente enumerazione degli
 * slug. Il controllo sta in preValidation, così una richiesta non
 * autenticata riceve 401 anche con payload malformato.
 *
 * Validazione: il payload è ingestBatchSchema (max 100 eventi); a differenza
 * del resto dell'API (400), qui un payload non valido risponde 422 come da
 * contratto con gli SDK — lo schemaErrorFormatter per-route alza lo
 * statusCode dell'errore di validazione prima che arrivi all'error handler.
 */
export async function ingestRoutes(
  instance: FastifyInstance,
  opts: IngestRoutesOptions,
): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // CORS solo su questo scope: origin aperto (la chiave è l'autenticazione),
  // soltanto POST e i due header che l'SDK invia. Il plugin gestisce anche
  // la preflight OPTIONS.
  await app.register(fastifyCors, {
    origin: "*",
    methods: ["POST"],
    allowedHeaders: ["content-type", "x-stubwise-key"],
  });

  app.post(
    "/:slug",
    {
      config: {
        // Bucket per chiave di ingestion: un progetto loquace non consuma
        // il budget degli altri. Senza header si ripiega sull'IP, così le
        // richieste anonime non condividono un bucket globale fittizio.
        rateLimit: {
          ...opts.rateLimit,
          keyGenerator: (request) =>
            (request.headers["x-stubwise-key"] as string | undefined) ?? request.ip,
        },
      },
      preValidation: async (request, reply) => {
        const provided = request.headers["x-stubwise-key"];
        const { slug } = request.params as { slug: string };
        const [repository] = await app.db
          .select({
            id: repositories.id,
            name: repositories.name,
            ingestionKey: repositories.ingestionKey,
          })
          .from(repositories)
          .where(eq(repositories.slug, slug));
        // Ramo unico di rifiuto: header assente, slug sconosciuto e chiave
        // errata sono indistinguibili dal client.
        if (
          typeof provided !== "string" ||
          !repository ||
          !keysMatch(provided, repository.ingestionKey)
        ) {
          return apiError(reply, 401, "invalid_ingestion_key", "Invalid ingestion key");
        }
        request.ingestProject = { id: repository.id, name: repository.name };
      },
      schemaErrorFormatter: (errors, dataVar) => {
        const error = new Error(
          `${dataVar} non valido: ${errors.map((e) => `${e.instancePath} ${e.message ?? e.keyword}`.trim()).join("; ")}`,
        ) as Error & { statusCode: number };
        // Fastify usa 400 solo se statusCode non è già impostato: qui il
        // contratto con gli SDK prevede 422.
        error.statusCode = 422;
        return error;
      },
      schema: {
        params: z.object({ slug: z.string().min(1) }),
        body: ingestBatchSchema,
        response: {
          202: z.object({
            accepted: z.number().int(),
            created: z.number().int(),
            deduped: z.number().int(),
          }),
          401: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const { events } = request.body;
      const project = request.ingestProject!;
      const { created, deduped } = await processEvents(app.db, project, events, {
        // publicUrl per comporre il link assoluto al ticket nella notifica;
        // projectName per il messaggio. La notifica è best-effort (non lancia).
        // Il getter publicUrl esplode se l'app è stata costruita senza (alcuni
        // test): la notifica è opzionale, in quel caso il link è il solo path.
        publicUrl: publicUrlOrUndefined(app),
        projectName: project.name,
        // Storage attivo per salvare lo screenshot del feedback come allegato
        // (best-effort). app.storage() incapsula db+encryptionKey e ritorna null
        // se lo storage non è configurato.
        storage: () => app.storage(),
      });
      return reply.code(202).send({ accepted: events.length, created, deduped });
    },
  );
}

declare module "fastify" {
  interface FastifyRequest {
    /** Progetto autenticato dalla preValidation dell'ingestion. */
    ingestProject?: { id: string; name: string };
  }
}
