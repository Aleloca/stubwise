import { personalAccessTokens } from "@stubwise/db";
import type { Db } from "@stubwise/db";
import { createPatSchema, patViewSchema, patWithTokenSchema } from "@stubwise/shared";
import type { PatView, PatWithToken } from "@stubwise/shared";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import { apiError } from "../errors.js";
import { authErrorResponses, errorSchema, generatePat, hashServerKey } from "./shared.js";

type PatRow = typeof personalAccessTokens.$inferSelect;

/**
 * Proiezione pubblica di un PAT: campi elencati esplicitamente (mai lo spread
 * della riga, così `tokenHash` non può sfuggire), date in ISO string. Il token
 * in chiaro NON vive in DB e non compare qui: si mostra solo alla creazione.
 */
function toPatView(row: PatRow): PatView {
  return {
    id: row.id,
    name: row.name,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Emette un PAT per un utente e ne restituisce la vista pubblica CON il token
 * in chiaro. Unico punto in cui un PAT nasce: la generazione, l'hash e il
 * fatto che in DB finisca solo lo sha256 non vanno riscritti altrove.
 *
 * Il chiamante decide chi è l'utente — qui non c'è nessun controllo di
 * autorizzazione: `POST /api/pats` prende l'id dalla sessione, `mobile-login`
 * lo prende dall'utente di cui ha appena verificato la password.
 *
 * E nemmeno nessuna validazione: i vincoli su `name` e `expiresAt` li applica
 * lo schema del chiamante (`createPatSchema` per la rotta, il `deviceName` di
 * `mobileLoginBodySchema` per l'app), perché sono diversi — 100 caratteri
 * liberi contro 80 senza bidi né interruzioni di riga. Chi aggiunge un
 * chiamante porta il proprio schema.
 */
export async function createPatForUser(
  db: Db,
  userId: string,
  name: string,
  expiresAt: Date | null,
): Promise<PatWithToken> {
  const token = generatePat();
  const [created] = await db
    .insert(personalAccessTokens)
    .values({ userId, name, tokenHash: hashServerKey(token), expiresAt })
    .returning();
  if (!created) throw new Error("insert del PAT non ha restituito la riga");
  return { ...toPatView(created), token };
}

/**
 * CRUD dei Personal Access Token, sotto /api/pats. I PAT sono PER-UTENTE (non
 * admin): ogni utente autenticato gestisce solo i propri. L'isolamento è un
 * requisito di sicurezza — `userId` è sempre nel WHERE di lista e revoca, così
 * un utente non può vedere né cancellare i token altrui. Il token in chiaro
 * (`stw_pat_…`) si restituisce SOLO alla creazione: in DB vive solo il suo hash.
 */
export async function patRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: { response: { 200: z.array(patViewSchema), ...authErrorResponses } },
    },
    async (request) => {
      const rows = await app.db
        .select()
        .from(personalAccessTokens)
        .where(eq(personalAccessTokens.userId, request.user!.id))
        .orderBy(desc(personalAccessTokens.createdAt));
      return rows.map(toPatView);
    },
  );

  app.post(
    "/",
    {
      preHandler: requireAuth,
      schema: {
        body: createPatSchema,
        response: { 201: patWithTokenSchema, 400: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const created = await createPatForUser(
        app.db,
        request.user!.id,
        request.body.name,
        request.body.expiresAt ? new Date(request.body.expiresAt) : null,
      );
      return await reply.code(201).send(created);
    },
  );

  app.delete(
    "/:id",
    {
      preHandler: requireAuth,
      schema: {
        params: z.object({ id: z.uuid() }),
        response: { 204: z.null(), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      // userId nel WHERE: revoca solo un token proprio; un id altrui non matcha
      // e torna 404 (indistinguibile da inesistente, nessun leak d'esistenza).
      const deleted = await app.db
        .delete(personalAccessTokens)
        .where(
          and(
            eq(personalAccessTokens.id, request.params.id),
            eq(personalAccessTokens.userId, request.user!.id),
          ),
        )
        .returning({ id: personalAccessTokens.id });
      if (deleted.length === 0) return apiError(reply, 404, "pat_not_found", "Token not found");
      return reply.code(204).send(null);
    },
  );
}
