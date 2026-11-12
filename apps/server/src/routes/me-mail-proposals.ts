import { mailProposalListSchema, mailProposalSchema, mailProposalStatusSchema } from "@stubwise/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { apiError } from "../errors.js";
import { confirmMailProposal, ignoreMailProposal, type DecideResult } from "../services/mail-proposals-decide.js";
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

  const idParams = z.object({ id: z.uuid() });
  const decideResponses = {
    200: z.union([
      z.object({ status: z.literal("confirmed"), results: mailProposalSchema.shape.results }),
      z.object({ status: z.literal("failed"), error: z.string() }),
      z.object({ status: z.literal("ignored") }),
    ]),
    400: errorSchema,
    404: errorSchema,
    409: errorSchema.extend({ decidedBy: mailProposalSchema.shape.decidedBy.optional() }),
    ...authErrorResponses,
  };

  /** L'esito di una decisione, con i codici d'errore del contratto (piano F2, §4). */
  function send(reply: FastifyReply, result: DecideResult) {
    if (result.ok) {
      if (result.status === "confirmed") return { status: "confirmed" as const, results: result.results };
      if (result.status === "failed") return { status: "failed" as const, error: result.error };
      return { status: "ignored" as const };
    }
    switch (result.error) {
      case "not_found":
        return apiError(reply, 404, "not_found", "Mail proposal not found");
      case "already_handled":
        return reply.code(409).send({ code: "already_handled", message: "Someone already decided this proposal", decidedBy: result.decidedBy ?? null });
      case "forbidden":
        return apiError(reply, 403, "forbidden", "Missing a permission for one of the chosen actions");
      default:
        return apiError(reply, 400, result.error, "Invalid decision");
    }
  }

  /**
   * Conferma (anche parziale, con le modifiche ai campi consentiti). Un
   * incaricato fuori dal progetto: `invalid_assignee` — si aggiunge come
   * Contributor con `confirm-with-members`, che chiede la riconferma.
   */
  app.post(
    "/:id/confirm",
    {
      config: { access: { kind: "user" } },
      schema: {
        params: idParams,
        body: z.object({
          indices: z.array(z.number().int().nonnegative()).max(20).optional(),
          edits: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
        }),
        response: decideResponses,
      },
    },
    async (request, reply) =>
      send(reply, await confirmMailProposal(app.db, request.user!, request.params.id, request.body, request.user!.language)),
  );

  /** «Ignora»: la chiude per tutti i destinatari. */
  app.post(
    "/:id/ignore",
    { config: { access: { kind: "user" } }, schema: { params: idParams, response: decideResponses } },
    async (request, reply) => send(reply, await ignoreMailProposal(app.db, request.user!, request.params.id)),
  );
}
