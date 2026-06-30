import { randomBytes } from "node:crypto";
import { repositorySchema } from "@stubwise/shared";
import { getProvider } from "@stubwise/git";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/session.js";
import { GitProviderError } from "@stubwise/git";
import { decrypt, gitAccounts, projects, repositories } from "@stubwise/db";
import { authErrorResponses, errorSchema, isUniqueViolation } from "./shared.js";
import { apiError } from "../errors.js";

/**
 * Tentativi massimi di insert prima di arrendersi sulla generazione dello
 * slug. In pratica non si raggiunge mai: serve solo a trasformare un bug in
 * un errore esplicito invece che in un loop infinito.
 */
const MAX_SLUG_ATTEMPTS = 100;

/**
 * Forma delle credenziali git decifrate dall'account (vedi git-accounts.ts).
 * Usata solo internamente per configurare il webhook; non entra né esce mai
 * dalle risposte dei repository.
 */
const gitCredentialsSchema = z.object({
  username: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  token: z.string().min(1),
});

const createRepositorySchema = z.object({
  // Progetto (gruppo) a cui il repository appartiene: deve esistere.
  projectId: z.uuid(),
  name: z.string().min(1).max(200),
  // Le credenziali e il provider vivono sull'account git: il repository
  // referenzia l'account e ne eredita il provider (denormalizzato sulla riga).
  gitAccountId: z.uuid(),
  repoUrl: z.url().max(500),
  defaultBranch: z.string().min(1).max(200).default("main"),
  // Comando di test che la pipeline AI esegue per validare il fix. Trim per
  // normalizzare; nullable/optional: omesso o null = nessun comando.
  testCommand: z.string().trim().min(1).max(500).nullable().optional(),
  // Comando di installazione delle dipendenze nel worktree. Stessa semantica
  // di testCommand: trim, omesso o null = nessun comando.
  installCommand: z.string().trim().min(1).max(500).nullable().optional(),
});

// Lo slug non è aggiornabile: è il path della DSN di ingestion degli SDK
// già distribuiti, cambiarlo romperebbe l'ingestion silenziosamente.
const updateRepositorySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  repoUrl: z.url().max(500).optional(),
  defaultBranch: z.string().min(1).max(200).optional(),
  // Cambio di account git (es. credenziali ruotate su un altro account):
  // aggiorna anche il provider denormalizzato del repository. Le credenziali
  // dirette sul repository non esistono più.
  gitAccountId: z.uuid().optional(),
  // Comando di test della pipeline AI: null lo azzera, omesso lo lascia invariato.
  testCommand: z.string().trim().min(1).max(500).nullable().optional(),
  // Comando di installazione delle dipendenze: null lo azzera, omesso lo lascia invariato.
  installCommand: z.string().trim().min(1).max(500).nullable().optional(),
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
 * Esito della configurazione automatica del webhook: `created`/`updated`
 * dicono se è stato creato o aggiornato lato provider, `detail` è il messaggio
 * per la UI, `url` è l'URL pubblico registrato. NON contiene MAI il segreto né
 * le credenziali.
 */
const configureWebhookResponseSchema = z.object({
  ok: z.literal(true),
  created: z.boolean(),
  updated: z.boolean(),
  detail: z.string(),
  url: z.string(),
});

/**
 * Slug URL-safe dal nome: minuscole, accenti scomposti e rimossi, tutto il
 * resto collassato in trattini. Fallback fisso se non resta nulla.
 */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "repository";
}

type RepositoryRow = typeof repositories.$inferSelect;

/**
 * Proiezione pubblica di un repository: campi elencati esplicitamente, mai
 * spread della riga. Le credenziali non vivono sul repository (stanno
 * sull'account git); si espongono `gitAccountId` e `gitAccountName` per la UI.
 * `projectId` è il progetto (gruppo) a cui il repository appartiene. Le
 * impostazioni di prodotto (provider AI, auto-update docs) sono salite al
 * progetto e NON fanno più parte di questa proiezione.
 */
