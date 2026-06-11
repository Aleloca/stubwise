import { randomBytes } from "node:crypto";
import { gitProviderKindSchema, projectSchema } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/session.js";
import { encrypt, projects } from "@stubwise/db";
import { authErrorResponses, errorSchema, isUniqueViolation } from "./shared.js";

/**
 * Tentativi massimi di insert prima di arrendersi sulla generazione dello
 * slug. In pratica non si raggiunge mai: serve solo a trasformare un bug in
 * un errore esplicito invece che in un loop infinito.
 */
const MAX_SLUG_ATTEMPTS = 100;

/**
 * Credenziali git del progetto: `token` sempre; `username` è l'identità git
 * (username Bitbucket per gli API token, o l'account per le app password
 * legacy); `email` è l'identità della REST API (email Atlassian), serve solo
 * agli API token di Bitbucket. Vengono serializzate in JSON e cifrate prima di
 * toccare il DB; non compaiono mai in nessuna risposta.
 */
const gitCredentialsSchema = z.object({
  username: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  token: z.string().min(1),
});

const createProjectSchema = z.object({
  name: z.string().min(1).max(200),
  provider: gitProviderKindSchema,
  repoUrl: z.url().max(500),
  defaultBranch: z.string().min(1).max(200).default("main"),
  credentials: gitCredentialsSchema,
});

// Lo slug non è aggiornabile: è il path della DSN di ingestion degli SDK
// già distribuiti, cambiarlo romperebbe l'ingestion silenziosamente.
const updateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  repoUrl: z.url().max(500).optional(),
  defaultBranch: z.string().min(1).max(200).optional(),
  credentials: gitCredentialsSchema.optional(),
});

const slugParamsSchema = z.object({ slug: z.string().min(1) });

/**
 * Risposta dell'endpoint admin del webhook: il segreto HMAC e il path su cui
 * il provider deve consegnare gli eventi. Si restituisce solo il path (non
 * l'URL assoluto): la UI lo antepone all'origin corrente, evitando di dover
 * propagare PUBLIC_URL fin dentro la route.
 */
const webhookConfigSchema = z.object({
  webhookSecret: z.string(),
  webhookPath: z.string(),
});

/**
 * Slug URL-safe dal nome: minuscole, accenti scomposti e rimossi, tutto il
 * resto collassato in trattini. Fallback fisso se non resta nulla.
 */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "progetto";
}

type ProjectRow = typeof projects.$inferSelect;

/**
 * Proiezione pubblica di un progetto: campi elencati esplicitamente, mai
 * spread della riga, così `encryptedCredentials` non può trapelare nemmeno
 * se lo schema di risposta cambiasse.
 */
function toPublicProject(row: ProjectRow): z.infer<typeof projectSchema> {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    provider: row.provider,
    repoUrl: row.repoUrl,
    defaultBranch: row.defaultBranch,
    ingestionKey: row.ingestionKey,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Route dei progetti, registrate sotto /api/projects. Lettura per ogni
 * utente autenticato; creazione e modifica solo admin. Le credenziali git
 * sono cifrate AES-256-GCM at rest e non escono mai dall'API.
 */
export async function projectRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/",
    {
      preHandler: requireAdmin,
      schema: {
        body: createProjectSchema,
        response: { 201: projectSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { name, provider, repoUrl, defaultBranch, credentials } = request.body;
      const encryptedCredentials = encrypt(JSON.stringify(credentials), app.encryptionKey);
      const baseSlug = slugify(name);
      // Unicità dello slug per insert-e-riprova: in caso di collisione si
      // aggiunge un suffisso numerico. Niente select preventiva: il vincolo
      // unique del DB è l'arbitro anche sotto richieste concorrenti.
      for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
        const slug = attempt === 1 ? baseSlug : `${baseSlug}-${attempt}`;
        try {
          const [created] = await app.db
            .insert(projects)
            .values({
              name,
              slug,
              provider,
              repoUrl,
              defaultBranch,
              encryptedCredentials,
              // Chiave di ingestion per gli SDK: 32 caratteri esadecimali.
              ingestionKey: randomBytes(16).toString("hex"),
              // Segreto HMAC del webhook git, generato come l'ingestionKey:
              // 32 hex. Sempre valorizzato alla creazione, così nessun
              // progetto nuovo nasce con webhook non verificabili.
              webhookSecret: randomBytes(16).toString("hex"),
            })
            .returning();
          if (!created) throw new Error("insert del progetto non ha restituito la riga");
          return await reply.code(201).send(toPublicProject(created));
        } catch (error) {
          // Collisione di slug (o, in teoria, di ingestionKey: entrambi
          // vengono rigenerati al giro dopo). Tutto il resto riemerge.
          if (!isUniqueViolation(error)) throw error;
        }
      }
      throw new Error(`impossibile generare uno slug unico per "${baseSlug}"`);
    },
  );

  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: { response: { 200: z.array(projectSchema), ...authErrorResponses } },
    },
    async () => {
      const rows = await app.db.select().from(projects).orderBy(projects.createdAt);
      return rows.map(toPublicProject);
    },
  );

  app.get(
    "/:slug",
    {
      preHandler: requireAuth,
      schema: {
        params: slugParamsSchema,
        response: { 200: projectSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const [row] = await app.db
        .select()
        .from(projects)
        .where(eq(projects.slug, request.params.slug));
      if (!row) return reply.code(404).send({ message: "Progetto non trovato" });
      return toPublicProject(row);
    },
  );

  // Solo admin: il webhookSecret è l'unica difesa contro webhook di merge
  // forgiati (che forzerebbero i ticket a "done"). Tenuto fuori da ogni
  // proiezione pubblica, si legge esclusivamente da qui.
  app.get(
    "/:slug/webhook",
    {
      preHandler: requireAdmin,
      schema: {
        params: slugParamsSchema,
        response: { 200: webhookConfigSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const [row] = await app.db
        .select({ webhookSecret: projects.webhookSecret })
        .from(projects)
        .where(eq(projects.slug, request.params.slug));
      if (!row) return reply.code(404).send({ message: "Progetto non trovato" });
      return { webhookSecret: row.webhookSecret, webhookPath: `/webhooks/git/${request.params.slug}` };
    },
  );

  app.patch(
    "/:slug",
    {
      preHandler: requireAdmin,
      schema: {
        params: slugParamsSchema,
        body: updateProjectSchema,
        response: { 200: projectSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { name, repoUrl, defaultBranch, credentials } = request.body;
      const updates: Partial<ProjectRow> = {};
      if (name !== undefined) updates.name = name;
      if (repoUrl !== undefined) updates.repoUrl = repoUrl;
      if (defaultBranch !== undefined) updates.defaultBranch = defaultBranch;
      if (credentials !== undefined) {
        updates.encryptedCredentials = encrypt(JSON.stringify(credentials), app.encryptionKey);
      }

      // Drizzle rifiuta un update senza colonne: un PATCH vuoto è una
      // lettura, si risponde con lo stato corrente.
      const [row] =
        Object.keys(updates).length === 0
          ? await app.db.select().from(projects).where(eq(projects.slug, request.params.slug))
          : await app.db
              .update(projects)
              .set(updates)
              .where(eq(projects.slug, request.params.slug))
              .returning();
      if (!row) return reply.code(404).send({ message: "Progetto non trovato" });
      return toPublicProject(row);
    },
  );
}
