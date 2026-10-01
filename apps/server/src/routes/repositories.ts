import { randomBytes } from "node:crypto";
import { repositorySaveResponseSchema, repositorySchema, type RepositoryWarning } from "@stubwise/shared";
import { getProvider } from "@stubwise/git";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/session.js";
import { GitProviderError } from "@stubwise/git";
import { decrypt, gitAccounts, projects, repositories } from "@stubwise/db";
import { decryptGitCredentials, resolveProviderUserId } from "@stubwise/notifications";
import { fetchPlatformIdentity } from "../services/platform-identity.js";
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
  // Account revisore (ciclo di correzione, 30 set 2026): omesso o null =
  // nessuno. Validato da `checkReviewAccount`.
  reviewGitAccountId: z.uuid().nullable().optional(),
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
  // Toggle del knowledge graph (graphify) per questo repository. Vive qui, con
  // gli altri flag del repository: le route del grafo lo leggono soltanto.
  graphEnabled: z.boolean().optional(),
  // Account revisore (ciclo di correzione, 30 set 2026): null lo toglie,
  // omesso lo lascia invariato (patch: un client che non conosce il campo non
  // azzera il revisore). Validato da `checkReviewAccount`.
  reviewGitAccountId: z.uuid().nullable().optional(),
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
 * impostazioni di prodotto (provider AI, auto-update docs) e l'ingestion
 * (`ingestionKey`, numerazione ticket) sono salite al progetto (Fase 3) e NON
 * fanno più parte di questa proiezione.
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
    gitAccountId: row.gitAccountId,
    gitAccountName,
    reviewGitAccountId: row.reviewGitAccountId,
    testCommand: row.testCommand,
    installCommand: row.installCommand,
    webhookConfiguredAt: row.webhookConfiguredAt?.toISOString() ?? null,
    graphEnabled: row.graphEnabled,
    createdAt: row.createdAt.toISOString(),
  };
}

type GitAccountRow = typeof gitAccounts.$inferSelect;

type ReviewAccountCheck =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 422; code: string; message: string };

/** Scrive nel log PERCHÉ un'identità non si risolve: il messaggio del provider, mai il token. */
function logIdentityError(app: FastifyInstance, gitAccountId: string, what: string) {
  return (err: unknown) =>
    app.log.warn({ gitAccountId, err: err instanceof Error ? err.message : String(err) }, what);
}

/**
 * Validazione dell'account revisore (design §8). I controlli LOCALI —
 * esistenza, account diverso, stesso provider, stesso workspace Bitbucket —
 * sempre; quelli di RETE solo quando il revisore viene scelto adesso
 * (`verifyRemote`): permessi sulla repository e identità sulla piattaforma,
 * RI-risolta (non dalla cache: il salvataggio è il momento in cui l'admin
 * deve sapere se funziona) e diversa da quella del principale. Anche
 * l'identità del principale si risolve qui: serve al confronto, e senza il
 * webhook scarterebbe ogni "Request changes" (fail-closed, §5). Senza
 * revisore, la stessa condizione è solo un avviso (`mainIdentityWarnings`).
 */
