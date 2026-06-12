import { gitAccountSchema, gitProviderKindSchema } from "@stubwise/shared";
import { GitProviderError, getProvider } from "@stubwise/git";
import { decrypt, encrypt, gitAccounts, projects } from "@stubwise/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/session.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Credenziali git di un account: `token` sempre; `username` è l'identità git
 * (username Bitbucket per gli API token, o l'account per le app password
 * legacy); `email` è l'identità della REST API (email Atlassian), serve solo
 * agli API token di Bitbucket. Serializzate in JSON e cifrate prima di toccare
 * il DB; non compaiono mai in nessuna risposta.
 */
const gitCredentialsSchema = z.object({
  username: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  token: z.string().min(1),
});

const createAccountSchema = z.object({
  name: z.string().min(1).max(200),
  provider: gitProviderKindSchema,
  credentials: gitCredentialsSchema,
  // Slug del workspace Bitbucket: di fatto richiesto per usare le feature repo
  // di un account Bitbucket (vedi gitAccountSchema), ma non blocchiamo la
  // creazione — la validazione/elenco segnalerà l'eventuale mancanza.
  workspace: z.string().min(1).max(200).optional(),
});

// In modifica: nome, credenziali e/o workspace. Credenziali assenti = invariate
// (non si possono "svuotare": un account senza credenziali non avrebbe senso).
const updateAccountSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  credentials: gitCredentialsSchema.optional(),
  workspace: z.string().min(1).max(200).optional(),
});

const idParamsSchema = z.object({ id: z.uuid() });

const credentialCheckSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  detail: z.string(),
});

/** Risultato della validazione: `ok` riassume i singoli check (tutti ok). */
const validateResponseSchema = z.object({
  ok: z.boolean(),
  checks: z.array(credentialCheckSchema),
});

const repoSummarySchema = z.object({
  fullName: z.string(),
  name: z.string(),
  cloneUrl: z.string(),
  defaultBranch: z.string().nullable(),
});

const branchesResponseSchema = z.object({
  branches: z.array(z.string()),
  defaultBranch: z.string().nullable(),
});

const repositoriesQuerySchema = z.object({});
const branchesQuerySchema = z.object({ repo: z.string().min(1) });
const validateRepoQuerySchema = z.object({ repo: z.string().min(1) });

type GitAccountRow = typeof gitAccounts.$inferSelect;

/**
 * Proiezione pubblica di un account: campi elencati esplicitamente, mai spread
 * della riga, così `encryptedCredentials` non può trapelare nemmeno se lo
 * schema cambiasse.
 */
