import {
  createOutgoingWebhookSchema,
  OUTGOING_WEBHOOK_EVENT_IDS,
  outgoingWebhookPreviewSchema,
  outgoingWebhookTestResultSchema,
  outgoingWebhookViewSchema,
  outgoingWebhookWithSecretSchema,
  updateOutgoingWebhookSchema,
  webhookFormatSchema,
} from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createWebhook, deleteWebhook, listWebhooks, previewWebhook, rotateWebhookSecret, testWebhook, updateWebhook } from "../services/outgoing-webhooks.js";
import { roleRuleErrorSchema, sendRoleRuleError } from "./roles.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Area 9, F3 (D-10 = b, H-1 = a): i webhook in uscita, sotto
 * `/api/settings/webhooks`, per chi gestisce le integrazioni dell'istanza.
 * Le regole: `services/outgoing-webhooks.ts`.
 */
const MANAGE = { kind: "instance", permission: "integrations.manage" } as const;
const idParams = z.object({ id: z.uuid() });

export async function outgoingWebhookRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const guard = async <T>(reply: Parameters<typeof sendRoleRuleError>[0], run: () => Promise<T>) => {
    try {
      return await run();
    } catch (error) {
      return sendRoleRuleError(reply, error);
    }
  };

  app.get("/", { config: { access: MANAGE }, schema: { response: { 200: z.array(outgoingWebhookViewSchema), ...authErrorResponses } } }, async () => listWebhooks(app.db));

  // Letterale PRIMA delle parametriche (trappola di routing in CLAUDE.md).
  app.get(
    "/preview",
    {
      config: { access: MANAGE },
      schema: {
        querystring: z.object({ format: webhookFormatSchema, event: z.enum(OUTGOING_WEBHOOK_EVENT_IDS) }),
        response: { 200: outgoingWebhookPreviewSchema, 422: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => guard(reply, () => previewWebhook(app.db, request.query.format, request.query.event, app.publicUrl)),
  );

  app.post(
    "/",
    {
      config: { access: MANAGE, reauth: true },
      schema: { body: createOutgoingWebhookSchema, response: { 201: outgoingWebhookWithSecretSchema, 409: roleRuleErrorSchema, ...authErrorResponses } },
    },
    async (request, reply) =>
      guard(reply, async () => reply.code(201).send(await createWebhook(app.db, app.encryptionKey, request.user!, request.body))),
  );

  app.patch(
    "/:id",
    {
      config: { access: MANAGE },
      schema: { params: idParams, body: updateOutgoingWebhookSchema, response: { 200: outgoingWebhookViewSchema, 404: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => guard(reply, () => updateWebhook(app.db, request.user!, request.params.id, request.body)),
  );

  app.post(
    "/:id/secret",
    {
      config: { access: MANAGE, reauth: true },
      schema: { params: idParams, response: { 200: outgoingWebhookWithSecretSchema, 404: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => guard(reply, () => rotateWebhookSecret(app.db, app.encryptionKey, request.user!, request.params.id)),
  );

  app.delete(
    "/:id",
    {
      config: { access: MANAGE, reauth: true },
      schema: { params: idParams, response: { 204: z.null(), 404: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) =>
      guard(reply, async () => {
        await deleteWebhook(app.db, request.user!, request.params.id);
        return reply.code(204).send(null);
      }),
  );

  app.post(
    "/:id/test",
    {
      config: { access: MANAGE },
      schema: { params: idParams, response: { 200: outgoingWebhookTestResultSchema, 404: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => guard(reply, () => testWebhook(app.db, app.encryptionKey, request.params.id, app.publicUrl)),
  );
}
