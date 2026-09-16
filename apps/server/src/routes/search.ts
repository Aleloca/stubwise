import {
  recordSearchHistoryBodySchema,
  searchDocsSemanticResultsSchema,
  searchHistoryItemSchema,
  searchResultsSchema,
} from "@stubwise/shared";
import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import {
  comments,
  docPages,
  emailMessages,
  googleAccounts,
  projects,
  repositories,
  searchHistory,
  tickets,
} from "@stubwise/db";
import { apiError } from "../errors.js";
import { retrieveChunks, retrieveChunksAll } from "./docs-retrieval.js";
import { authErrorResponses, errorSchema } from "./shared.js";

// Quanti risultati per gruppo restituisce la corsia veloce; ne chiediamo uno in
// più al DB per calcolare `hasMore` senza una COUNT separata.
const PER_GROUP = 8;
// Quante voci di cronologia si mostrano (recenti a query vuota).
const HISTORY_LIMIT = 8;
// Oltre quante voci di cronologia per utente si pota (le più vecchie).
const HISTORY_KEEP = 20;

/**
 * Tetto di righe scandite dalla gamba della posta.
 *
 * NON è una finestra di risultati (quella resta `PER_GROUP`): è la difesa
 * contro il giorno in cui la premessa «la tabella è piccola per costruzione»
 * smettesse di valere. `DISTINCT ON` produce una riga per conversazione, e
 * duecento conversazioni che combaciano una sola query sono già ben oltre
 * quello che una casella potata a 90 giorni può contenere.
 */
const MAIL_SCAN_CAP = 200;

/**
 * Il documento full-text di un messaggio: oggetto, mittente e l'ESTRATTO —
 * cioè esattamente il testo su cui la classificazione ha deciso
 * (`text_excerpt`), non il corpo HTML originale, che vive in `email_bodies`
 * per CHI LEGGE e non è ciò che Stubwise ha letto.
 *
 * Calcolato al volo e non da una colonna generata: vedi il commento
 * sull'assenza di indice nella gamba della posta.
 */
const MAIL_TSV = sql`to_tsvector('english', coalesce(${emailMessages.subject}, '') || ' ' || coalesce(${emailMessages.fromName}, '') || ' ' || ${emailMessages.fromAddress} || ' ' || coalesce(${emailMessages.textExcerpt}, ''))`;

const searchQuerySchema = z.object({
  q: z.string().min(1).max(300),
  // Scope Docs: se presente, RISTRINGE SOLO il gruppo docs a questo repository.
  // Gli altri gruppi (ticket/progetti/repo) restano globali.
  repositoryId: z.uuid().optional(),
});

const docsSemanticQuerySchema = z.object({
  q: z.string().min(1).max(300),
  // Scope Docs: se presente, il retrieval semantico è ristretto a QUEL repository
  // (+ generazione corrente/manuali); altrimenti è GLOBALE su tutti i repo.
  repositoryId: z.uuid().optional(),
});

const historyQuerySchema = z.object({
  // Scope Docs per i recenti: filtra la cronologia a quel repository.
  repositoryId: z.uuid().optional(),
});

const historyItemParamsSchema = z.object({
  type: z.enum(["ticket", "project", "repository", "doc"]),
  entityId: z.string().min(1),
});

/**
 * Ricerca globale (spotlight Cmd/K) — corsia veloce, federata full-text, e
 * cronologia unificata dei risultati cliccati. `GET /api/search` interroga in
 * parallelo ticket/progetti/repository/docs; lo scope Docs (`repositoryId`)
 * ristringe SOLO il gruppo docs, gli altri restano globali. La cronologia
 * (`/api/search/history`) è poliforma (qualsiasi tipo), con upsert+prune.
 */
