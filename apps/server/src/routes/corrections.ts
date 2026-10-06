import {
  adoptPrBodySchema,
  adoptPrResponseSchema,
  requestCorrectionBodySchema,
  requestCorrectionResponseSchema,
} from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/session.js";
import { apiError } from "../errors.js";
import { adoptPullRequest, releaseAdoption } from "../services/pr-adoption.js";
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

  // ADOZIONE di una PR aperta da altri (6 ott 2026): SOLO un maintainer.
  // `requireAdmin` qui E il controllo dentro il servizio (difesa in
  // profondità, come la coda di rilascio). Stessa forma di path delle
  // correzioni: segmenti letterali fra e DOPO i parametri.
  app.post(
    "/tickets/:id/repositories/:repositoryId/adoption",
    {
      preHandler: requireAdmin,
      schema: {
        params: correctionParamsSchema,
        body: adoptPrBodySchema.nullish(),
        response: {
          202: adoptPrResponseSchema,
          404: errorSchema,
          409: errorSchema,
          422: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await adoptPullRequest(
        { db: app.db, encryptionKey: app.encryptionKey, warn: (m) => request.log.warn(m) },
        {
          ticketId: request.params.id,
          repositoryId: request.params.repositoryId,
          actor: request.user!,
          ...(request.body?.note !== undefined ? { note: request.body.note } : {}),
        },
      );
      if (result.ok) return reply.code(202).send({ correctionId: result.correctionId });
      switch (result.error) {
        case "forbidden":
          return apiError(reply, 403, "forbidden", "Only a maintainer can hand a pull request to Stubwise");
        case "ticket_not_found":
          return apiError(reply, 404, "ticket_not_found", "Ticket not found");
        case "pr_not_found":
          return apiError(reply, 404, "pr_not_found", "There is no reviewed PR for this ticket on this repository");
        case "not_review_ticket":
          return apiError(reply, 422, "not_review_ticket", "Only the PR of a review ticket can be adopted");
        case "already_adopted":
          return apiError(reply, 409, "already_adopted", "Stubwise is already correcting this PR");
        case "pr_not_open":
          return apiError(reply, 409, "pr_not_open", "This PR is no longer open");
        case "pr_unverifiable":
          return apiError(reply, 422, "pr_unverifiable", "The PR could not be read from the platform: try again");
        case "pr_from_fork":
          return apiError(reply, 422, "pr_from_fork", "This PR comes from a fork: Stubwise cannot push to its branch");
        case "pr_fork_unverifiable":
          return apiError(
            reply,
            422,
            "pr_fork_unverifiable",
            "The platform does not say where this PR's branch lives: Stubwise does not push to it",
          );
        case "stubwise_pr":
          return apiError(reply, 422, "stubwise_pr", "This PR is on a Stubwise branch");
        case "base_branch":
          return apiError(
            reply,
            422,
            "base_branch",
            "This PR's branch is the base branch: Stubwise does not push to it",
          );
      }
    },
  );

  // «Smetti di correggere»: rilascia l'adozione. Solo un maintainer.
  app.delete(
    "/tickets/:id/repositories/:repositoryId/adoption",
    {
      preHandler: requireAdmin,
      schema: {
        params: correctionParamsSchema,
        response: { 204: z.null(), 409: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await releaseAdoption(
        { db: app.db, encryptionKey: app.encryptionKey, warn: (m) => request.log.warn(m) },
        { ticketId: request.params.id, repositoryId: request.params.repositoryId, actor: request.user! },
      );
      if (result.ok) return reply.code(204).send(null);
      if (result.error === "forbidden") {
        return apiError(reply, 403, "forbidden", "Only a maintainer can stop Stubwise corrections");
      }
      return apiError(reply, 409, "not_adopted", "Stubwise is not correcting this PR");
    },
  );
}
