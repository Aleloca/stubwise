import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { emailChangeStatusSchema } from "@stubwise/shared";
import { z } from "zod";
import { apiError } from "../errors.js";
import { cancelEmailChange, EmailChangeError, emailChangeStatus, requestEmailChange } from "../services/email-change.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Area 9, F1 (D-13, E-1 = a): il cambio della PROPRIA email di login, sotto
 * `/api/me/email-change`. La conferma (pubblica) sta in `routes/auth.ts`, col
 * tetto dei tentativi del login; il cambio fatto da un admin in `routes/users.ts`.
 * Le regole: `services/email-change.ts`, docs/invariants/identity.md.
 */


export function sendEmailChangeError(reply: FastifyReply, error: unknown): FastifyReply {
  if (!(error instanceof EmailChangeError)) throw error;
  return apiError(reply, error.status, error.code, error.message);
}

export async function meEmailChangeRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/email-change",
    { config: { access: { kind: "user" } }, schema: { response: { 200: emailChangeStatusSchema, ...authErrorResponses } } },
    async (request) => emailChangeStatus(app.db, app.mailTransport, request.user!.id),
  );

  app.post(
    "/email-change",
    {
      config: { access: { kind: "user" }, reauth: true },
      schema: {
        body: z.object({ newEmail: z.email().max(320) }),
        response: { 202: emailChangeStatusSchema, ...authErrorResponses, 409: errorSchema, 502: errorSchema },
      },
    },
    async (request, reply) => {
      try {
        const status = await requestEmailChange(app.db, app.mailTransport, app.publicUrl, request.user!, request.body.newEmail);
        return reply.code(202).send(status);
      } catch (error) {
        return sendEmailChangeError(reply, error);
      }
    },
  );

  app.delete(
    "/email-change",
    { config: { access: { kind: "user" } }, schema: { response: { 204: z.null(), ...authErrorResponses } } },
    async (request, reply) => {
      await cancelEmailChange(app.db, request.user!.id);
      return reply.code(204).send(null);
    },
  );
}