async function checkReviewAccount(
  app: FastifyInstance,
  input: {
    mainAccount: GitAccountRow;
    reviewGitAccountId: string;
    repoUrl: string;
    defaultBranch: string;
    verifyRemote: boolean;
  },
): Promise<ReviewAccountCheck> {
  const { mainAccount } = input;
  if (input.reviewGitAccountId === mainAccount.id) {
    return {
      ok: false,
      status: 400,
      code: "review_account_same_as_main",
      message: "The review account must differ from the repository's main account",
    };
  }
  const [review] = await app.db
    .select()
    .from(gitAccounts)
    .where(eq(gitAccounts.id, input.reviewGitAccountId));
  if (!review) {
    return { ok: false, status: 404, code: "review_git_account_not_found", message: "Review git account not found" };
  }
  if (review.provider !== mainAccount.provider) {
    return {
      ok: false,
      status: 400,
      code: "review_account_provider_mismatch",
      message: "The review account must be on the same provider as the main account",
    };
  }
  if (review.provider === "bitbucket" && review.workspace !== mainAccount.workspace) {
    return {
      ok: false,
      status: 400,
      code: "review_account_workspace_mismatch",
      message: "The review account must be in the same Bitbucket workspace as the main account",
    };
  }
  if (!input.verifyRemote) return { ok: true };

  const credentials = decryptGitCredentials(review.encryptedCredentials, app.encryptionKey);
  if (!credentials) {
    return {
      ok: false,
      status: 400,
      code: "credentials_undecryptable",
      message: "Git account credentials cannot be decrypted",
    };
  }
  const checks = await getProvider(review.provider).validateCredentials(
    { repoUrl: input.repoUrl, defaultBranch: input.defaultBranch, credentials },
    { fetchImpl: fetch },
  );
  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    return {
      ok: false,
      status: 422,
      code: "review_account_invalid",
      // Il dettaglio dei controlli (dal provider) è la parte utile: dice
      // quale permesso manca.
      message: failed.map((check) => `${check.name}: ${check.detail}`).join("; "),
    };
  }
  // Su Bitbucket leggere "chi sono" vuole lo scope `read:user:bitbucket`: un
  // token creato prima del ciclo di correzione risponde 403, e va detto QUI —
  // al webhook sarebbe un "Request changes" scartato (fail-closed), spiegato
  // solo a cose fatte sul ticket (D2). È un SUGGERIMENTO, non la diagnosi: il
  // motivo vero (401, 403, rate limit…) lo scrive onError nel log.
  const scopeHint =
    review.provider === "bitbucket" ? " (on Bitbucket, check that the token has the read:user:bitbucket scope)" : "";
  const reviewerId = await resolveProviderUserId(app.db, app.encryptionKey, review, fetchPlatformIdentity, {
    refresh: true,
    onError: logIdentityError(app, review.id, "identità dell'account revisore: il provider ha risposto con un errore"),
  });
  if (reviewerId === null) {
    return {
      ok: false,
      status: 422,
      code: "review_account_identity_unresolved",
      message: `Could not read the review account's identity from the provider${scopeHint}`,
    };
  }
  // Il principale dalla cache se c'è: è l'identità con cui il webhook
  // lavorerà comunque, e un rinfresco fallito non deve bloccare la scelta del
  // revisore se quella salvata è buona.
  const mainId = await resolveProviderUserId(app.db, app.encryptionKey, mainAccount, fetchPlatformIdentity, {
    onError: logIdentityError(
      app,
      mainAccount.id,
      "identità dell'account principale: il provider ha risposto con un errore",
    ),
  });
  if (mainId === null) {
    return {
      ok: false,
      status: 422,
      code: "main_account_identity_unresolved",
      message: `Could not read the main account's identity from the provider${scopeHint}`,
    };
  }
  if (mainId === reviewerId) {
    return {
      ok: false,
      status: 400,
      code: "review_account_same_identity",
      message: "The two accounts belong to the same user on the provider",
    };
  }
  return { ok: true };
}

/**
 * Avviso NON bloccante (ciclo di correzione): l'identità dell'account
 * principale si legge? Se no, il webhook scarterà ogni "Request changes"
 * dalla piattaforma (fail-closed, D2) — meglio dirlo a chi salva adesso.
 * Dalla CACHE (niente refresh): è l'identità con cui lavora il webhook, e con
 * `provider_user_id` salvato non costa una chiamata. Best-effort: un errore
 * della verifica si logga e non produce avviso, e non tocca il salvataggio
 * (la riga è già scritta). Il testo sullo scope Bitbucket lo mette il client,
 * che conosce `provider` dalla stessa risposta.
 */