export async function searchRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: {
        querystring: searchQuerySchema,
        response: { 200: searchResultsSchema, 400: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const q = request.query.q.trim();
      // `q` di soli spazi passa il min(1) di Zod ma è semanticamente vuota.
      if (q.length === 0) {
        return apiError(reply, 400, "empty_query", "Search query must not be empty");
      }
      const scopeRepositoryId = request.query.repositoryId;

      // websearch_to_tsquery tollera input utente arbitrario (&, :, !, virgolette)
      // senza errori di sintassi → niente escaping. Config 'english' per convenzione
      // di progetto (condivisa da tickets/doc_pages).
      const tsq = sql`websearch_to_tsquery('english', ${q})`;
      // Pattern ILIKE per progetti/repo (pochi record): escape dei metacaratteri
      // LIKE (%, _, \) così l'input utente non li interpreta.
      const likePattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

      // Esecuzione in PARALLELO delle cinque gambe.
      const [ticketRows, projectRows, repositoryRows, docRows, mailRows] = await Promise.all([
        // --- Ticket (globale): titolo+body (searchTsv) OPPURE un commento. ------
        app.db
          .select({
            id: tickets.id,
            number: tickets.number,
            title: tickets.title,
            status: tickets.status,
            projectId: tickets.projectId,
            projectName: projects.name,
            snippet: sql<string>`ts_headline('english', coalesce(${tickets.title}, '') || ' — ' || coalesce(${tickets.body}, ''), ${tsq}, 'MaxFragments=1,MaxWords=40,MinWords=15')`,
            rank: sql<number>`ts_rank(${tickets.searchTsv}, ${tsq})`,
          })
          .from(tickets)
          .innerJoin(projects, eq(tickets.projectId, projects.id))
          .where(
            sql`(
              ${tickets.searchTsv} @@ ${tsq}
              OR EXISTS (
                SELECT 1 FROM ${comments} c
                WHERE c.ticket_id = ${tickets.id}
                  AND to_tsvector('english', c.body) @@ ${tsq}
              )
            )`,
          )
          .orderBy(sql`ts_rank(${tickets.searchTsv}, ${tsq}) DESC`, desc(tickets.createdAt))
          .limit(PER_GROUP + 1),

        // --- Progetti (globale): ILIKE su nome/slug/descrizione. ---------------
        app.db
          .select({
            id: projects.id,
            name: projects.name,
            slug: projects.slug,
            description: projects.description,
          })
          .from(projects)
          .where(
            or(
              ilike(projects.name, likePattern),
              ilike(projects.slug, likePattern),
              ilike(projects.description, likePattern),
            ),
          )
          .orderBy(projects.name)
          .limit(PER_GROUP + 1),

        // --- Repository (globale): ILIKE su nome/slug/repoUrl. -----------------
        app.db
          .select({
            id: repositories.id,
            name: repositories.name,
            slug: repositories.slug,
            projectId: repositories.projectId,
            repoUrl: repositories.repoUrl,
          })
          .from(repositories)
          .where(
            or(
              ilike(repositories.name, likePattern),
              ilike(repositories.slug, likePattern),
              ilike(repositories.repoUrl, likePattern),
            ),
          )
          .orderBy(repositories.name)
          .limit(PER_GROUP + 1),

        // --- Docs (full-text): doc_pages.searchTsv sui repo con generazione
        // corrente. In scope Docs SOLO quel repository; altrimenti TUTTI (il
        // filtro di generazione corrente/manuale è per-repo, come in Fase 2).
        app.db
          .select({
            slug: docPages.slug,
            title: docPages.title,
            kind: docPages.kind,
            repositoryId: repositories.id,
            repositorySlug: repositories.slug,
            repositoryName: repositories.name,
            snippet: sql<string>`ts_headline('english', ${docPages.body}, ${tsq}, 'MaxFragments=1,MaxWords=40,MinWords=15')`,
            rank: sql<number>`ts_rank_cd(${docPages.searchTsv}, ${tsq}, 32)`,
          })
          .from(docPages)
          .innerJoin(repositories, eq(docPages.repositoryId, repositories.id))
          .where(
            and(
              sql`${docPages.searchTsv} @@ ${tsq}`,
              // Solo la generazione corrente del repo (o le pagine manuali,
              // generation_id null): le generazioni stale non compaiono.
              or(
                eq(docPages.generationId, repositories.currentDocGenerationId),
                isNull(docPages.generationId),
              ),
              scopeRepositoryId ? eq(repositories.id, scopeRepositoryId) : undefined,
            ),
          )
          .orderBy(sql`ts_rank_cd(${docPages.searchTsv}, ${tsq}, 32) DESC`)
          .limit(PER_GROUP + 1),

        // --- Posta (15 set 2026, design §3): CONVERSAZIONI, non messaggi. ------
        //
        // ⚠️ **L'ACL è la riga che non può sbagliare.** La posta è privata del
        // proprietario della casella (audience `mailbox_owner`, fase 6: «una
        // proposta nata dalla casella di qualcuno la vede SOLO quel
        // qualcuno», e nemmeno un admin). Il filtro è
        // `google_accounts.user_id = utente corrente`, dentro l'INNER JOIN,
        // come in ogni rotta di `/api/me/mail`: **nessun ruolo scavalca**, e
        // qui non c'è nemmeno un ramo `if (admin)` da sbagliare. C'è un test
        // NEGATIVO che cerca una parola che esiste SOLO nel messaggio di un
        // altro utente.
        //
        // `DISTINCT ON (account_id, thread_id)`: una riga per CONVERSAZIONE,
        // tenendo il messaggio che ha combaciato MEGLIO. Due caselle con lo
        // stesso thread Gmail restano due conversazioni, come nella lista.
        //
        // ⚠️ Include anche i messaggi di CONTESTO (`admitted = false`), ed è
        // corretto: quel limite esiste perché un messaggio di contesto non
        // diventi mai una CARD (CLAUDE.md), non perché non si possa leggere —
        // e cercare è leggere. Escluderli lascerebbe buchi in mezzo a
        // conversazioni che l'utente vede per intero nella pagina Posta.
        //
        // Nessun indice full-text su `email_messages`, e non serve: la
        // tabella è piccola PER COSTRUZIONE (una casella per utente, potata
        // da `GMAIL_RETENTION_DAYS`) — in produzione decine di righe. Il
        // giorno in cui non fosse più vero, la mossa è una colonna tsvector
        // generata come su `tickets`, non un filtro più stretto qui.
        app.db
          .selectDistinctOn([emailMessages.accountId, emailMessages.threadId], {
            threadId: emailMessages.threadId,
            accountId: emailMessages.accountId,
            accountEmail: googleAccounts.email,
            matchedMessageId: emailMessages.id,
            subject: emailMessages.subject,
            fromAddress: emailMessages.fromAddress,
            receivedAt: emailMessages.receivedAt,
            snippet: sql<string>`ts_headline('english', coalesce(${emailMessages.subject}, '') || ' — ' || coalesce(${emailMessages.textExcerpt}, ''), ${tsq}, 'MaxFragments=1,MaxWords=40,MinWords=15')`,
            rank: sql<number>`ts_rank(${MAIL_TSV}, ${tsq})`,
          })
          .from(emailMessages)
          .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
          .where(
            and(
              eq(googleAccounts.userId, request.user!.id),
              // Full-text OPPURE ILIKE su oggetto e mittente, e la seconda
              // metà non è ridondante: Postgres tokenizza un indirizzo come
              // UNA parola sola (`mario@acme.test`), quindi cercare «mario»
              // o «acme» con `websearch_to_tsquery` non trova NIENTE — e
              // cercare un pezzo di nome è il modo in cui si cerca la posta,
              // più che una parola intera del corpo. Stessa scelta di
              // progetti e repository qui sopra, per la stessa ragione (pochi
              // record, match parziale utile).
              or(
                sql`${MAIL_TSV} @@ ${tsq}`,
                ilike(emailMessages.subject, likePattern),
                ilike(emailMessages.fromAddress, likePattern),
                ilike(emailMessages.fromName, likePattern),
              ),
            ),
          )
          // `DISTINCT ON` obbliga l'ORDER BY a partire dalle sue espressioni:
          // l'ordinamento per RILEVANZA avviene quindi dopo, in memoria.
          .orderBy(
            emailMessages.accountId,
            emailMessages.threadId,
            sql`ts_rank(${MAIL_TSV}, ${tsq}) DESC`,
            desc(emailMessages.receivedAt),
          )
          // Tetto di sicurezza, non una finestra di risultati: protegge dal
          // giorno in cui la premessa «la tabella è piccola» smettesse di
          // valere, senza tagliare nulla finché vale.
          .limit(MAIL_SCAN_CAP),
      ]);

      // Le conversazioni ordinate per rilevanza: `DISTINCT ON` ha già scelto
      // UN messaggio per thread, qui si sceglie QUALI thread mostrare.
      //
      // A parità di rango vince la più RECENTE — e la parità è comune, non un
      // caso limite: una riga trovata dal solo ILIKE (un pezzo di indirizzo)
      // ha rango 0, e fra due conversazioni ugualmente rilevanti quella di
      // ieri è quasi sempre quella cercata.
      const mailByRank = [...mailRows].sort(
        (a, b) => b.rank - a.rank || b.receivedAt.getTime() - a.receivedAt.getTime(),
      );

      return {
        tickets: {
          items: ticketRows.slice(0, PER_GROUP).map((r) => ({
            id: r.id,
            number: r.number,
            title: r.title,
            status: r.status,
            snippet: r.snippet,
            projectId: r.projectId,
            projectName: r.projectName,
          })),
          hasMore: ticketRows.length > PER_GROUP,
        },
        projects: {
          items: projectRows.slice(0, PER_GROUP).map((r) => ({
            id: r.id,
            name: r.name,
            slug: r.slug,
            snippet: r.description,
          })),
          hasMore: projectRows.length > PER_GROUP,
        },
        repositories: {
          items: repositoryRows.slice(0, PER_GROUP).map((r) => ({
            id: r.id,
            name: r.name,
            slug: r.slug,
            projectId: r.projectId,
            repoUrl: r.repoUrl,
          })),
          hasMore: repositoryRows.length > PER_GROUP,
        },
        docs: {
          items: docRows.slice(0, PER_GROUP).map((r) => ({
            slug: r.slug,
            title: r.title,
            kind: r.kind,
            snippet: r.snippet,
            repositoryId: r.repositoryId,
            repositorySlug: r.repositorySlug,
            repositoryName: r.repositoryName,
          })),
          hasMore: docRows.length > PER_GROUP,
        },
        mail: {
          items: mailByRank.slice(0, PER_GROUP).map((r) => ({
            threadId: r.threadId,
            accountId: r.accountId,
            accountEmail: r.accountEmail,
            subject: r.subject,
            from: r.fromAddress,
            snippet: r.snippet,
            matchedMessageId: r.matchedMessageId,
            receivedAt: r.receivedAt.toISOString(),
          })),
          hasMore: mailByRank.length > PER_GROUP,
        },
      };
    },
  );

  /**
   * Corsia LENTA della ricerca globale: retrieval SEMANTICO sui Docs. Con
   * `repositoryId` è ristretta a quel repository ({@link retrieveChunks});
   * altrimenti è GLOBALE su tutti i repo di ogni progetto
   * ({@link retrieveChunksAll}). I risultati hanno lo STESSO shape del gruppo
   * `docs` di `GET /api/search` (più `score`), così il client li fonde nel
   * gruppo Docs.
   *
   * Best-effort: se l'embedding non è disponibile la gamba semantica degrada a
   * full-text-only DENTRO al retrieval (mai un 500); se non c'è alcun Doc
   * ritorna semplicemente una lista vuota. Lo `snippet` è quello del chunk più
   * rilevante già calcolato dal retrieval.
   */
  app.get(
    "/docs-semantic",
    {
      preHandler: requireAuth,
      schema: {
        querystring: docsSemanticQuerySchema,
        response: {
          200: searchDocsSemanticResultsSchema,
          400: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const q = request.query.q.trim();
      // `q` di soli spazi passa il min(1) di Zod ma è semanticamente vuota.
      if (q.length === 0) {
        return apiError(reply, 400, "empty_query", "Search query must not be empty");
      }
      const { repositoryId } = request.query;

      const chunks = repositoryId
        ? await retrieveChunks(app.db, app.embeddingClient, repositoryId, q, {
            logger: request.log,
          })
        : await retrieveChunksAll(app.db, app.embeddingClient, q, {
            logger: request.log,
          });

      return chunks.map((c) => ({
        slug: c.slug,
        title: c.title,
        kind: c.kind,
        snippet: c.snippet,
        repositoryId: c.repositoryId,
        repositorySlug: c.repositorySlug,
        repositoryName: c.repositoryName,
        score: c.score,
      }));
    },
  );

  // --- Cronologia unificata dei risultati cliccati -----------------------

  /**
   * Recenti dell'utente corrente: le ultime N voci, dal click più recente. In
   * scope Docs (`repositoryId`) filtra a quel repository (comportamento della
   * palette Docs), altrimenti globale.
   */
  app.get(
    "/history",
    {
      preHandler: requireAuth,
      schema: {
        querystring: historyQuerySchema,
        response: { 200: z.array(searchHistoryItemSchema), ...authErrorResponses },
      },
    },
    async (request) => {
      const { repositoryId } = request.query;
      const rows = await app.db
        .select({
          type: searchHistory.type,
          entityId: searchHistory.entityId,
          title: searchHistory.title,
          subtitle: searchHistory.subtitle,
          route: searchHistory.route,
          repositoryId: searchHistory.repositoryId,
          clickedAt: searchHistory.clickedAt,
        })
        .from(searchHistory)
        .where(
          and(
            eq(searchHistory.userId, request.user!.id),
            repositoryId ? eq(searchHistory.repositoryId, repositoryId) : undefined,
          ),
        )
        .orderBy(desc(searchHistory.clickedAt))
        .limit(HISTORY_LIMIT);

      return rows.map((r) => ({
        type: r.type,
        entityId: r.entityId,
        title: r.title,
        subtitle: r.subtitle,
        route: r.route,
        repositoryId: r.repositoryId,
        clickedAt: r.clickedAt.toISOString(),
      }));
    },
  );

  /**
   * Registra (upsert) un risultato cliccato. Una sola voce per (utente, tipo,
   * entità): un re-click aggiorna `clickedAt` e i campi denormalizzati. Dopo
   * l'insert pota le righe oltre le N più recenti dell'utente. 204 senza corpo.
   */
  app.post(
    "/history",
    {
      preHandler: requireAuth,
      schema: {
        body: recordSearchHistoryBodySchema,
        response: { 204: z.null(), ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { type, entityId, title, subtitle, route, repositoryId } = request.body;
      const userId = request.user!.id;

      await app.db
        .insert(searchHistory)
        .values({
          userId,
          type,
          entityId,
          title,
          subtitle: subtitle ?? null,
          route,
          repositoryId: repositoryId ?? null,
        })
        .onConflictDoUpdate({
          target: [searchHistory.userId, searchHistory.type, searchHistory.entityId],
          set: {
            clickedAt: new Date(),
            title,
            subtitle: subtitle ?? null,
            route,
            repositoryId: repositoryId ?? null,
          },
        });

      // Poda: tieni solo le N voci più recenti dell'utente (cronologia globale).
      const keep = app.db
        .select({ id: searchHistory.id })
        .from(searchHistory)
        .where(eq(searchHistory.userId, userId))
        .orderBy(desc(searchHistory.clickedAt))
        .limit(HISTORY_KEEP);
      await app.db
        .delete(searchHistory)
        .where(
          and(
            eq(searchHistory.userId, userId),
            sql`${searchHistory.id} NOT IN ${keep}`,
          ),
        );

      return reply.code(204).send(null);
    },
  );

  /**
   * Rimuove una singola voce (per tipo+entità) dell'utente corrente. 204 anche
   * se la voce non esiste (idempotente).
   */
  app.delete(
    "/history/:type/:entityId",
    {
      preHandler: requireAuth,
      schema: {
        params: historyItemParamsSchema,
        response: { 204: z.null(), ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { type, entityId } = request.params;
      await app.db
        .delete(searchHistory)
        .where(
          and(
            eq(searchHistory.userId, request.user!.id),
            eq(searchHistory.type, type),
            eq(searchHistory.entityId, entityId),
          ),
        );
      return reply.code(204).send(null);
    },
  );

  /**
   * Svuota tutta la cronologia dell'utente corrente. 204.
   */
  app.delete(
    "/history",
    {
      preHandler: requireAuth,
      schema: { response: { 204: z.null(), ...authErrorResponses } },
    },
    async (request, reply) => {
      await app.db
        .delete(searchHistory)
        .where(eq(searchHistory.userId, request.user!.id));
      return reply.code(204).send(null);
    },
  );
}
