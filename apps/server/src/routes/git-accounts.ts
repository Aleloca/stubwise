import { changedFields, recordChange } from "../services/change-log.js";
import { createGitAccountSchema, secretLast4, defaultReviewerResponseSchema, gitCredentialsSchema, defaultReviewerWarningSchema, gitAccountSchema, gitValidateResponseSchema, updateGitAccountSchema } from "@stubwise/shared";
import { GitProviderError, bitbucketRequiredScopes, getProvider } from "@stubwise/git";
import { decrypt, encrypt, gitAccounts, projects, repositories, type Db } from "@stubwise/db";
import { resolveReviewAccounts } from "@stubwise/notifications";
import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authErrorResponses, errorSchema, isUniqueViolation } from "./shared.js";
import { apiError } from "../errors.js";
import { clearDefaultReviewer, DefaultReviewerAccountChanged, DefaultReviewerAccountGone, gitAccountObject, sameReviewScope, writeDefaultReviewer } from "../services/default-reviewer-write.js";
import { verifyDefaultReviewer } from "../services/default-reviewer-verify.js";
import { requireReauth, scopeIncludes, visibleProjectIds } from "../auth/access.js";
import { checkReviewAccount, logIdentityError } from "../services/review-account-check.js";

/**
 * Credenziali git di un account: `token` sempre; `username` è l'identità git
 * (username Bitbucket per gli API token, o l'account per le app password
 * legacy); `email` è l'identità della REST API (email Atlassian), serve solo
 * agli API token di Bitbucket. Serializzate in JSON e cifrate prima di toccare
 * il DB; non compaiono mai in nessuna risposta.
 */


// In modifica: nome, credenziali e/o workspace. Credenziali assenti = invariate
// (non si possono "svuotare": un account senza credenziali non avrebbe senso).

const idParamsSchema = z.object({ id: z.uuid() });


/** Risultato della validazione: `ok` riassume i singoli check (tutti ok). */

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


type DefaultReviewerWarning = z.infer<typeof defaultReviewerWarningSchema>;

/** Concorrenza delle verifiche per repository dopo l'impostazione (D5). */
const DEFAULT_REVIEWER_CHECK_CONCURRENCY = 4;

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


/**
 * Proiezione pubblica di un account: campi elencati esplicitamente, mai spread
 * della riga, così `encryptedCredentials` non può trapelare nemmeno se lo
 * schema cambiasse.
 */
type AccountUsage = { repositories: { name: string; projectCode: string | null }[]; hiddenRepositories: number };

/**
 * Rimandi, lotto 5 (il prototipo, `usageOf` di `data/instance/git.ts`): i
 * repository che usano ogni account, per chi guarda — per nome quelli dei
 * progetti che vede e quelli staccati (senza progetto: il nome non dice da
 * quale progetto eliminato vengono), gli altri solo contati. Una query.
 */
async function usageOf(db: Db, viewer: Parameters<typeof visibleProjectIds>[1], accountIds: readonly string[]): Promise<Map<string, AccountUsage>> {
  const out = new Map<string, AccountUsage>(accountIds.map((id) => [id, { repositories: [], hiddenRepositories: 0 }]));
  if (accountIds.length === 0) return out;
  const scope = await visibleProjectIds(db, viewer);
  const rows = await db
    .select({ accountId: repositories.gitAccountId, name: repositories.name, projectId: repositories.projectId, code: projects.code })
    .from(repositories)
    .leftJoin(projects, eq(projects.id, repositories.projectId))
    .where(inArray(repositories.gitAccountId, [...accountIds]))
    .orderBy(asc(repositories.name));
  for (const r of rows) {
    const u = out.get(r.accountId)!;
    if (r.projectId === null) u.repositories.push({ name: r.name, projectCode: null });
    else if (r.code && scopeIncludes(scope, r.projectId)) u.repositories.push({ name: r.name, projectCode: r.code });
    else u.hiddenRepositories += 1;
  }
  return out;
}

