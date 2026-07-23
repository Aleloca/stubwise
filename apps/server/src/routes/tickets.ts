import {
  ticketPrioritySchema,
  ticketRepositorySchema,
  ticketSourceSchema,
  ticketStatusSchema,
  ticketTypeSchema,
  setContentSchema,
  type TicketStatus,
} from "@stubwise/shared";
import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import type { Db } from "@stubwise/db";
import {
  aiJobs,
  aiJobStatus,
  comments,
  commentAuthorType,
  milestones,
  ticketEventKind,
  ticketEvents,
  ticketLinkKind,
  ticketLinks,
  ticketRepositories,
  repositories,
  tickets,
  users,
} from "@stubwise/db";
import { maybeEnqueueBacklogIntake } from "../backlog/enqueue.js";
import { createTicket, ProjectNotFoundError, type Ticket } from "../db/tickets.js";
import { apiError } from "../errors.js";
import {
  authErrorResponses,
  errorSchema,
  isForeignKeyViolation,
  isUniqueViolation,
} from "./shared.js";

/**
 * Forma pubblica di un ticket nelle risposte API: la riga del DB con le
 * date in ISO 8601. Alimenta anche l'OpenAPI generata (Task 9).
 */
export const ticketSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  number: z.number().int(),
  title: z.string(),
  body: z.string(),
  type: ticketTypeSchema,
  priority: ticketPrioritySchema,
  status: ticketStatusSchema,
  source: ticketSourceSchema,
  assigneeId: z.uuid().nullable(),
  // Milestone a cui il ticket è assegnato; null = nessuna milestone.
  milestoneId: z.uuid().nullable(),
  // Stima di sforzo 1–5 del triage AI; null finché il ticket non è triagiato.
  effort: z.number().int().min(1).max(5).nullable(),
  labels: z.array(z.string()),
  technicalPayload: z.unknown().nullable(),
  occurrences: z.number().int(),
  lastSeenAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/**
 * Dettaglio del ticket: la forma pubblica più lo stato PR per-repo (Fase 3,
 * fix multi-repo). `repositories` elenca una voce per ogni repository
 * effettivamente modificato dal fix (righe `ticket_repositories`), con branch,
 * PR e stato. Vuoto prima dell'esecuzione dell'agente. È l'unico legame
 * ticket↔repo: il ticket appartiene solo al progetto.
 */
export const ticketDetailSchema = ticketSchema.extend({
  // Piano di implementazione e contenuto d'origine (design/piano collegati al
  // ticket): testo libero, null finché non impostati. Solo nel dettaglio: sono
  // potenzialmente grandi e fuori posto nelle liste.
  implementationPlan: z.string().nullable(),
  originContent: z.string().nullable(),
  repositories: z.array(ticketRepositorySchema),
});

/**
 * Item della lista ticket: la forma pubblica più il conteggio dei repository
 * toccati (righe `ticket_repositories`), utile ai badge di board/lista senza
 * caricare l'elenco completo per ogni ticket.
 */
export const ticketListItemSchema = ticketSchema.extend({
  repositoryCount: z.number().int(),
});

const titleSchema = z.string().min(1).max(300);
const bodyTextSchema = z.string().max(20_000);
const labelsSchema = z.array(z.string().min(1).max(50)).max(20);

const createTicketBodySchema = z.object({
  // Progetto (gruppo) a cui il ticket appartiene: dalla Fase 3 è l'unico legame
  // del ticket con la gerarchia repo (niente repository bersaglio, l'agente
  // sceglie i repo da toccare). Il numero ticket è per-progetto.
  projectId: z.uuid(),
  title: titleSchema,
  body: bodyTextSchema.optional(),
  type: ticketTypeSchema,
  priority: ticketPrioritySchema.default("medium"),
  assigneeId: z.uuid().optional(),
  labels: labelsSchema.optional(),
});

const updateTicketBodySchema = z.object({
  title: titleSchema.optional(),
  body: bodyTextSchema.optional(),
  type: ticketTypeSchema.optional(),
  priority: ticketPrioritySchema.optional(),
  // L'enum Zod è l'arbitro delle transizioni: uno stato fuori lista → 400.
  status: ticketStatusSchema.optional(),
  assigneeId: z.uuid().nullable().optional(),
  // Milestone del ticket; null = nessuna milestone (azzeramento).
  milestoneId: z.uuid().nullable().optional(),
  labels: labelsSchema.optional(),
});

