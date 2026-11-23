import { registerPersonMask } from "../services/people-known.js";
import { claudeDecisionViewSchema } from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { listClaudeDecisions } from "../services/claude-decisions.js";
import { authErrorResponses } from "./shared.js";

/**
 * Le voci di Claude in «Da decidere» (integrazione area 3, fetta 3b): piani e
 * domande che aspettano chi guarda, coi suoi permessi
 * (`services/claude-decisions.ts`). Si decide con le rotte di sempre
 * (approve/reject del piano, risposta alla domanda): questa legge e basta.
 */
export async function meClaudeRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Registro, A11 r.1414: chi guarda non riceve l'id di chi non conosce.
  registerPersonMask(app, new Set(["ownerId"]));
  app.get(
    "/claude-decisions",
    {
      config: { access: { kind: "user" } },
      schema: { response: { 200: z.array(claudeDecisionViewSchema), ...authErrorResponses } },
    },
    async (request) => listClaudeDecisions(app.db, request.user!),
  );
}
