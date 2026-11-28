import { projectFollows, projects, users } from "@stubwise/db";
import {
  notificationPrefsUpdateSchema,
  notificationPrefsViewSchema,
  projectFollowsSchema,
} from "@stubwise/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { inProjects, visibleProjectIds } from "../auth/access.js";
import { apiError } from "../errors.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Preferenze PERSONALI dell'utente autenticato, sotto `/api/me`: quali progetti
 * segue e su quali canali vuole essere avvisato.
 *
 * Sono gli ingressi dell'instradamento delle notifiche (`packages/notifications`
 * → `recipientsFor`): i follow decidono CHI riceve un evento di progetto,
 * `notify_push` se a quella persona si manda anche la push. Nessun privilegio
 * admin: ognuno gestisce solo le proprie righe, e `userId` è sempre nel WHERE
 * — un utente non può leggere né scrivere le preferenze altrui. (La
 * registrazione dei telefoni, `PUT /devices`, è andata via con R2.)
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
      config: { access: { kind: "user" }, mcp: { action: "me.follows", summary: "I progetti che segui (i fissati, pinned).", effect: "read" } },
      schema: { response: { 200: projectFollowsSchema, ...authErrorResponses } },
    },
    async (request) => {
      // Solo i follow di progetti che chi chiede vede ancora: quelli di un
      // progetto da cui è stato tolto restano in tabella (revoca a lettura) ma
      // non si mostrano, e non producono nulla.
      const visible = await visibleProjectIds(app.db, request.user!);
      const rows = await app.db
        .select({ projectId: projectFollows.projectId })
        .from(projectFollows)
        .where(
          and(eq(projectFollows.userId, request.user!.id), inProjects(projectFollows.projectId, visible)),
        );
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
      config: { access: { kind: "user" }, mcp: { action: "me.setFollows", summary: "Segue o fissa (pin) dei progetti: sostituisce l'insieme dei progetti che segui (manda l'elenco completo).", effect: "write" } },
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
      // L'insieme sostituito è quello dei progetti VISIBILI: un progetto che
      // non si vede vale come inesistente (400, non si conferma che c'è), e i
      // follow di progetti non più visibili restano in tabella intatti.
      const visible = await visibleProjectIds(app.db, request.user!);

      const outcome = await app.db.transaction(async (tx) => {
        if (projectIds.length > 0) {
          const known = await tx
            .select({ id: projects.id })
            .from(projects)
            .where(and(inArray(projects.id, projectIds), inProjects(projects.id, visible)));
          if (known.length !== projectIds.length) return "unknown_project" as const;
        }
        await tx
          .delete(projectFollows)
          .where(and(eq(projectFollows.userId, userId), inProjects(projectFollows.projectId, visible)));
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

  /** Preferenze di notifica: oggi la sola push. */
  app.get(
    "/notification-prefs",
    {
      config: { mcp: { action: "me.notificationPrefs", summary: "Le tue preferenze di notifica (push sui telefoni).", effect: "read" }, access: { kind: "user" } },
      schema: {
        response: { 200: notificationPrefsViewSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const [row] = await app.db
        .select({ push: users.notifyPush })
        .from(users)
        .where(eq(users.id, request.user!.id));
      // Utente cancellato fra l'autenticazione e questa query: raro ma non
      // impossibile, e meglio di un 500 su `row` undefined.
      if (!row) return apiError(reply, 404, "not_found", "User not found");
      return { push: row.push };
    },
  );

  /**
   * Accende o spegne i canali opzionali (oggi la push sui device mobili).
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
      config: { mcp: { action: "me.updateNotificationPrefs", summary: "Accende o spegne i tuoi canali di notifica (push sui telefoni).", effect: "write" }, access: { kind: "user" } },
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
      if (request.body.push !== undefined) patch.notifyPush = request.body.push;
      if (Object.keys(patch).length > 0) {
        await app.db.update(users).set(patch).where(eq(users.id, request.user!.id));
      }
      return reply.code(204).send(null);
    },
  );
}