const listTicketsQuerySchema = z.object({
  projectId: z.uuid().optional(),
  status: ticketStatusSchema.optional(),
  // Filtro multi-stato: lista comma-separated di stati (es. "open,triaged").
  // Ogni valore è validato nel handler con ticketStatusSchema (400 se invalido).
  // Mutuamente esclusivo con `status`: se presenti entrambi, vince `statuses`.
  statuses: z.string().optional(),
  type: ticketTypeSchema.optional(),
  priority: ticketPrioritySchema.optional(),
  assigneeId: z.uuid().optional(),
  milestoneId: z.uuid().optional(),
  q: z.string().min(1).max(300).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const listTicketsResponseSchema = z.object({
  items: z.array(ticketListItemSchema),
  nextCursor: z.string().nullable(),
});

const idParamsSchema = z.object({ id: z.uuid() });

/** Params delle route annidate sui link: il ticket e il link coinvolti. */
const linkParamsSchema = z.object({ id: z.uuid(), linkId: z.uuid() });

/** Tipo di relazione canonica memorizzato sul link (gemello dell'enum DB). */
const linkKindSchema = z.enum(ticketLinkKind.enumValues);

const createLinkBodySchema = z.object({
  targetTicketId: z.uuid(),
  kind: linkKindSchema,
});

/** Il link appena creato, come restituito dal POST. */
const ticketLinkSchema = z.object({
  id: z.uuid(),
  sourceTicketId: z.uuid(),
  targetTicketId: z.uuid(),
  kind: linkKindSchema,
  createdAt: z.iso.datetime(),
});

/**
 * Relazione vista dal ticket interrogato: 5 valori. Le kind canoniche
 * (blocks/relates_to/parent) sono il punto di vista del SOURCE; dal lato
 * TARGET si invertono in blocked_by (per blocks) e child (per parent),
 * mentre relates_to è simmetrica.
 */
const relationSchema = z.enum(["blocks", "blocked_by", "relates_to", "parent", "child"]);

/** Un link risolto col ticket "altro", dal punto di vista del ticket `:id`. */
const ticketLinkViewSchema = z.object({
  linkId: z.uuid(),
  relation: relationSchema,
  otherTicketId: z.uuid(),
  otherNumber: z.number().int(),
  otherTitle: z.string(),
  otherStatus: ticketStatusSchema,
  createdAt: z.iso.datetime(),
});

const ticketLinksResponseSchema = z.array(ticketLinkViewSchema);

/** Relazione vista dal SOURCE: coincide con la kind canonica del link. */
function relationFromSource(kind: (typeof ticketLinkKind.enumValues)[number]): z.infer<
  typeof relationSchema
> {
  return kind;
}

/** Relazione vista dal TARGET: inversa di blocks/parent, simmetrica per relates_to. */
function relationFromTarget(
  kind: (typeof ticketLinkKind.enumValues)[number],
): z.infer<typeof relationSchema> {
  switch (kind) {
    case "blocks":
      return "blocked_by";
    case "parent":
      return "child";
    case "relates_to":
      return "relates_to";
  }
}

/**
 * Item del feed unificato di un ticket. Tre forme discriminate su `kind`:
 *  - "comment": un commento (utente/AI/sistema);
 *  - "event": un evento di audit (la colonna `kind` della tabella diventa
 *    `eventKind` qui per non collidere col discriminante del feed);
 *  - "ai_job": un marker del job AI (solo lo stato e l'eventuale PR; log e
 *    consumi restano negli endpoint dedicati).
 * I nomi utente NON vengono risolti qui: si espongono authorId/actorId e la
 * UI li traduce dalla users query che ha già.
 */
const activityCommentSchema = z.object({
  kind: z.literal("comment"),
  id: z.uuid(),
  authorType: z.enum(commentAuthorType.enumValues),
  authorId: z.uuid().nullable(),
  body: z.string(),
  createdAt: z.iso.datetime(),
});

const activityEventSchema = z.object({
  kind: z.literal("event"),
  id: z.uuid(),
  eventKind: z.enum(ticketEventKind.enumValues),
  actorId: z.uuid().nullable(),
  // payload jsonb arbitrario: { from, to }, { changed: true }, … o null.
  payload: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.iso.datetime(),
});

const activityAiJobSchema = z.object({
  kind: z.literal("ai_job"),
  id: z.uuid(),
  status: z.enum(aiJobStatus.enumValues),
  prUrl: z.string().nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});

const activityResponseSchema = z.array(
  z.discriminatedUnion("kind", [
    activityCommentSchema,
    activityEventSchema,
    activityAiJobSchema,
  ]),
);

type ActivityItem = z.infer<typeof activityResponseSchema>[number];

/** Proiezione pubblica della riga ticket: date serializzate in ISO. */
function toPublicTicket(row: Ticket): z.infer<typeof ticketSchema> {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    title: row.title,
    body: row.body,
    type: row.type,
    priority: row.priority,
    status: row.status,
    source: row.source,
    assigneeId: row.assigneeId,
    milestoneId: row.milestoneId,
    effort: row.effort,
    labels: row.labels,
    technicalPayload: row.technicalPayload ?? null,
    occurrences: row.occurrences,
    lastSeenAt: row.lastSeenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Stato PR per-repo di un ticket (Fase 3, fix multi-repo): le righe
 * `ticket_repositories`, joinate su `repositories` per slug/nome, ordinate per
 * data di creazione (deterministica per la UI). Vuoto finché l'agente non ha
 * aperto PR. È l'unico legame ticket↔repo esposto: il ticket appartiene solo al
 * progetto.
 */
async function loadTicketRepositories(
  db: Db,
  ticketId: string,
): Promise<z.infer<typeof ticketRepositorySchema>[]> {
  const rows = await db
    .select({
      repositoryId: ticketRepositories.repositoryId,
      repositorySlug: repositories.slug,
      repositoryName: repositories.name,
      branch: ticketRepositories.branch,
      prUrl: ticketRepositories.prUrl,
      prState: ticketRepositories.prState,
    })
    .from(ticketRepositories)
    .innerJoin(repositories, eq(repositories.id, ticketRepositories.repositoryId))
    .where(eq(ticketRepositories.ticketId, ticketId))
    .orderBy(ticketRepositories.createdAt, ticketRepositories.repositoryId);
  return rows.map((row) => ({
    repositoryId: row.repositoryId,
    repositorySlug: row.repositorySlug,
    repositoryName: row.repositoryName,
    branch: row.branch,
    prUrl: row.prUrl,
    prState: row.prState,
  }));
}

/**
 * Cursore di paginazione decodificato: il timestamp resta la stringa
 * testuale di Postgres (precisione al microsecondo, che un Date JS
 * perderebbe) e viene ricastato a timestamptz solo nella query.
 *
 * NB: gli helper cursor qui sotto sono replicati in backlog.ts — tenere i due
 * file in sync (l'estrazione in shared.ts è rimandata).
 */
interface Cursor {
  createdAt: string;
  id: string;
}

/** Formato testuale di `timestamptz::text` di Postgres. */
const CURSOR_TIMESTAMP_PATTERN = /^\d{4}-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d+)?[+-]\d{2}(:\d{2})?$/;

/**
 * True se i campi del timestamp stanno nei range di un istante reale: il
 * pattern da solo accetterebbe `9999-99-99 99:99:99+00`, che Postgres non
 * sa castare e farebbe esplodere la query in un 500 invece di un 400.
 */
function isPlausibleTimestamp(match: RegExpMatchArray): boolean {
  const month = Number(match[1]);
  const day = Number(match[2]);
  const hour = Number(match[3]);
  const minute = Number(match[4]);
  const second = Number(match[5]);
  return (
    month >= 1 && month <= 12 && day >= 1 && day <= 31 && hour <= 23 && minute <= 59 && second <= 59
  );
}

/** Codifica il cursore opaco: base64url di `createdAt|id`. */
function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, "utf8").toString("base64url");
}

