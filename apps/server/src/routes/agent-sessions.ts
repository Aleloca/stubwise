import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  agentSessionDetailSchema,
  agentSessionEventPageSchema,
  agentSessionListQuerySchema,
  agentSessionListSchema,
  sendAgentMessageInputSchema,
  sendAgentMessageResultSchema,
  type AgentSessionDetail,
} from "@stubwise/shared";
import { requireAdmin, requireAuth } from "../auth/session.js";
import { apiError } from "../errors.js";
import {
  getAgentSession,
  listAgentSessionEvents,
  listAgentSessions,
  sendAgentMessage,
} from "../services/agent-sessions.js";
import { authErrorResponses, errorSchema } from "./shared.js";

const idParams = z.object({ id: z.uuid() });
const cursor = z.string().regex(/^\d+$/);

/** Pagina di eventi letta a ogni giro dello stream. */
const STREAM_PAGE = 200;
/** Rete di sicurezza: una NOTIFY persa (LISTEN caduta) non ferma lo stream. */
const STREAM_POLL_MS = 5000;
const STREAM_PING_MS = 25_000;

type StreamMessage =
  | { type: "events"; events: unknown[] }
  | { type: "partial"; segmentId: string; text: string }
  | { type: "session"; detail: AgentSessionDetail };

export async function agentSessionRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: {
        querystring: agentSessionListQuerySchema,
        response: { 200: agentSessionListSchema, ...authErrorResponses },
      },
    },
    async (request) => listAgentSessions(app.db, request.user!, request.query),
  );

  // Rotte con una parte letterale PRIMA di `GET /:id` (trappola di routing).
  app.get(
    "/:id/events",
    {
      preHandler: requireAuth,
      schema: {
        params: idParams,
        querystring: z.object({
          after: cursor.optional(),
          before: cursor.optional(),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        }),
        response: { 200: agentSessionEventPageSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const page = await listAgentSessionEvents(
        app.db,
        request.user!,
        request.params.id,
        request.query,
      );
      if (!page) return apiError(reply, 404, "not_found", "Session not found");
      return page;
    },
  );

  app.post(
    "/:id/messages",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParams,
        body: sendAgentMessageInputSchema,
        response: {
          202: sendAgentMessageResultSchema,
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await sendAgentMessage(app.db, {
        sessionId: request.params.id,
        actor: request.user!,
        text: request.body.text,
        interrupt: request.body.interrupt,
      });
      if (result.ok) return reply.code(202).send({ inputId: result.inputId, status: "pending" });
      switch (result.error) {
        case "forbidden":
          return apiError(reply, 403, "forbidden", "Administrators only");
        case "not_found":
          return apiError(reply, 404, "not_found", "Session not found");
        case "session_ended":
          return apiError(reply, 409, "session_ended", "The session is not running");
        case "not_interactive":
          return apiError(reply, 409, "not_interactive", "This step does not accept messages");
        case "interrupt_unsupported":
          return apiError(
            reply,
            409,
            "interrupt_unsupported",
            "This session cannot be interrupted",
          );
      }
    },
  );

  /**
   * Stream dal vivo (design §5.3). Ogni messaggio inoltrato passa dal filtro di
   * visibilità di chi guarda: eventi e dettaglio si rileggono dal DB con le
   * funzioni di lettura (che applicano `visibleTo`), mai dal payload della
   * NOTIFY; i parziali, l'unico contenuto che viaggia nel payload, passano
   * solo finché l'ultima rilettura ha confermato che la sessione è visibile, e
   * se non lo è più lo stream si chiude.
   */
  app.get(
    "/:id/stream",
    {
      preHandler: requireAuth,
      schema: { params: idParams, querystring: z.object({ after: cursor.optional() }) },
    },
    async (request, reply) => {
      const viewer = request.user!;
      const id = request.params.id;
      // Errori PRIMA del hijack, in JSON: la posta altrui è 404 e nessuno stream si apre.
      const initial = await getAgentSession(app.db, viewer, id);
      if (!initial) return apiError(reply, 404, "not_found", "Session not found");

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      let closed = false;
      let visible = true;
      const send = (message: StreamMessage) => {
        if (!closed) reply.raw.write(`data: ${JSON.stringify(message)}\n\n`);
      };
      let cursorId = request.query.after;
      let reading = false;
      // Una notifica arrivata MENTRE si legge non va persa (preflight L11):
      // segna il flusso «sporco» e il ciclo rilegge prima di uscire.
      let dirty = false;
      let unsubscribe: () => void = () => undefined;
      const timers: NodeJS.Timeout[] = [];

      const close = () => {
        if (closed) return;
        closed = true;
        for (const timer of timers) clearInterval(timer);
        unsubscribe();
        reply.raw.end();
      };

      const pump = async () => {
        if (closed) return;
        if (reading) {
          dirty = true;
          return;
        }
        reading = true;
        try {
          do {
            dirty = false;
            for (;;) {
              const page = await listAgentSessionEvents(app.db, viewer, id, {
                ...(cursorId ? { after: cursorId } : {}),
                limit: STREAM_PAGE,
              });
              if (!page) break;
              if (page.events.length === 0) break;
              cursorId = page.events[page.events.length - 1]!.id;
              send({ type: "events", events: page.events });
              if (page.events.length < STREAM_PAGE) break;
            }
            // Dettaglio intero: stato, canWrite, domande e `inputs` (H4).
            const detail = await getAgentSession(app.db, viewer, id);
            if (!detail) {
              // Non più visibile (o potata): niente più messaggi, parziali compresi.
              visible = false;
              close();
              return;
            }
            send({ type: "session", detail });
          } while (dirty && !closed);
        } catch (error) {
          request.log.warn({ err: error }, "agent session stream: lettura fallita");
        } finally {
          reading = false;
        }
      };

      reply.raw.on("close", close);
      send({ type: "session", detail: initial });
      // Sottoscrizione PRIMA della prima lettura: una notifica che arriva
      // durante quella lettura alza il flag sporco invece di andare persa.
      unsubscribe = app.agentSessionBus.subscribe(id, (m) => {
        if (m.sessionId !== id) return;
        if (m.kind === "partial") {
          // `visible` è l'esito dell'ULTIMA rilettura (pump: al più ogni
          // STREAM_POLL_MS o alla prossima notifica degli eventi), non una
          // verifica per parziale. Regge solo perché la visibilità di una
          // sessione non cambia: `mailbox_owner_user_id` si scrive una volta
          // alla creazione (`ensureAgentSession` in conflitto aggiorna solo il
          // titolo) e nessun ruolo allarga la visibilità della posta. Chi
          // rendesse mutabile quella colonna (o la visibilità in generale)
          // deve ricontrollarla qui, a ogni parziale.
          if (visible) send({ type: "partial", segmentId: m.segmentId, text: m.text });
        } else void pump();
      });
      if (closed) {
        unsubscribe();
        return;
      }
      timers.push(
        setInterval(() => void pump(), STREAM_POLL_MS),
        setInterval(() => {
          if (!closed) reply.raw.write(": ping\n\n");
        }, STREAM_PING_MS),
      );
      await pump();
    },
  );

  app.get(
    "/:id",
    {
      preHandler: requireAuth,
      schema: {
        params: idParams,
        response: { 200: agentSessionDetailSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const detail = await getAgentSession(app.db, request.user!, request.params.id);
      if (!detail) return apiError(reply, 404, "not_found", "Session not found");
      return detail;
    },
  );
}