function toPublicRepository(
  row: RepositoryRow,
  gitAccountName: string,
): z.infer<typeof repositorySchema> {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    slug: row.slug,
    provider: row.provider,
    repoUrl: row.repoUrl,
    defaultBranch: row.defaultBranch,
    ingestionKey: row.ingestionKey,
    gitAccountId: row.gitAccountId,
    gitAccountName,
    testCommand: row.testCommand,
    installCommand: row.installCommand,
    webhookConfiguredAt: row.webhookConfiguredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Route dei repository, registrate sotto /api/repositories. Lettura per ogni
 * utente autenticato; creazione e modifica solo admin. Le credenziali git
 * vivono sull'account collegato (git_accounts), non sul repository. Un
 * repository appartiene sempre a un progetto (gruppo).
 */
export async function repositoryRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/",
    {
      preHandler: requireAdmin,
      schema: {
        body: createRepositorySchema,
        response: { 201: repositorySchema, 400: errorSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { projectId, name, gitAccountId, repoUrl, defaultBranch, testCommand, installCommand } =
        request.body;

      // Il progetto (gruppo) deve esistere: il repository vi appartiene.
      const [project] = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId));
      if (!project) return apiError(reply, 404, "project_not_found", "Project not found");

      // L'account deve esistere: il provider del repository è quello dell'account.
      const [account] = await app.db
        .select()
        .from(gitAccounts)
        .where(eq(gitAccounts.id, gitAccountId));
      if (!account) return apiError(reply, 404, "git_account_not_found", "Git account not found");

      const baseSlug = slugify(name);
      // Unicità dello slug per insert-e-riprova: in caso di collisione si
      // aggiunge un suffisso numerico. Niente select preventiva: il vincolo
      // unique del DB è l'arbitro anche sotto richieste concorrenti.
      for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
        const slug = attempt === 1 ? baseSlug : `${baseSlug}-${attempt}`;
        try {
          const [created] = await app.db
            .insert(repositories)
            .values({
              projectId,
              name,
              slug,
              // Provider denormalizzato dall'account: fonte di verità è l'account.
              provider: account.provider,
              gitAccountId: account.id,
              repoUrl,
              defaultBranch,
              // Omesso → null: nessun comando di test configurato alla creazione.
              testCommand: testCommand ?? null,
              // Omesso → null: nessun comando di installazione alla creazione.
              installCommand: installCommand ?? null,
              // Chiave di ingestion per gli SDK: 32 caratteri esadecimali.
              ingestionKey: randomBytes(16).toString("hex"),
              // Segreto HMAC del webhook git, generato come l'ingestionKey:
              // 32 hex. Sempre valorizzato alla creazione, così nessun
              // repository nuovo nasce con webhook non verificabili.
              webhookSecret: randomBytes(16).toString("hex"),
            })
            .returning();
          if (!created) throw new Error("insert del repository non ha restituito la riga");
          return await reply.code(201).send(toPublicRepository(created, account.name));
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
      schema: {
        querystring: z.object({ projectId: z.uuid().optional() }),
        response: { 200: z.array(repositorySchema), ...authErrorResponses },
      },
    },
    async (request) => {
      const { projectId } = request.query;
      const rows = await app.db
        .select({ repository: repositories, gitAccountName: gitAccounts.name })
        .from(repositories)
        .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
        .where(projectId ? eq(repositories.projectId, projectId) : undefined)
        .orderBy(repositories.createdAt);
      return rows.map((r) => toPublicRepository(r.repository, r.gitAccountName));
    },
  );

  app.get(
    "/:slug",
    {
      preHandler: requireAuth,
      schema: {
        params: slugParamsSchema,
        response: { 200: repositorySchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const [row] = await app.db
        .select({ repository: repositories, gitAccountName: gitAccounts.name })
        .from(repositories)
        .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
        .where(eq(repositories.slug, request.params.slug));
      if (!row) return apiError(reply, 404, "repository_not_found", "Repository not found");
      return toPublicRepository(row.repository, row.gitAccountName);
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
        .select({ webhookSecret: repositories.webhookSecret })
        .from(repositories)
        .where(eq(repositories.slug, request.params.slug));
      if (!row) return apiError(reply, 404, "repository_not_found", "Repository not found");
      return { webhookSecret: row.webhookSecret, webhookPath: `/webhooks/git/${request.params.slug}` };
    },
  );

  // Configurazione automatica del webhook (solo admin): registra in modo
  // idempotente il webhook PR-merged sul provider git usando le credenziali
  // cifrate dell'ACCOUNT git collegato al repository. Né il segreto né le
  // credenziali escono mai dalla risposta. Gli errori del provider (es. scope
  // mancante) sono GitProviderError e vengono mappati su un 4xx col messaggio
  // di guida intatto per il client.
  app.post(
    "/:slug/configure-webhook",
    {
      preHandler: requireAdmin,
      schema: {
        params: slugParamsSchema,
        response: {
          200: configureWebhookResponseSchema,
          400: errorSchema,
          404: errorSchema,
          422: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const [row] = await app.db
        .select({ repository: repositories, account: gitAccounts })
        .from(repositories)
        .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
        .where(eq(repositories.slug, request.params.slug));
      if (!row) return apiError(reply, 404, "repository_not_found", "Repository not found");
      const { repository, account } = row;

      // Decifratura delle credenziali dell'ACCOUNT con la chiave dell'app
      // (stesso percorso del worker). Un fallimento qui è un errore di
      // configurazione: messaggio esplicito, MAI il payload cifrato.
      let credentials: z.infer<typeof gitCredentialsSchema>;
      try {
        credentials = gitCredentialsSchema.parse(
          JSON.parse(decrypt(account.encryptedCredentials, app.encryptionKey)),
        );
      } catch {
        return apiError(reply, 400, "credentials_undecryptable", "Git account credentials cannot be decrypted");
      }

      const url = `${app.publicUrl}/webhooks/git/${request.params.slug}`;
      try {
        const result = await getProvider(repository.provider).ensureWebhook(
          { repoUrl: repository.repoUrl, defaultBranch: repository.defaultBranch, credentials },
          { url, secret: repository.webhookSecret },
          { fetchImpl: fetch },
        );
        // Registra lo stato "configurato": la proiezione pubblica lo espone
        // come webhookConfiguredAt e la UI collassa l'azione di configurazione.
        await app.db
          .update(repositories)
          .set({ webhookConfiguredAt: new Date() })
          .where(eq(repositories.id, repository.id));
        return {
          ok: true as const,
          created: result.created,
          updated: result.updated,
          detail: result.detail,
          url,
        };
      } catch (error) {
        if (error instanceof GitProviderError) {
          // 422: la richiesta è valida ma il provider la rifiuta (es. scope
          // webhook mancante). Il messaggio < 500 passa intatto al client.
          return apiError(reply, 422, "git_provider_error", error.message);
        }
        throw error;
      }
    },
  );

  app.patch(
    "/:slug",
    {
      preHandler: requireAdmin,
      schema: {
        params: slugParamsSchema,
        body: updateRepositorySchema,
        response: { 200: repositorySchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { name, repoUrl, defaultBranch, gitAccountId, testCommand, installCommand } =
        request.body;
      const updates: Partial<RepositoryRow> = {};
      if (name !== undefined) updates.name = name;
      if (repoUrl !== undefined) updates.repoUrl = repoUrl;
      if (defaultBranch !== undefined) updates.defaultBranch = defaultBranch;
      // null azzera il comando, una stringa lo imposta; omesso (undefined) lo lascia.
      if (testCommand !== undefined) updates.testCommand = testCommand;
      // Stessa semantica di testCommand: null azzera, stringa imposta, omesso lascia.
      if (installCommand !== undefined) updates.installCommand = installCommand;
      // Cambio di account: valida l'esistenza e ri-denormalizza il provider.
      if (gitAccountId !== undefined) {
        const [account] = await app.db
          .select()
          .from(gitAccounts)
          .where(eq(gitAccounts.id, gitAccountId));
        if (!account) return apiError(reply, 404, "git_account_not_found", "Git account not found");
        updates.gitAccountId = account.id;
        updates.provider = account.provider;
      }

      // Drizzle rifiuta un update senza colonne: un PATCH vuoto è una lettura.
      if (Object.keys(updates).length > 0) {
        const [updated] = await app.db
          .update(repositories)
          .set(updates)
          .where(eq(repositories.slug, request.params.slug))
          .returning();
        if (!updated) return apiError(reply, 404, "repository_not_found", "Repository not found");
      }

      const [row] = await app.db
        .select({ repository: repositories, gitAccountName: gitAccounts.name })
        .from(repositories)
        .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
        .where(eq(repositories.slug, request.params.slug));
      if (!row) return apiError(reply, 404, "repository_not_found", "Repository not found");
      return toPublicRepository(row.repository, row.gitAccountName);
    },
  );
}
