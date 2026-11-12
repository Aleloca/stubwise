import { mailProposalListSchema, mailProposalSchema, mailProposalStatusSchema } from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { apiError } from "../errors.js";
import { listMailProposals } from "../services/mail-proposals.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * LE PROPOSTE CONDIVISE DELLA POSTA (area 6, fetta 2, D4), sotto
 * `/api/me/mail/proposals`. Chi le vede e come si calcolano i permessi: il
 * docblock di `services/mail-proposals.ts`. Una proposta che chi guarda non
 * può vedere è 404, come una che non c'è.
 *
 * ⚠️ Registrata PRIMA di `meMailRoutes`: `/proposals/:id` è una rotta con una
 * parte letterale sullo stesso prefisso di `/:source/:id` (la trappola di
 * routing di Fastify, CLAUDE.md).
 */
export async function meMailProposalsRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/",
    {
      config: { access: { kind: "user" } },
      schema: {
        querystring: z.object({ message: z.uuid().optional(), status: mailProposalStatusSchema.optional() }),
        response: { 200: mailProposalListSchema, ...authErrorResponses },
      },
    },
    async (request) => {
      const items = await listMailProposals(
        app.db,
        request.user!,
        { messageId: request.query.message, status: request.query.status },
        request.user!.language,
      );
      return { items };
    },
  );

  app.get(
    "/:id",
    {
      config: { access: { kind: "user" } },
      schema: {
        params: z.object({ id: z.uuid() }),
        response: { 200: mailProposalSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const [item] = await listMailProposals(app.db, request.user!, { id: request.params.id }, request.user!.language);
      if (!item) return apiError(reply, 404, "not_found", "Mail proposal not found");
      return item;
    },
  );
}