/** Decodifica e valida il cursore. Restituisce null se malformato (→ 400). */
function decodeCursor(raw: string): Cursor | null {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const separator = decoded.lastIndexOf("|");
  if (separator === -1) return null;
  const createdAt = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  const match = CURSOR_TIMESTAMP_PATTERN.exec(createdAt);
  if (!match || !isPlausibleTimestamp(match)) return null;
  if (!z.uuid().safeParse(id).success) return null;
  return { createdAt, id };
}

/** True se l'id corrisponde a un utente esistente (per validare assigneeId). */
async function userExists(db: Db, userId: string): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  return row !== undefined;
}

/** Forma minimale dell'evento da inserire, prima di aggiungere ticketId/actorId. */
type PendingEvent = Pick<typeof ticketEvents.$inferInsert, "kind" | "payload">;

/**
 * True se due liste di label rappresentano lo stesso insieme: l'ordine non
 * conta (riordinare le label in un PATCH non è una modifica reale), ma i
 * duplicati sì — confronto come multiset ordinato.
 */
function sameLabels(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((value, index) => value === sb[index]);
}

/**
 * Diffa i campi richiesti nel PATCH contro la riga corrente e produce un
 * evento `ticket_events` per OGNI campo effettivamente cambiato. I payload
 * restano piccoli: per title/body si segna solo che è cambiato (mai il testo
 * lungo), per gli altri si tiene { from, to }.
 */
function diffTicketEvents(current: Ticket, updates: Partial<Ticket>): PendingEvent[] {
  const events: PendingEvent[] = [];
  if (updates.title !== undefined && updates.title !== current.title) {
    events.push({ kind: "title_changed", payload: { changed: true } });
  }
  if (updates.body !== undefined && updates.body !== current.body) {
    events.push({ kind: "body_changed", payload: { changed: true } });
  }
  if (updates.type !== undefined && updates.type !== current.type) {
    events.push({ kind: "type_changed", payload: { from: current.type, to: updates.type } });
  }
  if (updates.priority !== undefined && updates.priority !== current.priority) {
    events.push({
      kind: "priority_changed",
      payload: { from: current.priority, to: updates.priority },
    });
  }
  if (updates.status !== undefined && updates.status !== current.status) {
    events.push({ kind: "status_changed", payload: { from: current.status, to: updates.status } });
  }
  if (updates.assigneeId !== undefined && updates.assigneeId !== current.assigneeId) {
    events.push({
      kind: "assignee_changed",
      payload: { from: current.assigneeId, to: updates.assigneeId },
    });
  }
  if (updates.labels !== undefined && !sameLabels(updates.labels, current.labels)) {
    events.push({
      kind: "labels_changed",
      payload: { from: current.labels, to: updates.labels },
    });
  }
  if (updates.milestoneId !== undefined && updates.milestoneId !== current.milestoneId) {
    events.push({
      kind: "milestone_changed",
      payload: { from: current.milestoneId, to: updates.milestoneId },
    });
  }
  return events;
}

/**
 * Route dei ticket, registrate sotto /api/tickets. Tutte dietro requireAuth
 * e tutte aperte a qualunque utente autenticato: la gestione dei ticket è
 * il lavoro quotidiano dei member, non un privilegio admin.
 */
/**
 * Risposta di DETTAGLIO di un ticket (la stessa forma di GET /:id): forma
 * pubblica + i campi design/piano (implementationPlan/originContent) + lo stato
 * PR per-repo. Riusata dagli endpoint design/plan così espongono i campi appena
 * scritti esattamente come fa il GET di dettaglio.
 */
async function ticketDetailResponse(
  db: Db,
  row: Ticket,
): Promise<z.infer<typeof ticketDetailSchema>> {
  const repositoriesState = await loadTicketRepositories(db, row.id);
  return {
    ...toPublicTicket(row),
    implementationPlan: row.implementationPlan,
    originContent: row.originContent,
    repositories: repositoriesState,
  };
}

