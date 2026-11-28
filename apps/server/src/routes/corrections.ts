import {
  requestCorrectionBodySchema,
  requestCorrectionResponseSchema,
} from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteAccess } from "../auth/access.js";
import { fromTicket, ticketVisible } from "../auth/project-resolvers.js";
import { apiError } from "../errors.js";
import { requestCorrection } from "../services/pr-corrections.js";
import { authErrorResponses, errorSchema } from "./shared.js";

const correctionParamsSchema = z.object({ id: z.uuid(), repositoryId: z.uuid() });

/** Un permesso nel progetto del ticket `:id`, che chi agisce deve anche vedere. */
function onTicket(permission: "corrections.request" | "prs.adopt"): RouteAccess {
  return { kind: "project", permission, project: fromTicket("id"), resource: ticketVisible("id") };
}

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

  // `corrections.request` (che il Legacy Member ha, come `runs.start`): da
  // Bitbucket/GitHub una correzione la chiede chiunque abbia il permesso
  // lassù (design §3). Il budget lo scavalca solo chi ha `plans.approve`, e
  // una PR adottata la corregge solo chi ha `prs.adopt` (E7, nel servizio).
  app.post(
    "/tickets/:id/repositories/:repositoryId/corrections",
    {
      config: { access: onTicket("corrections.request"), mcp: { action: "pulls.requestCorrection", summary: "Chiede una correzione di una PR aperta da Stubwise («Chiedi modifiche»), con le indicazioni; il lavoro parte da solo.", effect: "write", note: "Non si usa il tool `run_ticket` per correggere una PR: ripartirebbe dal branch di default. Il budget lo scavalca solo chi ha `plans.approve`." } },
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
        actor: { id: request.user!.id, permissions: request.access!.permissions },
        note: request.body?.note,
      });
      if (result.ok) return reply.code(202).send({ correctionId: result.correctionId });
      switch (result.error) {
        case "forbidden":
          return apiError(
            reply,
            403,
            "adopted_pr_admin_only",
            "On a PR handed over to Stubwise, only who can adopt pull requests can ask for changes",
          );
        // Un codice DEDICATO, non il generico `not_found`: il web traduce per
        // codice (`errors:<code>`), e `not_found` lo usano altre rotte con
        // significati diversi — una chiave unica direbbe la cosa sbagliata.
        case "pr_not_found":
          return apiError(reply, 404, "pr_not_found", "There is no PR for this ticket on this repository");
        case "not_stubwise_pr":
          return apiError(reply, 409, "not_stubwise_pr", "Only PRs opened or adopted by Stubwise can be corrected");
        case "adopted_branch_protected":
          return apiError(
            reply,
            409,
            "adopted_branch_protected",
            "This PR's branch is protected on this repository: Stubwise does not push to it",
          );
        case "pr_not_open":
          return apiError(reply, 409, "pr_not_open", "This PR is no longer open");
        case "correction_in_flight":
          return apiError(reply, 409, "correction_in_flight", "A correction is already running on this PR");
        case "job_in_flight":
          return apiError(reply, 409, "job_in_flight", "A job for this ticket is already running");
        case "budget_exhausted":
          return apiError(reply, 409, "budget_exhausted", "The monthly AI budget is used up");
        case "colleague_analysis_only":
          return apiError(reply, 409, "colleague_analysis_only", "This colleague's PR is set to analysis only: Stubwise does not correct it");
      }
    },
  );
}
