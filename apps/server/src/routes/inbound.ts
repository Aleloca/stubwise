import fastifyCors from "@fastify/cors";
import { ticketPrioritySchema, ticketTypeSchema } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { repositories } from "@stubwise/db";
import { createExternalTicket } from "../ingest/processor.js";
import { resolveReporter } from "../ingest/reporter.js";
import { keysMatch, publicUrlOrUndefined, ticketUrl } from "../ingest/shared.js";
import { errorSchema } from "./shared.js";
import type { RateLimitConfig } from "./shared.js";
import { apiError } from "../errors.js";

export interface InboundRoutesOptions {
  /** Limite di richieste per chiave di ingestion (default 300/min). */
  rateLimit: RateLimitConfig;
}

/**
 * Endpoint webhook generico per chiamanti esterni: POST /api/inbound/:slug/ticket.
 *
 * Stessa superficie di sicurezza dell'ingestion SDK: CORS aperto solo su questo
 * scope, autenticazione via X-Stubwise-Key (confronto a tempo costante con la
 * ingestionKey del progetto), rate-limit per chiave. Slug sconosciuto, header
 * assente e chiave errata producono lo stesso 401 (niente enumerazione degli
 * slug). Payload non valido → 422 (come l'ingestion, via schemaErrorFormatter).
 *
 * Il ticket nasce con source `webhook`. Se `reporterEmail` corrisponde a un
 * utente Stubwise il ticket gli viene assegnato; altrimenti resta non assegnato
 * e la provenienza (con l'email se presente) viene tracciata nel body.
 */
export async function inboundRoutes(
  instance: FastifyInstance,
  opts: InboundRoutesOptions,
): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  await app.register(fastifyCors, {
    origin: "*",
    methods: ["POST"],
    allowedHeaders: ["content-type", "x-stubwise-key"],
  });

  app.post(
    "/:slug/ticket",
    {
      config: {
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
        // Stesso contratto degli SDK: validazione fallita → 422.
        error.statusCode = 422;
        return error;
      },
      schema: {
        params: z.object({ slug: z.string().min(1) }),
        body: z.object({
          title: z.string().min(1).max(300),
          body: z.string().optional(),
          type: ticketTypeSchema,
          priority: ticketPrioritySchema.optional().default("medium"),
          reporterEmail: z.email().optional(),
        }),
        response: {
          201: z.object({
            id: z.string(),
            number: z.number().int(),
            url: z.string().optional(),
          }),
          401: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const { title, body, type, priority, reporterEmail } = request.body;
      const repository = request.ingestProject!;

      const assigneeId = await resolveReporter(app.db, reporterEmail);
      // Provenienza sempre tracciata: generica se non c'è un'email, con email
      // se non risolta a un utente Stubwise. Se l'email risolve a un utente, il
      // ticket è già assegnato: nessuna nota "no account".
      const reporterNote =
        reporterEmail && assigneeId === null
          ? `Reported via webhook (no Stubwise account: ${reporterEmail})`
          : "Reported via webhook";

      const ticket = await createExternalTicket(app.db, repository, {
        title,
        body,
        type,
        priority,
        source: "webhook",
        assigneeId,
        reporterNote,
      });

      const publicUrl = publicUrlOrUndefined(app);
      return reply.code(201).send({
        id: ticket.id,
        number: ticket.number,
        ...(publicUrl !== undefined ? { url: ticketUrl(publicUrl, ticket.id) } : {}),
      });
    },
  );
}
