import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { claudeCapabilitiesSchema } from "@stubwise/shared";
import { claudeCapabilitiesOf } from "../services/claude-capabilities.js";
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
}
