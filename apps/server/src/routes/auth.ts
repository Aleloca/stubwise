import { randomBytes } from "node:crypto";
import { count, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { hashPassword, verifyPassword } from "../auth/password.js";
import {
  createSession,
  deleteSession,
  requireAdmin,
  requireAuth,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sessionIdFromRequest,
} from "../auth/session.js";
import { invites, users } from "../db/schema.js";

/** Validità di un link di invito: 7 giorni. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const publicUserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  role: z.enum(["admin", "member"]),
});

const credentialsSchema = z.object({
  email: z.email(),
  password: z.string().min(8, "la password deve avere almeno 8 caratteri"),
});

const errorSchema = z.object({ message: z.string() });

/** Opzioni condivise del cookie di sessione (set e clear devono combaciare). */
const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: "auto",
} as const;

/**
 * Route di autenticazione, registrate sotto /api/auth.
 * Sessioni opache: il cookie contiene solo l'id (firmato), lo stato vive
 * nella tabella `sessions`.
 */
export async function authRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // La UI usa questo flag per decidere se mostrare la pagina di primo setup.
  app.get(
    "/setup",
    { schema: { response: { 200: z.object({ needed: z.boolean() }) } } },
    async () => {
      const [row] = await app.db.select({ value: count() }).from(users);
      return { needed: (row?.value ?? 0) === 0 };
    },
  );

  app.post(
    "/setup",
    {
      schema: {
        body: credentialsSchema,
        response: { 201: z.object({ user: publicUserSchema }), 403: errorSchema },
      },
    },
    async (request, reply) => {
      const [row] = await app.db.select({ value: count() }).from(users);
      if ((row?.value ?? 0) > 0) {
        return reply.code(403).send({ message: "Setup già completato" });
      }
      const passwordHash = await hashPassword(request.body.password);
      const [user] = await app.db
        .insert(users)
        .values({ email: request.body.email, passwordHash, role: "admin" })
        .returning();
      if (!user) throw new Error("insert dell'admin non ha restituito la riga");
      return reply
        .code(201)
        .send({ user: { id: user.id, email: user.email, role: user.role } });
    },
  );

  app.post(
    "/login",
    {
      schema: {
        // Nessun vincolo di lunghezza al login: la policy vale alla creazione.
        body: z.object({ email: z.email(), password: z.string().min(1) }),
        response: { 200: z.object({ user: publicUserSchema }), 401: errorSchema },
      },
    },
    async (request, reply) => {
      const [user] = await app.db
        .select()
        .from(users)
        .where(eq(users.email, request.body.email));
      // Risposta identica per email inesistente e password errata: nessuna
      // enumerazione degli account dal messaggio di errore.
      if (!user || !(await verifyPassword(user.passwordHash, request.body.password))) {
        return reply.code(401).send({ message: "Credenziali non valide" });
      }
      const session = await createSession(app.db, user.id);
      return reply
        .setCookie(SESSION_COOKIE, session.id, {
          ...SESSION_COOKIE_OPTIONS,
          signed: true,
          maxAge: Math.floor(SESSION_TTL_MS / 1000),
        })
        .code(200)
        .send({ user: { id: user.id, email: user.email, role: user.role } });
    },
  );

  app.post("/logout", { preHandler: requireAuth }, async (request, reply) => {
    const sessionId = sessionIdFromRequest(request);
    if (sessionId) await deleteSession(app.db, sessionId);
    return reply.clearCookie(SESSION_COOKIE, SESSION_COOKIE_OPTIONS).code(204).send();
  });

  app.get(
    "/me",
    {
      preHandler: requireAuth,
      schema: { response: { 200: z.object({ user: publicUserSchema }), 401: errorSchema } },
    },
    async (request) => ({ user: request.user! }),
  );

  app.post(
    "/invites",
    {
      preHandler: requireAdmin,
      schema: {
        body: z.object({ email: z.email() }),
        response: {
          201: z.object({ token: z.string(), expiresAt: z.iso.datetime() }),
        },
      },
    },
    async (request, reply) => {
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
      await app.db.insert(invites).values({ token, email: request.body.email, expiresAt });
      return reply.code(201).send({ token, expiresAt: expiresAt.toISOString() });
    },
  );

  app.post(
    "/register",
    {
      schema: {
        body: credentialsSchema.extend({ token: z.string().min(1) }),
        response: {
          201: z.object({ user: publicUserSchema }),
          409: errorSchema,
          410: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const [invite] = await app.db
        .select()
        .from(invites)
        .where(eq(invites.token, request.body.token));
      // Token sconosciuto e token già consumato sono indistinguibili (la riga
      // non c'è più): stessa risposta 410.
      if (!invite) {
        return reply.code(410).send({ message: "Invito non valido o già usato" });
      }
      if (invite.expiresAt.getTime() <= Date.now()) {
        await app.db.delete(invites).where(eq(invites.token, invite.token));
        return reply.code(410).send({ message: "Invito scaduto" });
      }

      const [existing] = await app.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, request.body.email));
      if (existing) {
        return reply.code(409).send({ message: "Esiste già un utente con questa email" });
      }

      const passwordHash = await hashPassword(request.body.password);
      // Creazione utente e consumo dell'invito sono atomici: niente inviti
      // bruciati senza utente, niente doppio uso in concorrenza.
      const user = await app.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(users)
          .values({ email: request.body.email, passwordHash, role: "member" })
          .returning();
        if (!created) throw new Error("insert del member non ha restituito la riga");
        await tx.delete(invites).where(eq(invites.token, invite.token));
        return created;
      });
      return reply
        .code(201)
        .send({ user: { id: user.id, email: user.email, role: user.role } });
    },
  );
}
