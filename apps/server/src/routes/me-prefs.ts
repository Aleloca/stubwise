import { deviceTokens, projectFollows, projects, users } from "@stubwise/db";
import {
  deviceRegistrationSchema,
  notificationPrefsUpdateSchema,
  notificationPrefsViewSchema,
  projectFollowsSchema,
} from "@stubwise/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import { apiError } from "../errors.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Preferenze PERSONALI dell'utente autenticato, sotto `/api/me`: quali progetti
 * segue e su quali canali vuole essere avvisato.
 *
 * Sono gli ingressi dell'instradamento delle notifiche (`packages/notifications`
 * → `recipientsFor`): i follow decidono CHI riceve un evento di progetto,
 * `notify_slack_dm` e `notify_push` se a quella persona si manda anche il DM
 * Slack o la push, e `device_tokens` DOVE recapitare quella push. Nessun
 * privilegio admin: ognuno gestisce solo le proprie righe, e `userId` è sempre
 * nel WHERE — un utente non può leggere né scrivere le preferenze altrui.
 *
 * Separate da `/api/users` (che è l'amministrazione degli utenti, riservata
 * agli admin) proprio per questa ragione: qui il soggetto è sempre "io".
 */
export async function mePrefsRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  /** Progetti seguiti: l'insieme completo, senza ordine significativo. */
  app.get(
    "/follows",
    {
      preHandler: requireAuth,
      schema: { response: { 200: projectFollowsSchema, ...authErrorResponses } },
    },
    async (request) => {
      const rows = await app.db
        .select({ projectId: projectFollows.projectId })
        .from(projectFollows)
        .where(eq(projectFollows.userId, request.user!.id));
      return { projectIds: rows.map((row) => row.projectId) };
    },
  );

  /**
   * SOSTITUISCE l'insieme dei progetti seguiti (non aggiunge): il client manda
   * lo stato che vuole, non un delta — così la UI a checkbox non deve calcolare
   * differenze e due schede aperte non si sommano a vicenda.
   *
   * Delete + insert in UNA transazione, con la validazione degli id DENTRO la
   * transazione e PRIMA della cancellazione: un id inesistente fa 400 senza aver
   * toccato nulla (la FK darebbe comunque errore, ma dopo aver già cancellato
   * l'insieme vecchio, e con un 500 invece di un messaggio utile).
   */
  app.put(
    "/follows",
    {
      preHandler: requireAuth,
      schema: {
        body: projectFollowsSchema,
        response: { 204: z.null(), 400: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      // I duplicati nel payload sono innocui per il client ma violerebbero la
      // PK (user_id, project_id): si deduplica qui, non si risponde 400.
      const projectIds = [...new Set(request.body.projectIds)];

      const outcome = await app.db.transaction(async (tx) => {
        if (projectIds.length > 0) {
          const known = await tx
            .select({ id: projects.id })
            .from(projects)
            .where(inArray(projects.id, projectIds));
          if (known.length !== projectIds.length) return "unknown_project" as const;
        }
        await tx.delete(projectFollows).where(eq(projectFollows.userId, userId));
        if (projectIds.length > 0) {
          await tx
            .insert(projectFollows)
            .values(projectIds.map((projectId) => ({ userId, projectId })));
        }
        return "ok" as const;
      });

      if (outcome === "unknown_project") {
        return apiError(reply, 400, "unknown_project", "One or more projects do not exist");
      }
      return reply.code(204).send(null);
    },
  );

  /**
   * Preferenze di notifica. `slackLinked` non è una preferenza ma il contesto
   * che serve alla UI: senza identità Slack collegata il toggle del DM va
   * mostrato disabilitato, perché anche acceso il canale resterebbe muto.
   */
  app.get(
    "/notification-prefs",
    {
      preHandler: requireAuth,
      schema: {
        response: { 200: notificationPrefsViewSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const [row] = await app.db
        .select({
          slackDm: users.notifySlackDm,
          push: users.notifyPush,
          slackUserId: users.slackUserId,
        })
        .from(users)
        .where(eq(users.id, request.user!.id));
      // Utente cancellato fra l'autenticazione e questa query: raro ma non
      // impossibile, e meglio di un 500 su `row` undefined.
      if (!row) return apiError(reply, 404, "not_found", "User not found");
      return { slackDm: row.slackDm, push: row.push, slackLinked: row.slackUserId !== null };
    },
  );

  /**
   * Accende o spegne i canali opzionali (DM Slack, push sui device mobili).
   * Applica i campi presenti e lascia stare gli assenti — non sostituisce
   * l'insieme. Così un client vecchio, che manda solo i canali che conosceva,
   * continua a funzionare quando ne aggiungiamo uno: è l'invariante «solo
   * cambi additivi» applicata alla direzione in SCRITTURA, dove pesa più che
   * altrove perché l'app mobile non si aggiorna insieme al server.
   *
   * ⚠️ È `PATCH`, e NON va "uniformata" al `PUT /follows` qui sopra: i due
   * verbi sono diversi perché le due semantiche lo sono. `/follows`
   * SOSTITUISCE l'insieme dei progetti seguiti (mandarne metà ne cancella
   * metà); questa applica un delta. Quando i due verbi erano uguali la
   * differenza è passata inosservata abbastanza a lungo da produrre un
   * commento sbagliato in `@stubwise/api-client` («entrambi i PUT
   * sostituiscono»), che il verbo identico rendeva plausibile. Il verbo è la
   * prima cosa che si legge: qui è lui a raccontare la differenza.
   *
   * Un body vuoto è un no-op da 204, non un 400: una patch senza campi non è
   * ambigua, è solo vuota. Non c'è un toggle per l'inbox in-app: è la
   * superficie primaria delle notifiche, non un canale opzionale.
   */
  app.patch(
    "/notification-prefs",
    {
      preHandler: requireAuth,
      schema: {
        body: notificationPrefsUpdateSchema,
        response: { 204: z.null(), ...authErrorResponses },
      },
    },
    async (request, reply) => {
      // Si costruisce il SET coi soli campi presenti: con un body vuoto
      // l'update resterebbe senza colonne da scrivere e drizzle solleverebbe
      // "No values to set" (un 500 al posto del no-op).
      const patch: Partial<typeof users.$inferInsert> = {};
      if (request.body.slackDm !== undefined) patch.notifySlackDm = request.body.slackDm;
      if (request.body.push !== undefined) patch.notifyPush = request.body.push;
      if (Object.keys(patch).length > 0) {
        await app.db.update(users).set(patch).where(eq(users.id, request.user!.id));
      }
      return reply.code(204).send(null);
    },
  );

  /**
   * REGISTRA il token push di un device: un UPSERT idempotente, non una
   * creazione. L'app lo chiama a ogni avvio e a ogni rotazione del token del
   * sistema operativo, quindi la stessa chiamata ripetuta deve valere una sola
   * riga.
   *
   * La chiave del conflitto è `token` (unique GLOBALE, non per utente), e da
   * questo discendono i due comportamenti che seguono.
   *
   * 1. **L'upsert RIATTIVA.** Se la riga era disattivata — `pat_revoked` dopo
   *    la revoca del PAT, `invalid_token` da un rifiuto del relay — questa
   *    registrazione azzera `disabledAt` **e** `disabledReason`. Senza,
   *    un telefono che rifà login resterebbe muto PER SEMPRE, e in silenzio:
   *    la registrazione risponderebbe 204 e nessuna push arriverebbe mai più.
   *    I due campi si azzerano INSIEME perché il CHECK
   *    `device_tokens_disabled_chk` impone `(disabled_at IS NULL) =
   *    (disabled_reason IS NULL)`: uno solo darebbe un 23514.
   *
   * 2. **Il device PASSA a chi lo registra ora.** `userId` è nel SET, non solo
   *    nei valori d'insert: sullo stesso telefono l'utente A esce e B entra, e
   *    il token del sistema operativo è lo stesso. Senza il passaggio la
   *    registrazione di B sbatterebbe contro la unique e quel telefono non
   *    riceverebbe più nulla. Il token identifica l'INSTALLAZIONE, non la
   *    persona. Il prezzo è noto e accettato: chi conosce il token di un altro
   *    device può intestarselo, e da quel momento è il telefono altrui a
   *    ricevere le SUE notifiche mentre il legittimo proprietario smette di
   *    riceverne — un disservizio più che una lettura di dati altrui, e
   *    raggiungibile solo da chi il token ce l'ha già.
   *
   * Una sola istruzione, quindi nessuna transazione: non c'è una scrittura
   * "prima di quella decisiva" da cui difendersi.
   */
  app.put(
    "/devices",
    {
      preHandler: requireAuth,
      schema: {
        body: deviceRegistrationSchema,
        response: { 204: z.null(), 400: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      // Il PAT con cui l'app si è autenticata, se è arrivata con un PAT: è ciò
      // su cui la revoca (`routes/pat.ts`) ritrova i device di quel telefono.
      // Da cookie di sessione non c'è, e la colonna resta null.
      const patId = request.user!.patId ?? null;
      const appVersion = request.body.appVersion ?? null;
      const values = {
        userId,
        patId,
        platform: request.body.platform,
        token: request.body.token,
        appVersion,
      };
      await app.db
        .insert(deviceTokens)
        .values(values)
        .onConflictDoUpdate({
          target: deviceTokens.token,
          set: {
            ...values,
            lastSeenAt: new Date(),
            // La riattivazione: vedi il punto 1 del docblock.
            disabledAt: null,
            disabledReason: null,
          },
        });
      return reply.code(204).send(null);
    },
  );

  /**
   * CANCELLA la registrazione di un device: è il logout dell'app.
   *
   * La riga si ELIMINA, non si disattiva. Un soft delete continuerebbe a
   * occupare la unique sul token e si farebbe riaccendere dal primo upsert di
   * chiunque: il contrario di ciò che chiede chi esce.
   *
   * ⚠️ `userId` nel WHERE è la sola cosa che impedisce a chi conosce un token
   * altrui di cancellarlo. Non è ridondante con nulla — qui non c'è nemmeno un
   * 404 dietro cui nascondersi — e va letto insieme alla stessa riga in
   * `routes/pat.ts`, dove il filtro serve per una ragione diversa e altrettanto
   * non ovvia. C'è un test che lo dimostra guardando il DB, non lo status code:
   * senza il filtro la risposta sarebbe 204 identica.
   *
   * **204 anche su un token che non c'è (o non è nostro)**, non 404. Il logout
   * dev'essere idempotente: l'app lo ritenta dopo un timeout di rete e non deve
   * inciampare in un errore per un lavoro già fatto. Un 404 in più direbbe
   * «questo token non è tuo o non esiste», che è più di quanto serva a chi sta
   * uscendo — e non c'è nessun client che sappia farci qualcosa.
   */
  app.delete(
    "/devices/:token",
    {
      preHandler: requireAuth,
      schema: {
        params: z.object({ token: z.string().min(1) }),
        response: { 204: z.null(), ...authErrorResponses },
      },
    },
    async (request, reply) => {
      await app.db
        .delete(deviceTokens)
        .where(
          and(
            eq(deviceTokens.token, request.params.token),
            eq(deviceTokens.userId, request.user!.id),
          ),
        );
      return reply.code(204).send(null);
    },
  );
}