function toPublicAccount(row: GitAccountRow): z.infer<typeof gitAccountSchema> {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    workspace: row.workspace,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Decifra le credenziali di un account. Lancia se il payload non è decifrabile
 * (chiave sbagliata o blob manomesso) o non ha la forma attesa: i chiamanti
 * traducono il fallimento in un 400 con messaggio esplicito (mai il payload).
 */
function decryptAccountCredentials(
  row: GitAccountRow,
  key: Buffer,
): z.infer<typeof gitCredentialsSchema> {
  return gitCredentialsSchema.parse(JSON.parse(decrypt(row.encryptedCredentials, key)));
}

/**
 * Route degli account git riutilizzabili, registrate sotto /api/git-accounts.
 * Le credenziali sono cifrate AES-256-GCM at rest e non escono mai dall'API.
 * Lettura per ogni utente autenticato (così un admin può scegliere l'account
 * creando un progetto); creazione, modifica, eliminazione e operazioni che
 * decifrano le credenziali (validazione, elenco repo/branch) solo admin.
 */
export async function gitAccountRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/",
    {
      preHandler: requireAdmin,
      schema: {
        body: createAccountSchema,
        response: { 201: gitAccountSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { name, provider, credentials, workspace } = request.body;
      const encryptedCredentials = encrypt(JSON.stringify(credentials), app.encryptionKey);
      const [created] = await app.db
        .insert(gitAccounts)
        .values({ name, provider, encryptedCredentials, workspace: workspace ?? null })
        .returning();
      if (!created) throw new Error("insert dell'account non ha restituito la riga");
      return reply.code(201).send(toPublicAccount(created));
    },
  );

  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: { response: { 200: z.array(gitAccountSchema), ...authErrorResponses } },
    },
    async () => {
      const rows = await app.db.select().from(gitAccounts).orderBy(gitAccounts.createdAt);
      return rows.map(toPublicAccount);
    },
  );

  app.get(
    "/:id",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        response: { 200: gitAccountSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const [row] = await app.db
        .select()
        .from(gitAccounts)
        .where(eq(gitAccounts.id, request.params.id));
      if (!row) return reply.code(404).send({ message: "Account git non trovato" });
      return toPublicAccount(row);
    },
  );

  app.patch(
    "/:id",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        body: updateAccountSchema,
        response: { 200: gitAccountSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { name, credentials, workspace } = request.body;
      const updates: Partial<GitAccountRow> = {};
      if (name !== undefined) updates.name = name;
      if (workspace !== undefined) updates.workspace = workspace;
      if (credentials !== undefined) {
        updates.encryptedCredentials = encrypt(JSON.stringify(credentials), app.encryptionKey);
      }

      // Drizzle rifiuta un update senza colonne: un PATCH vuoto è una lettura.
      const [row] =
        Object.keys(updates).length === 0
          ? await app.db.select().from(gitAccounts).where(eq(gitAccounts.id, request.params.id))
          : await app.db
              .update(gitAccounts)
              .set(updates)
              .where(eq(gitAccounts.id, request.params.id))
              .returning();
      if (!row) return reply.code(404).send({ message: "Account git non trovato" });
      return toPublicAccount(row);
    },
  );

  app.delete(
    "/:id",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        response: {
          204: z.null(),
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      // 409 se almeno un progetto usa l'account: la FK è ON DELETE RESTRICT,
      // ma controlliamo prima per dare un messaggio chiaro invece di un 500.
      const [used] = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.gitAccountId, request.params.id))
        .limit(1);
      if (used) {
        return reply
          .code(409)
          .send({ message: "Account git in uso da uno o più progetti: scollegalo prima di eliminarlo" });
      }
      const deleted = await app.db
        .delete(gitAccounts)
        .where(eq(gitAccounts.id, request.params.id))
        .returning({ id: gitAccounts.id });
      if (deleted.length === 0) return reply.code(404).send({ message: "Account git non trovato" });
      return reply.code(204).send(null);
    },
  );

  // Validazione delle credenziali memorizzate (solo admin) a LIVELLO DI ACCOUNT:
  // decifra e controlla via HTTPS che il token autentichi e abbia accesso in
  // lettura ai repository. I check repo-specifici (push git / PR / webhook su un
  // repo) vivono in /validate-repo, eseguiti nel wizard dopo la scelta del repo.
  app.post(
    "/:id/validate",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        response: { 200: validateResponseSchema, 400: errorSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const [row] = await app.db
        .select()
        .from(gitAccounts)
        .where(eq(gitAccounts.id, request.params.id));
      if (!row) return reply.code(404).send({ message: "Account git non trovato" });

      let credentials: z.infer<typeof gitCredentialsSchema>;
      try {
        credentials = decryptAccountCredentials(row, app.encryptionKey);
      } catch {
        return reply.code(400).send({ message: "credenziali dell'account non decifrabili" });
      }

      const checks = await getProvider(row.provider).validateAccount(
        { credentials: { provider: row.provider, credentials }, workspace: row.workspace ?? undefined },
        { fetchImpl: fetch },
      );
      return { ok: checks.every((c) => c.ok), checks };
    },
  );

  // Verifica REPO-SPECIFICA (solo admin): sonda i tre check che richiedono un
  // repo reale (push git, REST/PR, webhook) su un repo scelto (query `repo` =
  // "workspace/slug" o "owner/repo"). È advisory: la usa il wizard dopo la
  // scelta del repo, prima di creare il progetto (anche se rossa non blocca).
  app.get(
    "/:id/validate-repo",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        querystring: validateRepoQuerySchema,
        response: { 200: validateResponseSchema, 400: errorSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const [row] = await app.db
        .select()
        .from(gitAccounts)
        .where(eq(gitAccounts.id, request.params.id));
      if (!row) return reply.code(404).send({ message: "Account git non trovato" });

      let credentials: z.infer<typeof gitCredentialsSchema>;
      try {
        credentials = decryptAccountCredentials(row, app.encryptionKey);
      } catch {
        return reply.code(400).send({ message: "credenziali dell'account non decifrabili" });
      }

      // Ricostruisce il repoUrl dall'host del provider + fullName.
      const host = row.provider === "bitbucket" ? "bitbucket.org" : "github.com";
      const repoUrl = `https://${host}/${request.query.repo}`;
      const checks = await getProvider(row.provider).validateCredentials(
        { repoUrl, defaultBranch: "main", credentials },
        { fetchImpl: fetch },
      );
      return { ok: checks.every((c) => c.ok), checks };
    },
  );

  app.get(
    "/:id/repositories",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        querystring: repositoriesQuerySchema,
        response: {
          200: z.array(repoSummarySchema),
          400: errorSchema,
          404: errorSchema,
          422: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const [row] = await app.db
        .select()
        .from(gitAccounts)
        .where(eq(gitAccounts.id, request.params.id));
      if (!row) return reply.code(404).send({ message: "Account git non trovato" });

      let credentials: z.infer<typeof gitCredentialsSchema>;
      try {
        credentials = decryptAccountCredentials(row, app.encryptionKey);
      } catch {
        return reply.code(400).send({ message: "credenziali dell'account non decifrabili" });
      }

      try {
        return await getProvider(row.provider).listRepositories(
          { credentials: { provider: row.provider, credentials }, workspace: row.workspace ?? undefined },
          { fetchImpl: fetch },
        );
      } catch (error) {
        if (error instanceof GitProviderError) {
          return reply.code(422).send({ message: error.message });
        }
        throw error;
      }
    },
  );

  app.get(
    "/:id/branches",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        querystring: branchesQuerySchema,
        response: {
          200: branchesResponseSchema,
          400: errorSchema,
          404: errorSchema,
          422: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const [row] = await app.db
        .select()
        .from(gitAccounts)
        .where(eq(gitAccounts.id, request.params.id));
      if (!row) return reply.code(404).send({ message: "Account git non trovato" });

      let credentials: z.infer<typeof gitCredentialsSchema>;
      try {
        credentials = decryptAccountCredentials(row, app.encryptionKey);
      } catch {
        return reply.code(400).send({ message: "credenziali dell'account non decifrabili" });
      }

      try {
        return await getProvider(row.provider).listBranches(
          { provider: row.provider, credentials },
          request.query.repo,
          { fetchImpl: fetch },
        );
      } catch (error) {
        if (error instanceof GitProviderError) {
          return reply.code(422).send({ message: error.message });
        }
        throw error;
      }
    },
  );
}
