import fastifyCors from "@fastify/cors";
import { widgetSettingsSchema } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { projects, widgetSettings } from "@stubwise/db";
import { keysMatch } from "../ingest/shared.js";
import { errorSchema } from "./shared.js";
import type { RateLimitConfig } from "./shared.js";
import { apiError } from "../errors.js";

export interface WidgetRoutesOptions {
  /** Limite di richieste per chiave del progetto (default 300/min). */
  rateLimit: RateLimitConfig;
}

/**
 * Superficie PUBBLICA cross-origin del widget di assistenza: GET/POST
 * /widget/:slug/*. È embeddata nei siti dei clienti, quindi CORS è aperto e
 * registrato QUI, dentro lo scope incapsulato del plugin (le altre route non
 * ricevono header CORS).
 *
 * Autenticazione: header X-Stubwise-Key confrontato (tempo costante) con la
 * ingestionKey del progetto individuato dallo slug. La chiave è visibile nel
 * sorgente della pagina ospite, per design (stesso modello dell'ingestion SDK):
 * autentica il progetto, non l'utente. Slug sconosciuto e chiave errata
 * producono la stessa 401 (niente enumerazione degli slug). Il controllo sta in
 * preValidation, condiviso da tutte le route del plugin (config e — nei task
 * successivi — conversazioni, messaggi, ticket): una richiesta non autenticata
 * riceve 401 anche con payload malformato.
 *
 * Validazione: come l'ingestion, un payload non valido risponde 422 (contratto
 * col client widget), via schemaErrorFormatter per-route.
 */
export async function widgetRoutes(
  instance: FastifyInstance,
  opts: WidgetRoutesOptions,
): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // CORS solo su questo scope: origin aperto (la chiave è l'autenticazione),
  // GET+POST e i due header che il widget invia. Gestisce anche la preflight OPTIONS.
  await app.register(fastifyCors, {
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["content-type", "x-stubwise-key"],
  });

  /**
   * preValidation condivisa da tutte le route del plugin: autentica il progetto
   * dallo slug + X-Stubwise-Key (tempo costante) e decora request.widgetProject.
   * Ramo unico di rifiuto: header assente, slug sconosciuto e chiave errata sono
   * indistinguibili dal client.
   */
  const authenticateWidget = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const provided = request.headers["x-stubwise-key"];
    const { slug } = request.params as { slug: string };
    const [project] = await app.db
      .select({
        id: projects.id,
        name: projects.name,
        ingestionKey: projects.ingestionKey,
      })
      .from(projects)
      .where(eq(projects.slug, slug));
    if (
      typeof provided !== "string" ||
      !project ||
      !keysMatch(provided, project.ingestionKey)
    ) {
      await apiError(reply, 401, "invalid_ingestion_key", "Invalid ingestion key");
      return;
    }
    request.widgetProject = { id: project.id, name: project.name };
  };

  // Bucket per chiave del progetto (fallback IP per le richieste senza header):
  // un progetto loquace non consuma il budget degli altri. Riusato da tutte le
  // route del plugin.
  const rateLimit = {
    ...opts.rateLimit,
    keyGenerator: (request: FastifyRequest) =>
      (request.headers["x-stubwise-key"] as string | undefined) ?? request.ip,
  };

  const configResponseSchema = z.union([
    z.object({ enabled: z.literal(false) }),
    z.object({
      enabled: z.literal(true),
      title: z.string(),
      welcomeMessage: z.string(),
      accentColor: z.string(),
      language: widgetSettingsSchema.shape.language,
      chatEnabled: z.boolean(),
    }),
  ]);

  app.get(
    "/:slug/config",
    {
      config: { rateLimit },
      preValidation: authenticateWidget,
      schema: {
        params: z.object({ slug: z.string().min(1) }),
        response: {
          200: configResponseSchema,
          401: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const project = request.widgetProject!;
      // Superficie pubblica: mai 500 su un errore interno (badge di caricamento
      // rotto nel sito del cliente). La config è per-richiesta e riflette lo stato
      // dei settings/provider al momento: niente cache lato browser/proxy.
      reply.header("cache-control", "no-store");

      const [row] = await app.db
        .select()
        .from(widgetSettings)
        .where(eq(widgetSettings.projectId, project.id));

      // Assente o spento: il widget non si monta. Non si espone alcun dettaglio.
      if (!row || !row.enabled) {
        return { enabled: false as const };
      }

      // La chat è servibile solo se esiste un provider LLM utilizzabile E almeno
      // un repo è esposto al retrieval (lista vuota = chat disabilitata). Se
      // isAvailable non è implementato, si assume disponibile. Se LANCIA (provider
      // misconfigurato, errore DB) non si abbatte l'endpoint pubblico: si degrada
      // a chat spenta e si logga, il widget si monta comunque.
      let llmAvailable = true;
      try {
        llmAvailable = (await app.chatLlm.isAvailable?.())?.available ?? true;
      } catch (err) {
        request.log.warn({ err }, "widget config: controllo disponibilità chat fallito, chat disabilitata");
        llmAvailable = false;
      }
      const chatEnabled = llmAvailable && row.enabledRepositoryIds.length > 0;

      // safeParse con fallback: un `language` corrotto a DB non deve 500-are la
      // superficie pubblica (il default del progetto è l'italiano).
      const language = widgetSettingsSchema.shape.language.safeParse(row.language);

      return {
        enabled: true as const,
        title: row.title,
        welcomeMessage: row.welcomeMessage,
        accentColor: row.accentColor,
        language: language.success ? language.data : ("it" as const),
        chatEnabled,
      };
    },
  );
}

declare module "fastify" {
  interface FastifyRequest {
    /** Progetto autenticato dalla preValidation della superficie widget. */
    widgetProject?: { id: string; name: string };
  }
}