async function mainIdentityWarnings(app: FastifyInstance, mainAccount: GitAccountRow): Promise<RepositoryWarning[]> {
  try {
    const id = await resolveProviderUserId(app.db, app.encryptionKey, mainAccount, fetchPlatformIdentity, {
      onError: logIdentityError(
        app,
        mainAccount.id,
        "identità dell'account principale: il provider ha risposto con un errore",
      ),
    });
    return id === null ? ["main_account_identity_unresolved"] : [];
  } catch (err) {
    app.log.warn(
      { gitAccountId: mainAccount.id, err: err instanceof Error ? err.message : String(err) },
      "verifica dell'identità dell'account principale non riuscita: nessun avviso",
    );
    return [];
  }
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
        response: {
          201: repositorySaveResponseSchema,
          400: errorSchema,
          404: errorSchema,
          422: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const {
        projectId,
        name,
        gitAccountId,
        repoUrl,
        defaultBranch,
        testCommand,
        installCommand,
        reviewGitAccountId,
      } = request.body;

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

      if (reviewGitAccountId) {
        const check = await checkReviewAccount(app, {
          mainAccount: account,
          reviewGitAccountId,
          repoUrl,
          defaultBranch,
          verifyRemote: true,
        });
        if (!check.ok) return apiError(reply, check.status, check.code, check.message);
      }

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
              // Omesso → null: nessun account revisore.
              reviewGitAccountId: reviewGitAccountId ?? null,
              repoUrl,
              defaultBranch,
              // Omesso → null: nessun comando di test configurato alla creazione.
              testCommand: testCommand ?? null,
              // Omesso → null: nessun comando di installazione alla creazione.
              installCommand: installCommand ?? null,
              // Segreto HMAC del webhook git: 32 hex. Sempre valorizzato alla
              // creazione, così nessun repository nuovo nasce con webhook non
              // verificabili. L'ingestionKey NON vive più qui (salita al
              // progetto, Fase 3): il repo eredita l'ingestion del suo progetto.
              webhookSecret: randomBytes(16).toString("hex"),
            })
            .returning();
          if (!created) throw new Error("insert del repository non ha restituito la riga");
          // L'account può aver appena salvato la sua identità in
          // `checkReviewAccount`: si rilegge, così l'avviso guarda la cache vera.
          const [mainAccount] = await app.db.select().from(gitAccounts).where(eq(gitAccounts.id, account.id));
          return await reply.code(201).send({
            ...toPublicRepository(created, account.name),
            warnings: await mainIdentityWarnings(app, mainAccount ?? account),
          });
        } catch (error) {
          // Collisione di slug: rigenerato al giro dopo. Tutto il resto riemerge.
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
        response: {
          200: repositorySaveResponseSchema,
          400: errorSchema,
          404: errorSchema,
          422: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const {
        name,
        repoUrl,
        defaultBranch,
        gitAccountId,
        testCommand,
        installCommand,
        graphEnabled,
        reviewGitAccountId,
      } = request.body;
      const updates: Partial<RepositoryRow> = {};
      if (name !== undefined) updates.name = name;
      if (repoUrl !== undefined) updates.repoUrl = repoUrl;
      if (defaultBranch !== undefined) updates.defaultBranch = defaultBranch;
      // null azzera il comando, una stringa lo imposta; omesso (undefined) lo lascia.
      if (testCommand !== undefined) updates.testCommand = testCommand;
      // Stessa semantica di testCommand: null azzera, stringa imposta, omesso lascia.
      if (installCommand !== undefined) updates.installCommand = installCommand;
      // Toggle del knowledge graph: booleano puro, omesso lo lascia invariato.
      if (graphEnabled !== undefined) updates.graphEnabled = graphEnabled;
      // Account principale e revisore si validano INSIEME: cambiare uno dei due
      // può invalidare l'altro (promuovere il revisore a principale, passare a
      // un provider diverso). Cambio di principale: valida l'esistenza e
      // ri-denormalizza il provider. I controlli di RETE sul revisore solo
      // quando lo si sceglie adesso; cambiando il solo principale, quelli locali.
      if (gitAccountId !== undefined || reviewGitAccountId !== undefined) {
        const [current] = await app.db
          .select({ repository: repositories, account: gitAccounts })
          .from(repositories)
          .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
          .where(eq(repositories.slug, request.params.slug));
        if (!current) return apiError(reply, 404, "repository_not_found", "Repository not found");

        let mainAccount = current.account;
        if (gitAccountId !== undefined) {
          const [account] = await app.db
            .select()
            .from(gitAccounts)
            .where(eq(gitAccounts.id, gitAccountId));
          if (!account) return apiError(reply, 404, "git_account_not_found", "Git account not found");
          mainAccount = account;
          updates.gitAccountId = account.id;
          updates.provider = account.provider;
        }

        const effectiveReview =
          reviewGitAccountId !== undefined ? reviewGitAccountId : current.repository.reviewGitAccountId;
        if (effectiveReview !== null) {
          const check = await checkReviewAccount(app, {
            mainAccount,
            reviewGitAccountId: effectiveReview,
            repoUrl: repoUrl ?? current.repository.repoUrl,
            defaultBranch: defaultBranch ?? current.repository.defaultBranch,
            verifyRemote: reviewGitAccountId !== undefined && reviewGitAccountId !== null,
          });
          if (!check.ok) return apiError(reply, check.status, check.code, check.message);
        }
        // null toglie il revisore; omesso (undefined) lo lascia invariato.
        if (reviewGitAccountId !== undefined) updates.reviewGitAccountId = reviewGitAccountId;
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

      // Riletto DOPO l'update: l'account principale effettivo (cambiato o no)
      // con la cache d'identità che `checkReviewAccount` può aver appena scritto.
      const [row] = await app.db
        .select({ repository: repositories, account: gitAccounts })
        .from(repositories)
        .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
        .where(eq(repositories.slug, request.params.slug));
      if (!row) return apiError(reply, 404, "repository_not_found", "Repository not found");
      return {
        ...toPublicRepository(row.repository, row.account.name),
        warnings: await mainIdentityWarnings(app, row.account),
      };
    },
  );
}