function toPublicAccount(row: GitAccountRow, usage: AccountUsage = { repositories: [], hiddenRepositories: 0 }): z.infer<typeof gitAccountSchema> {
  return {
    ...usage,
    id: row.id,
    name: row.name,
    provider: row.provider,
    workspace: row.workspace,
    isDefaultReviewer: row.isDefaultReviewer,
    createdAt: row.createdAt.toISOString(),
    tokenLast4: row.tokenLast4,
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
 * Il RUOLO di un account, per gli scope che Validate gli chiede (D9). Lo
 * calcola il server, dal database:
 * - `primary`: è il principale di almeno una repository;
 * - `reviewer`: è il revisore EFFETTIVO di almeno una repository — la regola è
 *   `resolveReviewAccounts`, mai la sola colonna esplicita: un predefinito che
 *   fa da revisore senza essere scritto da nessuna parte conta — OPPURE è
 *   marcato predefinito. Il flag conta anche senza repository nell'ambito
 *   (deviazione dalla lettera della richiesta, D9): un predefinito appena
 *   impostato cadrebbe altrimenti in «mai usato», cioè nell'insieme del
 *   principale, e Validate gli segnerebbe ko sui webhook che il suo ruolo non
 *   chiede.
 * Nessuno dei due → `bitbucketRequiredScopes` chiede l'insieme del principale.
 *
 * Tre query in tutto, qualunque sia il numero di repository: una per le
 * repository candidate (lo stesso provider, o quelle di cui è il principale),
 * due dentro `resolveReviewAccounts`. Nessuna scrittura, nessuna chiamata al
 * provider.
 */
async function accountReviewRole(
  app: FastifyInstance,
  account: GitAccountRow,
): Promise<{ primary: boolean; reviewer: boolean }> {
  const rows = await app.db
    .select({ id: repositories.id, gitAccountId: repositories.gitAccountId })
    .from(repositories)
    .where(or(eq(repositories.provider, account.provider), eq(repositories.gitAccountId, account.id)));
  const primary = rows.some((r) => r.gitAccountId === account.id);
  if (account.isDefaultReviewer) return { primary, reviewer: true };
  const resolutions = await resolveReviewAccounts(
    app.db,
    rows.map((r) => r.id),
  );
  const reviewer = [...resolutions.values()].some((r) => r.effective?.account.id === account.id);
  return { primary, reviewer };
}

/**
 * Route degli account git riutilizzabili, registrate sotto /api/git-accounts.
 * Le credenziali sono cifrate AES-256-GCM at rest e non escono mai dall'API.
 * Lettura con `git_accounts.view` (così un admin può scegliere l'account
 * creando un progetto); creazione, modifica, eliminazione e operazioni che
 * decifrano le credenziali (validazione, elenco repo/branch) `git_accounts.manage`.
 */
/** Area 9, F3: l'oggetto delle voci (l'account col nome dato da una persona) e il nome della piattaforma (un marchio, non una parola). */
const PLATFORM_NAME: Record<string, string> = { github: "GitHub", bitbucket: "Bitbucket" };

/**
 * La patch di un account git (`PATCH /api/git-accounts/:id`, area 9, F7:
 * estratta dalla rotta). La riconferma per le credenziali la chiede la ROTTA;
 * Claude non le porta mai (`encryptionKey` null).
 */
export async function patchGitAccount(
  db: Db,
  encryptionKey: Buffer | null,
  actor: { id: string; email: string },
  id: string,
  body: { name?: string | undefined; credentials?: z.infer<typeof gitCredentialsSchema> | undefined; workspace?: string | undefined },
): Promise<GitAccountRow | "not_found" | "workspace_locked"> {
  const { name, credentials, workspace } = body;
  const key = (): Buffer => {
    if (!encryptionKey) throw new Error("patchGitAccount: credenziali senza chiave di cifratura");
    return encryptionKey;
  };
  const updates: Partial<GitAccountRow> = {};
  if (name !== undefined) updates.name = name;
  if (workspace !== undefined) updates.workspace = workspace;
  if (credentials !== undefined) {
    updates.encryptedCredentials = encrypt(JSON.stringify(credentials), key());
    updates.tokenLast4 = secretLast4(credentials.token);
    // Un token nuovo può appartenere a un ALTRO utente della piattaforma:
    // l'identità salvata (ciclo di correzione, design §5) non vale più e si
    // riscopre al primo uso. Tenerla farebbe passare dal filtro
    // anti-auto-innesco proprio il bot nuovo. Stessa scrittura del blob
    // nuovo: `resolveProviderUserId` guarda la sua cache proprio sul blob.
    updates.providerUserId = null;
  }

  // D7: il workspace di un revisore PREDEFINITO Bitbucket non si cambia —
  // sposterebbe in silenzio l'ambito, cioè il revisore di N repository,
  // senza la validazione del PUT, e potrebbe collidere con l'indice. Vale
  // SOLO dove il workspace entra nell'ambito (`sameReviewScope`): su GitHub
  // l'ambito è il solo provider, e cambiare il workspace non sposta niente.
  // La guardia sta nel WHERE (non in una lettura prima): un PUT concorrente
  // che marca l'account fra la lettura e la scrittura non la scavalca. Lo
  // stesso workspace di prima non è un cambio. Il verso opposto (un PATCH
  // che sposta l'account mentre il PUT verifica) lo chiude il PUT.
  const workspaceGuard =
    workspace === undefined
      ? undefined
      : or(
          eq(gitAccounts.isDefaultReviewer, false),
          ne(gitAccounts.provider, "bitbucket"),
          sql`${gitAccounts.workspace} is not distinct from ${workspace}`,
        );

  // Drizzle rifiuta un update senza colonne: un PATCH vuoto è una lettura.
  const row = await db.transaction(async (tx) => {
    const [before] = await tx.select().from(gitAccounts).where(eq(gitAccounts.id, id)).for("update");
    if (!before || Object.keys(updates).length === 0) return before;
    const [after] = await tx
      .update(gitAccounts)
      .set(updates)
      .where(and(eq(gitAccounts.id, id), workspaceGuard))
      .returning();
    if (!after) return undefined;
    // Area 9, F3: come il prototipo (`git.ts`), i soli campi cambiati; il
    // token solo «sostituito».
    const diff = changedFields({ name: before.name, workspace: before.workspace }, { name: after.name, workspace: after.workspace });
    if (diff) await recordChange(tx, { type: "git_account.updated", actor: actor, projectId: null, data: { object: gitAccountObject(after), ...diff } });
    if (credentials !== undefined) await recordChange(tx, { type: "git_account.token_replaced", actor: actor, projectId: null, data: { object: gitAccountObject(after) } });
    return after;
  });
  if (!row) {
    if (workspaceGuard !== undefined) {
      const [exists] = await db
        .select({ id: gitAccounts.id })
        .from(gitAccounts)
        .where(eq(gitAccounts.id, id));
      if (exists) {
        return "workspace_locked" as const;
      }
    }
    return "not_found" as const;
  }
  return row;
}

export async function gitAccountRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/",
    {
      config: { access: { kind: "instance", permission: "git_accounts.manage" }, reauth: true },
      schema: {
        body: createGitAccountSchema,
        response: { 201: gitAccountSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { name, provider, credentials, workspace } = request.body;
      const encryptedCredentials = encrypt(JSON.stringify(credentials), app.encryptionKey);
      const created = await app.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(gitAccounts)
          .values({ name, provider, encryptedCredentials, tokenLast4: secretLast4(credentials.token), workspace: workspace ?? null })
          .returning();
        if (!row) throw new Error("insert dell'account non ha restituito la riga");
        await recordChange(tx, { type: "git_account.created", actor: request.user!, projectId: null, data: { object: gitAccountObject(row), params: { provider: PLATFORM_NAME[row.provider] ?? row.provider } } });
        return row;
      });
      return reply.code(201).send(toPublicAccount(created));
    },
  );

  app.get(
    "/",
    {
      config: { access: { kind: "instance", permission: "git_accounts.view" } },
      schema: { response: { 200: z.array(gitAccountSchema), ...authErrorResponses } },
    },
    async (request) => {
      const rows = await app.db.select().from(gitAccounts).orderBy(gitAccounts.createdAt);
      const usage = await usageOf(app.db, request.user!, rows.map((r) => r.id));
      return rows.map((r) => toPublicAccount(r, usage.get(r.id)));
    },
  );

  app.get(
    "/:id",
    {
      config: { access: { kind: "instance", permission: "git_accounts.view" } },
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
      return toPublicAccount(row, (await usageOf(app.db, request.user!, [row.id])).get(row.id));
    },
  );

  app.patch(
    "/:id",
    {
      config: { access: { kind: "instance", permission: "git_accounts.manage" }, partialReauth: true },
      schema: {
        params: idParamsSchema,
        body: updateGitAccountSchema,
        response: { 200: gitAccountSchema, 404: errorSchema, 409: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { name, credentials, workspace } = request.body;
      // Area 9, F3 (D-5): la riconferma solo quando il corpo porta un segreto
      // (sostituito o azzerato), con la regola del gate (`requireReauth`).
      if (credentials !== undefined && !(await requireReauth(request, reply))) return reply;
      // Area 9, F7: la funzione, la stessa dell'azione di Claude `updateGitAccount`.
      const row = await patchGitAccount(app.db, app.encryptionKey, request.user!, request.params.id, { name, credentials, workspace });
      if (row === "workspace_locked") {
        return apiError(
          reply,
          409,
          "default_reviewer_workspace_locked",
          "This account is the default reviewer: remove the default before changing its workspace",
        );
      }
      if (row === "not_found") return apiError(reply, 404, "git_account_not_found", "Git account not found");
      return toPublicAccount(row, (await usageOf(app.db, request.user!, [row.id])).get(row.id));
    },
  );

  app.delete(
    "/:id",
    {
      config: { access: { kind: "instance", permission: "git_accounts.manage" }, reauth: true },
      schema: {
        params: idParamsSchema,
        response: {
          204: z.null(),
          404: errorSchema,
          // `usedBy`/`hiddenCount` sul rifiuto `git_account_in_use` (rimandi, lotto 5).
          409: errorSchema.extend({
            usedBy: z.array(z.object({ label: z.string(), projectCode: z.string().nullable() })).optional(),
            hiddenCount: z.number().int().optional(),
          }),
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
        // Rimandi, lotto 5: chi lo usa, con la regola della riga (`usedBy` per nome, gli altri contati).
        const usage = (await usageOf(app.db, request.user!, [request.params.id])).get(request.params.id)!;
        return reply.code(409).send({
          code: "git_account_in_use",
          message: "Git account in use by one or more repositories: unlink it before deleting",
          usedBy: usage.repositories.map((r) => ({ label: r.name, projectCode: r.projectCode })),
          hiddenCount: usage.hiddenRepositories,
        });
      }
      const deleted = await app.db.transaction(async (tx) => {
        const gone = await tx.delete(gitAccounts).where(eq(gitAccounts.id, request.params.id)).returning();
        for (const g of gone) await recordChange(tx, { type: "git_account.deleted", actor: request.user!, projectId: null, data: { object: gitAccountObject(g) } });
        return gone;
      });
      if (deleted.length === 0) return apiError(reply, 404, "git_account_not_found", "Git account not found");
      return reply.code(204).send(null);
    },
  );

  /**
   * Imposta il REVISORE PREDEFINITO del suo ambito (provider + workspace
   * Bitbucket, D1/D4). `git_accounts.manage`. Due livelli di verifica (D5):
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
   * parziale → 409 `default_reviewer_conflict`. Un PATCH che SPOSTA l'account
   * in un altro ambito mentre il PUT verifica (secondi di rete, e il PATCH è
   * permesso finché l'account non è predefinito) lo ferma la guardia
   * sull'ambito letto nell'UPDATE che marca il flag → 409
   * `default_reviewer_account_changed`, e il rollback rimette il predecessore.
   *
   * Le verifiche di account vengono PRIMA dell'identità (il piano diceva il
   * contrario): un token senza `read:user` o non valido produce così il
   * dettaglio preciso del check, invece del generico «identità non leggibile».
   */
  app.put(
    "/:id/default-reviewer",
    {
      config: { access: { kind: "instance", permission: "git_accounts.manage" } },
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

      // Lotto 6, voce 1: la verifica (solo letture, fuori dalla transazione) e la
      // scrittura (solo DB, con le sue guardie) sono due funzioni, le stesse
      // dell'azione di Claude `setDefaultReviewer`. Comportamento invariato.
      const check = await verifyDefaultReviewer(row, app.encryptionKey, {
        onIdentityError: logIdentityError(app, row.id, "identità del revisore predefinito: il provider ha risposto con un errore"),
      });
      if (!check.ok) return apiError(reply, check.status, check.code, check.message);

      let outcome: { account: GitAccountRow; replaced: { id: string; name: string } | null };
      try {
        outcome = await app.db.transaction(async (tx) => writeDefaultReviewer(tx as unknown as Db, request.user!, row, check.providerUserId));
      } catch (error) {
        if (error instanceof DefaultReviewerAccountGone) {
          return apiError(reply, 404, "git_account_not_found", "Git account not found");
        }
        if (error instanceof DefaultReviewerAccountChanged) {
          return apiError(
            reply,
            409,
            "default_reviewer_account_changed",
            "The account's workspace changed while it was being verified: reload and retry",
          );
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
      return { account: toPublicAccount(outcome.account, (await usageOf(app.db, request.user!, [outcome.account.id])).get(outcome.account.id)), replaced: outcome.replaced, warnings };
    },
  );

  /** Toglie il revisore predefinito (`git_accounts.manage`). Idempotente: 204 anche se non lo era. */
  app.delete(
    "/:id/default-reviewer",
    {
      config: { access: { kind: "instance", permission: "git_accounts.manage" } },
      schema: {
        params: idParamsSchema,
        response: { 204: z.null(), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const row = await app.db.transaction(async (tx) => clearDefaultReviewer(tx as unknown as Db, request.user!, request.params.id));
      if (!row) return apiError(reply, 404, "git_account_not_found", "Git account not found");
      return reply.code(204).send(null);
    },
  );

  // Validazione delle credenziali memorizzate (`git_accounts.manage`) a LIVELLO DI ACCOUNT:
  // decifra e controlla via HTTPS che il token autentichi e abbia accesso in
  // lettura ai repository. I check repo-specifici (push git / PR / webhook su un
  // repo) vivono in /validate-repo, eseguiti nel wizard dopo la scelta del repo.
  // Su Bitbucket confronta anche gli scope CONCESSI con quelli del RUOLO
  // dell'account (`accountReviewRole`, D9): un account solo revisore non deve
  // risultare ko sui webhook, che non usa.
  app.post(
    "/:id/validate",
    {
      config: { access: { kind: "instance", permission: "git_accounts.manage" } },
      schema: {
        params: idParamsSchema,
        response: { 200: gitValidateResponseSchema, 400: errorSchema, 404: errorSchema, ...authErrorResponses },
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

      const requiredScopes =
        row.provider === "bitbucket" ? bitbucketRequiredScopes(await accountReviewRole(app, row)) : undefined;
      const checks = await getProvider(row.provider).validateAccount(
        { credentials: { provider: row.provider, credentials }, workspace: row.workspace ?? undefined },
        { fetchImpl: fetch, requiredScopes },
      );
      return { ok: checks.every((c) => c.ok), checks };
    },
  );

  // Verifica REPO-SPECIFICA (`git_accounts.manage`): sonda i tre check che richiedono un
  // repo reale (push git, REST/PR, webhook) su un repo scelto (query `repo` =
  // "workspace/slug" o "owner/repo"). È advisory: la usa il wizard dopo la
  // scelta del repo, prima di creare il progetto (anche se rossa non blocca).
  app.get(
    "/:id/validate-repo",
    {
      config: { access: { kind: "instance", permission: "git_accounts.manage" } },
      schema: {
        params: idParamsSchema,
        querystring: validateRepoQuerySchema,
        response: { 200: gitValidateResponseSchema, 400: errorSchema, 404: errorSchema, ...authErrorResponses },
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
      config: { access: { kind: "instance", permission: "git_accounts.manage" } },
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
      config: { access: { kind: "instance", permission: "git_accounts.manage" } },
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
