import { asc } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import { users } from "@stubwise/db";
import { authErrorResponses } from "./shared.js";

/** Identità pubblica di un utente: mai hash o altri campi sensibili. */
export const publicUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: z.enum(["admin", "member"]),
  // Istante di registrazione: la pagina Team mostra "membro dal …".
  createdAt: z.iso.datetime(),
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
      const rows = await app.db
        .select({
          id: users.id,
          email: users.email,
          role: users.role,
          createdAt: users.createdAt,
        })
        .from(users)
        .orderBy(asc(users.createdAt));
      return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
    },
  );
}
