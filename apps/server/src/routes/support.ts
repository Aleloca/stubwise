import { SUPPORT_STATE_ORDER } from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  getSupportConversation,
  listSupportConversations,
  listWaitingCustomers,
  supportCustomerPreview,
  SupportError,
} from "../services/support.js";

/**
 * Support (area 8, F3): le conversazioni coi clienti per i membri. I permessi
 * li valuta il servizio (un progetto invisibile è 404, come una conversazione
 * che non esiste; `support.reply` per rispondere); le rotte dichiarano
 * `user`, come quelle dei rilasci.
 */
export async function supportRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const handle = async <T>(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof SupportError) return reply.code(error.status).send({ code: error.code, message: error.message });
      throw error;
    }
  };
  const codeParams = z.object({ code: z.string().min(1).max(40) });

  app.get(
    "/projects/:projectId/support/conversations",
    {
      config: { access: { kind: "user" } },
      schema: {
        params: z.object({ projectId: z.uuid() }),
        querystring: z.object({ state: z.enum(SUPPORT_STATE_ORDER as [string, ...string[]]).optional() }),
      },
    },
    async (request, reply) =>
      handle(reply, async () => ({
        items: await listSupportConversations(app.db, request.user!, request.params.projectId, { ...(request.query.state ? { state: request.query.state } : {}) }),
      })),
  );
  app.get("/me/waiting-customers", { config: { access: { kind: "user" } } }, async (request) => ({
    items: await listWaitingCustomers(app.db, request.user!),
  }));
  // Le rotte letterali (`/preview`) prima delle altre sullo stesso prefisso.
  app.get("/support/conversations/by-code/:code/preview", { config: { access: { kind: "user" } }, schema: { params: codeParams } }, async (request, reply) =>
    handle(reply, () => supportCustomerPreview(app.db, request.user!, request.params.code)),
  );
  app.get("/support/conversations/by-code/:code", { config: { access: { kind: "user" } }, schema: { params: codeParams } }, async (request, reply) =>
    handle(reply, () => getSupportConversation(app.db, request.user!, request.params.code)),
  );
}
