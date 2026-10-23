import { deviceTokens, personalAccessTokens } from "@stubwise/db";
import type { Db } from "@stubwise/db";
import { createPatSchema, patViewSchema, patWithTokenSchema } from "@stubwise/shared";
import type { PatView, PatWithToken } from "@stubwise/shared";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
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
  // `mobile` solo da `/mobile-login`: è il marcatore con cui reset e cambio
  // della password ritrovano i token dell'app (vedi revokeMobilePats).
  kind: "manual" | "mobile" = "manual",
): Promise<PatWithToken> {
  const token = generatePat();
  const [created] = await db
    .insert(personalAccessTokens)
    .values({ userId, name, tokenHash: hashServerKey(token), expiresAt, kind })
    .returning();
  if (!created) throw new Error("insert del PAT non ha restituito la riga");
  return { ...toPatView(created), token };
}

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Revoca i token dell'app mobile di un utente (`kind = 'mobile'`, emessi da
 * `/mobile-login`), tranne `exceptPatId` se dato: la chiamano il reset e il
 * cambio della password (21 ott 2026), così un telefono resta fuori finché
 * non si rientra con la password nuova. I PAT `manual` (MCP, Claude Code,
 * script) non si toccano: non sono un accesso «con la password».
 *
 * Stesso ordine della revoca a mano qui sotto, e per la stessa ragione: i
 * device si spengono PRIMA del delete, perché dopo la FK `ON DELETE SET NULL`
 * avrebbe già azzerato `pat_id` e l'UPDATE non troverebbe più nulla.
 */
export async function revokeMobilePats(
  db: DbOrTx,
  userId: string,
  exceptPatId?: string,
): Promise<void> {
  const where = and(
    eq(personalAccessTokens.userId, userId),
    eq(personalAccessTokens.kind, "mobile"),
    exceptPatId === undefined ? undefined : ne(personalAccessTokens.id, exceptPatId),
  );
  const mobile = await db
    .select({ id: personalAccessTokens.id })
    .from(personalAccessTokens)
    .where(where);
  if (mobile.length === 0) return;
  const ids = mobile.map((row) => row.id);
  await db
    .update(deviceTokens)
    .set({ disabledAt: new Date(), disabledReason: "pat_revoked" })
    .where(
      and(
        inArray(deviceTokens.patId, ids),
        eq(deviceTokens.userId, userId),
        isNull(deviceTokens.disabledAt),
      ),
    );
  await db
    .delete(personalAccessTokens)
    .where(and(inArray(personalAccessTokens.id, ids), eq(personalAccessTokens.userId, userId)));
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
      config: { access: { kind: "user" } },
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
      config: { access: { kind: "user" }, reauth: true },
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
      config: { access: { kind: "user" } },
      schema: {
        params: z.object({ id: z.uuid() }),
        response: { 204: z.null(), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const deleted = await app.db.transaction(async (tx) => {
        // ⚠️ L'ORDINE NON È LIBERO: i device vanno disabilitati PRIMA del
        // delete. Dopo, la FK `ON DELETE SET NULL` ha già azzerato `pat_id` e
        // questo UPDATE non troverebbe più nulla — un riordino che sembra
        // innocuo e che spegnerebbe in silenzio tutto il meccanismo.
        //
        // Serve perché chi revoca il PAT di un telefono perso si aspetta di
        // aver tagliato fuori quel telefono. Senza questo passo la riga
        // resterebbe attiva con `pat_id` null, indistinguibile da un device
        // registrato via web, e le push continuerebbero ad arrivare finché il
        // relay non dichiarasse invalido il token — cosa che su un telefono
        // acceso non succede mai.
        // `userId` nel WHERE NON è ridondante col controllo di proprietà del
        // delete qui sotto, e va letto per esteso prima di toglierlo: su un PAT
        // altrui il delete non matcha e la richiesta esce con un 404, ma il 404
        // è un `return`, non un `throw` — la transazione COMMITTA comunque,
        // portandosi dietro questo UPDATE. Il filtro per utente è quindi
        // l'unica cosa che impedisce di spegnere i device altrui indovinando
        // l'id di un PAT; il 404 non protegge niente.
        await tx
          .update(deviceTokens)
          .set({ disabledAt: new Date(), disabledReason: "pat_revoked" })
          .where(
            and(
              eq(deviceTokens.patId, request.params.id),
              eq(deviceTokens.userId, request.user!.id),
              isNull(deviceTokens.disabledAt),
            ),
          );
        // userId nel WHERE: revoca solo un token proprio; un id altrui non
        // matcha e torna 404 (indistinguibile da inesistente, nessun leak
        // d'esistenza).
        return await tx
          .delete(personalAccessTokens)
          .where(
            and(
              eq(personalAccessTokens.id, request.params.id),
              eq(personalAccessTokens.userId, request.user!.id),
            ),
          )
          .returning({ id: personalAccessTokens.id });
      });
      if (deleted.length === 0) return apiError(reply, 404, "pat_not_found", "Token not found");
      return reply.code(204).send(null);
    },
  );
}
