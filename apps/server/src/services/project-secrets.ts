import { randomBytes } from "node:crypto";
import { decrypt, gitAccounts, projects, repositories, users, type Db } from "@stubwise/db";
import type { ProjectIntegration } from "@stubwise/shared";
import { getProvider, GitProviderError } from "@stubwise/git";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { generateIngestionKey } from "../routes/shared.js";
import { recordChange } from "./change-log.js";
import { RoleRuleError } from "./roles.js";

/**
 * Area 9, F5: le rigenerazioni dei segreti di un progetto. Il valore nuovo si
 * mostra UNA volta; il vecchio smette di valere quando quello nuovo è
 * scritto. Nessuna voce del registro porta un valore.
 */

type Actor = { id: string; email: string };

/** La chiave d'ingestione: la vecchia smette subito (l'ingestion cerca il progetto per chiave). */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function regenerateIngestionKey(db: Db, actor: Actor, projectId: string): Promise<{ ingestionKey: string }> {
  const ingestionKey = generateIngestionKey();
  await db.transaction(async (tx) => {
    const [p] = await tx.update(projects).set({ ingestionKey, ingestionKeyCreatedAt: new Date(), ingestionKeyCreatedByUserId: actor.id }).where(eq(projects.id, projectId)).returning({ id: projects.id, code: projects.code });
    if (!p) throw new RoleRuleError(404, "not_found", "Project not found");
    await recordChange(tx, { type: "project.ingestion_key_regenerated", actor, projectId, data: { object: { type: "project", id: p.id, label: p.code } } });
  });
  return { ingestionKey };
}

const gitCredentialsSchema = z.object({ username: z.string().optional(), email: z.string().optional(), token: z.string().min(1) });

export type WebhookSecretOutcome =
  | { mode: "manual" | "platform"; webhookSecret: string }
  | { mode: "rollback"; platformRestored: boolean };

/**
 * Il segreto del webhook git (K-5 = a, l'ordine scritto nel piano di F5):
 * - webhook NON configurato da Stubwise → si scrive il nuovo, da copiare a
 *   mano (`manual`); il vecchio smette subito;
 * - configurato → PRIMA gli scope del token (gestire i webhook: 422
 *   `webhook_scope_missing`, niente cambia), poi il nuovo IN MEMORIA va sulla
 *   piattaforma; se la piattaforma rifiuta → 502 `platform_update_failed` e
 *   resta il VECCHIO; se accetta → si scrive nel DB con la voce (da qui il
 *   vecchio smette). Se proprio quella scrittura fallisce si prova a rimettere
 *   il vecchio sulla piattaforma (`rollback`, con l'esito): l'unico punto in
 *   cui i due possono restare divisi.
 */
