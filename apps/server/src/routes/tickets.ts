import {
  ticketPrioritySchema,
  ticketSourceSchema,
  ticketStatusSchema,
  ticketTypeSchema,
} from "@stubwise/shared";
import { and, desc, eq, ilike, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import type { Db } from "@stubwise/db";
import { aiJobs, comments, tickets, users } from "@stubwise/db";
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
  // Stima di sforzo 1–5 del triage AI; null finché il ticket non è triagiato.
  effort: z.number().int().min(1).max(5).nullable(),
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
      if (!ticket) return reply.code(404).send({ message: "Ticket non trovato" });

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
  if (!ticket) return reply.code(404).send({ message: "Ticket non trovato" });

  const [latest] = await db
    .select({ id: aiJobs.id })
    .from(aiJobs)
    .where(eq(aiJobs.ticketId, ticketId))
    .orderBy(desc(aiJobs.createdAt), desc(aiJobs.id))
    .limit(1);
  if (!latest) {
    return reply.code(409).send({ message: "Nessun piano in attesa di approvazione" });
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
    return reply.code(409).send({ message: "Nessun piano in attesa di approvazione" });
  }
  return reply.code(202).send({ jobId: result.id });
}
