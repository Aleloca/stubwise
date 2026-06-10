import {
  ticketPrioritySchema,
  ticketSourceSchema,
  ticketStatusSchema,
  ticketTypeSchema,
} from "@stubwise/shared";
import { and, desc, eq, ilike, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import type { Db } from "@stubwise/db";
import { tickets, users } from "@stubwise/db";
import { createTicket, ProjectNotFoundError, type Ticket } from "../db/tickets.js";
import { authErrorResponses, errorSchema, isForeignKeyViolation } from "./shared.js";

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
  labels: z.array(z.string()),
  technicalPayload: z.unknown().nullable(),
  occurrences: z.number().int(),
  lastSeenAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const titleSchema = z.string().min(1).max(300);
const bodyTextSchema = z.string().max(20_000);
const labelsSchema = z.array(z.string().min(1).max(50)).max(20);

const createTicketBodySchema = z.object({
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
  labels: labelsSchema.optional(),
});

const listTicketsQuerySchema = z.object({
  projectId: z.uuid().optional(),
  status: ticketStatusSchema.optional(),
  type: ticketTypeSchema.optional(),
  priority: ticketPrioritySchema.optional(),
  assigneeId: z.uuid().optional(),
  q: z.string().min(1).max(300).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const listTicketsResponseSchema = z.object({
  items: z.array(ticketSchema),
  nextCursor: z.string().nullable(),
});

const idParamsSchema = z.object({ id: z.uuid() });

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
    labels: row.labels,
    technicalPayload: row.technicalPayload ?? null,
    occurrences: row.occurrences,
    lastSeenAt: row.lastSeenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Cursore di paginazione decodificato: il timestamp resta la stringa
 * testuale di Postgres (precisione al microsecondo, che un Date JS
 * perderebbe) e viene ricastato a timestamptz solo nella query.
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

/** Neutralizza i caratteri jolly di LIKE/ILIKE nel termine di ricerca. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** True se l'id corrisponde a un utente esistente (per validare assigneeId). */
async function userExists(db: Db, userId: string): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  return row !== undefined;
}

/**
 * Route dei ticket, registrate sotto /api/tickets. Tutte dietro requireAuth
 * e tutte aperte a qualunque utente autenticato: la gestione dei ticket è
 * il lavoro quotidiano dei member, non un privilegio admin.
 */
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
        return reply.code(400).send({ message: "Assegnatario inesistente" });
      }
      try {
        const ticket = await createTicket(app.db, {
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
        return await reply.code(201).send(toPublicTicket(ticket));
      } catch (error) {
        if (error instanceof ProjectNotFoundError) {
          return reply.code(404).send({ message: "Progetto non trovato" });
        }
        // Finestra TOCTOU: l'utente verificato sopra può sparire prima
        // dell'insert; la FK su assignee_id lo segnala a posteriori.
        if (isForeignKeyViolation(error)) {
          return reply.code(400).send({ message: "Assegnatario inesistente" });
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
      const { projectId, status, type, priority, assigneeId, q, cursor, limit } = request.query;

      const conditions: SQL[] = [];
      if (projectId) conditions.push(eq(tickets.projectId, projectId));
      if (status) conditions.push(eq(tickets.status, status));
      if (type) conditions.push(eq(tickets.type, type));
      if (priority) conditions.push(eq(tickets.priority, priority));
      if (assigneeId) conditions.push(eq(tickets.assigneeId, assigneeId));
      if (q) conditions.push(ilike(tickets.title, `%${escapeLike(q)}%`));

      if (cursor !== undefined) {
        const decoded = decodeCursor(cursor);
        if (!decoded) {
          return reply.code(400).send({ message: "Cursore di paginazione non valido" });
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
      return { items: page.map((row) => toPublicTicket(row.ticket)), nextCursor };
    },
  );

  app.get(
    "/:id",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        response: { 200: ticketSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const [row] = await app.db
        .select()
        .from(tickets)
        .where(eq(tickets.id, request.params.id));
      if (!row) return reply.code(404).send({ message: "Ticket non trovato" });
      return toPublicTicket(row);
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
      const { title, body, type, priority, status, assigneeId, labels } = request.body;
      if (typeof assigneeId === "string" && !(await userExists(app.db, assigneeId))) {
        return reply.code(400).send({ message: "Assegnatario inesistente" });
      }

      const updates: Partial<Ticket> = {};
      if (title !== undefined) updates.title = title;
      if (body !== undefined) updates.body = body;
      if (type !== undefined) updates.type = type;
      if (priority !== undefined) updates.priority = priority;
      if (status !== undefined) updates.status = status;
      if (assigneeId !== undefined) updates.assigneeId = assigneeId;
      if (labels !== undefined) updates.labels = labels;

      // Drizzle rifiuta un update senza colonne: una PATCH vuota è una
      // lettura, si risponde con lo stato corrente.
      try {
        const [row] =
          Object.keys(updates).length === 0
            ? await app.db.select().from(tickets).where(eq(tickets.id, request.params.id))
            : await app.db
                .update(tickets)
                .set(updates)
                .where(eq(tickets.id, request.params.id))
                .returning();
        if (!row) return reply.code(404).send({ message: "Ticket non trovato" });
        return toPublicTicket(row);
      } catch (error) {
        // Finestra TOCTOU: l'utente verificato sopra può sparire prima
        // dell'update; la FK su assignee_id lo segnala a posteriori.
        if (isForeignKeyViolation(error)) {
          return reply.code(400).send({ message: "Assegnatario inesistente" });
        }
        throw error;
      }
    },
  );
}
