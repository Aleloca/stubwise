import { asc, count, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/session.js";
import { users } from "@stubwise/db";
import { apiError } from "../errors.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/** Identità pubblica di un utente: mai hash o altri campi sensibili. */
export const publicUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: z.enum(["admin", "member"]),
  // Istante di registrazione: la pagina Team mostra "membro dal …".
  createdAt: z.iso.datetime(),
  // Avatar Slack (image URL) derivato dal profilo Slack al momento del link;
  // null se l'utente non è linkato. Sempre lato server, mai dal client.
  avatarUrl: z.string().nullable(),
  // Slack user id linkato a questo utente; null se non linkato.
  slackUserId: z.string().nullable(),
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
          avatarUrl: users.slackAvatarUrl,
          slackUserId: users.slackUserId,
        })
        .from(users)
        .orderBy(asc(users.createdAt));
      return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
    },
  );

  // PATCH /api/users/:id/role — cambia il ruolo di un altro utente (solo admin).
  // I safeguard sono AUTORITATIVI lato server: non ci si declassa da soli
  // (self-check) e non si declassa l'ultimo admin rimasto.
  app.patch(
    "/:id/role",
    {
      preHandler: requireAdmin,
      schema: {
        params: z.object({ id: z.uuid() }),
        body: z.object({ role: z.enum(["admin", "member"]) }),
        response: {
          200: publicUserSchema,
          400: errorSchema,
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { role } = request.body;

      const [target] = await app.db
        .select({
          id: users.id,
          email: users.email,
          role: users.role,
          createdAt: users.createdAt,
          avatarUrl: users.slackAvatarUrl,
          slackUserId: users.slackUserId,
        })
        .from(users)
        .where(eq(users.id, id));
      if (!target) {
        return apiError(reply, 404, "user_not_found", "User not found");
      }

      // Ultimo admin: declassare l'unico admin lascerebbe l'istanza senza
      // amministratori. Si conta solo quando si declassa effettivamente un
      // admin. Verificato PRIMA del self-check così che, se l'unico admin tenta
      // di declassarsi, prevalga la ragione più specifica (last_admin) — è
      // comunque vietato, ma il codice spiega che il problema è l'assenza di
      // altri admin, non il fatto in sé di toccare il proprio ruolo.
      if (target.role === "admin" && role === "member") {
        const [adminCountRow] = await app.db
          .select({ value: count() })
          .from(users)
          .where(eq(users.role, "admin"));
        if ((adminCountRow?.value ?? 0) <= 1) {
          return apiError(reply, 409, "last_admin", "Cannot demote the last admin");
        }
      }

      // Self-check: un admin non può cambiare il PROPRIO ruolo (eviterebbe di
      // declassarsi e perdere l'accesso alle funzioni admin). Dopo il last_admin
      // così quel caso più specifico vince; per ogni altra auto-modifica resta
      // questo 400.
      if (id === request.user!.id) {
        return apiError(reply, 400, "cannot_change_own_role", "You cannot change your own role");
      }

      await app.db.update(users).set({ role }).where(eq(users.id, id));
      return reply.code(200).send({ ...target, role, createdAt: target.createdAt.toISOString() });
    },
  );
}
