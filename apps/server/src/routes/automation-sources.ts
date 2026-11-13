import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { RateLimitOptions } from "@fastify/rate-limit";
import { z } from "zod";
import { AutomationError, type Viewer } from "../automations/model.js";
import { receiveWebhook, IDEMPOTENCY_KEY_MAX } from "../automations/inbound-hook.js";
import {
  createWebhookSource,
  listClientLinks,
  listClientSuggestions,
  listSourceEvents,
  listSources,
  previewWebhookExample,
  putClientLink,
  regenerateWebhook,
  removeClientLink,
  renameSource,
  setWebhookExample,
  updateWebhookField,
} from "../automations/sources.js";
import { EXAMPLE_MAX_BYTES } from "../automations/sources.js";

/**
 * LE SORGENTI DELLE AUTOMATIONS E LA TABELLA CLIENTE → PROGETTO (area 7, F4,
 * S4). Scrivere vuole `integrations.manage` d'istanza (`config.access`, e il
 * servizio lo ricontrolla); leggere sorgenti e tabella chi può costruire
 * un'automazione; gli eventi recenti solo `integrations.manage` (F4-6). Il
 * segreto di un webhook esce SOLO dalla creazione e dalla rigenerazione
 * (`WebhookSourceCreated.address`).
 */

const USER = { kind: "user" } as const;
const INTEGRATIONS = { kind: "instance", permission: "integrations.manage" } as const;
const idParams = z.object({ id: z.uuid() });
const fieldTypeSchema = z.enum(["text", "number", "date", "email", "person", "list", "file", "boolean"]);

async function handle<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AutomationError) return reply.code(error.status).send({ code: error.code, message: error.message, ...error.extra });
    throw error;
  }
}

/** L'URL pubblico dell'istanza, se configurato (i test e le istanze senza `PUBLIC_URL` danno un indirizzo relativo). */
function publicUrlOf(app: FastifyInstance): string | null {
  try {
    return app.publicUrl;
  } catch {
    return null;
  }
}

export async function automationSourceRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const me = (request: { user?: Viewer | null }) => request.user!;

  app.get("/automation-sources", { config: { access: USER } }, async (request, reply) => handle(reply, async () => ({ items: await listSources(app.db, me(request)) })));
  app.post(
    "/automation-sources",
    { config: { access: INTEGRATIONS }, schema: { body: z.object({ name: z.string().max(200) }) } },
    async (request, reply) => handle(reply, async () => reply.code(201).send(await createWebhookSource(app.db, me(request), publicUrlOf(instance), request.body))),
  );
  app.patch(
    "/automation-sources/:id",
    { config: { access: INTEGRATIONS }, schema: { params: idParams, body: z.object({ name: z.string().max(200) }) } },
    async (request, reply) => handle(reply, () => renameSource(app.db, me(request), request.params.id, request.body)),
  );
  app.post("/automation-sources/:id/regenerate", { config: { access: INTEGRATIONS }, schema: { params: idParams } }, async (request, reply) =>
    handle(reply, () => regenerateWebhook(app.db, me(request), publicUrlOf(instance), request.params.id)),
  );
  const exampleBody = z.object({ json: z.string().max(EXAMPLE_MAX_BYTES) });
  app.post(
    "/automation-sources/:id/example/preview",
    { config: { access: INTEGRATIONS }, schema: { params: idParams, body: exampleBody } },
    async (request, reply) => handle(reply, () => previewWebhookExample(app.db, me(request), request.params.id, request.body.json)),
  );
  app.put(
    "/automation-sources/:id/example",
    { config: { access: INTEGRATIONS }, schema: { params: idParams, body: exampleBody } },
    async (request, reply) => handle(reply, () => setWebhookExample(app.db, me(request), request.params.id, request.body.json)),
  );
  app.patch(
    "/automation-sources/:id/fields/:key",
    {
      config: { access: INTEGRATIONS },
      schema: { params: idParams.extend({ key: z.string().min(1).max(400) }), body: z.object({ label: z.string().max(200).optional(), type: fieldTypeSchema.optional() }) },
    },
    async (request, reply) => handle(reply, () => updateWebhookField(app.db, me(request), request.params.id, request.params.key, request.body)),
  );
  app.get("/automation-sources/:id/events", { config: { access: INTEGRATIONS }, schema: { params: idParams } }, async (request, reply) =>
    handle(reply, async () => ({ items: await listSourceEvents(app.db, me(request), request.params.id) })),
  );

  // La tabella cliente → progetto. Le rotte letterali prima di `/:key` (la trappola di routing di CLAUDE.md).
  app.get("/client-links", { config: { access: USER } }, async (request, reply) => handle(reply, async () => ({ items: await listClientLinks(app.db, me(request)) })));
  app.get("/client-links/suggestions", { config: { access: INTEGRATIONS } }, async (request, reply) =>
    handle(reply, async () => ({ items: await listClientSuggestions(app.db, me(request)) })),
  );
  const keyParams = z.object({ key: z.string().min(1).max(200) });
  app.put(
    "/client-links/:key",
    { config: { access: INTEGRATIONS }, schema: { params: keyParams, body: z.object({ clientName: z.string().max(200), projectId: z.uuid() }) } },
    async (request, reply) => handle(reply, () => putClientLink(app.db, me(request), request.params.key, request.body)),
  );
  app.delete("/client-links/:key", { config: { access: INTEGRATIONS }, schema: { params: keyParams } }, async (request, reply) =>
    handle(reply, async () => {
      await removeClientLink(app.db, me(request), request.params.key);
      return reply.code(204).send();
    }),
  );
}

