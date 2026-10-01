import { gitAccountSchema, gitProviderKindSchema } from "@stubwise/shared";
import { BITBUCKET_REVIEWER_SCOPES, GitProviderError, getProvider } from "@stubwise/git";
import { decrypt, encrypt, gitAccounts, repositories } from "@stubwise/db";
import { resolveProviderUserId, resolveReviewAccounts } from "@stubwise/notifications";
import { and, eq, ne, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/session.js";
import { authErrorResponses, errorSchema, isUniqueViolation } from "./shared.js";
import { apiError } from "../errors.js";
import { fetchPlatformIdentity } from "../services/platform-identity.js";
import { checkReviewAccount, logIdentityError } from "../services/review-account-check.js";

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
 * Un avviso dell'impostazione del revisore predefinito, per repository (D5):
 * `default_is_main` = il predefinito è il principale di quella repository e lì
 * non si applica (D3); ogni altro `code` è quello di `checkReviewAccount`
 * (es. `review_account_no_write_permission`). Mai un blocco: il predefinito è
 * già impostato quando si leggono.
 */
const defaultReviewerWarningSchema = z.object({
  repositoryId: z.uuid(),
  repositoryName: z.string(),
  code: z.string(),
});

const defaultReviewerResponseSchema = z.object({
  account: gitAccountSchema,
  /** Il predefinito precedente dello stesso ambito, tolto nella STESSA transazione; null = nessuno. */
  replaced: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  warnings: z.array(defaultReviewerWarningSchema),
});

type DefaultReviewerWarning = z.infer<typeof defaultReviewerWarningSchema>;

/** Concorrenza delle verifiche per repository dopo l'impostazione (D5). */
const DEFAULT_REVIEWER_CHECK_CONCURRENCY = 4;

/**
 * Le righe di `git_accounts` nello stesso AMBITO del revisore predefinito di
 * `row` (D1): gemello SQL di `reviewScopeKey` (`@stubwise/notifications`) e
 * dell'indice `git_accounts_default_reviewer_scope_uq` della 0082. Su
 * Bitbucket conta il workspace, con NULL uguale a ''; altrove solo il provider.
 */
function sameReviewScope(row: Pick<GitAccountRow, "provider" | "workspace">): SQL {
  if (row.provider !== "bitbucket") return eq(gitAccounts.provider, row.provider);
  return and(
    eq(gitAccounts.provider, "bitbucket"),
    sql`coalesce(${gitAccounts.workspace}, '') = ${row.workspace ?? ""}`,
  ) as SQL;
}

/** `fn` su ogni elemento, al più `limit` alla volta; l'ordine dei risultati è quello di `items`. */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Sentinella: l'account è sparito dentro la transazione del PUT, che va annullata. */
class DefaultReviewerAccountGone extends Error {}

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
    isDefaultReviewer: row.isDefaultReviewer,
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
 * Gli avvisi per repository dopo l'impostazione del predefinito (D5), DOPO il
 * commit: si leggono le repository il cui principale è nello stesso ambito, e
 * la regola del revisore effettivo la decide `resolveReviewAccounts` (mai
 * ridedotta qui). Dove il predefinito è il principale → `default_is_main`
 * (D3); dove è effettivo → `checkReviewAccount` con le verifiche di rete, al
 * più 4 alla volta. Best-effort come gli avvisi del form: una verifica che
 * lancia si logga e non produce avviso — il predefinito è già impostato.
 */
async function defaultReviewerWarnings(app: FastifyInstance, account: GitAccountRow): Promise<DefaultReviewerWarning[]> {
  const rows = await app.db
    .select({ repository: repositories, main: gitAccounts })
    .from(repositories)
    .innerJoin(gitAccounts, eq(gitAccounts.id, repositories.gitAccountId))
    .where(sameReviewScope(account))
    .orderBy(repositories.name);
  if (rows.length === 0) return [];
  const resolutions = await resolveReviewAccounts(
    app.db,
    rows.map((r) => r.repository.id),
  );

  const results = await mapWithConcurrency(rows, DEFAULT_REVIEWER_CHECK_CONCURRENCY, async ({ repository, main }) => {
    const resolution = resolutions.get(repository.id);
    const base = { repositoryId: repository.id, repositoryName: repository.name };
    if (resolution?.skippedDefault?.id === account.id) return { ...base, code: "default_is_main" };
    const effective = resolution?.effective;
    if (!effective || effective.source !== "default" || effective.account.id !== account.id) return null;
    try {
      const check = await checkReviewAccount(app, {
        mainAccount: main,
        reviewGitAccountId: account.id,
        repoUrl: repository.repoUrl,
        defaultBranch: repository.defaultBranch,
        verifyRemote: true,
      });
      return check.ok ? null : { ...base, code: check.code };
    } catch (err) {
      app.log.warn(
        { repositoryId: repository.id, gitAccountId: account.id, err: err instanceof Error ? err.message : String(err) },
        "verifica del revisore predefinito sulla repository non riuscita: nessun avviso",
      );
      return null;
    }
  });
  return results.filter((w): w is DefaultReviewerWarning => w !== null);
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
      if (!row) return apiError(reply, 404, "git_account_not_found", "Git account not found");
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
        response: { 200: gitAccountSchema, 404: errorSchema, 409: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { name, credentials, workspace } = request.body;
      const updates: Partial<GitAccountRow> = {};
      if (name !== undefined) updates.name = name;
      if (workspace !== undefined) updates.workspace = workspace;
      if (credentials !== undefined) {
        updates.encryptedCredentials = encrypt(JSON.stringify(credentials), app.encryptionKey);
        // Un token nuovo può appartenere a un ALTRO utente della piattaforma:
        // l'identità salvata (ciclo di correzione, design §5) non vale più e si
        // riscopre al primo uso. Tenerla farebbe passare dal filtro
        // anti-auto-innesco proprio il bot nuovo. Stessa scrittura del blob
        // nuovo: `resolveProviderUserId` guarda la sua cache proprio sul blob.
        updates.providerUserId = null;
      }

      // D7: il workspace di un revisore PREDEFINITO non si cambia — sposterebbe
      // in silenzio l'ambito, cioè il revisore di N repository, senza la
      // validazione del PUT, e potrebbe collidere con l'indice. La guardia sta
      // nel WHERE (non in una lettura prima): un PUT concorrente che marca
      // l'account fra la lettura e la scrittura non la scavalca. Lo stesso
      // workspace di prima non è un cambio.
      const workspaceGuard =
        workspace === undefined
          ? undefined
          : or(eq(gitAccounts.isDefaultReviewer, false), sql`${gitAccounts.workspace} is not distinct from ${workspace}`);

      // Drizzle rifiuta un update senza colonne: un PATCH vuoto è una lettura.
      const [row] =
        Object.keys(updates).length === 0
          ? await app.db.select().from(gitAccounts).where(eq(gitAccounts.id, request.params.id))
          : await app.db
              .update(gitAccounts)
              .set(updates)
              .where(and(eq(gitAccounts.id, request.params.id), workspaceGuard))
              .returning();
      if (!row) {
        if (workspaceGuard !== undefined) {
          const [exists] = await app.db
            .select({ id: gitAccounts.id })
            .from(gitAccounts)
            .where(eq(gitAccounts.id, request.params.id));
          if (exists) {
            return apiError(
              reply,
              409,
              "default_reviewer_workspace_locked",
              "This account is the default reviewer: remove the default before changing its workspace",
            );
          }
        }
        return apiError(reply, 404, "git_account_not_found", "Git account not found");
      }
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
      // 409 se almeno un repository usa l'account: la FK è ON DELETE RESTRICT,
      // ma controlliamo prima per dare un messaggio chiaro invece di un 500.
      const [used] = await app.db
        .select({ id: repositories.id })
        .from(repositories)
        .where(eq(repositories.gitAccountId, request.params.id))
        .limit(1);
      if (used) {
        return apiError(reply, 409, "git_account_in_use", "Git account in use by one or more repositories: unlink it before deleting");
      }
      const deleted = await app.db
        .delete(gitAccounts)
        .where(eq(gitAccounts.id, request.params.id))
        .returning({ id: gitAccounts.id });
      if (deleted.length === 0) return apiError(reply, 404, "git_account_not_found", "Git account not found");
      return reply.code(204).send(null);
    },
  );

  /**
   * Imposta il REVISORE PREDEFINITO del suo ambito (provider + workspace
   * Bitbucket, D1/D4). Solo admin. Due livelli di verifica (D5):
   * - BLOCCANTI, a livello di account (422, nessuna scrittura): workspace
   *   Bitbucket, credenziali, scope del RUOLO revisore
   *   (`BITBUCKET_REVIEWER_SCOPES`, mai l'insieme del principale: i webhook il
   *   revisore non li usa), identità sulla piattaforma rinfrescata;
   * - AVVISI, per repository (200, `warnings`): dove il predefinito diventa
   *   effettivo, `checkReviewAccount` con le verifiche di rete; dove è il
   *   principale, `default_is_main` (D3). Non bloccano perché non esiste
   *   l'opzione «nessun revisore» per repository: un 422 per UNA repository
   *   senza accesso renderebbe il predefinito impossibile finché esiste.
   *
   * Un predefinito già presente nello stesso ambito si SOSTITUISCE nella stessa
   * transazione (`replaced`). Due admin in corsa li ferma l'indice unico
   * parziale → 409 `default_reviewer_conflict`.
   *
   * Le verifiche di account vengono PRIMA dell'identità (il piano diceva il
   * contrario): un token senza `read:user` o non valido produce così il
   * dettaglio preciso del check, invece del generico «identità non leggibile».
   */
  app.put(
    "/:id/default-reviewer",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        response: {
          200: defaultReviewerResponseSchema,
          400: errorSchema,
          404: errorSchema,
          409: errorSchema,
          422: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const id = request.params.id;
      const [row] = await app.db.select().from(gitAccounts).where(eq(gitAccounts.id, id));
      if (!row) return apiError(reply, 404, "git_account_not_found", "Git account not found");

      if (row.provider === "bitbucket" && !row.workspace) {
        return apiError(
          reply,
          422,
          "default_reviewer_workspace_missing",
          "A Bitbucket default reviewer needs a workspace: set it on the git account first",
        );
      }

      let credentials: z.infer<typeof gitCredentialsSchema>;
      try {
        credentials = decryptAccountCredentials(row, app.encryptionKey);
      } catch {
        return apiError(reply, 400, "credentials_undecryptable", "Account credentials cannot be decrypted");
      }

      const checks = await getProvider(row.provider).validateAccount(
        { credentials: { provider: row.provider, credentials }, workspace: row.workspace ?? undefined },
        { fetchImpl: fetch, requiredScopes: BITBUCKET_REVIEWER_SCOPES },
      );
      const failed = checks.filter((c) => !c.ok);
      if (failed.length > 0) {
        return apiError(
          reply,
          422,
          "default_reviewer_invalid",
          failed.map((c) => `${c.name}: ${c.detail}`).join("; "),
        );
      }

      // Rinfrescata, non dalla cache: è il momento in cui l'admin deve sapere
      // se il webhook potrà riconoscere le review di questo account.
      const scopeHint =
        row.provider === "bitbucket" ? " (on Bitbucket, check that the token has the read:user:bitbucket scope)" : "";
      const identity = await resolveProviderUserId(app.db, app.encryptionKey, row, fetchPlatformIdentity, {
        refresh: true,
        onError: logIdentityError(app, row.id, "identità del revisore predefinito: il provider ha risposto con un errore"),
      });
      if (identity === null) {
        return apiError(
          reply,
          422,
          "review_account_identity_unresolved",
          `Could not read the account's identity from the provider${scopeHint}`,
        );
      }

      let outcome: { account: GitAccountRow; replaced: { id: string; name: string } | null };
      try {
        outcome = await app.db.transaction(async (tx) => {
          const replaced = await tx
            .update(gitAccounts)
            .set({ isDefaultReviewer: false })
            .where(and(sameReviewScope(row), eq(gitAccounts.isDefaultReviewer, true), ne(gitAccounts.id, id)))
            .returning({ id: gitAccounts.id, name: gitAccounts.name });
          const [account] = await tx
            .update(gitAccounts)
            .set({ isDefaultReviewer: true })
            .where(eq(gitAccounts.id, id))
            .returning();
          // Sparito fra la lettura e qui: si annulla anche la rimozione del
          // predefinito precedente, che altrimenti resterebbe tolto per niente.
          if (!account) throw new DefaultReviewerAccountGone();
          return { account, replaced: replaced[0] ?? null };
        });
      } catch (error) {
        if (error instanceof DefaultReviewerAccountGone) {
          return apiError(reply, 404, "git_account_not_found", "Git account not found");
        }
        if (isUniqueViolation(error)) {
          return apiError(
            reply,
            409,
            "default_reviewer_conflict",
            "Another default reviewer was set for this provider/workspace at the same time: reload and retry",
          );
        }
        throw error;
      }

      const warnings = await defaultReviewerWarnings(app, outcome.account);
      return { account: toPublicAccount(outcome.account), replaced: outcome.replaced, warnings };
    },
  );

  /** Toglie il revisore predefinito (solo admin). Idempotente: 204 anche se non lo era. */
  app.delete(
    "/:id/default-reviewer",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        response: { 204: z.null(), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const [row] = await app.db
        .update(gitAccounts)
        .set({ isDefaultReviewer: false })
        .where(eq(gitAccounts.id, request.params.id))
        .returning({ id: gitAccounts.id });
      if (!row) return apiError(reply, 404, "git_account_not_found", "Git account not found");
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
      if (!row) return apiError(reply, 404, "git_account_not_found", "Git account not found");

      let credentials: z.infer<typeof gitCredentialsSchema>;
      try {
        credentials = decryptAccountCredentials(row, app.encryptionKey);
      } catch {
        return apiError(reply, 400, "credentials_undecryptable", "Account credentials cannot be decrypted");
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
      if (!row) return apiError(reply, 404, "git_account_not_found", "Git account not found");

      let credentials: z.infer<typeof gitCredentialsSchema>;
      try {
        credentials = decryptAccountCredentials(row, app.encryptionKey);
      } catch {
        return apiError(reply, 400, "credentials_undecryptable", "Account credentials cannot be decrypted");
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
      if (!row) return apiError(reply, 404, "git_account_not_found", "Git account not found");

      let credentials: z.infer<typeof gitCredentialsSchema>;
      try {
        credentials = decryptAccountCredentials(row, app.encryptionKey);
      } catch {
        return apiError(reply, 400, "credentials_undecryptable", "Account credentials cannot be decrypted");
      }

      try {
        return await getProvider(row.provider).listRepositories(
          { credentials: { provider: row.provider, credentials }, workspace: row.workspace ?? undefined },
          { fetchImpl: fetch },
        );
      } catch (error) {
        if (error instanceof GitProviderError) {
          return apiError(reply, 422, "git_provider_error", error.message);
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
      if (!row) return apiError(reply, 404, "git_account_not_found", "Git account not found");

      let credentials: z.infer<typeof gitCredentialsSchema>;
      try {
        credentials = decryptAccountCredentials(row, app.encryptionKey);
      } catch {
        return apiError(reply, 400, "credentials_undecryptable", "Account credentials cannot be decrypted");
      }

      try {
        return await getProvider(row.provider).listBranches(
          { provider: row.provider, credentials },
          request.query.repo,
          { fetchImpl: fetch },
        );
      } catch (error) {
        if (error instanceof GitProviderError) {
          return apiError(reply, 422, "git_provider_error", error.message);
        }
        throw error;
      }
    },
  );
}