export async function regenerateWebhookSecret(
  db: Db,
  key: Buffer,
  actor: Actor,
  slug: string,
  publicUrl: string,
  onWriteError?: (error: unknown) => void,
): Promise<WebhookSecretOutcome> {
  // Review I2: la riga del repository resta BLOCCATA per tutta la sequenza
  // (scope → piattaforma → DB). Due rigenerazioni insieme (un doppio click), o
  // una rigenerazione e una «configura», si mettono in fila: senza, la
  // piattaforma poteva finire sul segreto dell'una e il DB su quello dell'altra.
  return db.transaction(async (tx): Promise<WebhookSecretOutcome> => {
    const [row] = await tx
      .select({ repository: repositories, account: gitAccounts })
      .from(repositories)
      .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
      // Lo slug o l'id (rimandi, lotto 5: l'app passa l'id), come `fromRepository`.
      .where(UUID_RE.test(slug) ? eq(repositories.id, slug) : eq(repositories.slug, slug))
      .for("update", { of: repositories });
    if (!row) throw new RoleRuleError(404, "repository_not_found", "Repository not found");
    const { repository, account } = row;
    const fresh = randomBytes(16).toString("hex");
    const write = (t: typeof tx) =>
      // Un savepoint: se la scrittura fallisce, la transazione esterna resta
      // valida e il vecchio può tornare sulla piattaforma (passo 5).
      t.transaction(async (sp) => {
        await sp.update(repositories).set({ webhookSecret: fresh }).where(eq(repositories.id, repository.id));
        await recordChange(sp, { type: "repository.webhook_secret_regenerated", actor, projectId: repository.projectId, data: { object: { type: "repository", id: repository.id, label: repository.name } } });
      });

    if (!repository.webhookConfiguredAt) {
      await write(tx);
      return { mode: "manual", webhookSecret: fresh };
    }

    let credentials: z.infer<typeof gitCredentialsSchema>;
    try {
      credentials = gitCredentialsSchema.parse(JSON.parse(decrypt(account.encryptedCredentials, key)));
    } catch {
      throw new RoleRuleError(400, "credentials_undecryptable", "Git account credentials cannot be decrypted");
    }
    const provider = getProvider(repository.provider);
    const config = { repoUrl: repository.repoUrl, defaultBranch: repository.defaultBranch, credentials };

    // 1. Gli scope PRIMA di toccare qualunque cosa.
    const checks = await provider.validateCredentials(config, { fetchImpl: fetch });
    const webhookCheck = checks.find((c) => c.purpose === "webhook");
    if (!webhookCheck?.ok) throw new RoleRuleError(422, "webhook_scope_missing", webhookCheck?.detail ?? "The git token cannot manage webhooks");

    // 2. Il nuovo, in memoria, sulla piattaforma.
    // Lo SLUG della riga, mai il parametro (review del lotto 5, I-1): chiamata
    // per id, l'URL con l'uuid creerebbe un hook che /webhooks/git non trova.
    const url = `${publicUrl}/webhooks/git/${repository.slug}`;
    try {
      await provider.ensureWebhook(config, { url, secret: fresh }, { fetchImpl: fetch });
    } catch (error) {
      // 3. Rifiutato: resta il vecchio, che continua a valere.
      const detail = error instanceof GitProviderError ? error.message : "The platform did not answer";
      throw new RoleRuleError(502, "platform_update_failed", detail);
    }

    // 4. Accettato: si scrive il nuovo, con la voce.
    try {
      await write(tx);
      return { mode: "platform", webhookSecret: fresh };
    } catch (error) {
      // 5. La scrittura è fallita con la piattaforma già sul nuovo: si prova a
      // rimettere il vecchio. La causa al chiamante, che la registra (mai il segreto).
      onWriteError?.(error);
      try {
        await provider.ensureWebhook(config, { url, secret: repository.webhookSecret }, { fetchImpl: fetch });
        return { mode: "rollback", platformRestored: true };
      } catch {
        return { mode: "rollback", platformRestored: false };
      }
    }
  });
}

const last4 = (value: string) => (value.length >= 4 ? value.slice(-4) : value);

/**
 * L'Integrazione in lettura (I2): le ultime 4 della chiave, quando e da chi,
 * il DSN senza chiave, l'URL in entrata; i webhook git (le ultime 4 del
 * segreto) solo a chi vede i repository. I permessi calcolati qui.
 */
export async function projectIntegration(db: Db, projectId: string, permissions: ReadonlySet<string>, publicUrl: string): Promise<ProjectIntegration> {
  const [p] = await db
    .select({ slug: projects.slug, key: projects.ingestionKey, at: projects.ingestionKeyCreatedAt, byId: projects.ingestionKeyCreatedByUserId, byName: users.displayName, byEmail: users.email })
    .from(projects)
    .leftJoin(users, eq(users.id, projects.ingestionKeyCreatedByUserId))
    .where(eq(projects.id, projectId));
  if (!p) throw new RoleRuleError(404, "not_found", "Project not found");
  const base = new URL(publicUrl);
  const seesRepos = permissions.has("repos.view") || permissions.has("repos.manage");
  const repos = seesRepos
    ? await db
        .select({ id: repositories.id, slug: repositories.slug, name: repositories.name, provider: repositories.provider, secret: repositories.webhookSecret, configuredAt: repositories.webhookConfiguredAt })
        .from(repositories)
        .where(eq(repositories.projectId, projectId))
        .orderBy(asc(repositories.name))
    : [];
  return {
    ingestion: {
      last4: last4(p.key),
      createdAt: p.at ? p.at.toISOString() : null,
      createdBy: p.byId ? { id: p.byId, name: p.byName ?? p.byEmail ?? "" } : null,
      dsnBase: `${base.protocol}//${base.host}/p/${p.slug}`,
    },
    inbound: { url: `${base.protocol}//${base.host}/api/inbound/${p.slug}/ticket` },
    gitWebhooks: repos.map((r) => ({
      repositoryId: r.id,
      slug: r.slug,
      name: r.name,
      // Rimandi, lotto 5: la piattaforma, per dire «GitHub» o «Bitbucket» nel dialogo.
      provider: r.provider,
      url: `${base.protocol}//${base.host}/webhooks/git/${r.slug}`,
      secretLast4: r.secret ? last4(r.secret) : null,
      configured: r.configuredAt !== null,
    })),
    canRegenerateKey: permissions.has("project.settings.manage"),
    canRegenerateWebhookSecret: permissions.has("repos.manage"),
  };
}