export async function ticketRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/",
    {
      preHandler: requireAuth,
      schema: {
        body: createTicketBodySchema,
        response: { 201: ticketSchema, 400: errorSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { projectId, title, body, type, priority, assigneeId, labels } = request.body;
      if (assigneeId !== undefined && !(await userExists(app.db, assigneeId))) {
        return apiError(reply, 400, "assignee_not_found", "Assignee not found");
      }
      try {
        // Il ticket nasce a livello di PROGETTO (Fase 3): niente repository
        // bersaglio, il numero è per-progetto (row-lock su projects dentro
        // createTicket). L'agente sceglierà da sé i repo da toccare.
        const ticket = await app.db.transaction(async (tx) => {
          const created = await createTicket(tx, {
            projectId,
            title,
            body,
            type,
            priority,
            // Da questa route nascono solo ticket manuali: l'eventuale source
            // nel payload del client viene ignorato dallo schema.
            source: "manual",
            assigneeId,
            labels,
          });
          // Feedback/feature su progetto con backlogEnabled → job intake nel
          // backlog di discovery. La creazione manuale non ha mai accodato
          // aiJobs (l'automazione parte da POST /:id/run-ai): qui si AGGIUNGE
          // solo la deviazione al backlog, atomica col ticket.
          await maybeEnqueueBacklogIntake(tx, created);
          return created;
        });
        return await reply.code(201).send(toPublicTicket(ticket));
      } catch (error) {
        if (error instanceof ProjectNotFoundError) {
          return apiError(reply, 404, "project_not_found", "Project not found");
        }
        // Finestra TOCTOU: l'utente verificato sopra può sparire prima
        // dell'insert; la FK su assignee_id lo segnala a posteriori.
        if (isForeignKeyViolation(error)) {
          return apiError(reply, 400, "assignee_not_found", "Assignee not found");
        }
        throw error;
      }
    },
  );

  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: {
        querystring: listTicketsQuerySchema,
        response: { 200: listTicketsResponseSchema, 400: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { projectId, status, statuses, type, priority, assigneeId, milestoneId, q, cursor, limit } =
        request.query;

      const conditions: SQL[] = [];
      if (projectId) conditions.push(eq(tickets.projectId, projectId));
      // Multi-stato: `statuses` (comma-separated, ogni valore validato) vince
      // sul singolo `status` se presenti entrambi.
      if (statuses !== undefined) {
        const values: TicketStatus[] = [];
        for (const raw of statuses.split(",")) {
          const parsed = ticketStatusSchema.safeParse(raw);
          if (!parsed.success) {
            return apiError(reply, 400, "invalid_statuses", "Invalid status value in statuses");
          }
          values.push(parsed.data);
        }
        // Dedup: evita bind param ripetuti con ?statuses=open,open,...
        conditions.push(inArray(tickets.status, [...new Set(values)]));
      } else if (status) conditions.push(eq(tickets.status, status));
      if (type) conditions.push(eq(tickets.type, type));
      if (priority) conditions.push(eq(tickets.priority, priority));
      if (assigneeId) conditions.push(eq(tickets.assigneeId, assigneeId));
      if (milestoneId) conditions.push(eq(tickets.milestoneId, milestoneId));
      // Ricerca full-text: matcha titolo+body (colonna generata searchTsv) OPPURE
      // il corpo di un commento del ticket. websearch_to_tsquery tollera input
      // utente arbitrario (&, :, !, virgolette) senza errori di sintassi → niente
      // escaping. L'espressione sui commenti è ESATTAMENTE `to_tsvector('english',
      // body)` per usare l'indice GIN espressivo `comments_body_fts_idx`.
      if (q) {
        const tsq = sql`websearch_to_tsquery('english', ${q})`;
        conditions.push(sql`(
          ${tickets.searchTsv} @@ ${tsq}
          OR EXISTS (
            SELECT 1 FROM ${comments} c
            WHERE c.ticket_id = ${tickets.id}
              AND to_tsvector('english', c.body) @@ ${tsq}
          )
        )`);
      }

      if (cursor !== undefined) {
        const decoded = decodeCursor(cursor);
        if (!decoded) {
          return apiError(reply, 400, "invalid_cursor", "Invalid pagination cursor");
        }
        // Confronto di tupla: tutto ciò che viene strettamente "dopo" il
        // cursore nell'ordinamento (createdAt DESC, id DESC).
        conditions.push(
          sql`(${tickets.createdAt}, ${tickets.id}) < (${decoded.createdAt}::timestamptz, ${decoded.id}::uuid)`,
        );
      }

      // `createdAt::text` preserva i microsecondi di Postgres: un Date JS li
      // tronca ai millisecondi e il cursore salterebbe o duplicherebbe righe
      // create nello stesso millisecondo.
      const rows = await app.db
        .select({ ticket: tickets, cursorTimestamp: sql<string>`${tickets.createdAt}::text` })
        .from(tickets)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(tickets.createdAt), desc(tickets.id))
        // Una riga in più del limite: se arriva, esiste una pagina successiva.
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const nextCursor =
        rows.length > limit && last
          ? encodeCursor({ createdAt: last.cursorTimestamp, id: last.ticket.id })
          : null;

      // Conteggio dei repository toccati per ciascun ticket della pagina (righe
      // ticket_repositories), in un'unica query, per i badge di board/lista.
      // Vuoto per i ticket non ancora eseguiti (nessuna riga → count 0).
      const ticketIds = page.map((row) => row.ticket.id);
      const countByTicket = new Map<string, number>();
      if (ticketIds.length > 0) {
        const counts = await app.db
          .select({
            ticketId: ticketRepositories.ticketId,
            count: sql<number>`count(*)::int`,
          })
          .from(ticketRepositories)
          .where(inArray(ticketRepositories.ticketId, ticketIds))
          .groupBy(ticketRepositories.ticketId);
        for (const c of counts) countByTicket.set(c.ticketId, c.count);
      }

      return {
        items: page.map((row) => ({
          ...toPublicTicket(row.ticket),
          repositoryCount: countByTicket.get(row.ticket.id) ?? 0,
        })),
        nextCursor,
      };
    },
  );

  app.get(
    "/:id",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        response: { 200: ticketDetailSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const [row] = await app.db
        .select()
        .from(tickets)
        .where(eq(tickets.id, request.params.id));
      if (!row) return apiError(reply, 404, "ticket_not_found", "Ticket not found");
      // Unica fonte della forma di dettaglio (design/piano + stato PR per-repo,
      // vuoto finché l'agente non apre PR): la stessa risposta prodotta dagli
      // endpoint design/plan (helper condiviso, niente duplicazione).
      return ticketDetailResponse(app.db, row);
    },
  );

  // Feed unificato del ticket: commenti + eventi audit + marker dei job AI,
  // fusi in un unico array ordinato per createdAt ASC. I volumi per-ticket
  // sono piccoli, quindi le tre query separate + merge/sort in memoria sono
  // più semplici (e abbastanza efficienti) di una UNION SQL.
  app.get(
    "/:id/activity",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        response: { 200: activityResponseSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const [ticket] = await app.db.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, id));
      if (!ticket) return apiError(reply, 404, "ticket_not_found", "Ticket not found");

      const [commentRows, eventRows, jobRows] = await Promise.all([
        app.db.select().from(comments).where(eq(comments.ticketId, id)),
        app.db.select().from(ticketEvents).where(eq(ticketEvents.ticketId, id)),
        app.db.select().from(aiJobs).where(eq(aiJobs.ticketId, id)),
      ]);

      const items: ActivityItem[] = [
        ...commentRows.map(
          (row): ActivityItem => ({
            kind: "comment",
            id: row.id,
            authorType: row.authorType,
            authorId: row.authorId,
            body: row.body,
            createdAt: row.createdAt.toISOString(),
          }),
        ),
        ...eventRows.map(
          (row): ActivityItem => ({
            kind: "event",
            id: row.id,
            eventKind: row.kind,
            actorId: row.actorId,
            payload: (row.payload as Record<string, unknown> | null) ?? null,
            createdAt: row.createdAt.toISOString(),
          }),
        ),
        ...jobRows.map(
          (row): ActivityItem => ({
            kind: "ai_job",
            id: row.id,
            status: row.status,
            prUrl: row.prUrl,
            createdAt: row.createdAt.toISOString(),
            finishedAt: row.finishedAt?.toISOString() ?? null,
          }),
        ),
      ];

      // Ordine cronologico crescente. A parità di createdAt si spareggia per
      // id (stabile e deterministico), così i test sull'ordine non dipendono
      // dall'ordine d'arrivo delle tre query.
      items.sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      return items;
    },
  );

  // Relazioni tra ticket: i link che coinvolgono :id come source O target,
  // risolti col ticket "altro" e con la relazione vista da :id (5 valori).
  app.get(
    "/:id/links",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        response: { 200: ticketLinksResponseSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const [ticket] = await app.db.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, id));
      if (!ticket) return apiError(reply, 404, "ticket_not_found", "Ticket not found");

      // Due query speculari (id come source / id come target), ognuna joina la
      // tabella tickets sul ticket "altro" per number/title/status. Il volume
      // per-ticket è piccolo, quindi due select + merge in memoria sono più
      // semplici di una UNION SQL.
      const [asSource, asTarget] = await Promise.all([
        app.db
          .select({
            linkId: ticketLinks.id,
            kind: ticketLinks.kind,
            createdAt: ticketLinks.createdAt,
            otherTicketId: tickets.id,
            otherNumber: tickets.number,
            otherTitle: tickets.title,
            otherStatus: tickets.status,
          })
          .from(ticketLinks)
          .innerJoin(tickets, eq(tickets.id, ticketLinks.targetTicketId))
          .where(eq(ticketLinks.sourceTicketId, id)),
        app.db
          .select({
            linkId: ticketLinks.id,
            kind: ticketLinks.kind,
            createdAt: ticketLinks.createdAt,
            otherTicketId: tickets.id,
            otherNumber: tickets.number,
            otherTitle: tickets.title,
            otherStatus: tickets.status,
          })
          .from(ticketLinks)
          .innerJoin(tickets, eq(tickets.id, ticketLinks.sourceTicketId))
          .where(eq(ticketLinks.targetTicketId, id)),
      ]);

      const items: z.infer<typeof ticketLinkViewSchema>[] = [
        ...asSource.map((row) => ({
          linkId: row.linkId,
          relation: relationFromSource(row.kind),
          otherTicketId: row.otherTicketId,
          otherNumber: row.otherNumber,
          otherTitle: row.otherTitle,
          otherStatus: row.otherStatus,
          createdAt: row.createdAt.toISOString(),
        })),
        ...asTarget.map((row) => ({
          linkId: row.linkId,
          relation: relationFromTarget(row.kind),
          otherTicketId: row.otherTicketId,
          otherNumber: row.otherNumber,
          otherTitle: row.otherTitle,
          otherStatus: row.otherStatus,
          createdAt: row.createdAt.toISOString(),
        })),
      ];
      // Ordine deterministico: cronologico crescente, linkId come spareggio.
      items.sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
        return a.linkId < b.linkId ? -1 : a.linkId > b.linkId ? 1 : 0;
      });
      return items;
    },
  );

  // Crea una relazione source(:id) → target. Valida self-link, cross-project e
  // duplicato; in transazione inserisce il link + DUE eventi (uno per ciascun
  // ticket, con direzione e numero dell'altro nel payload).
  app.post(
    "/:id/links",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        body: createLinkBodySchema,
        response: {
          201: ticketLinkSchema,
          400: errorSchema,
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { targetTicketId, kind } = request.body;

      if (targetTicketId === id) {
        return apiError(reply, 400, "self_link", "Cannot link a ticket to itself");
      }

      const [source] = await app.db
        .select({ id: tickets.id, number: tickets.number, projectId: tickets.projectId })
        .from(tickets)
        .where(eq(tickets.id, id));
      if (!source) return apiError(reply, 404, "ticket_not_found", "Ticket not found");

      const [target] = await app.db
        .select({ id: tickets.id, number: tickets.number, projectId: tickets.projectId })
        .from(tickets)
        .where(eq(tickets.id, targetTicketId));
      if (!target) return apiError(reply, 404, "target_not_found", "Target ticket not found");

      if (source.projectId !== target.projectId) {
        return apiError(reply, 400, "cross_project_link", "Tickets must be in the same project");
      }

      const [existing] = await app.db
        .select({ id: ticketLinks.id })
        .from(ticketLinks)
        .where(
          and(
            eq(ticketLinks.sourceTicketId, id),
            eq(ticketLinks.targetTicketId, targetTicketId),
            eq(ticketLinks.kind, kind),
          ),
        );
      if (existing) return apiError(reply, 409, "link_exists", "Link already exists");

      const actorId = request.user!.id;
      try {
        const link = await app.db.transaction(async (tx) => {
          const [created] = await tx
            .insert(ticketLinks)
            .values({ sourceTicketId: id, targetTicketId, kind })
            .returning();
          await tx.insert(ticketEvents).values([
            {
              ticketId: id,
              actorId,
              kind: "relation_added",
              payload: {
                kind,
                direction: "outgoing",
                otherTicketId: targetTicketId,
                otherNumber: target.number,
              },
            },
            {
              ticketId: targetTicketId,
              actorId,
              kind: "relation_added",
              payload: {
                kind,
                direction: "incoming",
                otherTicketId: id,
                otherNumber: source.number,
              },
            },
          ]);
          return created!;
        });
        return await reply.code(201).send({
          id: link.id,
          sourceTicketId: link.sourceTicketId,
          targetTicketId: link.targetTicketId,
          kind: link.kind,
          createdAt: link.createdAt.toISOString(),
        });
      } catch (error) {
        // Finestra TOCTOU: il duplicato verificato sopra può essere inserito da
        // una richiesta concorrente; l'unique (source, target, kind) lo segnala.
        if (isUniqueViolation(error)) {
          return apiError(reply, 409, "link_exists", "Link already exists");
        }
        throw error;
      }
    },
  );

  // Rimuove un link che coinvolge :id (come source O target). In transazione
  // cancella il link + DUE eventi relation_removed sui due ticket coinvolti.
  app.delete(
    "/:id/links/:linkId",
    {
      preHandler: requireAuth,
      schema: {
        params: linkParamsSchema,
        response: { 204: z.null(), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { id, linkId } = request.params;
      const actorId = request.user!.id;

      const deleted = await app.db.transaction(async (tx) => {
        // Il link deve esistere E coinvolgere :id (source o target): altrimenti
        // 404, così non si possono cancellare link di altri ticket.
        const [link] = await tx
          .select()
          .from(ticketLinks)
          .where(
            and(
              eq(ticketLinks.id, linkId),
              or(eq(ticketLinks.sourceTicketId, id), eq(ticketLinks.targetTicketId, id)),
            ),
          );
        if (!link) return false;

        // Numeri dei due ticket per i payload simmetrici degli eventi.
        const numbers = await tx
          .select({ id: tickets.id, number: tickets.number })
          .from(tickets)
          .where(inArray(tickets.id, [link.sourceTicketId, link.targetTicketId]));
        const numberOf = new Map(numbers.map((r) => [r.id, r.number]));

        await tx.delete(ticketLinks).where(eq(ticketLinks.id, linkId));
        await tx.insert(ticketEvents).values([
          {
            ticketId: link.sourceTicketId,
            actorId,
            kind: "relation_removed",
            payload: {
              kind: link.kind,
              direction: "outgoing",
              otherTicketId: link.targetTicketId,
              otherNumber: numberOf.get(link.targetTicketId) ?? null,
            },
          },
          {
            ticketId: link.targetTicketId,
            actorId,
            kind: "relation_removed",
            payload: {
              kind: link.kind,
              direction: "incoming",
              otherTicketId: link.sourceTicketId,
              otherNumber: numberOf.get(link.sourceTicketId) ?? null,
            },
          },
        ]);
        return true;
      });

      if (!deleted) return apiError(reply, 404, "link_not_found", "Link not found");
      return reply.code(204).send(null);
    },
  );

  app.patch(
    "/:id",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        body: updateTicketBodySchema,
        response: { 200: ticketSchema, 400: errorSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { title, body, type, priority, status, assigneeId, milestoneId, labels } = request.body;
      if (typeof assigneeId === "string" && !(await userExists(app.db, assigneeId))) {
        return apiError(reply, 400, "assignee_not_found", "Assignee not found");
      }

      const updates: Partial<Ticket> = {};
      if (title !== undefined) updates.title = title;
      if (body !== undefined) updates.body = body;
      if (type !== undefined) updates.type = type;
      if (priority !== undefined) updates.priority = priority;
      if (status !== undefined) updates.status = status;
      if (assigneeId !== undefined) updates.assigneeId = assigneeId;
      if (milestoneId !== undefined) updates.milestoneId = milestoneId;
      if (labels !== undefined) updates.labels = labels;

      const id = request.params.id;
      try {
        // Tutto in una transazione: SELECT della riga corrente, validazione
        // della milestone, diff degli eventi, UPDATE e INSERT degli eventi
        // devono essere atomici e consistenti. Una PATCH vuota resta una pura
        // lettura (no update, no eventi); un PATCH che non cambia nulla produce
        // 0 eventi. crossProject segnala una milestone di un altro progetto:
        // si traduce in 400 fuori dalla transazione (così la si annulla).
        let crossProject = false;
        const row = await app.db.transaction(async (tx) => {
          const [current] = await tx.select().from(tickets).where(eq(tickets.id, id));
          if (!current) return null;

          // Una milestone non-null deve esistere ed appartenere allo STESSO
          // progetto del ticket: assegnare ticket a milestone di altri progetti
          // romperebbe l'avanzamento (counts per progetto). Azzerare (null) è
          // sempre lecito.
          if (milestoneId !== undefined && milestoneId !== null) {
            const [ms] = await tx
              .select({ projectId: milestones.projectId })
              .from(milestones)
              .where(eq(milestones.id, milestoneId));
            if (!ms || ms.projectId !== current.projectId) {
              crossProject = true;
              return current;
            }
          }

          if (Object.keys(updates).length === 0) return current;

          const events = diffTicketEvents(current, updates);

          const [updated] = await tx
            .update(tickets)
            .set(updates)
            .where(eq(tickets.id, id))
            .returning();
          // L'id è già stato verificato dalla SELECT in transazione: l'update
          // tocca sempre la riga.
          if (events.length > 0) {
            await tx
              .insert(ticketEvents)
              .values(events.map((event) => ({ ...event, ticketId: id, actorId: request.user!.id })));
          }
          return updated!;
        });
        if (!row) return apiError(reply, 404, "ticket_not_found", "Ticket not found");
        if (crossProject) {
          return apiError(
            reply,
            400,
            "milestone_cross_project",
            "Milestone belongs to a different project",
          );
        }
        return toPublicTicket(row);
      } catch (error) {
        // Finestra TOCTOU: l'utente verificato sopra può sparire prima
        // dell'update; la FK su assignee_id lo segnala a posteriori.
        if (isForeignKeyViolation(error)) {
          return apiError(reply, 400, "assignee_not_found", "Assignee not found");
        }
        throw error;
      }
    },
  );

  // --- Design collegato (body) ---------------------------------------------
  //
  // PUT sostituisce il `body` del ticket con un design fornito dall'esterno
  // (es. dalla skill/MCP che collega un doc a un ticket) PRESERVANDO il corpo
  // originale in `originContent` — una sola volta: se un design è già attivo
  // (`originContent` non null) l'origine NON viene sovrascritta. DELETE ripristina
  // l'origine e azzera `originContent`. Poiché il set/rimozione del design cambia
  // il `body`, si genera un evento `body_changed` di AUDIT con lo stesso
  // meccanismo della PATCH (diffTicketEvents), così il cambio resta tracciato.
  // requireAuth (non admin): collegare un design è lavoro quotidiano. Transazionale
  // con SELECT ... FOR UPDATE: il lock serve al read-modify-write su
  // originContent (preserve-once — l'origine si salva una sola volta leggendo
  // il valore precedente); la PATCH non deriva stato dal valore precedente e
  // non lo richiede.
  app.put(
    "/:id/design",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        body: setContentSchema,
        response: {
          200: ticketDetailSchema,
          400: errorSchema,
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { content } = request.body;

      const result = await app.db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(tickets)
          .where(eq(tickets.id, id))
          .for("update");
        if (!current) return null;
        // Preserva l'origine UNA SOLA VOLTA: se già impostata resta com'è.
        const origin = current.originContent ?? current.body;
        const [updated] = await tx
          .update(tickets)
          .set({ body: content, originContent: origin })
          .where(eq(tickets.id, id))
          .returning();
        // AUDIT: il set del design cambia il `body` → evento body_changed (stesso
        // diff della PATCH). Se il contenuto coincide col corpo attuale, 0 eventi.
        const events = diffTicketEvents(current, { body: content });
        if (events.length > 0) {
          await tx
            .insert(ticketEvents)
            .values(events.map((event) => ({ ...event, ticketId: id, actorId: request.user!.id })));
        }
        return updated!;
      });
      if (!result) return apiError(reply, 404, "ticket_not_found", "Ticket not found");
      return ticketDetailResponse(app.db, result);
    },
  );

  // Rimuove il design collegato: ripristina il `body` da `originContent` e lo
  // azzera. 404 se non c'è alcun design attivo (`originContent` null). Anche il
  // ripristino del `body` produce un evento body_changed di audit.
  app.delete(
    "/:id/design",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        response: {
          200: ticketDetailSchema,
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const result = await app.db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(tickets)
          .where(eq(tickets.id, id))
          .for("update");
        if (!current) return "missing" as const;
        // Nessun design attivo: niente da rimuovere.
        if (current.originContent === null) return "no_design" as const;
        const [updated] = await tx
          .update(tickets)
          .set({ body: current.originContent, originContent: null })
          .where(eq(tickets.id, id))
          .returning();
        const events = diffTicketEvents(current, { body: current.originContent });
        if (events.length > 0) {
          await tx
            .insert(ticketEvents)
            .values(events.map((event) => ({ ...event, ticketId: id, actorId: request.user!.id })));
        }
        return updated!;
      });
      if (result === "missing") return apiError(reply, 404, "ticket_not_found", "Ticket not found");
      if (result === "no_design") {
        return apiError(reply, 404, "no_active_design", "No active design to remove");
      }
      return ticketDetailResponse(app.db, result);
    },
  );

  // --- Piano di implementazione --------------------------------------------
  //
  // PUT imposta `implementationPlan`, DELETE lo azzera. requireAuth (non admin).
  // Il piano è un campo a sé e NON tocca il `body`: nessun evento di audit
  // (diffTicketEvents non contempla i nuovi campi; l'audit resta focalizzato sul
  // cambio di body del design).
  app.put(
    "/:id/plan",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        body: setContentSchema,
        response: {
          200: ticketDetailSchema,
          400: errorSchema,
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { content } = request.body;

      const [row] = await app.db
        .update(tickets)
        .set({ implementationPlan: content })
        .where(eq(tickets.id, id))
        .returning();
      if (!row) return apiError(reply, 404, "ticket_not_found", "Ticket not found");
      return ticketDetailResponse(app.db, row);
    },
  );

  app.delete(
    "/:id/plan",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        response: {
          200: ticketDetailSchema,
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const [row] = await app.db
        .update(tickets)
        .set({ implementationPlan: null })
        .where(eq(tickets.id, id))
        .returning();
      if (!row) return apiError(reply, 404, "ticket_not_found", "Ticket not found");
      return ticketDetailResponse(app.db, row);
    },
  );

  // Avvio manuale dell'AI: rimette in coda l'ultimo job del ticket con il
  // flag manual_trigger, così il worker rifà il triage e, su decisione "fix",
  // procede SCAVALCANDO il gate di automazione (soglia/auto-fix). Se il ticket
  // non ha ancora job, ne crea uno queued+manuale. Aperta a ogni utente
  // autenticato: lanciare il fix è lavoro quotidiano, non un privilegio admin.
  app.post(
    "/:id/run-ai",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        // nullish (non optional): fastify-type-provider-zod passa `null` quando
        // la POST arriva senza corpo, e un `.optional()` puro lo rifiuterebbe.
        body: z.object({ withInstructions: z.boolean().optional() }).nullish(),
        response: { 202: z.object({ jobId: z.uuid() }), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      // withInstructions=true => il worker riprende sul fix scavalcando il
      // triage (resume_mode=fix). Altrimenti si rifà il triage da capo.
      const resume = request.body?.withInstructions ? "fix" : null;
      const [ticket] = await app.db
        .select({ id: tickets.id })
        .from(tickets)
        .where(eq(tickets.id, id));
      if (!ticket) return apiError(reply, 404, "ticket_not_found", "Ticket not found");

      // L'ultimo job del ticket (per createdAt, id come spareggio): è quello
      // che la timeline mostra in cima e che l'utente intende rilanciare.
      const [latest] = await app.db
        .select({ id: aiJobs.id })
        .from(aiJobs)
        .where(eq(aiJobs.ticketId, id))
        .orderBy(desc(aiJobs.createdAt), desc(aiJobs.id))
        .limit(1);

      if (latest) {
        await app.db
          .update(aiJobs)
          .set({
            status: "queued",
            manualTrigger: true,
            resumeMode: resume,
            planText: null,
            startedAt: null,
            finishedAt: null,
            error: null,
            lastActivityAt: sql`now()`,
          })
          .where(eq(aiJobs.id, latest.id));
        return reply.code(202).send({ jobId: latest.id });
      }

      const [created] = await app.db
        .insert(aiJobs)
        .values({ ticketId: id, status: "queued", manualTrigger: true, resumeMode: resume, planText: null })
        .returning({ id: aiJobs.id });
      return reply.code(202).send({ jobId: created!.id });
    },
  );

  // Approvazione del piano: porta l'ultimo job (se in awaiting_plan_approval) a
  // queued con resume_mode="execute", CONSERVANDO planText — è il piano che il
  // worker eseguirà. Azzera started/finished/error e bumpa lastActivityAt.
  app.post(
    "/:id/approve-plan",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        response: {
          202: z.object({ jobId: z.uuid() }),
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      return resumeFromPlanApproval(app.db, request.params.id, "execute", reply);
    },
  );

  // Rifiuto del piano: porta l'ultimo job (se in awaiting_plan_approval) a queued
  // con resume_mode="fix" e planText=null — il worker ri-pianifica incorporando
  // gli eventuali commenti utente. Azzera started/finished/error, bumpa lastActivityAt.
  app.post(
    "/:id/reject-plan",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        response: {
          202: z.object({ jobId: z.uuid() }),
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      return resumeFromPlanApproval(app.db, request.params.id, "fix", reply);
    },
  );
}

