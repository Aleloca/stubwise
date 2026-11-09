import { decisionRequestViewSchema } from "@stubwise/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { apiError } from "../errors.js";
import { answerDecision, listDecisions, withdrawDecision, type CloseResult } from "../services/decisions.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * `/api/decisions` (integrazione area 2, fetta 1): elenco, risposta e ritiro
 * delle richieste di decisione. Chiedere sta sotto la task
 * (`POST /api/tasks/:ticketId/decisions`). Una decisione di una task che chi
 * guarda non vede risponde 404 come una che non esiste.
 */

const idParamsSchema = z.object({ id: z.uuid() });

function sendClose(reply: FastifyReply, result: CloseResult) {
  if (result.ok) return result.decision;
  switch (result.error) {
    case "not_found":
      return apiError(reply, 404, "not_found", "Not found");
    case "forbidden":
      return apiError(reply, 403, "forbidden", "Only the person asked can answer, only the asker can withdraw");
    case "decision_closed":
      return apiError(reply, 409, "decision_closed", "The decision request is already closed");
    case "option_out_of_range":
      return apiError(reply, 400, "option_out_of_range", "No such option");
  }
}

export async function decisionRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/",
    {
      config: { access: { kind: "user" } },
      schema: {
        querystring: z.object({
          taskId: z.uuid().optional(),
          askedOfId: z.union([z.uuid(), z.literal("me")]).optional(),
          open: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
        }),
        response: { 200: z.array(decisionRequestViewSchema), ...authErrorResponses },
      },
    },
    async (request) => listDecisions(app.db, request.user!, request.query),
  );

  const closeResponses = {
    200: decisionRequestViewSchema,
    400: errorSchema,
    404: errorSchema,
    409: errorSchema,
    ...authErrorResponses,
  };

  app.post(
    "/:id/answer",
    {
      config: { access: { kind: "user" } },
      schema: {
        params: idParamsSchema,
        body: z.union([
          z.object({ optionIndex: z.number().int().min(0).max(7) }),
          z.object({ text: z.string().trim().min(1).max(2000) }),
        ]),
        response: closeResponses,
      },
    },
    async (request, reply) => sendClose(reply, await answerDecision(app.db, request.user!, request.params.id, request.body)),
  );

  app.post(
    "/:id/withdraw",
    {
      config: { access: { kind: "user" } },
      schema: { params: idParamsSchema, response: closeResponses },
    },
    async (request, reply) => sendClose(reply, await withdrawDecision(app.db, request.user!, request.params.id)),
  );
}
