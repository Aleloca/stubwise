import { randomBytes } from "node:crypto";
import { decrypt, gitAccounts, projects, repositories, type Db } from "@stubwise/db";
import { getProvider, GitProviderError } from "@stubwise/git";
import { eq } from "drizzle-orm";
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
export async function regenerateIngestionKey(db: Db, actor: Actor, projectId: string): Promise<{ ingestionKey: string }> {
  const ingestionKey = generateIngestionKey();
  await db.transaction(async (tx) => {
    const [p] = await tx.update(projects).set({ ingestionKey }).where(eq(projects.id, projectId)).returning({ id: projects.id, code: projects.code });
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
export async function regenerateWebhookSecret(db: Db, key: Buffer, actor: Actor, slug: string, publicUrl: string): Promise<WebhookSecretOutcome> {
  const [row] = await db
    .select({ repository: repositories, account: gitAccounts })
    .from(repositories)
    .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
    .where(eq(repositories.slug, slug));
  if (!row) throw new RoleRuleError(404, "repository_not_found", "Repository not found");
  const { repository, account } = row;
  const fresh = randomBytes(16).toString("hex");
  const write = () =>
    db.transaction(async (tx) => {
      await tx.update(repositories).set({ webhookSecret: fresh }).where(eq(repositories.id, repository.id));
      await recordChange(tx, { type: "repository.webhook_secret_regenerated", actor, projectId: repository.projectId, data: { object: { type: "repository", id: repository.id, label: repository.name } } });
    });

  if (!repository.webhookConfiguredAt) {
    await write();
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
  const url = `${publicUrl}/webhooks/git/${slug}`;
  try {
    await provider.ensureWebhook(config, { url, secret: fresh }, { fetchImpl: fetch });
  } catch (error) {
    // 3. Rifiutato: resta il vecchio, che continua a valere.
    const detail = error instanceof GitProviderError ? error.message : "The platform did not answer";
    throw new RoleRuleError(502, "platform_update_failed", detail);
  }

  // 4. Accettato: si scrive il nuovo, con la voce.
  try {
    await write();
    return { mode: "platform", webhookSecret: fresh };
  } catch {
    // 5. La scrittura è fallita con la piattaforma già sul nuovo: si prova a rimettere il vecchio.
    try {
      await provider.ensureWebhook(config, { url, secret: repository.webhookSecret }, { fetchImpl: fetch });
      return { mode: "rollback", platformRestored: true };
    } catch {
      return { mode: "rollback", platformRestored: false };
    }
  }
}
