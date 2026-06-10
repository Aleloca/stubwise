import { asc } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import { users } from "../db/schema.js";
import { authErrorResponses } from "./shared.js";

/** Identità pubblica di un utente: mai hash o altri campi sensibili. */
export const publicUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: z.enum(["admin", "member"]),
});

/**
 * Route degli utenti, registrate sotto /api/users. La lista è visibile a
 * qualunque utente autenticato: serve alla UI per il selettore degli
 * assegnatari, non espone nulla oltre a email e ruolo.
 */
export async function userRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: { response: { 200: z.array(publicUserSchema), ...authErrorResponses } },
    },
    async () => {
      return app.db
        .select({ id: users.id, email: users.email, role: users.role })
        .from(users)
        .orderBy(asc(users.email));
    },
  );
}
