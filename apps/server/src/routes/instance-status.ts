import { instanceStatusSchema } from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { aiBudgetState } from "@stubwise/notifications";
import { z } from "zod";
import { routePermissions } from "../auth/access.js";
import { fromJob } from "../auth/project-resolvers.js";
import { apiError } from "../errors.js";
import { publicUrlOrUndefined } from "../ingest/shared.js";
import { recordChange } from "../services/change-log.js";
import { instanceStatus, retryCheck, retryFactsOf } from "../services/instance-status.js";
import { startRun } from "../services/jobs.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Area 9, F4: lo Stato dell'istanza, `GET /api/instance/status`
 * (`instance.status.view`). Solo letture: le regole in
 * `services/instance-status.ts`.
 */
export async function instanceStatusRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  app.get(
    "/status",
    {
      config: { access: { kind: "instance", permission: "instance.status.view" } },
      schema: { response: { 200: instanceStatusSchema, ...authErrorResponses } },
    },
    async (request) => instanceStatus(app.db, request.user!),
  );

  /**
   * Task 6: «Retry» dello Stato dell'istanza. Chiede `project.settings.manage`
   * (qui, nell'hook) E `runs.start` nel progetto del lavoro (D-7, maintainer
   * 30 ott). Solo un job di una task fallito negli ultimi 7 giorni, non
   * superato, mai una correzione (`pr-corrections.md`); la decisione è la
   * STESSA `retryCheck` della vista. Riparte con `startRun`, a nome di chi
   * preme e col gate del piano: nessuna seconda logica di rilancio. Agisce
   * solo sulla coda di Stubwise.
   */
  app.post(
    "/jobs/:id/retry",
    {
      config: { access: { kind: "project", permission: "project.settings.manage", project: fromJob("id") } },
      schema: {
        params: z.object({ id: z.uuid() }),
        response: { 202: z.object({ jobId: z.string(), status: z.string(), stopsAtPlan: z.boolean() }), 404: errorSchema, 409: errorSchema, 422: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const facts = await retryFactsOf(app.db, request.params.id);
      if (!facts) return apiError(reply, 404, "job_not_found", "Job not found");
      const perms = routePermissions(request) as ReadonlySet<string>;
      const check = retryCheck(facts, perms, (await aiBudgetState(app.db)).exhausted, new Date());
      if (check.reason === "conflict") return apiError(reply, 409, "conflict", "The task already has newer work running");
      if (check.reason === "not_retryable") return apiError(reply, 422, "not_retryable", "Only a failed run of a task, in the last 7 days, can be retried");
      if (check.retryBlock) return apiError(reply, 422, "monthly_budget", "The monthly AI budget is used up");
      if (check.retry !== "allowed") return apiError(reply, 403, "forbidden", "Missing permission");
      // La voce `job.retried` nella transazione di `startRun` (change-log.md):
      // esiste esattamente quando il job riparte.
      const result = await startRun(app.db, {
        ticketId: facts.ticketId,
        actor: { id: request.user!.id, permissions: perms as never },
        publicUrl: publicUrlOrUndefined(app),
        // Sotto il lock: l'ultimo job del ticket deve essere ancora QUESTO (review M1).
        expectLatestJobId: request.params.id,
        afterInTx: (tx) => recordChange(tx, { type: "job.retried", actor: request.user!, projectId: facts.projectId, data: { object: { type: "task", id: facts.ticketId, label: facts.code } } }),
      });
      if (!result.ok) {
        if (result.error === "job_in_flight" || result.error === "latest_changed") return apiError(reply, 409, "conflict", "The task already has newer work running");
        if (result.error === "forbidden") return apiError(reply, 403, "forbidden", "Missing permission");
        return apiError(reply, 409, result.error, "The run could not start");
      }
      return reply.code(202).send({ jobId: result.jobId, status: result.status, stopsAtPlan: check.retryStopsAtPlan });
    },
  );
}
