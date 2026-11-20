import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { claudeCapabilitiesSchema, claudeSuggestionQuerySchema, claudeSuggestionSchema, dismissClaudeSuggestionSchema } from "@stubwise/shared";
import { claudeCapabilitiesOf } from "../services/claude-capabilities.js";
import { claudeSuggestionFor, dismissClaudeSuggestion } from "../services/claude-suggestions.js";
import { authErrorResponses } from "./shared.js";

// Area 10, F7, sotto `/api/claude`: ciò che Claude sa fare per chi chiede
// (S0) e, dal Task 3, le righe «Claude can help you…» delle pagine. Le regole
// stanno nei servizi; qui solo le rotte. `GET /capabilities` è anche
// nell'allowlist del token del turno (`show_capabilities`): risponde per
// l'autore della conversazione.
export async function claudeHelpRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/capabilities",
    { config: { access: { kind: "user" } }, schema: { response: { 200: claudeCapabilitiesSchema, ...authErrorResponses } } },
    async (request) => ({ items: await claudeCapabilitiesOf(app.db, request.user!) }),
  );

  // Area 10, F7 (D-5 = a): la riga «Claude can help you…» di una pagina per
  // chi guarda, o null (anche per un oggetto che non vede: mai 404).
  app.get(
    "/suggestions",
    { config: { access: { kind: "user" } }, schema: { querystring: claudeSuggestionQuerySchema, response: { 200: claudeSuggestionSchema, ...authErrorResponses } } },
    async (request) => claudeSuggestionFor(app.db, request.user!, request.query),
  );
  // «Not now»: per chi guarda, su quel tipo e quell'oggetto.
  app.post(
    "/suggestions/dismiss",
    { config: { access: { kind: "user" } }, schema: { body: dismissClaudeSuggestionSchema } },
    async (request, reply) => {
      await dismissClaudeSuggestion(app.db, request.user!, { kind: request.body.kind, objectId: request.body.objectId });
      return reply.code(204).send();
    },
  );
}
