import { releaseQueueSchema, releaseResultSchema } from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAdmin } from "../auth/session.js";
import { apiError } from "../errors.js";
import { listReleaseQueue, releasePullRequest } from "../services/release.js";
import { authErrorResponses, errorSchema } from "./shared.js";

const releaseParamsSchema = z.object({ id: z.uuid(), repositoryId: z.uuid() });

/**
 * Coda di rilascio (fase 8, Task 9-10): "una pagina sola, per il maintainer"
 * (design §4) — sia la LISTA sia l'AZIONE sono `requireAdmin`, a differenza
 * degli ambienti (dove solo le scritture lo erano): qui l'intera pagina è
 * riservata, non solo il rilascio.
 */
export async function releaseRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/release-queue",
    {
      preHandler: requireAdmin,
      schema: { response: { 200: releaseQueueSchema, ...authErrorResponses } },
    },
    async () => {
      return { items: await listReleaseQueue(app.db, app.encryptionKey) };
    },
  );

  // Il CANCELLO (design fase 7 §2, invariante): rende vero, con un controllo
  // vero, il secondo divieto dell'operatore — finora vero solo per assenza
  // di funzionalità (nessuna capacità di merge esisteva prima di questa
  // fase). requireAdmin sulla rotta E dentro releasePullRequest (difesa in
  // profondità, come preApprovePlan/resolvePlan in jobs.ts).
  app.post(
    "/tickets/:id/repositories/:repositoryId/release",
    {
      preHandler: requireAdmin,
      schema: {
        params: releaseParamsSchema,
        response: {
          200: releaseResultSchema,
          404: errorSchema,
          409: errorSchema,
          502: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await releasePullRequest(app.db, app.encryptionKey, {
        ticketId: request.params.id,
        repositoryId: request.params.repositoryId,
        actor: request.user!,
      });
      if (result.ok) return { merged: true as const, sha: result.sha };

      switch (result.error) {
        case "forbidden":
          // Irraggiungibile dietro requireAdmin: difesa in profondità.
          return apiError(reply, 403, "forbidden", "Administrators only");
        case "not_found":
          return apiError(reply, 404, "not_found", "PR not found for this ticket and repository");
        case "already_closed":
          return apiError(reply, 409, "already_closed", "This PR is no longer open");
        case "checks_failed":
          return apiError(
            reply,
            409,
            "checks_failed",
            "The provider's checks are failing on this PR — it cannot be released",
          );
        case "not_mergeable":
          return apiError(
            reply,
            409,
            "not_mergeable",
            "The provider refused to merge this PR (conflicts or unmet branch rules)",
          );
        case "merge_forbidden":
          return apiError(
            reply,
            403,
            "merge_forbidden",
            "The stored git credentials do not have permission to merge this PR",
          );
        case "merge_failed":
          return apiError(reply, 502, "merge_failed", "The merge request to the provider failed");
      }
    },
  );
}