/**
 * Logica condivisa di approve/reject del piano. Verifica il ticket (404),
 * individua l'ultimo job e, in una transazione, fa un UPDATE CONDIZIONATO allo
 * stato awaiting_plan_approval: se 0 righe tocca → 409 (nessun piano in attesa,
 * idempotente contro doppi click/race). Altrimenti inserisce il commento system
 * nella stessa transazione e risponde 202. mode="execute" conserva il piano;
 * mode="fix" lo azzera per la ripianificazione.
 */
async function resumeFromPlanApproval(
  db: Db,
  ticketId: string,
  mode: "execute" | "fix",
  reply: FastifyReply,
): Promise<FastifyReply> {
  const [ticket] = await db.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, ticketId));
  if (!ticket) return apiError(reply, 404, "ticket_not_found", "Ticket not found");

  // Si prende l'ultimo job IN STATO awaiting_plan_approval, non l'ultimo job in
  // assoluto: un job più recente in altro stato (es. un re-triage queued)
  // renderebbe altrimenti irraggiungibile un piano genuinamente in attesa (409).
  const [latest] = await db
    .select({ id: aiJobs.id })
    .from(aiJobs)
    .where(and(eq(aiJobs.ticketId, ticketId), eq(aiJobs.status, "awaiting_plan_approval")))
    .orderBy(desc(aiJobs.createdAt), desc(aiJobs.id))
    .limit(1);
  if (!latest) {
    return apiError(reply, 409, "plan_not_pending", "No plan pending approval");
  }

  // planText: conservato in execute (è il piano approvato), azzerato in fix
  // (ripianificazione). L'UPDATE è condizionato allo stato per idempotenza.
  const planTextUpdate = mode === "fix" ? { planText: null } : {};
  const result = await db.transaction(async (tx) => {
    const updated = await tx
      .update(aiJobs)
      .set({
        status: "queued",
        resumeMode: mode,
        ...planTextUpdate,
        startedAt: null,
        finishedAt: null,
        error: null,
        lastActivityAt: sql`now()`,
      })
      .where(and(eq(aiJobs.id, latest.id), eq(aiJobs.status, "awaiting_plan_approval")))
      .returning({ id: aiJobs.id });
    if (updated.length === 0) return null;

    await tx.insert(comments).values({
      ticketId,
      authorType: "system",
      body:
        mode === "execute"
          ? "Piano approvato — esecuzione in corso"
          : "Piano rifiutato — ripianificazione in corso",
    });
    return updated[0]!;
  });

  if (!result) {
    return apiError(reply, 409, "plan_not_pending", "No plan pending approval");
  }
  return reply.code(202).send({ jobId: result.id });
}
