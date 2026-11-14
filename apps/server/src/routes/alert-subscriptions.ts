import { setAlertSubscriptionSchema } from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AlertSubscriptionError,
  copyAlertSubscriptions,
  listAlertSubscriptions,
  muteFromNotification,
  muteProjectAlerts,
  setAlertSubscription,
} from "../services/alert-subscriptions.js";

/**
 * Le iscrizioni agli avvisi di chi chiede (area 8, F2, S5), sotto
 * `/api/me/alert-subscriptions`. Ciascuno scrive SOLO le proprie; i permessi e
 * lo stato li calcola il servizio (404 a un progetto che non si vede, 403 a
 * una riga sospesa o solo obbligatoria). Rotte letterali prima di quelle coi
 * parametri sullo stesso prefisso (la trappola di Fastify di CLAUDE.md).
 */
export async function alertSubscriptionRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const handle = async <T>(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof AlertSubscriptionError) return reply.code(error.status).send({ code: error.code, message: error.message });
      throw error;
    }
  };
  const projectParams = z.object({ projectId: z.uuid() });

  app.get("/me/alert-subscriptions", { config: { access: { kind: "user" } } }, async (request) => ({
    items: await listAlertSubscriptions(app.db, request.user!),
  }));
  app.post(
    "/me/alert-subscriptions/:projectId/copy",
    { config: { access: { kind: "user" } }, schema: { params: projectParams, body: z.object({ fromProjectId: z.uuid() }) } },
    async (request, reply) =>
      handle(reply, async () => ({ before: await copyAlertSubscriptions(app.db, request.user!, { projectId: request.params.projectId, fromProjectId: request.body.fromProjectId }) })),
  );
  app.post("/me/alert-subscriptions/:projectId/mute", { config: { access: { kind: "user" } }, schema: { params: projectParams } }, async (request, reply) =>
    handle(reply, async () => ({ before: await muteProjectAlerts(app.db, request.user!, request.params.projectId) })),
  );
  // S6: «Non avvisarmi più di questo» dalla card.
  app.post("/inbox/:id/mute-type", { config: { access: { kind: "user" } }, schema: { params: z.object({ id: z.uuid() }) } }, async (request, reply) =>
    handle(reply, () => muteFromNotification(app.db, request.user!, request.params.id)),
  );
  app.put(
    "/me/alert-subscriptions/:projectId/:type",
    {
      config: { access: { kind: "user" } },
      schema: { params: z.object({ projectId: z.uuid(), type: z.string().min(1).max(80) }), body: setAlertSubscriptionSchema },
    },
    async (request, reply) =>
      handle(reply, () => setAlertSubscription(app.db, request.user!, { projectId: request.params.projectId, type: request.params.type, patch: request.body })),
  );
}
