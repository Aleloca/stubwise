import { requestCorrectionBodySchema, requestCorrectionResponseSchema } from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import { apiError } from "../errors.js";
import { requestCorrection } from "../services/pr-corrections.js";
import { authErrorResponses, errorSchema } from "./shared.js";

const correctionParamsSchema = z.object({ id: z.uuid(), repositoryId: z.uuid() });

/**
 * Correzioni post-PR (30 set 2026). Montata sotto `/api` come la coda di
 * rilascio (`routes/release.ts`), con cui condivide la forma del path: i
 * segmenti letterali stanno fra e DOPO i parametri, e nessun'altra rotta
 * registrata ha `/api/tickets/:id/repositories/:repositoryId/<parametro>`,
 * quindi non c'è la trappola di routing del CLAUDE.md (una letterale accanto a
 * una parametrica sullo stesso prefisso).
 */
export async function correctionRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // requireAuth, non requireAdmin: è la regola di `POST /tickets/:id/run-ai`
  // (lanciare un run è lavoro quotidiano), e da Bitbucket/GitHub una
  // correzione la chiede chiunque abbia il permesso lassù (design §3). Il
  // budget lo scavalca solo un admin (E7, nel servizio).
  app.post(
    "/tickets/:id/repositories/:repositoryId/corrections",
    {
      preHandler: requireAuth,
      schema: {
        params: correctionParamsSchema,
        // nullish: una POST senza corpo arriva `null` (come /run-ai).
        body: requestCorrectionBodySchema.nullish(),
        response: {
          202: requestCorrectionResponseSchema,
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await requestCorrection(app.db, {
        ticketId: request.params.id,
        repositoryId: request.params.repositoryId,
        actor: request.user!,
        note: request.body?.note,
      });
      if (result.ok) return reply.code(202).send({ correctionId: result.correctionId });
      switch (result.error) {
        // Un codice DEDICATO, non il generico `not_found`: il web traduce per
        // codice (`errors:<code>`), e `not_found` lo usano altre rotte con
        // significati diversi — una chiave unica direbbe la cosa sbagliata.
        case "pr_not_found":
          return apiError(reply, 404, "pr_not_found", "There is no PR for this ticket on this repository");
        case "not_stubwise_pr":
          return apiError(reply, 409, "not_stubwise_pr", "Only PRs opened or adopted by Stubwise can be corrected");
        case "pr_not_open":
          return apiError(reply, 409, "pr_not_open", "This PR is no longer open");
        case "correction_in_flight":
          return apiError(reply, 409, "correction_in_flight", "A correction is already running on this PR");
        case "job_in_flight":
          return apiError(reply, 409, "job_in_flight", "A job for this ticket is already running");
      }
    },
  );
}
