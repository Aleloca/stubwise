import { instanceStatusSchema } from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { instanceStatus } from "../services/instance-status.js";
import { authErrorResponses } from "./shared.js";

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
}