/** Il tetto del corpo di un evento (F4-3 = a): oltre, 413 da Fastify. */
export const WEBHOOK_BODY_MAX_BYTES = 256 * 1024;

/**
 * La rotta PUBBLICA del webhook in arrivo (F4, S3): fuori da `/api`, senza
 * sessione, sotto `/webhooks` come quella dei provider git (caddy la inoltra
 * già: nessuna riga nuova nel Caddyfile). Il corpo arriva com'è (testo, di
 * qualunque tipo), così un JSON rotto diventa un 422 registrato fra gli
 * eventi recenti invece di un 400 del parser. In più del tetto per indirizzo
 * (nel servizio, in Postgres) c'è un freno grezzo per IP (`rateLimit`).
 */
export async function automationHookRoutes(instance: FastifyInstance, opts: { rateLimit?: RateLimitOptions } = {}): Promise<void> {
  instance.removeAllContentTypeParsers();
  instance.addContentTypeParser("*", { parseAs: "string", bodyLimit: WEBHOOK_BODY_MAX_BYTES }, (_request, body, done) => done(null, body));
  instance.post<{ Params: { secret: string } }>(
    "/in/:secret",
    {
      bodyLimit: WEBHOOK_BODY_MAX_BYTES,
      config: { access: { kind: "public" }, rateLimit: opts.rateLimit ?? { max: 1200, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const header = request.headers["idempotency-key"];
      const idempotencyKey = typeof header === "string" && header.length <= IDEMPOTENCY_KEY_MAX ? header : undefined;
      const out = await receiveWebhook(instance.db, { secret: request.params.secret, body: typeof request.body === "string" ? request.body : "", idempotencyKey });
      switch (out.status) {
        case 202:
          return reply.code(202).send({ accepted: true, duplicate: out.duplicate });
        case 404:
          return reply.code(404).send({ code: "not_found", message: "Not found" });
        case 422:
          return reply.code(422).send({ code: "invalid_event", message: "The event doesn't match the source's fields", reason: out.reason });
        case 429:
          return reply.code(429).send({ code: "rate_limited", message: "Too many events for this address", window: out.window });
      }
    },
  );
}
